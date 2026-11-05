import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { readMcpToolSummaries } from './scripts/mcp-discovery.mjs';
import { readReleases, readUpdates, UPDATES_DIR, RELEASES_FILE } from '../scripts/changelog-updates.mjs';
import { capabilityRegistryMarkdown, glossaryMarkdown, markdownTwinPath, mcpPairingLines, ORIGIN, PRODUCT_SUMMARY, PUBLIC_PAGES, SITE_FORM_PAGES } from './agent-surface';
import { publishedFieldNotes } from './marketing/field-notes';
import { INTEREST_AGENT_API_PATH, INTEREST_GUIDE_PATH, INTEREST_SCHEMA_PATH, PRODUCT_INTEREST_PATH as INTEREST_PATH } from '@starlings/contracts/paths';
import { PRODUCT_SITE_ORIGIN } from '@starlings/contracts/deployment';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(rootDir, '..');

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function resolveMeetBuild(): { version: string; build: string } {
  const version = readFileSync(path.join(repoDir, 'VERSION'), 'utf8').trim();
  let build = '0';
  try {
    // A shallow clone answers this confidently and wrongly: it counts the
    // commits it was given, which is how the footer shipped "build 1" for a
    // commit that is build 285 anywhere with full history. Cloudflare Workers
    // Builds clones shallow on every push, so fetch the rest of the history
    // before counting. '0' still means "no build number" here.
    if (git('rev-parse', '--is-shallow-repository') === 'true') {
      try {
        git('fetch', '--unshallow', '--quiet');
      } catch {
        // No network or no remote — checked again below.
      }
    }
    if (git('rev-parse', '--is-shallow-repository') !== 'true') {
      build = git('rev-list', '--count', 'HEAD') || '0';
    }
  } catch {
    // A source archive may not include .git; keep the footer honest about the
    // marketing version without inventing a build number.
  }
  if (build === '0' && process.env.WORKERS_CI) {
    // Production must not ship without a build number. Fail loudly instead of
    // quietly hiding it in the footer.
    throw new Error('meet-version: could not count commits (shallow clone and `git fetch --unshallow` failed)');
  }
  return { version, build };
}

/**
 * Commits per day, oldest first, for the /changelog activity chart. Rides on
 * the same unshallowed history the build number needs, so a shallow clone
 * yields an empty list rather than a wrong one.
 */
function resolveMeetActivity(): Array<[string, number]> {
  try {
    if (git('rev-parse', '--is-shallow-repository') === 'true') return [];
    const counts = new Map<string, number>();
    for (const day of git('log', '--format=%ad', '--date=short').split('\n')) {
      if (day) counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  } catch {
    return [];
  }
}

const MEET_CHANGELOG_MODULE = 'virtual:meet-changelog';
const MEET_CHANGELOG_RESOLVED = `\0${MEET_CHANGELOG_MODULE}`;

/**
 * The changelog as data (changelog/README.md): every release and every
 * update, for the /changelog page's filters. An update with no version waits
 * for the next release: the web deploys on every push, the apps when a
 * release is cut.
 */
export function meetChangelogPlugin(): Plugin {
  const updatesDir = path.join(repoDir, UPDATES_DIR);
  const releasesFile = path.join(repoDir, RELEASES_FILE);
  const source = () => `export const meetChangelog = ${JSON.stringify({ releases: readReleases(repoDir), updates: readUpdates(repoDir) })};\n`;
  return {
    name: 'meet-changelog',
    resolveId(id) {
      if (id === MEET_CHANGELOG_MODULE) return MEET_CHANGELOG_RESOLVED;
    },
    load(id) {
      if (id === MEET_CHANGELOG_RESOLVED) return source();
    },
    configureServer(server) {
      server.watcher.add([updatesDir, releasesFile]);
      const reload = (file: string) => {
        if (file !== releasesFile && !file.startsWith(updatesDir)) return;
        const mod = server.moduleGraph.getModuleById(MEET_CHANGELOG_RESOLVED);
        if (mod) void server.reloadModule(mod);
      };
      server.watcher.on('change', reload);
      server.watcher.on('add', reload);
      server.watcher.on('unlink', reload);
    },
  };
}

const MEET_HELP_MODULE = 'virtual:meet-help';
const MEET_HELP_RESOLVED = `\0${MEET_HELP_MODULE}`;

type HelpDoc = { path: string; slug: string; kind: string; status: string; verified: string; summary: string; surface?: string; capabilities: string[]; body: string };

/**
 * The product docs (`docs/help/` and `docs/help/howto/`) as one module for
 * the /help site, and `llms.txt` / `llms-full.txt` for
 * agents (docs/DOCUMENTATION.md decision 5). Intent and contract
 * docs stay out: they describe plans and internals, not the product.
 * Frontmatter is read by the same parser `pnpm docs:check` uses.
 */
async function readHelpDocs(): Promise<HelpDoc[]> {
  const parser = await import(path.join(repoDir, 'scripts', 'docs-frontmatter-parse.mjs')) as {
    readFrontmatter: (text: string) => { fields: Record<string, unknown> | null; body: string; errors: string[] };
  };
  const docsDir = path.join(repoDir, 'docs');
  const out: HelpDoc[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (name.endsWith('.md')) {
        const relPath = path.relative(repoDir, file);
        const { fields, body, errors } = parser.readFrontmatter(readFileSync(file, 'utf8'));
        if (!fields || errors.length > 0) throw new Error(`${relPath}: ${errors.join('; ') || 'no frontmatter'}`);
        // Product docs live under docs/help/ and docs/help/howto/; a runbook
        // elsewhere shares the kind and stays internal.
        if (!/^docs\/help\//u.test(relPath)) continue;
        if (fields.status !== 'active') continue;
        out.push({
          path: relPath,
          slug: relPath.replace(/^docs\/help\//u, '').replace(/\.md$/u, ''),
          kind: String(fields.kind),
          status: String(fields.status),
          verified: String(fields.verified),
          summary: String(fields.summary),
          ...(typeof fields.surface === 'string' ? { surface: fields.surface } : {}),
          capabilities: Array.isArray(fields.capabilities) ? fields.capabilities.map(String) : [],
          body: body.replace(/^\s+/u, ''),
        });
      }
    }
  };
  walk(docsDir);
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The home page's description, as its template writes it: the one source for the page's meta tag and its llms.txt line. */
function homeDescription(): string {
  const template = readFileSync(path.join(rootDir, 'marketing', 'index.html'), 'utf8');
  return /<meta name="description" content="([^"]*)"/u.exec(template)?.[1] ?? '';
}

function llmsIndex(docs: HelpDoc[], origin: string, tools: Array<{ name: string; summary: string }>, skills: Array<{ name: string; description: string }> = []): string {
  // The product site writes a markdown twin of every public page (marketing/prerender.mjs); each line links both.
  const site = origin === PRODUCT_SITE_ORIGIN;
  const twin = (pagePath: string) => (site ? ` ([markdown](${origin}${markdownTwinPath(pagePath)}))` : '');
  const lines = site ? ['# Starlings', '', '> One workspace for a team and its AI agents: calls, chat, tasks, docs and calendar, organized by project, on Mac, iOS and the web. Early access is open; self-serve workspaces are not available yet.', '', 'Every page below has a markdown twin at its address plus `.md` (the home page: `/index.md`), and answers `Accept: text/markdown` with it.', '', '## Product', '', `- [Starlings](${origin}/): ${homeDescription()}${twin('/')}`, ...PUBLIC_PAGES.filter((page) => !page.path.startsWith('/help')).map((page) => `- [${page.title}](${origin}${page.path}): ${page.description}${twin(page.path)}`), ...publishedFieldNotes.map((note) => `- [${note.title}](${origin}/field-notes/${note.slug}): ${note.description}${twin(`/field-notes/${note.slug}`)}`), ''] : ['# Starlings', '', `> ${PRODUCT_SUMMARY}`, ''];
  if (site) {
    // An agent can apply for its person (docs/FORMS.md §Agents); the form's twin is the guide.
    const form = SITE_FORM_PAGES.find((page) => page.path === INTEREST_PATH)!;
    lines.push('## Early access', '', `- [${form.title}](${origin}${form.path}): ${form.description}${twin(form.path)}`, `- For agents: follow ${origin}${INTEREST_GUIDE_PATH}, check the answers against ${origin}${INTEREST_SCHEMA_PATH}, and POST them to ${origin}${INTEREST_AGENT_API_PATH}. The person confirms from a mail before anything is filed.`, '');
  }
  for (const [kind, title] of [['reference', 'Surfaces'], ['howto', 'How-to']] as const) {
    lines.push(`## ${title}`, '');
    // Help pages are markdown at source, so both hosts serve their twin.
    for (const doc of docs.filter((d) => d.kind === kind)) lines.push(`- [${doc.slug}](${origin}/help/${doc.slug}): ${doc.summary} ([markdown](${origin}/help/${doc.slug}.md))`);
    lines.push('');
  }
  if (skills.length > 0) {
    lines.push('## For agents', '', `- [agents](${origin}/agents.md): how an agent works on subjects: the model, authority, approval, errors and the MCP tools`, `- [spec](${origin}/spec.md): the Starlings Subject Spec: subject kinds, doors and records; JSON Schema at ${origin}/spec/schema.json`, `- [conformance](${origin}/spec/conformance/cases.json): the conformance cases, with a zero-dependency runner at ${origin}/spec/conformance/run.mjs`, '');
    lines.push('## Skills', '', ...skills.map((skill) => `- [${skill.name}](${origin}/skills/${skill.name}/SKILL.md): ${skill.description}`), '');
  }
  lines.push('## Glossary', '', `- [glossary](${origin}/help/glossary): what each word means in Starlings, with its source${twin('/help/glossary')}`, '');
  lines.push('## Capabilities', '', `- [features/status](${origin}/workspace/status): every capability, where it works, and the door an agent has into it; the same rows are in llms-full.txt${twin('/workspace/status')}`, '');
  lines.push(
    '## Agent access',
    '',
    ...(origin === PRODUCT_SITE_ORIGIN ? ['- MCP is available within a workspace, with member authorization.'] : mcpPairingLines(origin)),
    `- OpenAPI 3.1: ${origin}/openapi.json (the internal routes wrapped by MCP)`,
    '- Door grammar: things use `subject:<kind>:<id>`, `person:<email>`, `agent:<email>`, `thread:<id>`, `document:<id>`, `event:<id>`, `task:<id>`, `issue:<owner>/<repo>#<number>` or `core:<id>`; places use `destination:<home|calendar|work|team|docs>`, `settings:<account|home|work|calendar>` or `verb:<new-task|new-issue|new-document|start-room|open-internal-room>`. `open` accepts thing doors only.',
    '- Agents never enter a room or read live meetings; they can read finalized artifacts after a meeting ends. Every MCP call is recorded.',
    '',
    '### MCP tools',
    '',
    ...tools.map(({ name, summary }) => `- ${name}: ${summary}`),
    '',
  );
  lines.push('## Changelog', '', `- [changelog](${origin}/changelog.md): every release, newest first, as markdown; the page is ${origin}/changelog`, '');
  lines.push(`Full text: ${origin}/llms-full.txt`, '');
  return lines.join('\n');
}

/**
 * The pages, then two appendices an agent cannot get from prose: the
 * capability registry (what works where, and the door an agent has into
 * it) and the glossary. Both come from `@starlings/contracts` at build time, so
 * llms-full.txt can never say something the app's own data does not. The
 * product site's build puts the product pages' twins in front of this
 * (marketing/prerender.mjs), since only the prerender can render them.
 */
async function llmsFull(docs: HelpDoc[], origin: string): Promise<string> {
  const pages = docs.map((doc) => `<!-- ${origin}/help/${doc.slug} · ${doc.kind} · verified ${doc.verified} -->\n${doc.body.trim()}\n`);
  const { CAPABILITIES_REVIEWED_AT } = await import('@starlings/contracts/capabilities');
  const capabilities = [
    `<!-- ${origin}/workspace/status · capability registry · reviewed ${CAPABILITIES_REVIEWED_AT} -->`,
    '# Capabilities',
    '',
    capabilityRegistryMarkdown(origin).trim(),
    '',
  ].join('\n');
  const glossary = [
    `<!-- ${origin}/help/glossary · glossary -->`,
    '# Glossary',
    '',
    glossaryMarkdown(),
  ].join('\n');
  return [...pages, capabilities, glossary].join('\n---\n\n');
}

export function meetHelpPlugin(origin = ORIGIN): Plugin {
  const docsDir = path.join(repoDir, 'docs');
  const source = async () => `export const helpDocs = ${JSON.stringify(await readHelpDocs())};\n`;
  return {
    name: 'meet-help',
    resolveId(id) {
      if (id === MEET_HELP_MODULE) return MEET_HELP_RESOLVED;
    },
    load(id) {
      if (id === MEET_HELP_RESOLVED) return source();
    },
    async generateBundle() {
      const docs = await readHelpDocs();
      const tools = await readMcpToolSummaries();
      const skills = origin === PRODUCT_SITE_ORIGIN ? (await readStandard()).skills : [];
      this.emitFile({ type: 'asset', fileName: 'llms.txt', source: llmsIndex(docs, origin, tools, skills) });
      this.emitFile({ type: 'asset', fileName: 'llms-full.txt', source: await llmsFull(docs, origin) });
    },
    configureServer(server) {
      server.watcher.add(docsDir);
      server.watcher.on('change', (file) => {
        if (!file.startsWith(docsDir)) return;
        const mod = server.moduleGraph.getModuleById(MEET_HELP_RESOLVED);
        if (mod) void server.reloadModule(mod);
      });
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/llms.txt' && req.url !== '/llms-full.txt') return next();
        const docs = await readHelpDocs();
        const tools = req.url === '/llms.txt' ? await readMcpToolSummaries() : [];
        const skills = req.url === '/llms.txt' && origin === PRODUCT_SITE_ORIGIN ? (await readStandard()).skills : [];
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(req.url === '/llms.txt' ? llmsIndex(docs, origin, tools, skills) : await llmsFull(docs, origin));
      });
    },
  };
}

const MEET_STANDARD_MODULE = 'virtual:meet-standard';
const MEET_STANDARD_RESOLVED = `\0${MEET_STANDARD_MODULE}`;

type StandardSkill = { name: string; description: string; title: string; body: string; source: string };
type StandardConformance = { passed: number; failed: number; cases: string; runner: string; adapter: string };
type StandardDocs = { agents: { title: string; body: string }; spec: { title: string; body: string; version: string; schema: Record<string, unknown>; conformance: StandardConformance }; skills: StandardSkill[]; tools: Array<{ name: string; summary: string }> };

/**
 * `standard/` (ADR 0005): the agent instructions and the portable skills the
 * product site publishes at /agents and /skills. The folder is the seed of
 * the public standard repo, so its files link to each other as files; the
 * site rewrites those links. The build fails when a skill's frontmatter is
 * wrong or an "On Starlings" table names an MCP tool that mcp.ts does not
 * define, so no page tells an agent to call a tool that is not there.
 */
export async function readStandard(): Promise<StandardDocs> {
  const standardDir = path.join(repoDir, 'standard');
  const tools = await readMcpToolSummaries();
  const toolNames = new Set(tools.map((tool) => tool.name));
  const title = (body: string, fallback: string) => /^#\s+(.+)\n/u.exec(body)?.[1]?.trim() ?? fallback;
  const skillsDir = path.join(standardDir, 'skills');
  const skills = readdirSync(skillsDir).filter((name) => statSync(path.join(skillsDir, name)).isDirectory()).sort().map((dir): StandardSkill => {
    const relPath = `standard/skills/${dir}/SKILL.md`;
    const source = readFileSync(path.join(skillsDir, dir, 'SKILL.md'), 'utf8');
    const match = /^---\n([\s\S]*?)\n---\n/u.exec(source);
    if (!match) throw new Error(`${relPath}: no frontmatter`);
    const fields = Object.fromEntries(match[1]!.split('\n').map((line) => /^([a-z-]+):\s*(.+)$/u.exec(line)).filter((m): m is RegExpExecArray => m !== null).map((m) => [m[1]!, m[2]!.trim()]));
    if (fields.name !== dir) throw new Error(`${relPath}: frontmatter name "${fields.name}" must equal the folder name "${dir}"`);
    if (!fields.description) throw new Error(`${relPath}: frontmatter needs a description`);
    const body = source.slice(match[0].length).replace(/^\s+/u, '');
    const onStarlings = body.split(/^## On Starlings$/mu)[1]?.split(/^## /mu)[0] ?? '';
    for (const row of onStarlings.split('\n').filter((line) => line.startsWith('|')).slice(2)) {
      const tool = /`([a-z_]+)`/u.exec(row.split('|').slice(-2, -1)[0] ?? '')?.[1];
      if (!tool || !toolNames.has(tool)) throw new Error(`${relPath}: "On Starlings" row names "${tool ?? 'no tool'}", which services/control-plane/src/mcp.ts does not define`);
    }
    return { name: dir, description: fields.description, title: title(body, dir), body, source };
  });
  // AGENTS.md lists the skills in the order an agent uses them; that list is the order, and it must name every skill.
  const agentsBody = readFileSync(path.join(standardDir, 'AGENTS.md'), 'utf8');
  const order = [...(agentsBody.split(/^## Skills$/mu)[1]?.split(/^## /mu)[0] ?? '').matchAll(/\(\/skills\/([a-z0-9-]+)\)/gu)].map((m) => m[1]!);
  const unlisted = skills.filter((skill) => !order.includes(skill.name)).map((skill) => skill.name);
  if (unlisted.length > 0) throw new Error(`standard/AGENTS.md: the Skills list does not name ${unlisted.join(', ')}`);
  skills.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  const { SPEC_VERSION, standardJsonSchema } = await import('@starlings/subject-spec');
  const specBody = readFileSync(path.join(standardDir, 'SPEC.md'), 'utf8');
  if (!specBody.includes(`Version ${SPEC_VERSION}.`)) throw new Error(`standard/SPEC.md: §Status must say "Version ${SPEC_VERSION}." to match SPEC_VERSION in standard/src/index.ts`);
  // The published suite, and the reference implementation's own result on it: the page never claims a pass the build did not see.
  const conformanceDir = path.join(standardDir, 'conformance');
  const casesText = readFileSync(path.join(conformanceDir, 'cases.json'), 'utf8');
  const { runConformance } = await import(path.join(conformanceDir, 'run.mjs'));
  const reference = (await import(path.join(conformanceDir, 'reference-adapter.mjs'))).default;
  const result = runConformance(JSON.parse(casesText), reference);
  if (result.failed > 0) throw new Error(`standard/conformance: the reference implementation fails ${result.failed} case(s): ${result.failures.join('; ')}`);
  const conformance = { passed: result.passed, failed: result.failed, cases: casesText, runner: readFileSync(path.join(conformanceDir, 'run.mjs'), 'utf8'), adapter: readFileSync(path.join(conformanceDir, 'reference-adapter.mjs'), 'utf8') };
  const spec = { title: title(specBody, 'Spec'), body: specBody, version: SPEC_VERSION, schema: standardJsonSchema(`${PRODUCT_SITE_ORIGIN}/spec/schema.json`, SPEC_VERSION), conformance };
  return { agents: { title: title(agentsBody, 'Agents'), body: agentsBody }, spec, skills, tools };
}

export function meetStandardPlugin(): Plugin {
  const standardDir = path.join(repoDir, 'standard');
  return {
    name: 'meet-standard',
    resolveId(id) {
      if (id === MEET_STANDARD_MODULE) return MEET_STANDARD_RESOLVED;
    },
    async load(id) {
      if (id === MEET_STANDARD_RESOLVED) return `export const standard = ${JSON.stringify(await readStandard())};\n`;
    },
    configureServer(server) {
      server.watcher.add(standardDir);
      server.watcher.on('change', (file) => {
        if (!file.startsWith(standardDir)) return;
        const mod = server.moduleGraph.getModuleById(MEET_STANDARD_RESOLVED);
        if (mod) void server.reloadModule(mod);
      });
    },
  };
}

const MEET_VERSION_MODULE = 'virtual:meet-version';
const MEET_VERSION_RESOLVED = `\0${MEET_VERSION_MODULE}`;

/** Re-read VERSION on each load so a long-lived Vite process cannot stamp 0.5.0 forever. */
export function meetVersionPlugin(): Plugin {
  const versionFile = path.join(repoDir, 'VERSION');
  const gitHead = path.join(repoDir, '.git', 'HEAD');
  const source = () => {
    const { version, build } = resolveMeetBuild();
    return [
      `export const meetVersion = ${JSON.stringify(version)};`,
      `export const meetBuild = ${JSON.stringify(build)};`,
      `export const meetActivity = ${JSON.stringify(resolveMeetActivity())};`,
      '',
    ].join('\n');
  };
  return {
    name: 'meet-version',
    resolveId(id) {
      if (id === MEET_VERSION_MODULE) return MEET_VERSION_RESOLVED;
    },
    load(id) {
      if (id === MEET_VERSION_RESOLVED) return source();
    },
    configureServer(server) {
      for (const file of [versionFile, gitHead]) {
        if (existsSync(file)) server.watcher.add(file);
      }
      server.watcher.on('change', (file) => {
        if (file !== versionFile && file !== gitHead) return;
        const mod = server.moduleGraph.getModuleById(MEET_VERSION_RESOLVED);
        if (mod) void server.reloadModule(mod);
      });
    },
  };
}

/**
 * The selfie-segmentation model MediaPipe loads at runtime. `@mediapipe/tasks-vision`
 * ships the wasm but not the weights, so we fetch once at build time and cache
 * outside `public/` (which is gitignored and rewritten on every build).
 */
const SEGMENTER_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';
const SEGMENTER_MODEL_FILE = 'selfie_segmenter.tflite';
/** Sanity floor — a truncated or error-page download must not ship as a model. */
const SEGMENTER_MIN_BYTES = 100_000;

/**
 * LiveKit background processors load MediaPipe's `vision_wasm_internal.js` as a
 * classic script, and the segmenter fetches its `.tflite` weights over the
 * network. Production CSP is `script-src 'self'`, so the default CDN URL
 * is blocked and setProcessor rejects with a bare Event ("Background effect failed.").
 *
 * Both halves ship from our origin instead: the wasm copied out of node_modules,
 * the model fetched once into a build cache. That keeps turning blur on from
 * depending on jsdelivr or storage.googleapis.com being reachable mid-call, and
 * lets the CSP drop both hosts.
 */
function mediapipeAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const dest = path.join(rootDir, 'public', 'mediapipe');
  const cacheDir = path.join(rootDir, 'node_modules', '.cache', 'mediapipe');
  const cachedModel = path.join(cacheDir, SEGMENTER_MODEL_FILE);

  const syncWasm = () => {
    const entry = require.resolve('@mediapipe/tasks-vision');
    const source = path.join(path.dirname(entry), 'wasm');
    if (!existsSync(source)) {
      throw new Error(`MediaPipe wasm assets missing at ${source}`);
    }
    mkdirSync(path.join(dest, 'wasm'), { recursive: true });
    cpSync(source, path.join(dest, 'wasm'), { recursive: true });
  };

  const syncModel = async () => {
    if (!existsSync(cachedModel) || statSync(cachedModel).size < SEGMENTER_MIN_BYTES) {
      const response = await fetch(SEGMENTER_MODEL_URL);
      if (!response.ok) {
        throw new Error(
          `Could not download the MediaPipe segmenter model (${response.status}). `
            + `Retry with a network connection, or place the file at ${cachedModel}.`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength < SEGMENTER_MIN_BYTES) {
        throw new Error(`Downloaded segmenter model is implausibly small (${bytes.byteLength} bytes).`);
      }
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cachedModel, bytes);
    }
    mkdirSync(dest, { recursive: true });
    copyFileSync(cachedModel, path.join(dest, SEGMENTER_MODEL_FILE));
  };

  const sync = async () => {
    syncWasm();
    await syncModel();
  };

  return {
    name: 'mediapipe-assets',
    buildStart: sync,
    async configureServer() {
      await sync();
    },
  };
}

/**
 * Packages that must stay off the guest entry path. shadcn's
 * Button is allowed there (MZ, 2026-09-24): it needs Radix's Slot and its
 * compose-refs helper, so those two are the exception; every other Radix
 * primitive, cmdk, sonner, react-day-picker and recharts load with a lazy
 * surface.
 */
const GUEST_ENTRY_FORBIDDEN = /[\\/]node_modules[\\/](?:\.pnpm[\\/])?(?:@radix-ui[\\/+](?!react-slot|react-compose-refs)|(?:cmdk|sonner|react-day-picker|recharts)[\\/+@])/u;

/**
 * `main.tsx` imports App dynamically so the page's strings are in place
 * before any module builds a label table (src/i18n). Left alone, that costs
 * a guest a second round trip: entry first, App after. Preloading the App
 * chunk from index.html fetches both at once, and the entry budget counts
 * it again, as it should.
 */
function preloadAppChunk(): Plugin {
  const preload: string[] = [];
  return {
    name: 'meet-preload-app-chunk',
    apply: 'build',
    generateBundle(_options, bundle) {
      const app = Object.entries(bundle).find(([, output]) => output.type === 'chunk' && output.facadeModuleId?.endsWith('/src/App.tsx'));
      if (!app) return;
      // App and every chunk it imports statically, the set Vite would have
      // preloaded had App stayed a static import of the entry.
      const seen = new Set<string>();
      const walk = (fileName: string) => {
        if (seen.has(fileName)) return;
        seen.add(fileName);
        const output = bundle[fileName];
        if (output?.type === 'chunk') for (const dep of output.imports) walk(dep);
      };
      walk(app[0]);
      preload.push(...seen);
      // A guest pays for the entry and this set before the meeting chunk.
      // The shadcn components (Radix, and what they pull in) belong to lazy
      // surfaces only. A static import from App or the entry
      // fails the build here instead of quietly growing the guest's load.
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'chunk' && output.isEntry) walk(fileName);
      }
      for (const fileName of seen) {
        const output = bundle[fileName];
        if (output?.type !== 'chunk') continue;
        const leak = output.moduleIds.find((id) => GUEST_ENTRY_FORBIDDEN.test(id));
        if (leak) this.error(`${leak} is on the guest entry path (${fileName}). Import it from a lazy surface.`);
      }
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const already = new Set([...html.matchAll(/href="\/(assets\/[^"]+)"/gu)].map((m) => m[1]));
        const links = preload.filter((f) => !already.has(f)).map((f) => `  <link rel="modulepreload" crossorigin href="/${f}">`);
        return links.length ? html.replace('</head>', `${links.join('\n')}\n  </head>`) : html;
      },
    },
  };
}

export default defineConfig({
  resolve: {
    // The shadcn components import from `@/` (web/components.json).
    alias: { '@': path.join(rootDir, 'src') },
  },
  plugins: [react(), tailwindcss(), mediapipeAssets(), meetVersionPlugin(), meetChangelogPlugin(), meetHelpPlugin(), preloadAppChunk()],
  build: {
    rollupOptions: {
      treeshake: {
        // `@starlings/contracts` defines every wire shape as a zod schema, and the
        // browser imports most of them for their types only. Every `z.*`
        // factory is pure, so a schema nobody calls is dropped whole instead
        // of leaving its field builders behind as statements (measured in
        // scripts/check-web-entry-budget.mjs).
        manualPureFunctions: ['z'],
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/.well-known/meet': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/workspace-background': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
        ws: true,
      },
    },
  },
});

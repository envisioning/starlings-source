// The changelog as one file per update (changelog/README.md, and the schema
// in packages/contracts/src/changelog.ts).
//
// `changelog/updates/<id>.md` holds one update: a flat frontmatter block, then
// the update's Markdown. An update with no `version` waits for the next
// release. `changelog/releases.json` lists the releases, newest first.
// CHANGELOG.md is generated from both and never edited by hand.
//
// This module is the one reader. The CLI (`assemble-changelog.mjs`), the web
// build (`web/vite.config.ts`, the two prerender scripts) and the tests use it.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// The contract imports its sibling without an extension, as contracts do;
// this resolver lets plain Node follow it.
import './node-ts-resolve.mjs';

const {
  changelogReleaseOrder,
  changelogReleasesSchema,
  changelogUpdateSchema,
} = await import('../packages/contracts/src/changelog.ts');

export const UPDATES_DIR = 'changelog/updates';
export const RELEASES_FILE = 'changelog/releases.json';
/** Where fragments lived until 2026-10-06. A file there is refused. */
export const LEGACY_DIR = 'changelog.d';
export const NEXT_HEADING = '## Next release';
export const NEXT_NOTE = 'On the web now. In the Mac and iPhone apps with the next release.';
const FIELDS = ['id', 'date', 'version', 'area', 'kind', 'refs'];

/** The refs an update's text cites, in order, once each: ``. */
export function refsIn(body) {
  return [...new Set(body.match(/\b[a-z][a-z0-9-]*#\d+\b/gu) ?? [])];
}

/** One update as its file's text. */
export function serializeUpdate(update) {
  const lines = ['---'];
  for (const field of FIELDS) {
    const value = update[field];
    if (value === undefined) continue;
    lines.push(`${field}: ${Array.isArray(value) ? `[${value.join(', ')}]` : value}`);
  }
  lines.push('---', '', update.body.replace(/\s+$/u, ''), '');
  return lines.join('\n');
}

/** One update file's text, checked against the schema. Throws with the reason. */
export function parseUpdate(name, text) {
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/u.exec(text);
  if (!match) throw new Error(`${name}: starts with a --- frontmatter block`);
  const fields = {};
  for (const line of match[1].split('\n')) {
    const pair = /^([a-z]+): ?(.*)$/u.exec(line);
    if (!pair) throw new Error(`${name}: "${line}" is not "field: value"`);
    const [, key, raw] = pair;
    if (key === 'refs') {
      const list = /^\[(.*)\]$/u.exec(raw);
      if (!list) throw new Error(`${name}: refs is a list, [meet#1, meet#2]`);
      fields.refs = list[1].split(',').map((ref) => ref.trim()).filter(Boolean);
    } else if (raw !== '') {
      fields[key] = raw;
    }
  }
  const result = changelogUpdateSchema.safeParse({ ...fields, body: match[2].replace(/\s+$/u, '') });
  if (!result.success) {
    throw new Error(`${name}: ${result.error.issues.map((issue) => `${issue.path.join('.') || 'file'} ${issue.message}`).join('; ')}`);
  }
  if (`${result.data.id}.md` !== name) throw new Error(`${name}: id is ${result.data.id}; the file is <id>.md`);
  if (result.data.body.startsWith('- ')) throw new Error(`${name}: the body is the update's text, without a "- " list marker`);
  return result.data;
}

/** Every update in a checkout, and why any file could not be read. */
export function loadUpdates(repoDir) {
  const dir = path.join(repoDir, UPDATES_DIR);
  const updates = [];
  const problems = [];
  if (!existsSync(dir)) return { updates, problems };
  for (const name of readdirSync(dir).filter((file) => !file.startsWith('.')).sort()) {
    try {
      updates.push(parseUpdate(name, readFileSync(path.join(dir, name), 'utf8')));
    } catch (error) {
      problems.push(`${UPDATES_DIR}/${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { updates, problems };
}

/** Every update in a checkout. Throws when a file is malformed. */
export function readUpdates(repoDir) {
  const { updates, problems } = loadUpdates(repoDir);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return updates;
}

export function readReleases(repoDir) {
  return changelogReleasesSchema.parse(JSON.parse(readFileSync(path.join(repoDir, RELEASES_FILE), 'utf8')));
}

/** The updates no release has taken yet, newest first. */
export function waitingUpdates(updates) {
  return updates.filter((update) => !update.version).sort(changelogReleaseOrder);
}

/** One update as a CHANGELOG.md bullet: continuation lines take two spaces. */
export function updateBullet(update) {
  return `- ${update.body.split('\n').map((line, index) => (index === 0 || line === '' ? line : `  ${line}`)).join('\n')}`;
}

/** The released updates as CHANGELOG.md. */
export function renderChangelog(releases, updates) {
  const byVersion = new Map(releases.map((release) => [release.version, []]));
  for (const update of updates) {
    if (!update.version) continue;
    const list = byVersion.get(update.version);
    if (!list) throw new Error(`${UPDATES_DIR}/${update.id}.md: version ${update.version} is not in ${RELEASES_FILE}`);
    list.push(update);
  }
  const sections = releases.map((release) => {
    const list = byVersion.get(release.version).sort(changelogReleaseOrder);
    const parts = [`## ${release.version} — ${release.date}`];
    if (release.summary) parts.push(release.summary);
    if (list.length > 0) parts.push(list.map(updateBullet).join('\n'));
    return parts.join('\n\n');
  });
  return `# Changelog\n\n${sections.join('\n\n')}\n`;
}

/**
 * CHANGELOG.md as the web shows it: the waiting updates first, under "Next
 * release", because the web deploys on every push and the apps do not.
 */
export function changelogWithNext(repoDir) {
  const updates = readUpdates(repoDir);
  const changelog = renderChangelog(readReleases(repoDir), updates);
  const waiting = waitingUpdates(updates);
  if (waiting.length === 0) return changelog;
  const next = `${NEXT_HEADING}\n\n${NEXT_NOTE}\n\n${waiting.map(updateBullet).join('\n')}`;
  return changelog.replace(/^# Changelog\n\n/u, `# Changelog\n\n${next}\n\n`);
}

/** Why the changelog in a checkout is not as it should be; empty when it is. */
export function changelogProblems(repoDir) {
  const legacy = path.join(repoDir, LEGACY_DIR);
  const problems = [];
  if (existsSync(legacy)) {
    for (const name of readdirSync(legacy)) {
      problems.push(`${LEGACY_DIR}/${name}: fragments moved to ${UPDATES_DIR}/, one file per update with area and kind (changelog/README.md)`);
    }
  }
  const { updates, problems: fileProblems } = loadUpdates(repoDir);
  problems.push(...fileProblems);
  if (fileProblems.length > 0) return problems;
  let rendered;
  try {
    rendered = renderChangelog(readReleases(repoDir), updates);
  } catch (error) {
    return [...problems, error instanceof Error ? error.message : String(error)];
  }
  const changelogFile = path.join(repoDir, 'CHANGELOG.md');
  if (!existsSync(changelogFile) || readFileSync(changelogFile, 'utf8') !== rendered) {
    problems.push(`CHANGELOG.md is generated from ${UPDATES_DIR}/ and does not match it. Run: node scripts/assemble-changelog.mjs --write`);
  }
  return problems;
}

/** Patch step with single-digit minor and patch: 6.6.9 → 6.7.0, 6.9.9 → 7.0.0. */
export function nextVersion(version) {
  const match = /^(\d+)\.(\d)\.(\d)$/u.exec(version.trim());
  if (!match) throw new Error(`VERSION must look like 1.2.3 with single-digit minor and patch (got '${version.trim()}')`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (patch < 9) return `${major}.${minor}.${patch + 1}`;
  if (minor < 9) return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

/**
 * Give every waiting update the next version, add that release, and write
 * CHANGELOG.md and VERSION. Returns the new version. Nothing is written when
 * a file is malformed or nothing waits.
 */
export function release(repoDir, date) {
  const problems = changelogProblems(repoDir);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const updates = readUpdates(repoDir);
  const waiting = waitingUpdates(updates);
  if (waiting.length === 0) throw new Error(`no update in ${UPDATES_DIR}/ waits for a release: nothing to release`);
  const versionFile = path.join(repoDir, 'VERSION');
  const version = nextVersion(readFileSync(versionFile, 'utf8'));
  const releases = [{ version, date }, ...readReleases(repoDir)];
  for (const update of waiting) {
    update.version = version;
    writeFileSync(path.join(repoDir, UPDATES_DIR, `${update.id}.md`), serializeUpdate(update));
  }
  writeFileSync(path.join(repoDir, RELEASES_FILE), `${JSON.stringify(releases, null, 2)}\n`);
  writeFileSync(path.join(repoDir, 'CHANGELOG.md'), renderChangelog(releases, updates));
  writeFileSync(versionFile, `${version}\n`);
  return version;
}

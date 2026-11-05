import { standard } from 'virtual:meet-standard';
import { DocumentMarkdown } from '@shared/document-markdown';
import { DocArticle, DocNote } from '@shared/DocArticle';
import { AppShell } from './SiteChrome';
import { PageCrumb } from './PageCrumb';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { useDocumentTitle } from './document-title';
import { standardLinks } from '../../agent-surface';

/**
 * /agents and /skills — the open standard's agent pages (ADR 0005), rendered
 * from `standard/`. The same files are served beside each page as markdown,
 * and a skill also as its raw `SKILL.md`, so an agent installs exactly what
 * a person reads here.
 */

type Skill = (typeof standard.skills)[number];

/** Skill links become wikilinks: the markdown parser follows only absolute URLs. */
const siteLinks = (body: string) => standardLinks(body, (name, label) => `[[skills/${name}|${label}]]`);
const resolveSiteLink = (target: string) => `/${target}`;

/** The page's own `# Title` line removed; the page draws its title. */
const withoutTitle = (body: string) => body.replace(/^#\s+.+\n/u, '');

export function AgentsPage() {
  useDocumentTitle(standard.agents.title);
  return (
    <AppShell variant="document" current="agents">
      <DocArticle>
        <h1>{standard.agents.title}</h1>
        <DocumentMarkdown text={siteLinks(withoutTitle(standard.agents.body))} resolveWikilink={resolveSiteLink} />
        <section>
          <h2>MCP tools</h2>
          <p>This list comes from the server's own tool list when the site is built.</p>
          <ul className="m-0 list-none ps-0">
            {standard.tools.map((tool) => (
              <li key={tool.name} className="mt-0 grid grid-cols-[minmax(8rem,12rem)_1fr] gap-x-4 gap-y-1 border-t border-foreground/8 py-2 first:border-t-0 max-sm:grid-cols-1">
                <code>{tool.name}</code>
                <span className="block font-light text-muted-foreground">{tool.summary}</span>
              </li>
            ))}
          </ul>
        </section>
        <DocNote>
          Spec: <a href="/spec">/spec</a> · Markdown: <a href="/agents.md">/agents.md</a> · Source: <code>standard/AGENTS.md</code> · Apache-2.0
        </DocNote>
      </DocArticle>
    </AppShell>
  );
}

type JsonSchema = { type?: string; enum?: string[]; pattern?: string; description?: string; $ref?: string; anyOf?: JsonSchema[]; maxLength?: number; properties?: Record<string, JsonSchema>; required?: string[] };

/** A field's type in one line: a reference by name, an enum's values, or the JSON type. */
function typeOf(schema: JsonSchema): string {
  if (schema.$ref) return schema.$ref.replace('#/$defs/', '');
  if (schema.anyOf) return schema.anyOf.map(typeOf).join(' or ');
  if (schema.enum) return schema.enum.map((value) => `"${value}"`).join(' | ');
  return schema.type ?? 'any';
}

export function SpecPage() {
  const { spec } = standard;
  useDocumentTitle(spec.title);
  const defs = Object.entries((spec.schema.$defs ?? {}) as Record<string, JsonSchema>);
  return (
    <AppShell variant="document" current="spec">
      <DocArticle>
        <h1>{spec.title}</h1>
        <p className="-mt-2 text-sm text-muted-foreground">Version {spec.version}</p>
        <DocumentMarkdown text={siteLinks(withoutTitle(spec.body))} resolveWikilink={resolveSiteLink} />
        {defs.map(([name, def]) => (
          <section key={name} id={name}>
            <h3><code>{name}</code></h3>
            {def.description && <p>{def.description}</p>}
            {def.properties ? (
              <Table>
                <TableHeader><TableRow><TableHead>Field</TableHead><TableHead>Type</TableHead><TableHead>Description</TableHead></TableRow></TableHeader>
                <TableBody>
                  {Object.entries(def.properties).map(([field, schema]) => (
                    <TableRow key={field}>
                      <TableCell className="align-top whitespace-normal"><code>{field}</code>{def.required?.includes(field) ? '' : ' (optional)'}</TableCell>
                      <TableCell className="align-top whitespace-normal"><code>{typeOf(schema)}</code>{schema.maxLength ? `, at most ${schema.maxLength} characters` : ''}</TableCell>
                      <TableCell className="align-top whitespace-normal">{schema.description ?? ''}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p><code>{def.pattern ? `pattern ${def.pattern}` : typeOf(def)}</code></p>
            )}
          </section>
        ))}
        <section id="conformance-result">
          <h2>Conformance result</h2>
          <p>The reference implementation passes {spec.conformance.passed} of {spec.conformance.passed + spec.conformance.failed} checks in this version's suite. The build runs the suite and stops when a check fails.</p>
          <p>Download: <a href="/spec/conformance/cases.json" download="cases.json">cases.json</a> · <a href="/spec/conformance/run.mjs" download="run.mjs">run.mjs</a> · <a href="/spec/conformance/reference-adapter.mjs" download="reference-adapter.mjs">reference-adapter.mjs</a></p>
        </section>
        <DocNote>
          JSON Schema: <a href="/spec/schema.json" download="starlings-subject-spec.schema.json">/spec/schema.json</a> · Markdown: <a href="/spec.md">/spec.md</a> · Source: <code>standard/SPEC.md</code>, <code>standard/src/schema.ts</code> · Apache-2.0
        </DocNote>
      </DocArticle>
    </AppShell>
  );
}

export function SkillsPage({ name }: { name: string | null }) {
  if (name === null) return <SkillsIndex />;
  const skill = standard.skills.find((row) => row.name === name);
  return skill ? <SkillPage skill={skill} /> : <SkillMissing name={name} />;
}

function SkillsIndex() {
  useDocumentTitle('Skills');
  return (
    <AppShell variant="document" current="skills">
      <DocArticle>
        <h1>Skills</h1>
        <p className="lede">Skills that teach an agent how to work on a subject. Each one works in any workspace that holds subjects, Starlings included.</p>
        <ul className="m-0 list-none ps-0">
          {standard.skills.map((skill) => (
            <li key={skill.name} className="mt-0 grid grid-cols-[minmax(8rem,14rem)_1fr] gap-x-4 gap-y-1 border-t border-foreground/8 py-2 first:border-t-0 max-sm:grid-cols-1">
              <a href={`/skills/${skill.name}`}>{skill.title}</a>
              <span className="block font-light text-muted-foreground">{skill.description}</span>
            </li>
          ))}
        </ul>
        <section>
          <h2>Install</h2>
          <p>In Claude Code, install all five as one plugin:</p>
          <pre><code>{'claude plugin marketplace add envisioning/starlings-subject-spec\nclaude plugin install starlings-skills@starlings'}</code></pre>
          <p>For another agent, each skill is a folder with one <code>SKILL.md</code>, in the Agent Skills format. Download the file into your agent's skills folder, for example <code>~/.claude/skills/&lt;name&gt;/SKILL.md</code>. The rules behind them are on the <a href="/agents">For agents</a> page.</p>
        </section>
        <DocNote>Source: <code>standard/skills/</code> · Apache-2.0</DocNote>
      </DocArticle>
    </AppShell>
  );
}

function SkillPage({ skill }: { skill: Skill }) {
  useDocumentTitle(skill.title);
  return (
    <AppShell variant="document" current="skills">
      <DocArticle>
        <PageCrumb href="/skills" parent="Skills" page={skill.title} />
        <h1>{skill.title}</h1>
        <p className="lede">{skill.description}</p>
        <DocumentMarkdown text={siteLinks(withoutTitle(skill.body))} resolveWikilink={resolveSiteLink} />
        <DocNote>
          Install: <a href={`/skills/${skill.name}/SKILL.md`} download="SKILL.md">SKILL.md</a> · Source: <code>standard/skills/{skill.name}/SKILL.md</code> · Apache-2.0
        </DocNote>
      </DocArticle>
    </AppShell>
  );
}

function SkillMissing({ name }: { name: string }) {
  useDocumentTitle('Skills');
  return (
    <AppShell variant="document" current="skills">
      <DocArticle>
        <PageCrumb href="/skills" parent="Skills" page="No skill here." />
        <h1>No skill here.</h1>
        <p className="lede"><code>{name}</code> is not a skill. <a href="/skills">All skills</a>.</p>
      </DocArticle>
    </AppShell>
  );
}

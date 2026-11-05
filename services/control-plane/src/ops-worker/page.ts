// How the console asks each workspace and service (docs/OPS_CONSOLE.md), and
// the shared document for its server-rendered pages, Costs and Requests.
// Each workspace is asked on its own with a time limit, so one workspace that
// fails gives an error row and never a blank page.
import { formatOpsTime, OPS_PAGES, opsServiceMetadataSchema, opsWorkspaceMetadataSchema, type OpsServiceMetadata, type OpsWorkspaceMetadata } from '@starlings/contracts/ops';
import { opsTokensCSS } from '@starlings/contracts/ops-theme';
import type { FleetService, FleetWorkspace } from './fleet';

export const WORKSPACE_TIMEOUT_MS = 5_000;

export type WorkspaceRow =
  | { workspace: FleetWorkspace; ok: true; metadata: OpsWorkspaceMetadata }
  | { workspace: FleetWorkspace; ok: false; error: string };

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Ask one workspace. Never throws: a failure is an error row. */
export async function readWorkspace(workspace: FleetWorkspace, timeoutMs = WORKSPACE_TIMEOUT_MS): Promise<WorkspaceRow> {
  try {
    const answer = await withTimeout(Promise.resolve().then(() => workspace.service.metadata()), timeoutMs);
    const metadata = opsWorkspaceMetadataSchema.parse(answer);
    if (metadata.slug !== null && metadata.slug !== workspace.slug) {
      return { workspace, ok: false, error: `the binding reaches ${metadata.slug}` };
    }
    return { workspace, ok: true, metadata };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { workspace, ok: false, error: message.slice(0, 200) || 'no answer' };
  }
}

export type ServiceRow =
  | { service: FleetService; ok: true; metadata: OpsServiceMetadata }
  | { service: FleetService; ok: false; error: string };

/** Ask one workspace's Docs or Keep. Never throws: a failure is an error row. */
export async function readService(service: FleetService, timeoutMs = WORKSPACE_TIMEOUT_MS): Promise<ServiceRow> {
  try {
    const answer = await withTimeout(Promise.resolve().then(() => service.service.metadata()), timeoutMs);
    const metadata = opsServiceMetadataSchema.parse(answer);
    if (metadata.service !== service.kind) return { service, ok: false, error: `the binding reaches ${metadata.service}` };
    return { service, ok: true, metadata };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { service, ok: false, error: message.slice(0, 200) || 'no answer' };
  }
}

export const escapeHTML = (value: string) =>
  value.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);

/** `2026-10-04 13:05 UTC`. The 24-hour clock (AGENTS.md invariant 20). */
export const formatUTC = formatOpsTime;

/**
 * The server pages' own rules. Every colour, the type and the radius are the
 * console's tokens (`@starlings/contracts/ops-theme`, the dashboard's source too;
 * MZ, 2026-10-06): these pages stay server HTML and take only the
 * tokens from the kit. `sm` and `md` are the kit's radius steps
 * (web/src/ui-theme.css). No colour literal here.
 */
const OPS_RULES = `body { margin: 0 auto; max-width: 1080px; padding: 24px 16px; background: var(--ui-background); color: var(--ui-foreground); font: 14px/1.4 var(--ui-font-sans); -webkit-font-smoothing: antialiased; }
h1 { font-size: 18px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 24px 0 8px; }
h3 { font-size: 14px; margin: 0 0 8px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.cards .card { margin: 0; }
dl.counts { display: grid; grid-template-columns: 1fr auto; gap: 4px 16px; margin: 0; }
dl.counts div { display: contents; }
dl.counts dt { color: var(--ui-muted-foreground); }
dl.counts dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
p { margin: 0 0 16px; color: var(--ui-muted-foreground); }
.wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 720px; }
th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--ui-border); vertical-align: top; }
th { font-weight: 600; color: var(--ui-muted-foreground); }
.num { text-align: right; }
.muted { color: var(--ui-muted-foreground); }
.ok { color: var(--ui-ok); }
.warn { color: var(--ui-warn); }
.error { color: var(--ui-destructive); }
a { color: inherit; }
code { font: 12px var(--ui-font-mono); }
button, input, textarea { font: inherit; color: inherit; }
input, textarea { background: var(--ui-background); border: 1px solid var(--ui-input); border-radius: calc(var(--ui-radius) - 4px); padding: 6px 8px; }
input:focus-visible, textarea:focus-visible, button:focus-visible { outline: 2px solid var(--ui-ring); outline-offset: 1px; }
textarea { width: 100%; min-height: 3em; box-sizing: border-box; }
button { background: var(--ui-primary); color: var(--ui-primary-foreground); border: 0; border-radius: calc(var(--ui-radius) - 4px); padding: 6px 12px; cursor: pointer; }
button:hover { background: var(--accent-cta-hover); }
button.secondary { background: transparent; color: var(--ui-foreground); border: 1px solid var(--ui-border); }
button.secondary:hover { background: var(--hover-lift); border-color: var(--hover-border); }
nav { display: flex; gap: 16px; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--ui-border); }
nav a { text-decoration: none; color: var(--ui-muted-foreground); }
nav a[aria-current="page"] { color: var(--ui-foreground); font-weight: 600; }
form.inline { display: inline-flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.card { background: var(--ui-card); color: var(--ui-card-foreground); border: 1px solid var(--ui-border); border-radius: calc(var(--ui-radius) - 2px); padding: 12px 16px; margin: 0 0 12px; }
.swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; vertical-align: -1px; border: 1px solid var(--ui-border); }
dl.fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px 16px; margin: 0 0 12px; }
dl.fields dt { color: var(--ui-muted-foreground); font-size: 12px; }
dl.fields dd { margin: 0; }
.card h3 code { font-weight: 400; }
form.inline + .wrap { margin-top: 8px; }
pre { white-space: pre-wrap; font: 12px var(--ui-font-mono); background: var(--ui-muted); padding: 8px; border-radius: calc(var(--ui-radius) - 4px); }
`;

const OPS_CSS = `${opsTokensCSS()}${OPS_RULES}`;

/** A server-rendered page's document: one stylesheet, no script, the pages in the nav. */
export function opsDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Starlings ops: ${escapeHTML(title)}</title>
<style>
${OPS_CSS}</style>
</head>
<body>
<nav>${OPS_PAGES.map(({ href, label }) => `<a href="${href}"${label === title ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
${body}
</body>
</html>
`;
}

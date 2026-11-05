// The capability registry is data other pages and agents trust (docs/DOCUMENTATION.md,
// meet#267). Every row parses, every id is unique, and every doc a row names exists.
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, CAPABILITY_SECTIONS, agentDoorsSchema, capabilityById, capabilitySchema, capabilitySections, hasAgentDoor, surfaceSections, type CapabilitySurface, type SurfaceStatus } from '@starlings/contracts/capabilities';
import { settingsPages, type SettingsClient } from '@starlings/contracts/settings-pages';
import { SUBJECT_CONTEXT_CLIENTS, SUBJECT_CONTEXT_NOT_ON } from '@starlings/contracts/subject-context';
import { WORK_ROW_ACTION_CLIENTS } from '@starlings/contracts/work-actions';

// Keys are paths relative to this file; a row's `doc` is relative to the repo root.
const docs = new Set(Object.keys(import.meta.glob('../../docs/**/*.md')).map((key) => key.replace(/^\.\.\/\.\.\//u, '')));
// The Worker's router, as text: a route a row names must be one it matches. The router is the
// route table's families (`routes/*.ts`) and the branches in `index.ts` that have not moved there.
const router = Object.values(import.meta.glob(
  ['../../services/control-plane/src/index.ts', '../../services/control-plane/src/routes/*.ts'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>).join('\n');
// The `starlings` parser, as text: a verb a row names must be a `case` it accepts.
const cli = Object.values(import.meta.glob('../../CLI/StarlingsCLI.swift', { query: '?raw', import: 'default', eager: true }) as Record<string, string>).join('\n');
const routerMarkers: Record<string, string> = {
  // These paths are dispatched after stripping their owner-specific prefix.
  '/api/rooms/:slug/meetings': "path: '/api/rooms/:slug/meetings'",
  // A table row spells its dynamic segments by name.
  '/api/threads/:id/messages': "path: '/api/threads/:threadId/messages'",
};

describe('capability registry', () => {
  it('parses every row', () => {
    for (const row of CAPABILITIES) expect(() => capabilitySchema.parse(row), row.id).not.toThrow();
  });

  it('has one row per id', () => {
    const ids = CAPABILITIES.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The public tree ships docs/help and docs/adr only, so the rest of a row's docs stay here.
  const docsShipped = docs.has('docs/SURFACES.md');

  it('names only docs that exist', () => {
    for (const row of CAPABILITIES) {
      if (row.doc && docsShipped) expect(docs.has(row.doc), `${row.id}: ${row.doc}`).toBe(true);
    }
  });

  it('names only routes the Worker serves', () => {
    for (const row of CAPABILITIES) {
      for (const route of [...(row.agent?.routes ?? []), ...(row.agent?.signedRoutes ?? [])]) {
        // Room-scoped endpoints are dispatched on the slug-stripped `tail`,
        // so their public path cannot appear as a literal in this router.
        const marker = routerMarkers[route] ?? `'${route}`;
        expect(router, `${row.id} names route ${route}`).toContain(marker);
      }
    }
  });

  it('names only starlings verbs the CLI parses', () => {
    expect(cli).toContain('case "host"');
    for (const row of CAPABILITIES) {
      for (const verb of row.agent?.cli ?? []) {
        expect(cli, `${row.id} names ${verb}`).toMatch(new RegExp(`case [^\\n]*"${verb.slice('starlings '.length)}"`, 'u'));
      }
    }
  });

  it('says how an agent reaches every have and partial row', () => {
    // Exactly one of: the doors, `humanOnly` with its reason, `gap` with the issue for the door, or a built-in `rule`.
    for (const row of CAPABILITIES) {
      if (row.intent !== 'have' && row.intent !== 'partial') continue;
      const answers = [hasAgentDoor(row.agent), row.agent?.humanOnly !== undefined, row.agent?.gap !== undefined, row.agent?.rule !== undefined].filter(Boolean);
      expect(answers.length, `${row.id} needs one of agent doors, humanOnly, gap or rule`).toBe(1);
    }
  });

  it('refuses an agent answer that is two answers, or none', () => {
    expect(agentDoorsSchema.safeParse({ cli: ['starlings host'], humanOnly: 'x' }).success).toBe(false);
    expect(agentDoorsSchema.safeParse({ humanOnly: 'x', gap: 1 }).success).toBe(false);
    expect(agentDoorsSchema.safeParse({ gap: 1, rule: 'x' }).success).toBe(false);
    expect(agentDoorsSchema.safeParse({ mcpTools: [] }).success).toBe(false);
    expect(agentDoorsSchema.safeParse({ rule: 'x' }).success).toBe(true);
    expect(agentDoorsSchema.safeParse({ gap: 855 }).success).toBe(true);
  });

  it('gives a built row a stance a person can act on', () => {
    // `dont-want` with a surface that works is a contradiction; `want` with one is a stale row.
    for (const row of CAPABILITIES) {
      if (!row.surfaces) continue;
      expect(['have', 'partial'], `${row.id} is ${row.intent} but has surfaces`).toContain(row.intent);
    }
  });

  it('projects every section once, in order', () => {
    const all = capabilitySections();
    expect(all.map((section) => section.id)).toEqual(CAPABILITY_SECTIONS.map((section) => section.id));
    expect(all.reduce((n, section) => n + section.rows.length, 0)).toBe(CAPABILITIES.length);
    for (const section of surfaceSections()) for (const row of section.rows) expect(row.surfaces).toBeDefined();
  });
});

// Four registries say which client has what: the row menus (`work-actions`), the subject context,
// the Settings pages, and the Docs and Team rails. A capability row says the same thing in prose
// and in `surfaces`, and the two had drifted (meet#598). The registries are the source; these
// tests hold the rows to them. `rail-blocks` has no `clients` field, so there is nothing to hold.

/** A registry's client names the capability surfaces it covers. The Mac's Join mode is the same app. */
const REGISTRY_CLIENT_SURFACES: Record<SettingsClient, CapabilitySurface[]> = {
  mac: ['mac-host', 'mac-join'],
  ios: ['ios'],
  web: ['web'],
};

function surface(id: string, which: CapabilitySurface): SurfaceStatus | undefined {
  const row = capabilityById(id);
  expect(row, `no capability row ${id}`).toBeDefined();
  return row?.surfaces?.[which];
}

describe('capability rows agree with the registries that carry a clients field', () => {
  it('owner-settings follows settings-pages', () => {
    // The row's name: Account, audio/video, captions, calendar, privacy and update settings. Privacy is
    // the site footer and the update line is About, so the pages it needs are these six.
    const needed = ['account', 'video', 'audio', 'captions', 'calendar', 'about'];
    for (const client of Object.keys(REGISTRY_CLIENT_SURFACES) as SettingsClient[]) {
      const has = new Set(settingsPages(client).map((page) => page.id));
      const complete = needed.every((id) => has.has(id));
      for (const which of REGISTRY_CLIENT_SURFACES[client]) {
        expect(surface('owner-settings', which), `owner-settings on ${which}: the ${client} lists ${needed.filter((id) => !has.has(id)).join(', ') || 'every page it needs'}`)
          .toBe(complete ? 'works' : 'partial');
      }
    }
  });

  it('owner-meet-about follows the start-room action on a subject row', () => {
    // Join mode visits another room and hosts nothing, so only the Host column is held to it.
    const available = WORK_ROW_ACTION_CLIENTS.subject['start-room'];
    expect(surface('owner-meet-about', 'mac-host')).toBe(available.mac ? 'works' : 'not-available');
    expect(surface('owner-meet-about', 'ios')).toBe(available.ios ? 'works' : 'not-available');
    expect(surface('owner-meet-about', 'web')).toBe(available.web ? 'works' : 'not-available');
  });

  it('owner-keep is a handoff on the web while the subject menu offers the vault there', () => {
    // The action table says the web's Keep vault is a handoff to Mac and iPhone: it opens no vault.
    expect(WORK_ROW_ACTION_CLIENTS.subject['keep-vault'].web).toBe(true);
    expect(surface('owner-keep', 'web')).toBe('handoff');
    expect(surface('owner-keep', 'mac-host')).toBe('works');
    expect(surface('owner-keep', 'ios')).toBe('works');
  });

  it('owner-work works on every client the subject context draws a block elsewhere on', () => {
    // A block left out of a client's context is drawn elsewhere, by design (GOALS is an Overview group
    // on iOS and web). That only holds while Work itself works there.
    for (const [block, clients] of Object.entries(SUBJECT_CONTEXT_NOT_ON)) {
      for (const client of clients ?? []) {
        expect(SUBJECT_CONTEXT_CLIENTS, `${block}: ${client}`).toContain(client);
        for (const which of REGISTRY_CLIENT_SURFACES[client]) {
          expect(surface('owner-work', which), `owner-work on ${which}, where ${block} moved into the Overview`).toBe('works');
        }
      }
    }
  });
});

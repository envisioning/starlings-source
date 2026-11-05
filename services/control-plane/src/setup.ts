// The setup checklist (docs/ONBOARDING.md §The setup checklist): which of the
// registry's steps one viewer has, and which are done. Every `done` is read
// from data the step creates; nobody ticks a box. `GET /api/setup` answers
// here, the MCP resource `starlings://setup` reads that route, and the day-3
// reminder (mail E5) reads the same answer for each admin.
//
// Two workspace facts live in `workspace_settings`:
//   `setup_checklist`  {"on": false} when an admin turned the card off;
//   `setup_mail_e5`    the time the day-3 reminder went out, so it goes once.
// One fact per person lives in `setup_skips`: a step that person cleared with
// Skip. A skipped step is left out of their answer and counts as done.

import {
  SETUP_STEPS,
  type SetupBlocker,
  type SetupResponse,
  type SetupStepID,
  type SetupStepSpec,
  type SetupStepState,
} from '@starlings/contracts/setup';
import { recordAdminAction } from './admin-audit';
import { isCalendarConnected } from './calendar';
import { type Capability, CAPABILITIES, type PersonRole, roleAllows } from './capabilities';
import type { OwnerSession } from './contracts';
import { sendMail, withSenderName } from './mail';
import { log } from './route-util';
import { SAMPLE_PROJECT_ID } from './starter-content';
import { usesCoreFor } from './work-store';
import { identityDomains } from './workspace-identity';
import { workspaceDisplayName, workspaceMarkPath } from './workspace-profile';

const SETTING_KEY = 'setup_checklist';
const MAIL_KEY = 'setup_mail_e5';
const DAY_MS = 86_400_000;
/** E5 goes on day 3 of the workspace, and not after day 7: an old workspace never gets it. */
const MAIL_FROM_MS = 3 * DAY_MS;
const MAIL_UNTIL_MS = 7 * DAY_MS;

/** Who is asking: the session's person and the role D1 grants them. */
export interface SetupViewer {
  sub: string;
  email: string;
  role: PersonRole;
}

/** True unless an admin turned the checklist off for the workspace. A row nobody can read is on. */
export async function setupChecklistOn(env: Pick<Env, 'USAGE'>): Promise<boolean> {
  const row = await env.USAGE.prepare('SELECT value FROM workspace_settings WHERE key = ?1')
    .bind(SETTING_KEY)
    .first<{ value: string }>();
  if (!row) return true;
  try {
    return (JSON.parse(row.value) as { on?: unknown }).on !== false;
  } catch {
    return true;
  }
}

/** `PUT /api/admin/setup`. Audited, as every workspace setting an admin saves. */
export async function writeSetupChecklist(env: Env, actor: OwnerSession, on: boolean): Promise<void> {
  await env.USAGE.prepare(
    `INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(SETTING_KEY, JSON.stringify({ on }), actor.sub, Date.now()).run();
  await recordAdminAction(env, actor, 'workspace.setup_checklist', null, on ? 'on' : 'off');
}

/**
 * Open invitations. The seam for invitations (docs/ONBOARDING.md
 * §Invitations): until the `invitations` table exists this is 0, and
 * "Invite your team" is done by a second human member alone. Once the
 * table lands, an invitation that is not revoked counts, with no change here.
 */
async function invitationCount(env: Pick<Env, 'USAGE'>): Promise<number> {
  try {
    const table = await env.USAGE.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'invitations'")
      .first<{ present: number }>();
    if (!table) return 0;
    const row = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM invitations WHERE revoked_at IS NULL').first<{ n: number }>();
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

/** True when a calendar can be connected here at all: the Google client is set. */
function calendarConfigured(env: Env): boolean {
  const id = env.GOOGLE_WEB_CLIENT_ID;
  return Boolean(id && !id.startsWith('replace-with-'));
}

/**
 * Who can join is decided without an Admin save: signup recorded the
 * applicant's choice (decision 12; makes it editable), or a
 * workspace from before signup admits by its sign-in domains.
 */
function membershipChosen(env: Env): boolean {
  const recorded = env.WORKSPACE_MEMBERSHIP?.trim();
  if (recorded === 'domains' || recorded === 'invite') return true;
  return identityDomains(env).length > 0;
}

type Facts = Record<SetupStepID, boolean>;

/**
 * Every done test, for one viewer. One D1 batch plus the calendar key and the
 * mark's head. What each reads:
 *   look        a brand row an admin saved, or a mark an admin uploaded (the seed does neither);
 *   membership  a `membership` row an admin saved, the choice signup recorded
 *               (`WORKSPACE_MEMBERSHIP`), or, with neither, a sign-in domain rule
 *               (`IDENTITY_DOMAINS`), which already decides who can join;
 *   invite      an open invitation, or a second human member;
 *   project     one project that is not the sample provisioning seeds;
 *               a workspace whose subjects live in Core has them there;
 *   calendar    the viewer's Google calendar;
 *   agent       an agent row that is not the managed Steward;
 *   assistant   the viewer's MCP grant, from any MCP client;
 *   call        one meeting in the ledger;
 *   apps        a Mac or iOS device signed in as the viewer;
 *   profile     the viewer's picture.
 */
async function readFacts(env: Env, viewer: SetupViewer): Promise<Facts> {
  const db = env.USAGE;
  const exists = (sql: string, ...binds: unknown[]) => db.prepare(`SELECT EXISTS (${sql}) AS hit`).bind(...binds);
  const subjectsInCore = usesCoreFor(env, 'subjects');
  const [brand, membership, humans, project, grant, agent, call, apps, photo] = await db.batch<{ hit?: number; n?: number }>([
    exists("SELECT 1 FROM workspace_settings WHERE key = 'brand'"),
    exists("SELECT 1 FROM workspace_settings WHERE key = 'membership'"),
    db.prepare("SELECT COUNT(*) AS n FROM people WHERE kind = 'human' AND revoked_at IS NULL"),
    // The sample provisioning seeds is not a project anybody started.
    subjectsInCore ? db.prepare('SELECT 1 AS hit') : exists('SELECT 1 FROM projects WHERE id <> ?1', SAMPLE_PROJECT_ID),
    exists('SELECT 1 FROM mcp_grants WHERE sub = ?1 AND revoked_at IS NULL', viewer.sub),
    // The Starlings-managed Steward is not an agent anybody added (#1084).
    exists(`SELECT 1 FROM agents a WHERE a.removed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM built_in_agent_installations i WHERE i.agent_sub = a.sub)`),
    exists('SELECT 1 FROM meetings_ledger'),
    exists("SELECT 1 FROM owner_devices WHERE sub = ?1 AND client IN ('mac', 'ios')", viewer.sub),
    exists('SELECT 1 FROM people WHERE sub = ?1 AND avatar_updated_at IS NOT NULL', viewer.sub),
  ]);
  const hit = (result: D1Result<{ hit?: number }> | undefined) => Number(result?.results?.[0]?.hit ?? 0) === 1;
  const humanCount = Number(humans?.results?.[0]?.n ?? 0);
  const [calendar, mark, invitations] = await Promise.all([
    isCalendarConnected(env, viewer.sub).catch(() => false),
    workspaceMarkPath(env).catch(() => null),
    invitationCount(env),
  ]);
  return {
    profile: hit(photo),
    look: hit(brand) || mark !== null,
    membership: hit(membership) || membershipChosen(env),
    invite: humanCount > 1 || invitations > 0,
    project: hit(project),
    calendar,
    agent: hit(agent),
    assistant: hit(grant),
    call: hit(call),
    apps: hit(apps),
  };
}

/** Why an open step cannot be done yet, or null. */
function blockerFor(env: Env, step: SetupStepID): SetupBlocker | null {
  switch (step) {
    // No recorded choice and no sign-in domain: only a deploy sets it until.
    case 'membership': return { reason: 'Who can join isn’t set for this workspace.', by: 'starlings' };
    case 'calendar': return calendarConfigured(env) ? null : { reason: 'Calendar isn’t set up for this workspace.', by: 'starlings' };
    default: return null;
  }
}

function visibleTo(step: SetupStepSpec, role: PersonRole): boolean {
  return (step.roles as readonly string[]).includes(role)
    && step.capability in CAPABILITIES
    && roleAllows(role, step.capability as Capability);
}

/** The steps the viewer skipped. */
async function readSkips(env: Pick<Env, 'USAGE'>, sub: string): Promise<Set<string>> {
  const { results } = await env.USAGE.prepare('SELECT step FROM setup_skips WHERE sub = ?1').bind(sub).all<{ step: string }>();
  return new Set(results.map((row) => row.step));
}

/**
 * `PUT /api/setup/skip`: clear one step from the viewer's own card, or bring
 * it back. False when the step is not one the viewer has.
 */
export async function writeSetupSkip(env: Env, viewer: SetupViewer, step: string, skipped: boolean): Promise<boolean> {
  const spec = SETUP_STEPS.find((row) => row.id === step);
  if (!spec || !visibleTo(spec, viewer.role)) return false;
  const statement = skipped
    ? env.USAGE.prepare('INSERT INTO setup_skips (sub, step, skipped_at) VALUES (?1, ?2, ?3) ON CONFLICT (sub, step) DO NOTHING')
      .bind(viewer.sub, step, Date.now())
    : env.USAGE.prepare('DELETE FROM setup_skips WHERE sub = ?1 AND step = ?2').bind(viewer.sub, step);
  await statement.run();
  return true;
}

/** `GET /api/setup`: the viewer's steps, in the registry's order, without the ones they skipped. */
export async function readSetup(env: Env, viewer: SetupViewer): Promise<SetupResponse> {
  const [facts, on, skipped] = await Promise.all([readFacts(env, viewer), setupChecklistOn(env), readSkips(env, viewer.sub)]);
  const specs = SETUP_STEPS.filter((step) => visibleTo(step, viewer.role) && !skipped.has(step.id));
  const steps: SetupStepState[] = specs.map((spec) => {
    const done = facts[spec.id];
    return { id: spec.id, done, required: spec.required, blocked: done ? null : blockerFor(env, spec.id) };
  });
  const open = steps.filter((step) => !step.done && step.blocked === null);
  const next = open.find((step) => step.required) ?? open[0] ?? null;
  return {
    steps,
    next: next?.id ?? null,
    // A skipped step is not in `steps`, so it never holds the card open.
    complete: steps.every((step) => step.done || !step.required),
    on,
    can_turn_off: viewer.role === 'admin',
  };
}

/**
 * Mail E5 (docs/ONBOARDING.md §Mails): on day 3 of the workspace, each admin
 * with a required step open gets one mail naming their next step. Once per
 * workspace: the claim row is written before anything is sent, and taken back
 * only when a mail was owed and none went out, so the next hour tries again.
 */
export async function sendSetupReminder(env: Env, now: number): Promise<void> {
  const first = await env.USAGE.prepare("SELECT MIN(first_seen_at) AS at FROM people WHERE kind = 'human'")
    .first<{ at: number | null }>();
  const age = first?.at == null ? null : now - Number(first.at);
  if (age === null || age < MAIL_FROM_MS || age >= MAIL_UNTIL_MS) return;
  if (!(await setupChecklistOn(env))) return;
  const claim = await env.USAGE.prepare(
    `INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, 'setup-reminder', ?3)
     ON CONFLICT (key) DO NOTHING`,
  ).bind(MAIL_KEY, JSON.stringify({ sent_at: now }), now).run();
  if ((claim.meta?.changes ?? 0) === 0) return;

  const { results: admins } = await env.USAGE.prepare(
    "SELECT sub, email, name FROM people WHERE kind = 'human' AND role = 'admin' AND revoked_at IS NULL",
  ).all<{ sub: string; email: string; name: string | null }>();
  const name = await workspaceDisplayName(env).catch(() => 'Starlings');
  let owed = 0;
  let sent = 0;
  for (const admin of admins) {
    try {
      const setup = await readSetup(env, { sub: admin.sub, email: admin.email, role: 'admin' });
      if (setup.complete || !setup.next) continue;
      owed += 1;
      const step = SETUP_STEPS.find((row) => row.id === setup.next);
      if (!step) continue;
      const link = /^https?:\/\//u.test(step.route) ? step.route : new URL(step.route, env.WEB_ORIGIN).toString();
      const ok = await sendMail(env, {
        to: admin.email,
        from: withSenderName(env.MAIL_FROM, `${name} via Starlings`),
        subject: `Next step for ${name}: ${step.title}`,
        text: [
          `${name} is almost set up. Your next step is "${step.title}":`,
          '',
          link,
          '',
          `Every step is on Home in ${name}.`,
        ].join('\n'),
      });
      if (ok) sent += 1;
    } catch (error) {
      // The kind only; never the address.
      log('error', 'setup.reminder.failed', { error: error instanceof Error ? error.name : 'unknown' });
    }
  }
  if (owed > 0 && sent === 0) {
    await env.USAGE.prepare('DELETE FROM workspace_settings WHERE key = ?1').bind(MAIL_KEY).run();
  }
}

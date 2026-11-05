/**
 * The setup checklist (docs/ONBOARDING.md §The setup checklist): the steps a
 * new admin and a new member take, in the order every client lists them.
 *
 * One table. The Worker computes each step's `done` from data
 * (`services/control-plane/src/setup.ts`); nobody ticks a box. `GET /api/setup`
 * returns the viewer's steps, the web Home card, Mac and iOS Home and the MCP
 * resource `starlings://setup` draw them, and the generator writes the Swift
 * `SetupStep` (`Sources/Generated/SetupStepsRegistry.swift`) and
 * `fixtures/setup-steps.json` from this module.
 *
 * Each row: `roles` is who sees it (`people.role`), `capability` the Worker
 * capability the viewer must hold, `required` false for a step the card calls
 * optional, `route` where the web does it (a path on the workspace, or an
 * absolute URL). An admin's list and a member's list share `calendar`,
 * `assistant` and `apps`. `assistant` is any MCP client (Claude, Hermes, an
 * eve agent), not one vendor (MZ, 2026-10-18). `agent` is the admin's own:
 * connecting an assistant and adding an agent to the workspace are two steps
 * (MZ, 2026-10-15). Every step can be skipped, per person
 * (`PUT /api/setup/skip`); a skipped step is not returned.
 */
import { PRODUCT_SITE_ORIGIN } from './deployment';

export const SETUP_ROLES = ['admin', 'member'] as const;
export type SetupRole = (typeof SETUP_ROLES)[number];

/** Who can clear a blocked step: an admin of the workspace, or Starlings itself (a release or the operator). */
export const SETUP_UNBLOCKERS = ['admin', 'starlings'] as const;
export type SetupUnblocker = (typeof SETUP_UNBLOCKERS)[number];

export interface SetupStepSpec {
  id: string;
  title: string;
  roles: readonly SetupRole[];
  capability: string;
  required: boolean;
  route: string;
  /** What makes it done, in one sentence: the help page and the MCP resource say it. */
  doneWhen: string;
}

const ADMIN = ['admin'] as const;
const MEMBER = ['member'] as const;
const EVERYONE = ['admin', 'member'] as const;

/** Top to bottom. An admin reads the rows with `admin`, a member the rows with `member`. */
export const SETUP_STEPS = [
  { id: 'profile', title: 'Add your photo', roles: MEMBER, capability: 'ownProfile', required: true, route: '/settings#settings-account', doneWhen: 'Your profile has a picture.' },
  { id: 'look', title: 'Check your workspace’s look', roles: ADMIN, capability: 'adminOverview', required: true, route: '/admin/people', doneWhen: 'An admin saved the name, the accent or the mark.' },
  { id: 'membership', title: 'Choose who can join', roles: ADMIN, capability: 'adminOverview', required: true, route: '/admin/people', doneWhen: 'Who can join was chosen at signup, or the workspace signs people in by their email domain.' },
  { id: 'invite', title: 'Invite your team', roles: ADMIN, capability: 'adminOverview', required: true, route: '/admin/people', doneWhen: 'Someone has an invitation, or a second person signed in.' },
  { id: 'project', title: 'Start your first project', roles: ADMIN, capability: 'crmWork', required: true, route: '/work', doneWhen: 'The workspace has a project.' },
  { id: 'calendar', title: 'Connect your calendar', roles: EVERYONE, capability: 'calendar', required: true, route: '/settings#settings-calendar', doneWhen: 'Your calendar is connected.' },
  { id: 'assistant', title: 'Connect your agent', roles: EVERYONE, capability: 'ownProfile', required: true, route: '/help/howto/connect-an-agent-over-mcp', doneWhen: 'You connected an agent over MCP.' },
  { id: 'agent', title: 'Add your first agent', roles: ADMIN, capability: 'agents', required: true, route: '/admin/agents', doneWhen: 'The workspace has an agent besides the one Starlings runs.' },
  { id: 'call', title: 'Hold a call', roles: ADMIN, capability: 'hosting', required: false, route: '/', doneWhen: 'The workspace held its first call.' },
  { id: 'apps', title: 'Get the apps', roles: EVERYONE, capability: 'ownProfile', required: false, route: `${PRODUCT_SITE_ORIGIN}/download`, doneWhen: 'You signed in on the Mac or iPhone app.' },
] as const satisfies readonly SetupStepSpec[];

export type SetupStepID = (typeof SETUP_STEPS)[number]['id'];
export const SETUP_STEP_IDS = SETUP_STEPS.map((step) => step.id) as readonly SetupStepID[];

/** The row for an id, or undefined for one this build does not know. */
export function setupStep(id: string): SetupStepSpec | undefined {
  return SETUP_STEPS.find((step) => step.id === id);
}

/** The steps one role reads, in order. */
export function setupStepsFor(role: string): SetupStepSpec[] {
  return SETUP_STEPS.filter((step) => (step.roles as readonly string[]).includes(role));
}


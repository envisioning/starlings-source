import { dateLocale, plural, t } from '@shared/i18n';
import type { InterestPlanID } from '@starlings/contracts/interest';

/** The public prices (BUSINESS (HQ Docs) §The ladder; set, MZ 2026-10-10).
 * Not production billing configuration. The limits are placeholders until
 * measures real workspaces. Business is on request and not on the
 * page. No plan charges per person or agent;
 * each plan sets how many it holds. Each step costs about twice the last.
 */
export type PlanLimits = {
  teammates: number;
  guests: number;
  sharedAgents: number;
  activeProjects: number;
  peopleInCall: number;
  /** Call minutes a month, counted per person in the call. */
  callMinutes: number;
  /** Minutes; null is no limit. */
  callLength: number | null;
  /** Calls a month that get built-in notes; 0 means the workspace's own agent writes them. */
  notedCalls: number;
  storageGb: number;
};

/** The plans the site offers. Business stays in the contract (`INTEREST_PLANS`) for the backend, but the site no longer shows it (MZ, 2026-10-08). */
export type SitePlanID = Exclude<InterestPlanID, 'business'>;

export type PricingPlan = {
  /** One id per plan, one of the interest form's (`INTEREST_PLANS`). */
  id: SitePlanID;
  name: string;
  monthlyEur: number;
  purpose: string;
  /** The plan the page draws with an accent border. */
  highlighted: boolean;
  limits: PlanLimits;
};

export const PRICING_PLANS: readonly PricingPlan[] = [
  {
    id: 'free', name: t('Free'), monthlyEur: 0, purpose: t('Start on one project.'), highlighted: false,
    limits: { teammates: 2, guests: 5, sharedAgents: 1, activeProjects: 1, peopleInCall: 10, callMinutes: 1000, callLength: 40, notedCalls: 0, storageGb: 1 },
  },
  {
    id: 'starter', name: t('Starter'), monthlyEur: 29, purpose: t('For a small crew.'), highlighted: false,
    limits: { teammates: 10, guests: 25, sharedAgents: 3, activeProjects: 5, peopleInCall: 20, callMinutes: 5000, callLength: null, notedCalls: 60, storageGb: 10 },
  },
  {
    id: 'team', name: t('Team'), monthlyEur: 59, purpose: t('For a team that works with clients every day.'), highlighted: true,
    limits: { teammates: 20, guests: 75, sharedAgents: 8, activeProjects: 15, peopleInCall: 40, callMinutes: 10000, callLength: null, notedCalls: 120, storageGb: 50 },
  },
  {
    id: 'pro', name: t('Pro'), monthlyEur: 119, purpose: t('For a firm with many projects at once.'), highlighted: false,
    limits: { teammates: 50, guests: 250, sharedAgents: 25, activeProjects: 50, peopleInCall: 75, callMinutes: 20000, callLength: null, notedCalls: 250, storageGb: 200 },
  },
];

/** The plans a workspace can pick for itself, shown as cards. */
export const SELF_SERVE_PLANS = PRICING_PLANS;

/** The plan's size in one line, as its card and the interest form show it. */
export function planHeadline(plan: PricingPlan): string {
  return t('Up to {n} teammates', { n: new Intl.NumberFormat(dateLocale).format(plan.limits.teammates) });
}

/** What a plan holds beyond its size, as its card and the interest form list it. */
export function planFacts(plan: PricingPlan): string[] {
  const l = plan.limits;
  const n = new Intl.NumberFormat(dateLocale);
  return [
    plural(l.activeProjects, { one: '{count} active project', other: '{count} active projects' }),
    t('{n} guests on shared projects', { n: n.format(l.guests) }),
    plural(l.sharedAgents, { one: '{count} shared agent', other: '{count} shared agents' }),
    l.notedCalls === 0
      ? t('Calls up to 40 minutes. Your own agent writes the notes.')
      : t('{n} calls a month with built-in notes', { n: n.format(l.notedCalls) }),
  ];
}

/** The cheapest paid plan that holds `teammates`, the largest when none does. */
export function planForTeam(teammates: number): PricingPlan {
  return PRICING_PLANS.find((plan) => plan.monthlyEur > 0 && plan.limits.teammates >= teammates) ?? PRICING_PLANS[PRICING_PLANS.length - 1];
}

/**
 * The per-person stack Starlings replaces, for the comparison on /pricing.
 * Typical list prices in EUR per seat per month, ex VAT, as examples of a
 * category, never a verdict on a named tool (BUSINESS (HQ Docs) Q11). Seats scale
 * with team size the way a team usually buys them. Restored 2026-10-06 from
 * the earlier calculator (8ee67aad2^), without its per-agent pricing.
 */
export type StackTool = {
  id: 'video' | 'notes' | 'tasks' | 'chat' | 'connectors' | 'crm';
  label: string;
  examples: string;
  /** Seats a team of `people` usually buys. */
  seats: (people: number) => number;
  /** EUR per seat per month, or per month flat when `flat`. */
  price: number;
  flat?: boolean;
  /** What does the job in Starlings. */
  replaces: string;
  /** Ticked when the comparison opens. */
  common: boolean;
};

export const STACK_TOOLS: readonly StackTool[] = [
  { id: 'video', label: t('Video calls'), examples: 'Zoom Pro', seats: (p) => Math.max(2, Math.round(p * 0.15)), price: 16, replaces: t('Starlings rooms'), common: false },
  { id: 'notes', label: t('Meeting notes'), examples: 'Fireflies, Otter, Granola', seats: (p) => Math.max(1, Math.round(p * 0.4)), price: 12, replaces: t('Notes filed on the project after every call'), common: true },
  { id: 'tasks', label: t('Tasks and docs'), examples: 'Notion, Asana, Linear', seats: (p) => p, price: 10, replaces: t('Tasks and docs on each project, opened by agents from calls'), common: true },
  { id: 'chat', label: t('Team chat'), examples: 'Slack Pro', seats: (p) => p, price: 9, replaces: t('Messages on each project'), common: false },
  { id: 'connectors', label: t('Connectors'), examples: 'Zapier, Make', seats: () => 1, price: 100, flat: true, replaces: t('Your agents, connected through MCP'), common: true },
  { id: 'crm', label: t('CRM'), examples: 'HubSpot, Attio, Pipedrive', seats: (p) => Math.max(2, Math.round(p * 0.25)), price: 25, replaces: t('Contacts and leads on the same record'), common: false },
];

/** What one tool costs a team of `people` a month. */
export function stackToolCost(tool: StackTool, people: number): number {
  return tool.flat ? tool.price : tool.seats(people) * tool.price;
}

export type PlanAction = { href: string; label: string };

/**
 * Where a plan's button goes. The one place that changes when Starlings goes
 * on sale: today every button opens the early-access form with its plan
 * named. With self-serve signup and Checkout, Free
 * goes to signup and a paid plan to signup that ends in Stripe Checkout for
 * that plan and billing interval. BUSINESS (HQ Docs) §Launch plan, Stripe.
 */
export function planAction(plan: PricingPlan): PlanAction {
  return { href: `/interest?plan=${plan.id}`, label: t('Request early access') };
}

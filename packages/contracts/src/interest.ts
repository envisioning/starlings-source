// The interest form at /interest: a firm asking about a pilot. Starlings is not
// for sale yet; this is how we find out who it should be for. The option lists live here so the web form, the Worker's validator
// and the filed lead all speak the same ids.
import { z } from 'zod';
// Imported from index, not re-exported by it: consumers use
// `@starlings/contracts/interest`, which keeps this module out of a value cycle.
import { turnstileTokenSchema } from './index';
import { PUBLIC_WEB_ORIGIN } from './deployment';
import { AGENT_PRODUCTS } from './agent-products';

/** Where "we would take a call" leads: the owner's booking page. The sent screen and the copy mail link the same. */
export const INTEREST_BOOKING_URL = `${PUBLIC_WEB_ORIGIN}/book/mz`;

/**
 * The Starlings pilot group in the Artificial Insights community (STRATEGY (HQ Docs)
 * §How it reaches them). Only a request that names Artificial Insights as its
 * source sees it, on the sent screen and in the copy mail. The group approves
 * each join, so the link is public.
 */
export const INTEREST_COMMUNITY_GROUP_URL = 'https://chat.whatsapp.com/HoDne365v681SLBgnTml2V';

/** Whether a request's answers show the community group link. */
export function interestShowsCommunityGroup(source: string | undefined): boolean {
  return source === 'artificial-insights';
}

/** One pick in a list: the id goes over the wire, the label is what people read. */
export interface InterestOption<ID extends string = string> {
  id: ID;
  label: string;
  /** One plain line under the label, for a list whose names mean nothing to a stranger. */
  hint?: string;
  /** In an any-of-many list: picking this clears the rest, and picking another clears this. Drawn first. */
  exclusive?: boolean;
  /** Picking this opens a short text field: the answer the list did not have. */
  other?: boolean;
}

export const INTEREST_ROLES = [
  { id: 'founder', label: 'Founder or CEO' },
  { id: 'ops', label: 'Operations' },
  { id: 'it', label: 'IT or security' },
  { id: 'engineering', label: 'Engineering' },
  { id: 'sales', label: 'Sales or client work' },
  { id: 'other', label: 'Other', other: true },
] as const satisfies readonly InterestOption[];

/** Company and team share one scale so the two answers compare. */
export const INTEREST_SIZES = [
  { id: '1', label: 'Just me' },
  { id: '2-10', label: '2 to 10' },
  { id: '11-50', label: '11 to 50' },
  { id: '51-200', label: '51 to 200' },
  { id: '201+', label: 'More than 200' },
] as const satisfies readonly InterestOption[];

/**
 * Agents they would run. People are free on the pricing page and agents are
 * the seat, so this is the number that prices the answer.
 */
export const INTEREST_AGENTS = [
  { id: 'none', label: 'None yet' },
  { id: '1', label: 'One' },
  { id: '2-5', label: '2 to 5' },
  { id: '6-20', label: '6 to 20' },
  { id: '21+', label: 'More than 20' },
  { id: 'unsure', label: 'Not sure' },
] as const satisfies readonly InterestOption[];

/**
 * Whether we already work together. The first instances go to firms that
 * already share subjects with Envisioning, so this sorts the queue.
 */
export const INTEREST_RELATIONSHIPS = [
  { id: 'client', label: 'We are an Envisioning client' },
  { id: 'partner', label: 'We are an Envisioning partner' },
  { id: 'met', label: 'We have met or talked before' },
  { id: 'none', label: 'Not yet' },
] as const satisfies readonly InterestOption[];

/**
 * What kind of organization is asking. With size, this is what sorts a
 * request into a lane (GROWTH (HQ Docs), STRATEGY (HQ Docs) §Who it is for); size
 * alone cannot tell a consultancy from a fund or a crew.
 */
export const INTEREST_ORG_KINDS = [
  { id: 'consultancy', label: 'Consultancy or strategy firm' },
  { id: 'studio', label: 'Design studio or agency' },
  { id: 'research', label: 'Research, foresight or think tank' },
  { id: 'fund', label: 'Fund, investor or family office' },
  { id: 'new-company', label: 'New company, under two years old' },
  { id: 'collective', label: 'Freelancers or a collective who team up per project' },
  { id: 'student', label: 'Student team' },
  { id: 'nonprofit', label: 'Nonprofit or public body' },
  { id: 'in-house', label: 'A team inside a larger company' },
  { id: 'other', label: 'Other', other: true },
] as const satisfies readonly InterestOption[];

/** Who they work with beyond their own team: Starlings fits a group that works with outsiders all day. */
export const INTEREST_OUTSIDE_WORK = [
  { id: 'internal', label: 'Mostly people inside our team' },
  { id: 'clients', label: 'Clients' },
  { id: 'portfolio', label: 'Portfolio companies or founders' },
  { id: 'partners', label: 'Partners and collaborators' },
  { id: 'funders', label: 'Funders or investors' },
] as const satisfies readonly InterestOption[];

/** What their unit of work is: what a project would be for them in Starlings. */
export const INTEREST_WORK_UNITS = [
  { id: 'engagement', label: 'By client engagement' },
  { id: 'product', label: 'By product' },
  { id: 'deal', label: 'By deal or investment' },
  { id: 'gig', label: 'By gig or project, and each one ends' },
  { id: 'operations', label: 'Ongoing operations, not projects' },
] as const satisfies readonly InterestOption[];

/** Where they heard of Starlings, as a pick so each lane's sources count. */
export const INTEREST_SOURCES = [
  { id: 'artificial-insights', label: 'Artificial Insights' },
  { id: 'call', label: 'A call I joined on Starlings' },
  { id: 'envisioning', label: 'Someone at Envisioning' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'x-bluesky', label: 'X or Bluesky' },
  { id: 'search', label: 'A search engine' },
  { id: 'assistant', label: 'An AI assistant' },
  { id: 'programme', label: 'A programme or community' },
  { id: 'other', label: 'Other', other: true },
] as const satisfies readonly InterestOption[];

export type InterestSourceID = (typeof INTEREST_SOURCES)[number]['id'];

/**
 * The source a link prefills on the form: `/interest?source=<id>`. Only an id
 * in INTEREST_SOURCES is read; any other value is no pick, never an error.
 * An event's call to action uses it (docs/SESSIONS.md §0, S7).
 */
export function interestSourceFromQuery(search: string): InterestSourceID | undefined {
  const value = new URLSearchParams(search).get('source');
  return INTEREST_SOURCES.find((option) => option.id === value)?.id;
}

/**
 * The plans on `/pricing`, in ladder order. Their prices and limits live in
 * `web/marketing/src/pricing.ts`; this list holds only the ids and names, so
 * a pricing page button can name the plan it came from and the request
 * carries it (`/interest?plan=<id>`). BUSINESS (HQ Docs) §Launch plan.
 */
export const INTEREST_PLANS = [
  { id: 'free', label: 'Free' },
  { id: 'starter', label: 'Starter' },
  { id: 'team', label: 'Team' },
  { id: 'pro', label: 'Pro' },
  { id: 'business', label: 'Business' },
] as const satisfies readonly InterestOption[];

export type InterestPlanID = (typeof INTEREST_PLANS)[number]['id'];

/** The plan a pricing button prefills: `/interest?plan=<id>`. Any other value is no pick. */
export function interestPlanFromQuery(search: string): InterestPlanID | undefined {
  const value = new URLSearchParams(search).get('plan');
  return INTEREST_PLANS.find((option) => option.id === value)?.id;
}

/**
 * The ICP lanes in STRATEGY (HQ Docs) §Who it is for, in their order, and `outside`
 * for a request that fits none. Derived from the answers by `interestLane`;
 * nobody picks one on the form.
 */
export const INTEREST_LANES = [
  { id: 'peer-firm', label: 'Peer firm' },
  { id: 'crew', label: 'New crew' },
  { id: 'fund', label: 'Small fund' },
  { id: 'outside', label: 'Outside the lanes' },
] as const satisfies readonly InterestOption[];
export type InterestLane = (typeof INTEREST_LANES)[number]['id'];

const LANE_BY_KIND: Record<(typeof INTEREST_ORG_KINDS)[number]['id'], InterestLane> = {
  consultancy: 'peer-firm',
  studio: 'peer-firm',
  research: 'peer-firm',
  fund: 'fund',
  'new-company': 'crew',
  collective: 'crew',
  student: 'crew',
  nonprofit: 'outside',
  'in-house': 'outside',
  other: 'outside',
};

/**
 * A request's lane: the kind of organization decides, whatever its size
 * (STRATEGY (HQ Docs): small teams, no headcount). A row from before the question
 * has no kind and reads as `outside`.
 */
export function interestLane(answers: { org_kind?: string | undefined }): InterestLane {
  const kind = INTEREST_ORG_KINDS.find((option) => option.id === answers.org_kind);
  return kind ? LANE_BY_KIND[kind.id] : 'outside';
}

/** How far agents are into the work today: Meet is for firms where they work beside people. */
export const INTEREST_AGENT_USES = [
  { id: 'none', label: 'We do not use agents yet' },
  { id: 'personal', label: 'People use an assistant on their own' },
  { id: 'recurring', label: 'Agents run recurring jobs for the team' },
  { id: 'alongside', label: 'Agents work beside people on shared projects' },
] as const satisfies readonly InterestOption[];

/** The work agents do today, separate from how the team works with them. */
export const INTEREST_AGENT_USE_CASES = [
  { id: 'coding', label: 'Coding and software development' },
  { id: 'marketing', label: 'Marketing and content creation' },
  { id: 'research', label: 'Research and data analysis' },
  { id: 'extraction', label: 'Pulling structured data from websites' },
  { id: 'sales-support', label: 'Sales and customer support' },
  { id: 'operations', label: 'Operations and admin' },
  { id: 'personal', label: 'Personal tasks' },
  { id: 'none', label: 'Still exploring / not using them yet', exclusive: true },
  { id: 'other', label: 'Other', other: true },
] as const satisfies readonly InterestOption[];

/**
 * Where the agents they have live: a chat product's own agents, code in a
 * repository that a coding agent runs, a hosted agent platform, or jobs on
 * their own machines. The products in `tools.agents` do not tell these apart.
 */
export const INTEREST_AGENT_RUNTIMES = [
  { id: 'chat-app', label: 'Inside a chat app, like custom GPTs, Grok or Claude Projects' },
  { id: 'repo', label: 'As code in our repo, run by a coding agent like Claude Code or Codex' },
  { id: 'platform', label: 'On an agent platform, like Manus or Copilot Studio' },
  { id: 'scheduled', label: 'As scheduled jobs on our own servers or cloud' },
  { id: 'none', label: 'Nowhere yet', exclusive: true },
  { id: 'other', label: 'Other', other: true },
] as const satisfies readonly InterestOption[];

/** How a team checks an agent's work before it affects a client or system. */
export const INTEREST_AGENT_REVIEWS = [
  { id: 'every-result', label: 'A named person checks each result before it is sent or acted on' },
  { id: 'risk-based', label: 'People review higher-risk work; routine tasks have lighter checks' },
  { id: 'ad-hoc', label: 'Review happens, but no shared rule guides it' },
  { id: 'none', label: 'We do not have a repeatable review step yet' },
  { id: 'unsure', label: 'Not sure' },
] as const satisfies readonly InterestOption[];

/** The team's boundary for what an agent can read or change. */
export const INTEREST_AGENT_ACCESS = [
  { id: 'scoped', label: 'Agents get only the tools and data needed for each task' },
  { id: 'human-gated', label: 'People approve access or actions, but permissions are broad' },
  { id: 'broad', label: 'Agents can reach more than a task needs' },
  { id: 'undefined', label: 'We have not set boundaries yet' },
  { id: 'unsure', label: 'Not sure' },
] as const satisfies readonly InterestOption[];

export const INTEREST_DEPLOYMENTS = [
  { id: 'hosted', label: 'Run for us by Envisioning, under our domain' },
  { id: 'self-hosted', label: 'On our own Cloudflare and Apple accounts' },
  { id: 'on-prem', label: 'On our own servers' },
  { id: 'unsure', label: 'Not sure yet' },
] as const satisfies readonly InterestOption[];

export const INTEREST_REASONS = [
  // The first two are the starting value propositions under test.
  { id: 'agents', label: 'Agents that work alongside the team' },
  { id: 'one-app', label: 'One app instead of many' },
  { id: 'client-record', label: 'Everything about a project in one place' },
  { id: 'own-data', label: 'We keep our own data' },
  { id: 'filed-meetings', label: 'Calls that file their own notes' },
  { id: 'cost', label: 'Cost' },
  { id: 'no-recording', label: 'Nothing gets recorded' },
  { id: 'other', label: 'Something else', other: true },
] as const satisfies readonly InterestOption[];

export const INTEREST_TIMELINES = [
  { id: 'exploring', label: 'Exploring' },
  { id: 'quarter', label: 'This quarter' },
  { id: 'now', label: 'Now' },
] as const satisfies readonly InterestOption[];

export const INTEREST_BUDGETS = [
  { id: 'under-5', label: 'Under 5' },
  { id: '5-15', label: '5 to 15' },
  { id: 'over-15', label: 'Over 15' },
  { id: 'unsure', label: 'Not sure' },
] as const satisfies readonly InterestOption[];

/**
 * How the team signs in. Starlings signs in with Google today and Microsoft
 * 365 is next (the form says both); the answers measure who waits for which.
 */
export const INTEREST_IDENTITIES = [
  { id: 'google', label: 'Google Workspace' },
  { id: 'google-personal', label: 'Personal Google accounts' },
  { id: 'microsoft', label: 'Microsoft 365' },
  { id: 'other', label: 'Other', other: true },
] as const satisfies readonly InterestOption[];
export type InterestIdentity = (typeof INTEREST_IDENTITIES)[number]['id'];

export const INTEREST_DEVICES = [
  { id: 'mac', label: 'Mac' },
  { id: 'iphone', label: 'iPhone or iPad' },
  { id: 'windows', label: 'Windows' },
  { id: 'android', label: 'Android' },
  { id: 'linux', label: 'Linux' },
] as const satisfies readonly InterestOption[];

/** What they use today, one list per job Meet does. */
export const INTEREST_TOOLS = {
  video: {
    label: 'Live calls and presence',
    options: [
      { id: 'zoom', label: 'Zoom' },
      { id: 'google-meet', label: 'Google Meet' },
      { id: 'teams', label: 'Microsoft Teams' },
      { id: 'webex', label: 'Webex' },
      { id: 'whereby', label: 'Whereby' },
      { id: 'slack-huddles', label: 'Slack huddles' },
      { id: 'discord', label: 'Discord voice' },
      { id: 'gather', label: 'Gather' },
      { id: 'kumospace', label: 'Kumospace' },
      { id: 'tandem', label: 'Tandem' },
      { id: 'sowork', label: 'SoWork' },
      { id: 'loom', label: 'Loom' },
      { id: 'other', label: 'Other', other: true },
    ],
  },
  notes: {
    label: 'Meeting notes',
    options: [
      { id: 'none', label: 'None', exclusive: true },
      { id: 'granola', label: 'Granola' },
      { id: 'otter', label: 'Otter' },
      { id: 'fireflies', label: 'Fireflies' },
      { id: 'built-in', label: 'The video tool’s own' },
      { id: 'other', label: 'Other', other: true },
    ],
  },
  booking: {
    label: 'Booking',
    options: [
      { id: 'none', label: 'None', exclusive: true },
      { id: 'calendly', label: 'Calendly' },
      { id: 'cal-com', label: 'Cal.com' },
      { id: 'other', label: 'Other', other: true },
    ],
  },
  work: {
    label: 'Tasks and issues',
    options: [
      { id: 'none', label: 'None', exclusive: true },
      { id: 'linear', label: 'Linear' },
      { id: 'asana', label: 'Asana' },
      { id: 'notion', label: 'Notion' },
      { id: 'github', label: 'GitHub' },
      { id: 'jira', label: 'Jira' },
      { id: 'other', label: 'Other', other: true },
    ],
  },
  chat: {
    label: 'Team chat',
    options: [
      { id: 'slack', label: 'Slack' },
      { id: 'teams', label: 'Microsoft Teams' },
      { id: 'discord', label: 'Discord' },
      { id: 'other', label: 'Other', other: true },
    ],
  },
  agents: {
    label: 'Agents and assistants',
    options: [
      { id: 'none', label: 'None', exclusive: true },
      ...AGENT_PRODUCTS,
      { id: 'other', label: 'Other', other: true },
    ],
  },
} as const satisfies Record<string, { label: string; options: readonly InterestOption[] }>;
export type InterestToolGroup = keyof typeof INTEREST_TOOLS;
export const INTEREST_TOOL_GROUPS = Object.keys(INTEREST_TOOLS) as InterestToolGroup[];
type InterestToolID<G extends InterestToolGroup> = (typeof INTEREST_TOOLS)[G]['options'][number]['id'];
type InterestToolPicks = { [G in InterestToolGroup]?: readonly InterestToolID<G>[] };

/**
 * What a sign-in answer ticks in the tool lists: the suite's own call and
 * chat apps. The form fills only a list that is still empty, and every tick
 * can be cleared.
 */
export const INTEREST_IDENTITY_TOOLS: Partial<Record<InterestIdentity, InterestToolPicks>> = {
  google: { video: ['google-meet'] },
  'google-personal': { video: ['google-meet'] },
  microsoft: { video: ['teams'], chat: ['teams'] },
};

/** How the team wants to talk live, ahead of what it uses today. Pick any. */
export const INTEREST_LIVE = {
  label: 'How you want to talk live',
  options: [
    { id: 'scheduled', label: 'Scheduled calls with an agenda' },
    { id: 'drop-in', label: 'Drop-in rooms people walk into' },
    { id: 'presence', label: 'Always-on presence: see who is around, talk in one click' },
    { id: 'async', label: 'Async video and written updates instead of calls' },
    { id: 'agents', label: 'Agents in the room, taking notes and doing the follow-ups' },
  ],
} as const satisfies { label: string; options: readonly InterestOption[] };
export type InterestLiveStyle = (typeof INTEREST_LIVE)['options'][number]['id'];

/**
 * What a live tool says about how the team wants to talk. Picking one ticks
 * its style in INTEREST_LIVE while that list is still empty.
 */
export const INTEREST_TOOL_LIVE_STYLES: Partial<Record<InterestToolID<'video'>, InterestLiveStyle>> = {
  zoom: 'scheduled',
  'google-meet': 'scheduled',
  teams: 'scheduled',
  webex: 'scheduled',
  whereby: 'scheduled',
  'slack-huddles': 'drop-in',
  discord: 'drop-in',
  gather: 'presence',
  kumospace: 'presence',
  tandem: 'presence',
  sowork: 'presence',
  loom: 'async',
};

export const INTEREST_PAINS = [
  { id: 'recording', label: 'Calls get recorded and we do not want that' },
  { id: 'seat-cost', label: 'Cost per seat' },
  { id: 'too-many-tools', label: 'Too many tools' },
  { id: 'notes-lost', label: 'Notes go nowhere after the call' },
  { id: 'guest-accounts', label: 'Guests need an account to join' },
  { id: 'data-control', label: 'No control over where the data goes' },
  { id: 'other', label: 'Something else', other: true },
] as const satisfies readonly InterestOption[];

/**
 * The parts of the app, named as the /workspace tiles name them. Someone who
 * has never opened Meet does not know what Keep or Work is, so each part
 * carries one line saying what it does; the form draws it under the name.
 */
export const INTEREST_PARTS = [
  { id: 'meetings', label: 'Calls', hint: 'Video calls hosted from your Mac or iPhone. Guests join from a link, with no account.' },
  { id: 'transcript', label: 'Transcript and summary', hint: 'Written on the host’s device as the call runs, filed with the project when it ends.' },
  { id: 'booking', label: 'Booking page', hint: 'One link. People pick a time you are free.' },
  { id: 'calendar', label: 'Calendar', hint: 'Company meetings, your tasks and your personal calendars in one view.' },
  { id: 'work', label: 'Work', hint: 'Tasks and issues, on the project they belong to.' },
  { id: 'messages', label: 'Messages', hint: 'One thread per person, group or project, the same on every device.' },
  { id: 'docs', label: 'Docs', hint: 'Everything your team has written, next to the project it’s about.' },
  { id: 'agents', label: 'Agents', hint: 'AI teammates in your team list. Message one, or hand it a task.' },
  { id: 'mcp', label: 'MCP', hint: 'Connect your own Claude. It works as you, and Starlings logs what it does.' },
  { id: 'keep', label: 'Keep', hint: 'Client passwords and keys, encrypted on your device. The server can’t read them.' },
  { id: 'native', label: 'Native Mac and iPhone apps', hint: 'The same workspace as the web, built for each platform.' },
] as const satisfies readonly InterestOption[];

/**
 * The lists with an "Other": one short text each, keyed by the list, sent
 * only when Other is picked there. `tools.<group>` keys the tool lists.
 */
export const INTEREST_OTHER_KEYS = [
  'role', 'org_kind', 'source', 'identity', 'reason', 'pains', 'agent_use_cases', 'agent_runtimes',
  'tools.video', 'tools.notes', 'tools.booking', 'tools.work', 'tools.chat', 'tools.agents',
] as const;
export type InterestOtherKey = (typeof INTEREST_OTHER_KEYS)[number];

/**
 * Every question's words, keyed by its field, and the form's sections. The
 * form and the receipt mail read these, so the copy someone gets back says
 * what the form said. `{ label }` and `{ title }`, so the web string scan
 * (sync-web-strings) finds them as it finds the options.
 */
export const INTEREST_QUESTIONS = {
  name: { label: 'Your name' },
  email: { label: 'Work email' },
  company: { label: 'Company' },
  country: { label: 'Country' },
  role: { label: 'Your role' },
  org_kind: { label: 'What kind of organization' },
  outside_work: { label: 'Who you work with outside your team' },
  work_unit: { label: 'How your work is organized' },
  company_size: { label: 'Company size' },
  team_size: { label: 'Team that would use Starlings' },
  agents: { label: 'Agents you would run' },
  agent_use: { label: 'How agents work with you today' },
  agent_use_cases: { label: 'What are you using AI agents for today?' },
  agent_runtimes: { label: 'Where do your agents run?' },
  agent_review: { label: 'How is an agent’s work reviewed before it reaches a client or changes a system?' },
  agent_access: { label: 'How clear are the boundaries on what agents may read or change?' },
  agent_inventory: { label: 'Agents the team runs' },
  agent_name: { label: 'Filled in by' },
  agent_example: { label: 'Tell us about one task you use agents for.' },
  relationship: { label: 'Envisioning and you' },
  identity: { label: 'How your team signs in' },
  devices: { label: 'Devices of the people who would host calls' },
  pains: { label: 'What hurts today' },
  pains_text: { label: 'In your words' },
  parts: { label: 'What you would use' },
  missing: { label: 'What’s missing' },
  deployment: { label: 'How you would run it' },
  reason: { label: 'What matters most' },
  timeline: { label: 'When might your team try a real workflow with agents?' },
  budget: { label: 'Budget per agent per month' },
  pilot: { label: 'We’d try it on a real project, with your help' },
  call: { label: 'We’d take a 30-minute demo call' },
  source: { label: 'How you heard about Starlings' },
  plan: { label: 'Plan you’re looking at' },
  /** Free text from before `source`; kept so an older row still reads. */
  heard: { label: 'How you heard about Starlings' },
} as const satisfies Partial<Record<keyof InterestInput, { label: string }>>;

export const INTEREST_SECTIONS = {
  who: { title: 'Who' },
  today: { title: 'Today' },
  pains: { title: 'Pain points' },
  parts: { title: 'Which parts' },
  wants: { title: 'Wants' },
} as const satisfies Record<string, { title: string }>;

export const INTEREST_TEXT_MAX_CHARS = 160;
export const INTEREST_LONG_TEXT_MAX_CHARS = 2_000;
export const INTEREST_BODY_MAX_BYTES = 32_768;

type IDs<T extends readonly InterestOption[]> = T[number]['id'];
function ids<T extends readonly InterestOption[]>(options: T): [IDs<T>, ...IDs<T>[]] {
  return options.map((option) => option.id) as [IDs<T>, ...IDs<T>[]];
}
function pick<T extends readonly InterestOption[]>(options: T) {
  return z.enum(ids(options));
}
function picks<T extends readonly InterestOption[]>(options: T) {
  return z.array(z.enum(ids(options))).max(options.length).default([]);
}
function requiredPicks<T extends readonly InterestOption[]>(options: T) {
  return z.array(z.enum(ids(options))).min(1).max(options.length);
}
const shortText = z.string().trim().max(INTEREST_TEXT_MAX_CHARS);
const longText = z.string().trim().max(INTEREST_LONG_TEXT_MAX_CHARS);

export const INTEREST_AGENT_INVENTORY_MAX = 30;

/** One agent the team runs, as the agent filling the form sees it. */
export const interestAgentEntrySchema = z.object({
  name: shortText.min(1).describe('What the team calls it, like "sku-extractor".'),
  does: longText.min(1).describe('What it does, in a sentence or two.'),
  runtime: z.enum(ids(INTEREST_AGENT_RUNTIMES)).exclude(['none']).optional()
    .describe('Where it runs. chat-app: inside a chat product. repo: code in a repository, run by a coding agent. platform: a hosted agent platform. scheduled: jobs on their own servers or cloud.'),
  trigger: shortText.optional().describe('What starts it, like "nightly cron" or "a person asks in chat".'),
  operated_by: shortText.optional().describe('Who or what runs it, like "Claude Code" or "Grok".'),
  touches: z.array(shortText).max(20).default([]).describe('The systems and data it reads or writes, like "retailer sites" or "Postgres".'),
});
export type InterestAgentEntry = z.infer<typeof interestAgentEntrySchema>;

/**
 * Every field here is stored in hq's D1 and copied into a lead's notes.
 * Nothing on this schema may carry a credential.
 */
export const interestSchema = z.object({
  name: shortText.min(1),
  email: z.string().trim().email().max(254),
  company: shortText.min(1),
  role: pick(INTEREST_ROLES),
  /** Optional in the schema so a row written before the question still parses; the form requires it. */
  org_kind: pick(INTEREST_ORG_KINDS).optional(),
  /** Optional on the form; an older submission reads as no picks. */
  outside_work: picks(INTEREST_OUTSIDE_WORK),
  /** Optional in the schema for the same reason; the form requires it. */
  work_unit: pick(INTEREST_WORK_UNITS).optional(),
  company_size: pick(INTEREST_SIZES),
  team_size: pick(INTEREST_SIZES),
  /** Optional in the schema so a row written before the question still parses; the form requires it. */
  agents: pick(INTEREST_AGENTS).optional(),
  /** Optional for the same reason; the form requires it. */
  agent_use: pick(INTEREST_AGENT_USES).optional(),
  /** Optional on the form; an older submission reads as no picks. */
  agent_use_cases: picks(INTEREST_AGENT_USE_CASES),
  /** Optional on the form; an older submission reads as no picks. */
  agent_runtimes: picks(INTEREST_AGENT_RUNTIMES),
  /** Optional on the schema so old submissions and agent-filled requests still parse. */
  agent_review: pick(INTEREST_AGENT_REVIEWS).optional(),
  /** Optional on the schema so old submissions and agent-filled requests still parse. */
  agent_access: pick(INTEREST_AGENT_ACCESS).optional(),
  /** The agents the team runs, one entry each. An agent fills this from what it can see; the browser form does not ask. */
  agent_inventory: z.array(interestAgentEntrySchema).max(INTEREST_AGENT_INVENTORY_MAX).default([]),
  /** Optional in the schema so a row written before the rule still parses; the form requires it once agents are in use. */
  agent_example: longText.optional(),
  /** Optional for the same reason; the form requires it. */
  relationship: pick(INTEREST_RELATIONSHIPS).optional(),
  country: shortText.optional(),
  deployment: pick(INTEREST_DEPLOYMENTS),
  reason: pick(INTEREST_REASONS),
  timeline: pick(INTEREST_TIMELINES),
  /** Per agent per month, in whatever they think of as their currency. Optional on purpose. */
  budget: pick(INTEREST_BUDGETS).optional(),
  identity: pick(INTEREST_IDENTITIES),
  devices: picks(INTEREST_DEVICES),
  /** Defaults to none, so a row written before the question still parses. */
  live: picks(INTEREST_LIVE.options),
  tools: z.object({
    video: picks(INTEREST_TOOLS.video.options),
    notes: picks(INTEREST_TOOLS.notes.options),
    booking: picks(INTEREST_TOOLS.booking.options),
    work: picks(INTEREST_TOOLS.work.options),
    chat: picks(INTEREST_TOOLS.chat.options),
    /** Defaults to none, so a row written before the question still parses. */
    agents: picks(INTEREST_TOOLS.agents.options),
  }).prefault({}),
  pains: picks(INTEREST_PAINS),
  pains_text: longText.optional(),
  other: z.strictObject(Object.fromEntries(INTEREST_OTHER_KEYS.map((key) => [key, shortText.optional()])) as Record<InterestOtherKey, z.ZodOptional<typeof shortText>>).default({}),
  parts: picks(INTEREST_PARTS),
  missing: longText.optional(),
  pilot: z.boolean().default(false),
  call: z.boolean().default(false),
  source: pick(INTEREST_SOURCES).optional(),
  /** The pricing plan the person came from, or picked; optional everywhere. */
  plan: pick(INTEREST_PLANS).optional(),
  /** Browser form marker; set only when answers were carried from the readiness assessment. */
  readiness_assessment: z.literal('v1').optional(),
  /** Free text from before `source`. The form no longer sends it. */
  heard: shortText.optional(),
  /** Who filled the answers in. The route sets it; whatever a client sends is replaced. */
  filled_by: z.enum(['form', 'agent']).default('form'),
  /** The agent that filled them in, in its own words ("Claude Code"). Only on `filled_by: 'agent'`. */
  agent_name: shortText.optional(),
  turnstile_token: turnstileTokenSchema.optional(),
});
export type InterestInput = z.infer<typeof interestSchema>;

/** The ten answers shared by the readiness assessment and early-access form. */
const interestReadinessAnswersBaseSchema = z.object({
  org_kind: pick(INTEREST_ORG_KINDS),
  team_size: pick(INTEREST_SIZES),
  work_unit: pick(INTEREST_WORK_UNITS),
  outside_work: requiredPicks(INTEREST_OUTSIDE_WORK),
  agent_use: pick(INTEREST_AGENT_USES),
  agent_use_cases: requiredPicks(INTEREST_AGENT_USE_CASES),
  agent_runtimes: requiredPicks(INTEREST_AGENT_RUNTIMES),
  agent_review: pick(INTEREST_AGENT_REVIEWS),
  agent_access: pick(INTEREST_AGENT_ACCESS),
  timeline: pick(INTEREST_TIMELINES),
});
export const interestReadinessAnswersSchema = interestReadinessAnswersBaseSchema.superRefine((answers, context) => {
  const groups = [
    ['agent_use_cases', answers.agent_use_cases, new Set(['none'])],
    ['agent_runtimes', answers.agent_runtimes, new Set(['none'])],
  ] as const;
  for (const [field, values, exclusive] of groups) {
    if (values.some((value) => exclusive.has(value)) && values.length > 1) {
      context.addIssue({ code: 'custom', path: [field], message: 'Choose the exclusive option by itself.' });
    }
  }
});
export type InterestReadinessAnswers = z.infer<typeof interestReadinessAnswersSchema>;

/** Per-tab draft format. It never leaves the browser unless the person submits the interest form. */
export const INTEREST_READINESS_STORAGE_KEY = 'meet:agent-readiness:v1';
const interestReadinessDraftAnswersSchema = interestReadinessAnswersBaseSchema.partial().extend({
  outside_work: picks(INTEREST_OUTSIDE_WORK).optional(),
  agent_use_cases: picks(INTEREST_AGENT_USE_CASES).optional(),
  agent_runtimes: picks(INTEREST_AGENT_RUNTIMES).optional(),
});
export const interestReadinessDraftSchema = z.object({
  version: z.literal(1),
  step: z.number().int().min(0).max(10),
  answers: interestReadinessDraftAnswersSchema,
  /** The text an "Other" pick carries, for the lists the assessment asks. */
  other: z.object({ org_kind: shortText, agent_use_cases: shortText, agent_runtimes: shortText }).partial().optional(),
});
export type InterestReadinessDraft = z.infer<typeof interestReadinessDraftSchema>;

export type AgentReadinessDimensionID = 'agent-practice' | 'human-review' | 'access-boundaries' | 'pilot-horizon';
export interface AgentReadinessScore {
  score: number;
  band: 'exploring' | 'building' | 'ready-to-pilot';
  dimensions: Array<{ id: AgentReadinessDimensionID; score: number; max: number }>;
}

/**
 * A transparent reflection score, not a validated benchmark or sales-fit test.
 * Organization type, team size, work shape and external collaboration add
 * useful context but do not raise or lower a team's readiness score.
 */
export function scoreAgentReadiness(answers: Pick<InterestInput,
  'agent_use' | 'agent_use_cases' | 'agent_runtimes' | 'agent_review' | 'agent_access' | 'timeline'
>): AgentReadinessScore {
  const practiceLevel = { none: 0, personal: 1, recurring: 2, alongside: 3 } as const;
  const reviewLevel = { 'every-result': 2, 'risk-based': 2, 'ad-hoc': 1, none: 0, unsure: 0 } as const;
  const accessLevel = { scoped: 2, 'human-gated': 1, broad: 0, undefined: 0, unsure: 0 } as const;
  const pilotLevel = { exploring: 0, quarter: 1, now: 2 } as const;
  const dimensions: AgentReadinessScore['dimensions'] = [
    {
      id: 'agent-practice',
      score: (answers.agent_use ? practiceLevel[answers.agent_use] : 0)
        + (answers.agent_use_cases?.some((id) => id !== 'none') ? 1 : 0)
        + (answers.agent_runtimes?.some((id) => id !== 'none') ? 1 : 0),
      max: 5,
    },
    { id: 'human-review', score: answers.agent_review ? reviewLevel[answers.agent_review] : 0, max: 2 },
    { id: 'access-boundaries', score: answers.agent_access ? accessLevel[answers.agent_access] : 0, max: 2 },
    { id: 'pilot-horizon', score: answers.timeline ? pilotLevel[answers.timeline] : 0, max: 2 },
  ];
  const score = Math.round(dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / 11 * 100);
  return {
    score,
    band: score <= 33 ? 'exploring' : score <= 66 ? 'building' : 'ready-to-pilot',
    dimensions,
  };
}

/*
 * The agent path (docs/FORMS.md §Agents). A person's own agent applies for
 * them: it reads the fill guide (`/interest.md`) and the JSON Schema, posts
 * the answers, and Starlings mails the address in the answers a link to
 * confirm. Nothing reaches the lead queue until the person opens it, so the
 * mail is the proof a person stands behind the request, where the browser
 * form has Turnstile.
 */

export {
  INTEREST_AGENT_API_PATH,
  INTEREST_CONFIRM_API_PATH,
  INTEREST_CONFIRM_PATH,
  INTEREST_GUIDE_PATH,
  INTEREST_SCHEMA_PATH,
} from './paths';
/** An unconfirmed request is deleted after this. */
export const INTEREST_CONFIRM_DAYS = 3;

/**
 * The agent's submission: every answer the form requires, its own name, and
 * either the inventory or one task in words once agents are in use.
 */
export const interestAgentSubmissionSchema = interestSchema
  .omit({ turnstile_token: true, filled_by: true, heard: true, readiness_assessment: true })
  .required({ org_kind: true, work_unit: true, agents: true, agent_use: true, relationship: true })
  .extend({
    agent_name: shortText.min(1).describe('Your own name as an agent, like "Claude Code". The confirm mail names you.'),
  })
  .superRefine((input, ctx) => {
    if (input.agent_use === 'none' || input.agent_example || input.agent_inventory.length) return;
    ctx.addIssue({ code: 'custom', path: ['agent_inventory'], message: 'The team uses agents: list them in agent_inventory, or describe one task in agent_example.' });
  });
export type InterestAgentSubmission = z.infer<typeof interestAgentSubmissionSchema>;

/** The agent route's answer: what happens next, in a sentence the agent can pass on. */
export const interestAgentResponseSchema = z.object({
  ok: z.literal(true),
  state: z.literal('confirm_sent'),
  email: z.string(),
  expires_at: z.number(),
  next: z.string(),
});
export type InterestAgentResponse = z.infer<typeof interestAgentResponseSchema>;

export const interestConfirmInputSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
});
export type InterestConfirmInput = z.infer<typeof interestConfirmInputSchema>;

export const interestConfirmResponseSchema = z.object({
  ok: z.literal(true),
  company: z.string(),
  /** They asked for a call: the page offers the booking link. */
  call: z.boolean(),
});
export type InterestConfirmResponse = z.infer<typeof interestConfirmResponseSchema>;

/** The runtimes an inventory names, in the list's order: `agent_runtimes` when the agent sent none. */
export function interestRuntimesOf(inventory: readonly InterestAgentEntry[]): InterestInput['agent_runtimes'] {
  return INTEREST_AGENT_RUNTIMES.map((option) => option.id).filter((id) => inventory.some((entry) => entry.runtime === id));
}

/** As opaque as `FeedbackResponse`: the tracker is private. */
export const interestResponseSchema = z.object({
  ok: z.literal(true),
});
export type InterestResponse = z.infer<typeof interestResponseSchema>;

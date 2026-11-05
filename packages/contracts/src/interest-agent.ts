// What an agent reads to apply for early access for its person
// (docs/FORMS.md §Agents): the steps, the prompt a person hands their agent,
// the JSON Schema and the fill guide. The /interest page draws the steps and
// the prompt, the site build writes the schema and the guide, and all of
// them come from the option lists in ./interest, so none can drift from the
// ids the Worker validates.
import { z } from 'zod';
import {
  INTEREST_AGENT_API_PATH,
  INTEREST_AGENT_RUNTIMES,
  INTEREST_AGENT_USES,
  INTEREST_AGENT_USE_CASES,
  INTEREST_AGENTS,
  INTEREST_BUDGETS,
  INTEREST_CONFIRM_DAYS,
  INTEREST_DEPLOYMENTS,
  INTEREST_DEVICES,
  INTEREST_GUIDE_PATH,
  INTEREST_IDENTITIES,
  INTEREST_LIVE,
  INTEREST_ORG_KINDS,
  INTEREST_OUTSIDE_WORK,
  INTEREST_PAINS,
  INTEREST_PARTS,
  INTEREST_PLANS,
  INTEREST_QUESTIONS,
  INTEREST_REASONS,
  INTEREST_RELATIONSHIPS,
  INTEREST_ROLES,
  INTEREST_SCHEMA_PATH,
  INTEREST_SIZES,
  INTEREST_SOURCES,
  INTEREST_TIMELINES,
  INTEREST_TOOLS,
  INTEREST_TOOL_GROUPS,
  INTEREST_WORK_UNITS,
  type InterestOption,
  interestAgentSubmissionSchema,
} from './interest';

/** The pick lists by field, so the schema and the guide say what each id means. */
const FIELD_OPTIONS: Record<string, readonly InterestOption[]> = {
  role: INTEREST_ROLES,
  org_kind: INTEREST_ORG_KINDS,
  outside_work: INTEREST_OUTSIDE_WORK,
  work_unit: INTEREST_WORK_UNITS,
  company_size: INTEREST_SIZES,
  team_size: INTEREST_SIZES,
  agents: INTEREST_AGENTS,
  agent_use: INTEREST_AGENT_USES,
  agent_use_cases: INTEREST_AGENT_USE_CASES,
  agent_runtimes: INTEREST_AGENT_RUNTIMES,
  relationship: INTEREST_RELATIONSHIPS,
  deployment: INTEREST_DEPLOYMENTS,
  reason: INTEREST_REASONS,
  timeline: INTEREST_TIMELINES,
  budget: INTEREST_BUDGETS,
  identity: INTEREST_IDENTITIES,
  devices: INTEREST_DEVICES,
  live: INTEREST_LIVE.options,
  pains: INTEREST_PAINS,
  parts: INTEREST_PARTS,
  source: INTEREST_SOURCES,
  plan: INTEREST_PLANS,
};

/** Fields with no question on the form: what each is for. */
const FIELD_NOTES: Record<string, string> = {
  other: 'The text for a list where you picked "other", keyed by that field (role, org_kind, source, identity, reason, pains, agent_use_cases, agent_runtimes, or tools.<group>).',
  pilot: 'True: they would try Starlings on a real project, with Envisioning\'s help.',
  call: 'True: they would take a 30-minute demo call. The confirm page then offers the booking link.',
  agent_inventory: 'One entry per agent. Fill this from what you can see: their repositories, scheduled jobs, chat products and agent platforms.',
  tools: 'What they use today, one list per job.',
};

/** The sentence a person pastes into their own agent. */
export function interestAgentPrompt(origin: string): string {
  return `Request early access to Starlings for us. Follow ${origin}${INTEREST_GUIDE_PATH}.`;
}

/** The steps, in order, as the page and the guide both print them. */
export function interestAgentSteps(origin: string): string[] {
  return [
    `Read the JSON Schema at ${origin}${INTEREST_SCHEMA_PATH}. Each field says what it asks and what each id means.`,
    'Fill in what you know about the person and their company. Ask the person for anything you do not know. Never guess the email address: the confirm mail goes to it.',
    'List the agents the team runs in agent_inventory: what each does, where it runs, what starts it and what it touches. Look at their repositories, scheduled jobs and agent tools where you have access.',
    `POST the answers as JSON to ${origin}${INTEREST_AGENT_API_PATH}, with agent_name set to your own name. A 400 lists every field to fix.`,
    `Tell the person to open the mail from Starlings and press Send. Nothing reaches Envisioning before that, and the link works for ${INTEREST_CONFIRM_DAYS} days.`,
  ];
}

/** A minimal request, for the guide. */
export function interestAgentExample(origin: string): string {
  const body = {
    agent_name: 'Claude Code',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    company: 'Example Studio',
    role: 'founder',
    org_kind: 'studio',
    work_unit: 'engagement',
    company_size: '2-10',
    team_size: '2-10',
    agents: '2-5',
    agent_use: 'recurring',
    relationship: 'none',
    agent_inventory: [
      { name: 'sku-extractor', does: 'Pulls SKUs and prices from 40 retailer sites into Postgres.', runtime: 'repo', trigger: 'nightly cron', operated_by: 'Claude Code', touches: ['retailer sites', 'Postgres'] },
    ],
    identity: 'google',
    deployment: 'hosted',
    reason: 'agents',
    timeline: 'quarter',
  };
  return `curl -X POST ${origin}${INTEREST_AGENT_API_PATH} -H 'content-type: application/json' -d '${JSON.stringify(body)}'`;
}

function optionsText(options: readonly InterestOption[]): string {
  return options.map((option) => `${option.id} (${option.label})`).join('; ');
}

function fieldDescription(field: string): string | undefined {
  const question = (INTEREST_QUESTIONS as Record<string, { label: string }>)[field]?.label;
  const options = FIELD_OPTIONS[field];
  const sentence = question && !/[.?]$/u.test(question) ? `${question}.` : question;
  const parts = [sentence, FIELD_NOTES[field], options ? `Ids: ${optionsText(options)}.` : undefined].filter(Boolean);
  return parts.length ? parts.join(' ') : undefined;
}

type JSONSchemaNode = { description?: string; properties?: Record<string, JSONSchemaNode>; [key: string]: unknown };

/** The agent submission as JSON Schema, every field described in the form's own words. */
export function interestAgentJsonSchema(origin: string): Record<string, unknown> {
  const schema = z.toJSONSchema(interestAgentSubmissionSchema, { io: 'input' }) as JSONSchemaNode;
  for (const [field, node] of Object.entries(schema.properties ?? {})) {
    const description = fieldDescription(field);
    if (description && !node.description) node.description = description;
  }
  const tools = schema.properties?.tools?.properties ?? {};
  for (const group of INTEREST_TOOL_GROUPS) {
    const node = tools[group];
    if (node) node.description = `${INTEREST_TOOLS[group].label}. Ids: ${optionsText(INTEREST_TOOLS[group].options)}.`;
  }
  return {
    $id: `${origin}${INTEREST_SCHEMA_PATH}`,
    title: 'Starlings early access request, sent by an agent',
    description: `POST to ${origin}${INTEREST_AGENT_API_PATH}. Once agent_use is not "none", send agent_inventory or agent_example. Guide: ${origin}${INTEREST_GUIDE_PATH}`,
    ...schema,
  };
}

/** The twin of /interest: the guide an agent follows, with every field and id. */
export function interestGuideMarkdown(origin: string): string {
  const schema = interestAgentJsonSchema(origin) as JSONSchemaNode & { required?: string[] };
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties ?? {}).map(([field, node]) =>
    `- \`${field}\`${required.has(field) ? ' (required)' : ''}: ${node.description ?? ''}`.trimEnd());
  return [
    'This page is for a person, and for the agent a person asks to fill it in. A person can paste this into their own agent:',
    '',
    `> ${interestAgentPrompt(origin)}`,
    '',
    '## For agents',
    '',
    ...interestAgentSteps(origin).map((step, index) => `${index + 1}. ${step}`),
    '',
    '### Example',
    '',
    '```sh',
    interestAgentExample(origin),
    '```',
    '',
    `The answer is \`202\` with \`state: "confirm_sent"\` and a \`next\` sentence to pass on. A second request for the same address within a day answers \`429\`.`,
    '',
    '### Fields',
    '',
    ...fields,
    '',
  ].join('\n');
}

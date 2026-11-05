import { t } from '@shared/i18n';
import { AGENT_PAGE_LIST, type AgentPageID } from './agent-page-list';

/**
 * One page per agent product at /integrations/<id>, as data. One registry:
 * the page, the router, the agent table and the home row read it. Its ids
 * and meta descriptions are in `agent-page-list.ts`, which the page list in
 * `web/agent-surface.ts` reads, and which every product in
 * `@starlings/contracts/agent-products` must be in. The words are keyed by the
 * same ids, so a product without a page fails the typecheck. The agent's
 * name, role and source come from `AgentEcosystem.tsx`.
 *
 * Claims about Starlings name shipped behaviour only. Claims about the agent
 * come from its row in `AgentEcosystem.tsx` and the source linked there. An
 * agent that is not connected yet gets a page about the work, with the
 * connection written as what we are building with the first teams. It never
 * says the connection works. The page has no status badge: an agent that is
 * not connected says so in its connect heading and its early-access sentence.
 */

export type AgentPage = {
  id: AgentPageID;
  title: string;
  lede: string;
  /** Jobs a team hands to this agent, with the place the result lands. */
  jobs: ReadonlyArray<{ title: string; body: string }>;
  /** How the agent reaches the workspace, step by step. */
  connect: { heading: string; steps: ReadonlyArray<{ title: string; body: string }> };
  /** Why the team stays in charge: one sentence each. */
  control: readonly string[];
  /** The early-access band's sentence for this page. */
  ask: string;
};

type Step = { title: string; body: string };

/** How an agent we are connecting joins as a Team agent: beside people, messaged and handed cards. */
const TEAM_AGENT_STEPS: readonly Step[] = [
  { title: t('Your agent, your workspace'), body: t('It reaches Starlings through one connector, signed in as the person who set it up, with the same access that person has.') },
  { title: t('In your team list'), body: t('The agent sits in Team next to your people. Message it, mention it in a project, or hand it a task.') },
  { title: t('Work goes on the project'), body: t('Its replies go to the thread it was asked in, and its results go on the project. Nothing lives only in a private chat.') },
];

/** How a personal assistant we are connecting works: as the member who connects it. */
const PERSONAL_STEPS: readonly Step[] = [
  { title: t('Connect it as you'), body: t('It reaches Starlings through one connector, signed in as you. It reads only what you can read.') },
  { title: t('Ask from where you are'), body: t('Ask it about a client, a call or a task, and it answers from the projects you can open.') },
  { title: t('Work comes back to the project'), body: t('What it makes, a brief, a draft or a task, is filed on the project under your name.') },
];

/** The guarantees every agent we are connecting gets: shipped Starlings behaviour. */
const CANDIDATE_CONTROL: readonly string[] = [
  t('The agent acts as the person who connected it, never with more access than that person has.'),
  t('When it needs a person to choose, it files a decision in your INBOX with its options and a recommendation.'),
  t('An admin sees each agent’s activity and can freeze one.'),
];

const WORDS: Record<AgentPageID, Omit<AgentPage, 'id'>> = {
  'eve': {
    title: t('Your own agents, on Vercel Eve.'),
    lede: t('Envisioning’s shared agents run on Vercel Eve. Each one has its own skills, connections and keys, and sits in your team list next to your people. Hand it a card and it replies in the thread.'),
    jobs: [
      { title: t('A teammate that takes cards'), body: t('Hand a task or an issue to the agent. It works the card in one session, and every turn resumes it.') },
      { title: t('Jobs on a schedule'), body: t('Eve runs scheduled work. The agent lists its schedules on its Team profile, so everyone knows what it does and when.') },
      { title: t('Skills you write down'), body: t('Teach the agent a workflow as a Markdown skill. Its profile shows the skills, tools and connections it has.') },
    ],
    connect: {
      heading: t('How an Eve agent joins your team.'),
      steps: [
        { title: t('Run it on Eve'), body: t('The agent runs on Vercel Eve with its own tools, sandbox, skills and keys.') },
        { title: t('Signed handoffs'), body: t('Starlings signs each message and handoff it sends the agent, so the agent knows the work is real and who asked.') },
        { title: t('Replies in the thread'), body: t('The agent replies on the card or in the thread it was asked in. Starlings shows when it is working, ready or not connected.') },
      ],
    },
    control: [
      t('The agent acts for the person who asked, and each job names that person.'),
      t('When it needs a person to choose, it files a decision in your INBOX with its options and a recommendation.'),
      t('An admin sees each agent’s activity and can freeze one. A watchdog resets an agent that gets stuck.'),
    ],
    ask: t('Put your own agent in your team list. Tell us what it should do.'),
  },
  'claude': {
    title: t('{name}, on your team’s projects.', { name: 'Claude' }),
    lede: t('Connect Claude to Starlings and it reads what you can read: every call transcript, task, decision and document, filed by project. It prepares the work, files it where your team looks, and asks you when a person needs to decide.'),
    jobs: [
      { title: t('Brief the next call'), body: t('Claude reads the last calls, the open tasks and the decisions on a client, and files a one-page brief on the project before you join.') },
      { title: t('Turn a call into work'), body: t('After a meeting, Claude reads the transcript, creates the tasks people committed to, and records what the room decided.') },
      { title: t('Answer from the record'), body: t('Ask what was agreed with a client in March. Claude searches calls, messages and documents across every project you can open, and links the source.') },
      { title: t('Keep the docs current'), body: t('Claude drafts and updates documents on the project, so the next person, or the next agent, starts from the latest version.') },
    ],
    connect: {
      heading: t('Connected in a minute.'),
      steps: [
        { title: t('Add the connector'), body: t('In claude.ai, Claude Desktop or Claude Code, add your workspace’s MCP address as a custom connector.') },
        { title: t('Sign in as you'), body: t('Claude pairs as you. It reads only what you can read. Tick Also write to let it create tasks, send messages and file documents.') },
        { title: t('Ask'), body: t('Claude gets tools for search, transcripts, tasks, decisions, messages, documents and the calendar. Each one works on the same projects your team uses.') },
      ],
    },
    control: [
      t('Every message Claude sends is yours, and shows “via claude.ai” beside it, so readers can tell.'),
      t('When Claude runs without you and needs a person to choose, it files a decision in your INBOX with its options and a recommendation. It never applies the recommendation for you.'),
      t('Starlings records every call Claude makes. Pause a Claude at its next call, or revoke the pairing, from Settings.'),
    ],
    ask: t('Connect Claude to one real project and see what it does with your team’s history.'),
  },
  'grok-bot': {
    title: t('{name}, on your team’s projects.', { name: 'Grok Bot' }),
    lede: t('Grok Bot works on its own cloud computer: it browses, runs routines and keeps memory. Starlings files each result on the project it belongs to, beside the calls, tasks and decisions your team already has.'),
    jobs: [
      { title: t('The Monday scan'), body: t('A routine checks competitors, news and filings, and the summary goes to the client project, where the team reads it before the weekly call.') },
      { title: t('Research on a card'), body: t('Hand Grok Bot a task. It does the browser work and replies on the task, so the result and the request stay together.') },
      { title: t('Follow-ups after a call'), body: t('Grok Bot reads what the meeting decided and does the legwork: lookups, forms and first drafts, filed on the project.') },
      { title: t('One bot, the whole team'), body: t('Anyone on the project can message the bot. Everyone sees what it did and who asked for it.') },
    ],
    connect: { heading: t('How we are connecting {name}.', { name: 'Grok Bot' }), steps: TEAM_AGENT_STEPS },
    control: CANDIDATE_CONTROL,
    ask: t('We are setting up {name} with our first teams. Tell us what yours does, and we will connect it with you.', { name: 'Grok Bot' }),
  },
  'openclaw': {
    title: t('{name}, on your team’s projects.', { name: 'OpenClaw' }),
    lede: t('OpenClaw is an agent runtime you operate: shell, files, browser, search, skills and plugins, with background work. In Starlings it joins your team list, and its work goes on the project where people can see it.'),
    jobs: [
      { title: t('Background jobs, in the open'), body: t('OpenClaw runs automation in the background. Each result goes on the project it belongs to, not into a log nobody reads.') },
      { title: t('Hands-on tasks'), body: t('Hand it a card that needs a shell, files or a browser. It replies on the card when the work is done.') },
      { title: t('Agents that coordinate'), body: t('OpenClaw coordinates across agents. In Starlings, each handoff is saved with who asked for it.') },
    ],
    connect: { heading: t('How we are connecting {name}.', { name: 'OpenClaw' }), steps: TEAM_AGENT_STEPS },
    control: CANDIDATE_CONTROL,
    ask: t('We are setting up {name} with our first teams. Tell us what yours does, and we will connect it with you.', { name: 'OpenClaw' }),
  },
  'hermes': {
    title: t('{name}, on your team’s projects.', { name: 'Hermes' }),
    lede: t('Hermes learns how your team works: it keeps memory, recalls past sessions and writes its own skills. Starlings gives it the record to learn from. Calls, tasks and decisions sit on each project, and its work goes back there.'),
    jobs: [
      { title: t('Work that gets better'), body: t('Hermes turns a job it repeats into a skill. Run it against the same projects every week and it learns your team’s way.') },
      { title: t('Scheduled work'), body: t('Hermes runs work on a schedule and delegates parts of it. The results go to the project, not to a terminal.') },
      { title: t('Browser and files'), body: t('Hand it a task that needs the browser or files. It replies on the task with what it found.') },
    ],
    connect: {
      heading: t('How {name} joins your team.', { name: 'Hermes' }),
      steps: [
        { title: t('Run the adapter'), body: t('The Starlings adapter runs next to your Hermes, with a public https address. It is open source.') },
        { title: t('An admin approves it'), body: t('The adapter asks your workspace to let Hermes join and shows a code. An admin checks the code and approves it.') },
        { title: t('In your team list'), body: t('Hermes sits in Team next to your people. It answers in the conversation and reads Starlings as the person who asked.') },
      ],
    },
    control: CANDIDATE_CONTROL,
    ask: t('Connect your {name} to one real project and see what it does with your team’s history.', { name: 'Hermes' }),
  },
  'openai-dots': {
    title: t('{name}, on your team’s projects.', { name: 'OpenAI Dots' }),
    lede: t('Dots is an always-on assistant with its own cloud computer, connected apps and memory. Connect it to Starlings and it works from your team’s projects: the calls, tasks and decisions you can open.'),
    jobs: [
      { title: t('Ongoing tasks'), body: t('Dots keeps working on a task in the background. What it finds goes on the project, where your team can see it.') },
      { title: t('Context before you ask'), body: t('Dots reads the projects you can open, so it starts from the last call and the open tasks, not from a blank chat.') },
      { title: t('Work handed on'), body: t('Dots delegates to background agents. The result comes back to the project under your name.') },
    ],
    connect: { heading: t('How we are connecting {name}.', { name: 'OpenAI Dots' }), steps: PERSONAL_STEPS },
    control: CANDIDATE_CONTROL,
    ask: t('We are setting up {name} with our first teams. Tell us what yours does, and we will connect it with you.', { name: 'OpenAI Dots' }),
  },
  'meta-muse': {
    title: t('{name}, on your team’s projects.', { name: 'Meta Muse' }),
    lede: t('Muse works on a computer, a browser and your files, and makes documents, PDFs and websites. Connect it to Starlings and what it makes goes to the project, where your team reviews it.'),
    jobs: [
      { title: t('Deliverables on the project'), body: t('Muse drafts the document, the PDF or the page. Starlings files it on the project, beside the call that asked for it.') },
      { title: t('Proactive work'), body: t('Muse works ahead and runs tasks in parallel. Each result goes to the project, not to a private chat.') },
      { title: t('From your own context'), body: t('Muse reads the projects you can open, so its drafts start from what your team already decided.') },
    ],
    connect: { heading: t('How we are connecting {name}.', { name: 'Meta Muse' }), steps: PERSONAL_STEPS },
    control: CANDIDATE_CONTROL,
    ask: t('We are setting up {name} with our first teams. Tell us what yours does, and we will connect it with you.', { name: 'Meta Muse' }),
  },
  'instinct': {
    title: t('{name}, on your team’s projects.', { name: 'Instinct' }),
    lede: t('Instinct is a personal assistant you reach by text and by call. It operates your phone and computer and follows up on its own. Starlings could file its follow-ups on the project they are about.'),
    jobs: [
      { title: t('Follow-ups the team sees'), body: t('A follow-up from Instinct goes on the project, where the team sees it, not only on your phone.') },
      { title: t('Context from the record'), body: t('Instinct answers with what is on your projects: the last call, the open tasks and the decisions.') },
      { title: t('A text away'), body: t('Ask by text or call. The answer and the work it does are filed where your team works.') },
    ],
    connect: { heading: t('How we are looking at Instinct.'), steps: PERSONAL_STEPS },
    control: CANDIDATE_CONTROL,
    ask: t('We are looking at Instinct with our first teams. Tell us how you use it.'),
  },
  'manus': {
    title: t('{name}, on your team’s projects.', { name: 'Manus' }),
    lede: t('Manus takes a task and comes back with a deliverable: research, files and documents made in its own cloud sandbox. Starlings gives that work an address. The task, the result and the review sit on one project.'),
    jobs: [
      { title: t('Research, delivered'), body: t('Hand Manus a research task on a card. The deliverable comes back to the card for a person to review.') },
      { title: t('Result beside the request'), body: t('The finished work sits on the task it answers, so nobody chases a link.') },
      { title: t('Briefs from the record'), body: t('Manus reads the projects you can open, so its research starts from your calls and decisions.') },
    ],
    connect: { heading: t('How we are connecting {name}.', { name: 'Manus' }), steps: PERSONAL_STEPS },
    control: CANDIDATE_CONTROL,
    ask: t('We are setting up {name} with our first teams. Tell us what yours does, and we will connect it with you.', { name: 'Manus' }),
  },
  'gemini-enterprise': {
    title: t('{name}, on your team’s projects.', { name: 'Gemini Enterprise' }),
    lede: t('Gemini Enterprise runs research and multi-step work across your company’s knowledge, with agents your IT team manages. Starlings adds the projects: each call, task and decision, filed where the work happens.'),
    jobs: [
      { title: t('Research across the company'), body: t('Gemini researches across company knowledge and files the answer on the project that asked.') },
      { title: t('Multi-step workflows'), body: t('Workflows that end in a decision put the decision in a person’s INBOX, with the options.') },
      { title: t('Agents your IT team runs'), body: t('Custom agents built on Google’s tools stay under central management. In Starlings each one acts for a named person.') },
    ],
    connect: { heading: t('How we are connecting {name}.', { name: 'Gemini Enterprise' }), steps: PERSONAL_STEPS },
    control: CANDIDATE_CONTROL,
    ask: t('We are setting up {name} with our first teams. Tell us what yours does, and we will connect it with you.', { name: 'Gemini Enterprise' }),
  },
  'copilot-studio': {
    title: t('{name}, on your team’s projects.', { name: 'Copilot Studio agents' }),
    lede: t('Teams on Microsoft 365 build agents in Copilot Studio, with workflows, connectors and MCP tools. Starlings gives those agents your projects: the calls, tasks and decisions, in one place.'),
    jobs: [
      { title: t('Workflows that file their work'), body: t('A Copilot Studio workflow writes its result to the project, where the team will look for it.') },
      { title: t('Answers from your projects'), body: t('Your agent answers from Starlings’ calls, tasks and documents, alongside the knowledge it already uses.') },
      { title: t('Logged handoffs'), body: t('When one agent hands work to another, Starlings shows who asked and where it went.') },
    ],
    connect: { heading: t('How we are connecting {name}.', { name: 'Copilot Studio' }), steps: PERSONAL_STEPS },
    control: CANDIDATE_CONTROL,
    ask: t('We are setting up {name} with our first teams. Tell us what yours does, and we will connect it with you.', { name: 'Copilot Studio' }),
  },
};

/** The pages, in the list's order. */
export const AGENT_PAGES: readonly AgentPage[] = AGENT_PAGE_LIST.map(({ id }) => ({ id, ...WORDS[id] }));

export const agentPage = (id: string) => AGENT_PAGES.find((page) => page.id === id);

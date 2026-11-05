import { t } from '../../src/i18n';

/**
 * The team pages (/for/<slug>) and the comparison pages (/compare/<slug>), as
 * data. One registry: the pages, the page list in `web/agent-surface.ts`, the
 * router and the index pages all read it, so a page added here is listed,
 * prerendered and routed with nothing else to edit.
 *
 * Claims about Starlings name shipped behaviour only (the same facts as
 * /workspace, /security and /integrations). Claims about another product name
 * the source they came from and the date it was checked, and every comparison
 * says where the other product is the better choice.
 */

export type TeamPage = {
  slug: string;
  /** The team, as a reader names it: "Consultancies". */
  name: string;
  description: string;
  title: string;
  lede: string;
  /** The week before Starlings, one situation per line. */
  today: readonly string[];
  /** The work, step by step, in Starlings. */
  steps: ReadonlyArray<{ title: string; body: string }>;
  /** Jobs a team hands to an agent, each one a sentence. */
  agentJobs: readonly string[];
  /** The tools a team of this kind usually retires. */
  replaces: readonly string[];
};

export const TEAM_PAGES: readonly TeamPage[] = [
  {
    slug: 'consultancies',
    name: 'Consultancies',
    description: 'Starlings for consultancies: client calls, notes, tasks and documents on each engagement, with AI agents that work from the same history.',
    title: 'Every client engagement, in one place.',
    lede: 'Your team talks to clients all day. Starlings files each call, its notes and its follow-ups on the engagement it belongs to, so your consultants and your AI agents always work from the same history.',
    today: [
      'Client calls happen on Zoom, and the notes stay wherever the person who took them keeps notes.',
      'Action items live in a spreadsheet, a task tool and three inboxes.',
      'Preparing for a steering meeting means reading a month of threads.',
      'Your agents can read each tool, but nothing tells them which client a note was about.',
    ],
    steps: [
      { title: 'Kick-off', body: 'Send the client a booking link. They join the call from a browser, with no account, and your Mac transcribes it as it happens.' },
      { title: 'After the call', body: 'Starlings files the transcript and a summary on the client, and suggests a task for each commitment, with the exact quote.' },
      { title: 'Between calls', body: 'Tasks, decisions, documents and the client thread all sit on the engagement. Anyone who opens it sees where things stand.' },
      { title: 'Before the next call', body: 'Ask Claude for a brief. It reads the last calls, the open tasks and the decisions on the engagement, and files the brief there.' },
    ],
    agentJobs: [
      'Draft a steering-meeting brief from the last month of calls and decisions.',
      'List every commitment the team made to a client and what is still open.',
      'Turn a call transcript into a first draft of the follow-up email.',
    ],
    replaces: ['A meeting notetaker', 'A separate task tool', 'Shared folders for client notes', 'Zaps that copy notes between tools'],
  },
  {
    slug: 'studios',
    name: 'Studios and agencies',
    description: 'Starlings for design studios and agencies: briefs, client reviews, feedback, tasks and client logins on each project, with AI agents on the same work.',
    title: 'Client work, from brief to delivery, in one place.',
    lede: 'Briefs, reviews, feedback and delivery, filed on the client project. Your team, your freelancers and your AI agents work from the same brief and the same feedback.',
    today: [
      'The brief is in one tool, the feedback is in a call nobody wrote down, and the tasks are in another tool.',
      'Client logins sit in a shared password sheet.',
      'Every review means chasing what the client said last time.',
      'New people on a project start by asking for context.',
    ],
    steps: [
      { title: 'Brief', body: 'Write the brief in Docs on the client project, with versions and comments on each passage.' },
      { title: 'Review', body: 'The client books a review from your booking page and joins from a browser. The call’s transcript and feedback go on the project.' },
      { title: 'Feedback to tasks', body: 'Starlings suggests a task for each change the client asked for. Accept one and it links back to the call it came from.' },
      { title: 'Delivery', body: 'Development studios map a GitHub repository to the project, so issues and pull requests sit next to the brief.' },
    ],
    agentJobs: [
      'Summarize every piece of client feedback on a project, grouped by deliverable.',
      'Draft a creative brief from the kick-off call and the client’s documents.',
      'Check what changed since the last review and list it for the next one.',
    ],
    replaces: ['A meeting notetaker', 'A shared password sheet, with Keep', 'A separate task tool', 'Feedback threads spread across email and chat'],
  },
  {
    slug: 'research',
    name: 'Research and advisory teams',
    description: 'Starlings for research and advisory teams: interviews, transcripts, findings, decisions and reports on each project, with AI agents that cite the source.',
    title: 'Interviews, findings and reports, on the project they belong to.',
    lede: 'Run interviews from Starlings or transcribe the ones on Zoom, Teams and Google Meet. Every transcript goes on its project, so your analysts and your AI agents work from the same sources.',
    today: [
      'Interviews are recorded in four tools, and the transcripts live in folders nobody opens again.',
      'A finding in a report cannot be traced back to the interview it came from.',
      'Decisions about scope live in someone’s memory.',
      'Agents summarize well, but they have no idea which project an interview belongs to.',
    ],
    steps: [
      { title: 'Interview', body: 'Host the interview in Starlings, or let your Mac transcribe a Zoom, Teams or Google Meet call. Speakers are named.' },
      { title: 'File', body: 'The transcript and its summary go on the project. Quick Notes stay private until you file them.' },
      { title: 'Decide', body: 'Record what the team settled as a decision, with its source: a line in the thread, a call or a note.' },
      { title: 'Report', body: 'Ask Claude to draft a synthesis from the project’s transcripts. It reads them in one place and files the draft as a document.' },
    ],
    agentJobs: [
      'Draft a synthesis of ten interviews, with the quote behind each finding.',
      'Find every time a participant mentioned a topic, across a project’s transcripts.',
      'Prepare an interview guide from the project’s open questions.',
    ],
    replaces: ['A recording and transcription tool', 'Folders of transcripts', 'A separate task tool', 'A wiki for decisions'],
  },
  {
    slug: 'product-teams',
    name: t('Product crews'),
    description: t('Starlings for founders and small crews shipping a product: user calls, decisions, GitHub issues and coding agents on the product, with one history behind every change.'),
    title: t('Why it was built, next to what was built.'),
    lede: t('You are a few founders and builders, and coding agents do part of the work. User calls, decisions and GitHub issues sit on the product they belong to, so your people and your agents work from the same history.'),
    today: [
      t('User calls happen on whatever link the other person sent, and what you learned stays in one founder’s notes.'),
      t('Each of you runs a coding agent in a private chat, and the others never see what it was asked to do.'),
      t('A coding agent can read the repository, but not the call where you decided what to build.'),
      t('You decide things in a group chat, and by the next morning nobody can find where.'),
    ],
    steps: [
      { title: t('Talk to users'), body: t('Run user calls in Starlings, or let your Mac transcribe a Zoom, Teams or Google Meet call. The transcript goes on the product.') },
      { title: t('Decide'), body: t('Record what the team settled as a decision, with its source: a call, a line in the thread or a note.') },
      { title: t('Build'), body: t('Map a GitHub repository to the product. Issues and pull requests appear in Work, and every change shows up in the product’s thread.') },
      { title: t('Hand off'), body: t('Give an issue to an agent. Tasks and issues share one set of stages, an agent stops at Review, and anyone can take a card back.') },
    ],
    agentJobs: [
      t('Pick up a GitHub issue on a mapped repository and report back on the card.'),
      t('Draft a spec from the product’s user calls and the decisions already made.'),
      t('Summarize what changed this week from the product’s issues, calls and thread.'),
    ],
    replaces: [t('A meeting notetaker for user calls'), t('Decisions spread across a group chat and docs'), t('A separate board next to GitHub'), t('Private agent chats nobody else can read')],
  },
  {
    // The new-crew reader (STRATEGY (HQ Docs) §Who it is for): a few people
    // starting something, with agents on the team from the first day.
    slug: 'new-companies',
    name: t('New companies'),
    description: t('Starlings for new companies: founders and small crews who work with AI agents from day one, with every call, task and document on the project.'),
    title: t('Start the company with your agents on the team.'),
    lede: t('You are a few people with a lot to do. Starlings gives your crew and your AI agents one workspace, organized by project, so the work gets done and nobody loses track of it.'),
    today: [
      t('Calls happen on whatever tool the other person sent, and the notes stay in someone’s head.'),
      t('Each of you works with an agent in a private chat, and the rest of the team never sees what it did.'),
      t('Decisions live in a group chat that scrolls past them in a day.'),
      t('Every new tool is another login, another bill and another place to look.'),
    ],
    steps: [
      { title: t('Day one'), body: t('Set up the workspace and your first project: the launch, the product or the first customer. Invite the people, and add your agents to the same team.') },
      { title: t('Every call'), body: t('Host from a Mac or iPhone, or let your Mac transcribe a Zoom, Teams or Google Meet call. The transcript and the tasks from it go on the project.') },
      { title: t('Hand off'), body: t('Hand an agent a card in Work, or write in the project’s thread. The agent stops at Review until a person accepts the work, and its drafts go into Docs.') },
      { title: t('Grow'), body: t('Add people and agents when you need them. Pricing is per workspace, so neither adds a seat, and each new person reads the project’s whole history.') },
    ],
    agentJobs: [
      t('Prepare a brief before a call with an investor, a customer or a partner.'),
      t('Turn the week’s calls into a list of decisions and open tasks.'),
      t('Draft the proposal, the update or the follow-up email from what is already on the project.'),
    ],
    replaces: [t('A group chat for decisions'), t('A meeting notetaker'), t('A separate task tool'), t('A private chat with each agent')],
  },
];

export type ComparisonRow = { topic: string; starlings: string; them: string };

export type ComparisonPage = {
  slug: string;
  /** What Starlings is compared with, as a reader names it: "Notion". */
  name: string;
  description: string;
  title: string;
  lede: string;
  /** The date the facts about the other product were checked, and where. */
  checked: string;
  sources: ReadonlyArray<{ label: string; href: string }>;
  rows: readonly ComparisonRow[];
  /** Where the other product is the better choice. */
  theyWin: readonly string[];
  /** Where Starlings is the better choice. */
  weWin: readonly string[];
};

export const COMPARISON_PAGES: readonly ComparisonPage[] = [
  {
    slug: 'tool-stack',
    name: 'your tool stack',
    description: 'Starlings compared with Zoom, Slack, Notion and a meeting notetaker wired together: calls, notes, tasks, chat, agents and pricing.',
    title: 'One workspace instead of five tools.',
    lede: 'Many teams run their projects on Zoom, Slack, Notion and a meeting notetaker, joined by integrations. Each tool works. Each project’s history ends up split across all of them, and your agents need a connection to each one.',
    checked: '3 October 2026',
    sources: [
      { label: 'Zoom pricing', href: 'https://zoom.us/pricing' },
      { label: 'Slack pricing', href: 'https://slack.com/pricing' },
      { label: 'Notion pricing', href: 'https://www.notion.com/pricing' },
      { label: 'the Zoom MCP server', href: 'https://developers.zoom.us/docs/mcp/zoom-mcp-server/' },
      { label: 'the Slack MCP server', href: 'https://docs.slack.dev/ai/slack-mcp-server/' },
      { label: 'the Notion MCP server', href: 'https://developers.notion.com/docs/mcp' },
    ],
    rows: [
      { topic: 'Calls', starlings: 'Hosted from a Mac or iPhone. Guests join from a browser, with no account.', them: 'Zoom hosts the call. Notes come from a separate notetaker.' },
      { topic: 'Call notes', starlings: 'Transcribed on the host’s device and filed on the project when the call ends, with suggested tasks.', them: 'The notetaker writes them. Someone files them, or an integration copies them into another tool.' },
      { topic: 'Tasks and docs', starlings: 'On the same project as the calls and the chat.', them: 'In Notion or a task tool, linked to calls by hand.' },
      { topic: 'Chat', starlings: 'One thread per person, group or project, next to the work.', them: 'Slack, in channels that are not tied to a project.' },
      { topic: 'AI agents', starlings: 'Claude connects once, through one MCP endpoint, and works across every part, as you.', them: 'Zoom, Slack and Notion each have their own MCP server. An agent connects to each one and pieces the project together.' },
      { topic: 'Pricing', starlings: 'Proposed: a price per workspace, never per person or agent.', them: 'Each tool is priced per user, so every new person adds a seat in each one.' },
      { topic: 'Upkeep', starlings: 'Nothing to connect between calls, notes, tasks and chat.', them: 'You keep the integrations between the tools working.' },
    ],
    theyWin: [
      'Your hosts use Windows or Android. Starlings hosts calls from a Mac or iPhone.',
      'You are a large company, or depend on hundreds of app integrations.',
      'You rely on the depth of one tool, such as Notion databases.',
    ],
    weWin: [
      'Your team runs several projects at once, and you want each project’s history in one place.',
      'You want your agents to work from the same context as your team.',
      'You want fewer tools and fewer seats to pay for.',
    ],
  },
  {
    slug: 'notion',
    name: 'Notion',
    description: 'Starlings compared with Notion: calls, meeting notes, docs, tasks, chat, AI agents and pricing.',
    title: 'Notion holds the documents. Starlings holds the conversation around them.',
    lede: 'Notion is a deep workspace for documents, databases and projects. Starlings is built around calls: it hosts them, transcribes them on your device and files them on the project, next to the chat, tasks and docs.',
    checked: '3 October 2026',
    sources: [
      { label: 'Notion AI Meeting Notes', href: 'https://www.notion.com/help/ai-meeting-notes' },
      { label: 'Notion pricing', href: 'https://www.notion.com/pricing' },
      { label: 'Notion Custom Agents', href: 'https://www.notion.com/help/custom-agents' },
      { label: 'the Notion MCP server', href: 'https://developers.notion.com/docs/mcp' },
      { label: 'Notion Calendar', href: 'https://www.notion.com/product/calendar' },
    ],
    rows: [
      { topic: 'Calls', starlings: 'Hosts them from a Mac or iPhone. Guests join from a browser, with no account.', them: 'Does not host calls. AI Meeting Notes works with calls on Google Meet, Zoom and Microsoft Teams.' },
      { topic: 'Transcription', starlings: 'On the host’s device. Audio never leaves it, and only the text is kept.', them: 'No bot joins the call. The desktop app captures the audio, and transcription runs in the cloud through Notion’s sub-processors.' },
      { topic: 'Documents', starlings: 'Docs with versions, comments on a passage and saved links, filed on the project.', them: 'Pages, wikis and databases, with far more ways to structure them.' },
      { topic: 'Tasks', starlings: 'Tasks and GitHub issues on the project, suggested from what was said in calls.', them: 'Projects and tasks in databases you design.' },
      { topic: 'Chat', starlings: 'One thread per person, group or project.', them: 'We found no team chat on Notion’s product pages.' },
      { topic: 'Calendar', starlings: 'Company meetings, your tasks and personal calendars in one view, with a booking page.', them: 'Notion Calendar connects Google, Outlook and iCloud calendars.' },
      { topic: 'AI agents', starlings: 'Connect Claude through MCP, or hand work to shared agents in your team list. Included in the workspace.', them: 'Notion Agent and Custom Agents on the Business plan and above. Custom Agents use paid credits. Notion also has an MCP server.' },
      { topic: 'Pricing', starlings: 'Proposed: a price per workspace, never per person or agent.', them: 'Per member. AI Meeting Notes needs the Business plan.' },
    ],
    theyWin: [
      'You need flexible databases and a deep wiki.',
      'Your calls already run on Zoom or Teams and you only want notes next to your docs.',
      'Your team is larger than 50, or works mainly on Windows.',
    ],
    weWin: [
      'Calls are the center of your work.',
      'You want calls transcribed on your own device.',
      'You want calls, chat, tasks and docs in one place, without a separate chat tool.',
      'You want agents included in the workspace price, not billed per run.',
    ],
  },
  {
    slug: 'notetakers',
    name: 'meeting notetakers',
    description: 'Starlings compared with Granola, Fireflies and Otter: how each captures a call, where the notes go, and how agents reach them.',
    title: 'Notes on the project, not in another app.',
    lede: 'Granola, Fireflies and Otter take notes on calls that happen somewhere else. Starlings hosts the call, writes the transcript on your device and files it on the project, with the tasks, chat and docs around it.',
    checked: '3 October 2026',
    sources: [
      { label: 'Granola transcription', href: 'https://docs.granola.ai/help-center/taking-notes/transcription.md' },
      { label: 'Granola security FAQ', href: 'https://docs.granola.ai/help-center/consent-security-privacy/security-privacy-data-faqs.md' },
      { label: 'Granola pricing', href: 'https://www.granola.ai/pricing' },
      { label: 'Fireflies pricing', href: 'https://fireflies.ai/pricing' },
      { label: 'Fireflies bot-free recording', href: 'https://guide.fireflies.ai/articles/6666374717-how-to-record-meetings-without-a-bot-on-the-fireflies-desktop-app' },
      { label: 'Otter Notetaker', href: 'https://help.otter.ai/hc/en-us/articles/4425393298327-Otter-Notetaker-Overview' },
      { label: 'Otter audio export', href: 'https://help.otter.ai/hc/en-us/articles/13828318539031-Export-conversation-audio' },
      { label: 'Otter pricing', href: 'https://otter.ai/pricing' },
    ],
    rows: [
      { topic: 'Calls', starlings: 'Hosts them from a Mac or iPhone. The Mac app also transcribes Zoom, Teams and Google Meet calls.', them: 'None of the three hosts calls. They work with calls on Zoom, Google Meet and Teams.' },
      { topic: 'In the call', starlings: 'No bot. The host’s device transcribes.', them: 'Granola uses no bot. Fireflies and Otter send a bot by default, and each has a desktop mode without one.' },
      { topic: 'Audio', starlings: 'Never stored. Transcription runs on the host’s device, and only the text leaves it.', them: 'Granola deletes audio after cloud transcription. Otter keeps audio you can export. Fireflies records video on Pro and above.' },
      { topic: 'After the call', starlings: 'The transcript and summary are filed on the project, with a suggested task for each commitment.', them: 'Notes, summaries and AI chat over your meetings, in the notetaker’s own app.' },
      { topic: 'The rest of the work', starlings: 'Tasks, chat, docs and calendar on the same project.', them: 'Notes, first of all. Otter adds team chat in Channels. We found no tasks or projects in any of the three.' },
      { topic: 'AI agents', starlings: 'Claude works across calls, tasks, chat and docs through one MCP endpoint, as you. Shared agents sit in your team list.', them: 'All three offer an MCP server for their meeting notes. Granola’s needs the Business plan.' },
      { topic: 'Pricing', starlings: 'Proposed: a price per workspace, never per person or agent.', them: 'Per user, for all three.' },
    ],
    theyWin: [
      'You only want notes, and your calls stay on Zoom or Teams.',
      'You need many transcription languages. Fireflies lists more than 100, and Granola lists 31.',
      'You want a recording to replay. Otter keeps audio, and Fireflies records video.',
      'Your hosts use Windows.',
    ],
    weWin: [
      'You want notes filed on the project, next to the tasks and the chat.',
      'You want no bot and no stored audio, with transcription on your own device.',
      'You want your agents to work across calls and everything around them.',
    ],
  },
];

export const teamPage = (slug: string) => TEAM_PAGES.find((page) => page.slug === slug);
export const comparisonPage = (slug: string) => COMPARISON_PAGES.find((page) => page.slug === slug);

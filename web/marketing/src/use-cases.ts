import { t } from '../../src/i18n';

/** Config-safe registry: routes, HTML, simulations and Markdown read the same jobs. */
export const USE_CASES = [
  { slug: 'client-call-brief', title: t('Prepare a client-call brief'),
    summary: t('Walk into the next client call with the goal, the last conversation and open questions in view.'),
    audience: '/for/consultancies', capabilities: ['owner-docs', 'owner-work', 'collab-artifacts'],
    prompt: t('Prepare a brief for the next client call. Use the project brief, recent transcript and playbook. Cite each source, separate facts from open questions, and leave a draft for me to review.'),
    review: t('Check the goal and unresolved questions before the call. The agent cannot know what changed outside the project record.'),
    output: t('Call brief'), help: '/help/howto/connect-claude' },
  { slug: 'call-follow-up', title: t('Turn a client call into follow-up work'),
    summary: t('Use the finalized transcript to propose tasks with an owner and a project, then review the hand-off.'),
    audience: '/for/consultancies', capabilities: ['collab-artifacts', 'owner-work'],
    prompt: t('Read the finalized call transcript. Draft follow-up tasks on this project with a proposed owner and the supporting quote. Ask me to confirm missing owners or dates before creating tasks.'),
    review: t('Confirm the owner, date and project before filing each task. A proposal in the transcript is not an accepted task.'),
    output: t('Follow-up task draft'), help: '/help/surfaces/work' },
  { slug: 'proposal-from-playbook', title: t('Draft a proposal from your company playbook'),
    summary: t('Bring the client brief and your established way of working into one proposal draft.'),
    audience: '/for/studios', capabilities: ['owner-docs', 'owner-work'],
    prompt: t('Draft a proposal from this project brief and our company playbook. Cite the source of the scope and approach. Leave fees, dates and unsupported promises for a person to confirm. Do not send it to the client.'),
    review: t('Approve scope, pricing and commitments before sharing. Company memory supplies context; it does not authorize promises.'),
    output: t('Proposal draft'), help: '/help/surfaces/docs' },
  { slug: 'research-synthesis', title: t('Synthesize interviews with source quotes'),
    summary: t('Start a research memo from the interview record, keeping the evidence beside the interpretation.'),
    audience: '/for/research', capabilities: ['owner-docs', 'collab-artifacts'],
    prompt: t('Draft a research memo from the available interview transcripts. Keep direct quotes separate from interpretation, cite their source and mark gaps. Do not imply that one interview represents the whole study.'),
    review: t('Check every quote against its transcript and compare the wider evidence. This sample has one interview and cannot establish a research finding.'),
    output: t('Research memo draft'), help: '/help/surfaces/docs' },
  { slug: 'project-onboarding', title: t('Bring a teammate up to speed on a project'),
    summary: t('Give a new colleague a starting point in the shared project record, with links back to the evidence.'),
    audience: '/for/new-companies', capabilities: ['owner-docs', 'owner-work', 'collab-artifacts'],
    prompt: t('Prepare an onboarding note for a teammate joining this project. Explain the goal, current approach and next action using the brief, playbook and latest transcript. Cite sources and flag anything that needs an answer.'),
    review: t('Check that the teammate has access to the linked records. A summary or a link does not grant access.'),
    output: t('Project onboarding note'), help: '/help/surfaces/work' },
  { slug: 'agent-needs-an-answer', title: t('Give a blocked agent a human answer'),
    summary: t('See how one assigned question appears in chat and Inbox, and how one answer resolves both views.'),
    audience: '/for/product-teams', capabilities: ['owner-agent-interactive-questions', 'owner-question-inbox'],
    prompt: t('If the project record does not say which audience to prioritize, ask the assigned project lead a short informational question with choices. Wait for their answer and use it in the draft. Do not treat the answer as permission to publish.'),
    review: t('Only the assigned recipient answers. This is an informational question, not action approval. The linked question Inbox is available on the web; native Inbox coverage is still planned.'),
    output: t('Question'), help: '/help/howto/answer-a-question' },
] as const;

export type UseCase = typeof USE_CASES[number];
export type UseCaseSlug = UseCase['slug'];
export const useCaseHref = (job: UseCase) => `/use-cases/${job.slug}`;
export const DEMO_NOTICE = t('Interactive sample, with fictional data and scripted agent output. No agent runs and no workspace data is read or changed.');
export const SETUP_NOTICE = t('In your workspace, connect a member’s MCP client, make the source records available to that member, and ask for a draft. Shared-chat agents need their own workspace setup. Starlings provides the context and tools; your chosen agent produces the result.');
export const QUESTION_SETUP_NOTICE = t('Use a configured shared-chat agent for this example. A member’s MCP client can request a decision, but cannot create this informational question.');
export const setupFor = (job: UseCase) => job.slug === 'agent-needs-an-answer' ? QUESTION_SETUP_NOTICE : SETUP_NOTICE;
export const STEP_LABELS = [t('Sources'), t('Request'), t('Draft'), t('Review')] as const;
export const AUDIENCES = [t('Staff'), t('Managers')] as const;

/** Two coherent datasets: changing projects changes every derived draft and citation. */
export const DEMO_PROJECTS = [
  { id: 'northfield', name: 'Northfield Health',
    goal: t('Reduce the time it takes to train clinic staff.'),
    approach: t('Start with a small pilot, then review evidence before expanding.'),
    quote: t('We need a training pilot before we can choose the rollout.'),
    action: t('Draft the training pilot plan'), owner: 'Sam Lee' },
  { id: 'harbor', name: 'Harbor Works',
    goal: t('Help new customers complete their first setup.'),
    approach: t('Test the onboarding flow with a small group before changing the full service.'),
    quote: t('We need to test the first setup before changing the whole service.'),
    action: t('Draft the onboarding test plan'), owner: 'Camila Ortiz' },
] as const;
export type DemoProject = typeof DEMO_PROJECTS[number];
export type DemoState = { step: number; answer: number | null };
export const INITIAL_DEMO: DemoState = { step: 0, answer: null };
export const QUESTION = t('Which audience should the draft prioritize?');
export const sourceRecords = (project: DemoProject) => [
  { id: 'brief', title: t('Project brief'), body: project.goal },
  { id: 'playbook', title: t('Company playbook'), body: project.approach },
  { id: 'transcript', title: t('Finalized interview transcript'), body: project.quote },
];
export function answerDemo(state: DemoState, answer: number): DemoState {
  // One terminal request, shared by the drawn chat and Inbox. A second answer cannot win.
  if (state.answer !== null || !AUDIENCES[answer]) return state;
  return { step: 3, answer };
}
export function questionProjection(state: DemoState) {
  return { pending: state.answer === null, answer: state.answer === null ? null : AUDIENCES[state.answer] };
}
export function draftRows(job: UseCase, project: DemoProject, answer: number | null = null) {
  const goal = { label: t('Goal'), text: project.goal, source: 'brief' };
  const approach = { label: t('Approach'), text: project.approach, source: 'playbook' };
  const quote = { label: t('Source quote'), text: project.quote, source: 'transcript' };
  const task = { label: t('Proposed task'), text: `${project.action} · ${project.owner}`, source: 'transcript' };
  const gap = { label: t('Needs an answer'), text: QUESTION, source: null };
  switch (job.slug) {
    case 'client-call-brief': return [goal, quote, gap];
    case 'call-follow-up': return [quote, task, { label: t('Date'), text: t('Confirm with the project lead'), source: null }];
    case 'proposal-from-playbook': return [goal, approach, { label: t('Fees and dates'), text: t('Confirm before sharing'), source: null }];
    case 'research-synthesis': return [quote, { label: t('Interpretation to check'), text: project.goal, source: 'brief' }, { label: t('Evidence gap'), text: t('Compare more interviews before drawing a conclusion.'), source: null }];
    case 'project-onboarding': return [goal, approach, task, gap];
    case 'agent-needs-an-answer': return [{ label: t('Assigned recipient'), text: project.owner, source: null }, { label: QUESTION, text: answer === null ? t('Waiting for a human answer') : AUDIENCES[answer], source: null }];
  }
}

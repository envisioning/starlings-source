import type { CrmIssue } from '@starlings/contracts';
import type { DecisionAsk } from '@starlings/contracts/decision-asks';
import { useMemo } from 'react';
import { t } from '@shared/i18n';
import { SAMPLE_CALLS, useSampleMeeting, type SampleMeeting } from './sample-meeting';

/*
 * The sample workspace that HomeSim, WorkSim and ThreadsSim draw: the
 * host's day on the project of this visit's call, the day of that call in
 * MeetingSim. SAMPLE_DAYS holds one day per call in SAMPLE_CALLS, by the
 * same index; useSampleWorkspace fills it with the visit's host and guest.
 * Every sentence goes through t() at import, as the calls' do.
 * Where a part of the product reads a contract shape (the decision ask,
 * the issues), the sample is typed by it, so a change to the shape fails
 * the marketing build.
 */

export type SampleTask = {
  id: string;
  title: string;
  /** The one who owes it: a person, an agent, or nobody yet. */
  owner: string | null;
  due: string;
  late?: boolean;
};

type SampleIssue = { number: number; title: string; label?: string; by: 'host' | 'guest' | 'agent'; assignee: 'host' | 'agent'; closed?: boolean; comments: number };

/**
 * One call's day. `{guest}` in any text becomes the guest's first name.
 * The checklist is the call's agent task: the host hands it to the agent
 * in Work. The issue the agent is assigned is the one Work's tour opens.
 */
type SampleDay = {
  /** Home's clock stands still: ten minutes before the call. */
  now: [hour: number, minute: number];
  repo: string;
  lead: string;
  ask: { question: string; context: string; ship: string; wait: string };
  /** The guest's message before the call, on Home and in their conversation. */
  guestNote: string;
  /** The host's answer in the guest's conversation. */
  hostAnswer: string;
  invitation: { title: string; when: string };
  late: string;
  today: string;
  /** The task the call proposed from the guest's last line, waiting in Work's Inbox. */
  proposed: string;
  /** The guest's question on the project, the host's answer, and the agent's report after the hand-off. */
  mention: string;
  answer: string;
  report: string;
  /** The agent's message that arrives on Home. */
  agentNote: string;
  issues: readonly SampleIssue[];
  /** ThreadsSim: what the host asks the agent, its steps and its question; then the project's conversation. */
  thread: {
    ask: string;
    step: string;
    done: string;
    question: string;
    reply: string;
    project: readonly string[];
    filed: string;
  };
};

export const SAMPLE_DAYS: readonly SampleDay[] = [
  {
    now: [14, 20],
    repo: 'pilot',
    lead: t('Northfield Health pilot'),
    ask: { question: t('Ship the pilot scope this week?'), context: t('The scope is two pages.'), ship: t('Ship it'), wait: t('Wait for {guest}') },
    guestNote: t('Looking forward to the workshop. I sent the scope ahead.'),
    hostAnswer: t('Thanks, see you at 14:30.'),
    invitation: { title: t('Kickoff with Northfield Health'), when: t('Thu 9 Oct, 10:00') },
    late: t('Review the pilot scope'),
    today: t('Send the workshop brief'),
    proposed: t('Share the kickoff agenda with Northfield Health'),
    mention: t('Can we see the scope before Thursday?'),
    answer: t('Yes, it goes out today.'),
    report: t('I drafted the onboarding checklist and filed it in Documents. Two questions for {guest} are at the top.'),
    agentNote: t('The onboarding checklist draft is in Docs.'),
    issues: [
      { number: 12, title: t('Draft the pilot scope'), label: 'scope', by: 'guest', assignee: 'host', comments: 3 },
      { number: 14, title: t('Onboarding checklist for the client team'), label: 'onboarding', by: 'host', assignee: 'agent', comments: 0 },
      { number: 9, title: t('Set up the shared Docs folder'), by: 'host', assignee: 'host', closed: true, comments: 1 },
    ],
    thread: {
      ask: t('Draft the onboarding checklist for Northfield Health. Use the workshop notes.'),
      step: t('Reading the workshop notes and transcript'),
      done: t('Done.\n\n- **Read**: the notes, the transcript and 2 decisions\n- **Drafted**: 12 items in 4 sections\n- **Filed**: Documents · Onboarding checklist'),
      question: t('One gap: nobody owns the kickoff agenda yet.'),
      reply: t('On it. The draft agenda will be in this thread by Thursday morning.'),
      project: [t('Can we see the scope before Thursday?'), t('Yes. The scope is two pages: one client team, four weeks, a review on 6 November. Full draft attached to the project.')],
      filed: t('Onboarding checklist'),
    },
  },
  {
    now: [10, 50],
    repo: 'brand-refresh',
    lead: t('Brightwater Foods packaging'),
    ask: { question: t('Send the second direction to the printer today?'), context: t('The board meets next Thursday.'), ship: t('Send it'), wait: t('Wait for {guest}') },
    guestNote: t('The team has looked at all three directions. See you at 11.'),
    hostAnswer: t('Great, see you at 11:00.'),
    invitation: { title: t('Board preview with Brightwater Foods'), when: t('Thu 16 Oct, 09:30') },
    late: t('Collect feedback on the three directions'),
    today: t('Brief the photo studio'),
    proposed: t('Prepare the board preview for Brightwater Foods'),
    mention: t('Can the board see it on real packaging?'),
    answer: t('Yes, the shoot is next week.'),
    report: t('I listed the packaging mockups and filed them in Documents. Two pack sizes need {guest} to confirm.'),
    agentNote: t('The packaging mockup list is in Docs.'),
    issues: [
      { number: 21, title: t('Pick one brand direction'), label: 'design', by: 'guest', assignee: 'host', comments: 5 },
      { number: 24, title: t('Packaging mockups for every pack size'), label: 'packaging', by: 'host', assignee: 'agent', comments: 0 },
      { number: 18, title: t('Upload the three directions'), by: 'host', assignee: 'host', closed: true, comments: 2 },
    ],
    thread: {
      ask: t('List the packaging mockups Brightwater Foods needs. Use the brief and today’s call.'),
      step: t('Reading the brief and the call notes'),
      done: t('Done.\n\n- **Read**: the brief, the notes and 1 decision\n- **Listed**: 9 pack sizes in 3 ranges\n- **Filed**: Documents · Packaging mockups'),
      question: t('One gap: nobody has booked the photo studio yet.'),
      reply: t('On it. I will send the studio three dates by Wednesday.'),
      project: [t('Can the board see it on real packaging?'), t('Yes. The shoot is next week: 9 pack sizes, the second direction only. The list is attached to the project.')],
      filed: t('Packaging mockups'),
    },
  },
  {
    now: [15, 50],
    repo: 'market-scan',
    lead: t('Kestrel Logistics renewal'),
    ask: { question: t('Add the Nordics to the scan this round?'), context: t('It adds a week of research.'), ship: t('Add them'), wait: t('Ask {guest} first') },
    guestNote: t('Two new competitors launched in the Nordics. Can we talk about it at 16:00?'),
    hostAnswer: t('Yes, let’s start with that at 16:00.'),
    invitation: { title: t('Scan report with Kestrel Logistics'), when: t('Mon 20 Oct, 14:00') },
    late: t('Update the competitor list'),
    today: t('Book two analyst interviews'),
    proposed: t('Book the scan report call with Kestrel Logistics'),
    mention: t('Could you include their pricing too?'),
    answer: t('Yes, the pricing comes today.'),
    report: t('I collected the competitor pricing and filed a summary in Documents. Two plans need {guest}’s sales team to check.'),
    agentNote: t('The competitor pricing summary is in Docs.'),
    issues: [
      { number: 31, title: t('Add the Nordics to the scan'), label: 'scope', by: 'guest', assignee: 'host', comments: 4 },
      { number: 33, title: t('Collect public competitor pricing'), label: 'research', by: 'host', assignee: 'agent', comments: 0 },
      { number: 27, title: t('Refresh the 2026 competitor list'), by: 'host', assignee: 'host', closed: true, comments: 2 },
    ],
    thread: {
      ask: t('Collect the public pricing of the Nordic competitors for Kestrel Logistics.'),
      step: t('Reading the competitors’ pricing pages'),
      done: t('Done.\n\n- **Read**: 6 competitor sites\n- **Collected**: 14 plans, with sources\n- **Filed**: Documents · Competitor pricing'),
      question: t('One gap: two competitors only show prices after a demo.'),
      reply: t('On it. I will ask for both demos and add the prices when they come.'),
      project: [t('Could you include their pricing too?'), t('Yes. The pricing summary is filed: 6 competitors and 14 plans. The Nordic section is attached to the project.')],
      filed: t('Competitor pricing'),
    },
  },
  {
    now: [9, 20],
    repo: 'route-pilot',
    lead: t('Cedarline Mobility route pilot'),
    ask: { question: t('Start the two-route rider test next month?'), context: t('Six rider sessions fit the schedule.'), ship: t('Start the pilot'), wait: t('Wait for {guest}') },
    guestNote: t('We have the rider notes ready for today’s call.'),
    hostAnswer: t('Great, see you at 09:30.'),
    invitation: { title: t('Rider interviews with Cedarline Mobility'), when: t('Thu 23 Oct, 09:30') },
    late: t('Review the route notes'),
    today: t('Prepare the rider interview sheet'),
    proposed: t('Share the accessible route checklist with Cedarline Mobility'),
    mention: t('Can we see the checklist before interviews begin?'),
    answer: t('Yes, I’ll send it tomorrow.'),
    report: t('I drafted the route checklist and filed it in Documents. It covers both routes and the review before launch.'),
    agentNote: t('The route accessibility checklist is ready in Docs.'),
    issues: [
      { number: 42, title: t('Prepare the rider interview sheet'), label: 'research', by: 'host', assignee: 'host', comments: 2 },
      { number: 45, title: t('Draft the route accessibility checklist'), label: 'accessibility', by: 'host', assignee: 'agent', comments: 0 },
      { number: 39, title: t('Compare the two route maps'), by: 'guest', assignee: 'host', closed: true, comments: 1 },
    ],
    thread: {
      ask: t('Draft the route accessibility checklist for Cedarline Mobility from the pilot notes.'),
      step: t('Reading the pilot notes and rider feedback'),
      done: t('Done.\n\n- **Compared**: 2 routes\n- **Prepared**: 6 rider sessions\n- **Filed**: Documents · Route accessibility checklist'),
      question: t('One gap: the interview sheet still needs the final route names.'),
      reply: t('I’ve left the route names open for your review. The rest of the checklist is ready.'),
      project: [t('Can we see the checklist before interviews begin?'), t('Yes. The checklist covers both routes, six rider sessions and a review before launch.')],
      filed: t('Route accessibility checklist'),
    },
  },
  {
    now: [12, 50],
    repo: 'school-onboarding',
    lead: t('Fable Grove Learning pilot'),
    ask: { question: t('Test the shorter setup in three schools?'), context: t('The first teacher interviews are next week.'), ship: t('Run the pilot'), wait: t('Ask {guest} first') },
    guestNote: t('The coordinators have suggested three teachers to interview.'),
    hostAnswer: t('Thanks, I’ll bring the draft questions to the call.'),
    invitation: { title: t('Teacher onboarding with Fable Grove Learning'), when: t('Fri 24 Oct, 13:00') },
    late: t('Collect feedback on the lesson materials'),
    today: t('Book teacher interviews'),
    proposed: t('Share the teacher setup checklist with Fable Grove Learning'),
    mention: t('Can the first version include a one-page materials guide?'),
    answer: t('Yes, the guide is part of the draft.'),
    report: t('I drafted the teacher setup checklist and filed it in Documents. The one-page materials guide is attached.'),
    agentNote: t('The teacher setup checklist is ready in Docs.'),
    issues: [
      { number: 52, title: t('Book teacher interviews'), label: 'research', by: 'host', assignee: 'host', comments: 1 },
      { number: 55, title: t('Draft the teacher setup checklist'), label: 'onboarding', by: 'host', assignee: 'agent', comments: 0 },
      { number: 48, title: t('Collect the lesson materials'), by: 'guest', assignee: 'host', closed: true, comments: 3 },
    ],
    thread: {
      ask: t('Draft the teacher setup checklist for Fable Grove Learning using the pilot notes.'),
      step: t('Reading the setup notes and teacher feedback'),
      done: t('Done.\n\n- **Grouped**: 8 setup steps\n- **Drafted**: a one-page materials guide\n- **Filed**: Documents · Teacher setup checklist'),
      question: t('One gap: the coordinators have not confirmed the interview dates.'),
      reply: t('The checklist is ready. I’ve left the dates open until the coordinators confirm.'),
      project: [t('Can the first version include a one-page materials guide?'), t('Yes. The guide is attached to the checklist for the three-school pilot.')],
      filed: t('Teacher setup checklist'),
    },
  },
  {
    now: [14, 50],
    repo: 'solar-handover',
    lead: t('Blue Current Energy installation'),
    ask: { question: t('Prepare the first site while the grid date is pending?'), context: t('The inspection is booked for next week.'), ship: t('Prepare the site'), wait: t('Wait for {guest}') },
    guestNote: t('The grid connection date is still the only open item.'),
    hostAnswer: t('Understood. We can agree the handover owners at 15:00.'),
    invitation: { title: t('Site readiness review with Blue Current Energy'), when: t('Mon 27 Oct, 15:00') },
    late: t('Confirm the grid connection date'),
    today: t('Prepare the site handover list'),
    proposed: t('Review the first site handover with Blue Current Energy'),
    mention: t('Could the open dependencies and their owners be in one list?'),
    answer: t('Yes, I’ll bring it to the readiness review.'),
    report: t('I gathered the open dependencies and owners into one handover list. The grid date remains unconfirmed.'),
    agentNote: t('The site handover list is ready in Docs.'),
    issues: [
      { number: 62, title: t('Confirm the grid connection date'), label: 'schedule', by: 'guest', assignee: 'host', comments: 2 },
      { number: 65, title: t('Prepare the site handover list'), label: 'handover', by: 'host', assignee: 'agent', comments: 0 },
      { number: 59, title: t('Book the first site inspection'), by: 'host', assignee: 'host', closed: true, comments: 1 },
    ],
    thread: {
      ask: t('Prepare the site handover list for Blue Current Energy from the project notes.'),
      step: t('Reading the inspection notes and open dependencies'),
      done: t('Done.\n\n- **Listed**: 5 open dependencies\n- **Named**: an owner for each item\n- **Filed**: Documents · Site handover list'),
      question: t('The grid connection date is still unconfirmed.'),
      reply: t('I’ve marked the grid date as open and kept the second site on hold.'),
      project: [t('Could the open dependencies and their owners be in one list?'), t('Yes. The list names five open items and their owners. The second site stays on hold until the grid date is confirmed.')],
      filed: t('Site handover list'),
    },
  },
];

const firstName = (name: string) => name.split(' ')[0]!;

function sampleWorkspace(meeting: SampleMeeting) {
  const day = SAMPLE_DAYS[meeting.call]!;
  const call = SAMPLE_CALLS[meeting.call]!;
  const fill = (text: string) => text.replaceAll('{guest}', firstName(meeting.guest.name));
  const login = (who: 'host' | 'guest' | 'agent') => (who === 'agent' ? meeting.agent : who === 'host' ? meeting.host.name : meeting.guest.name).toLowerCase().replaceAll(' ', '-');
  const owner = 'example-partners';

  const decisionAsk: DecisionAsk = {
    id: '6f1c2d3e-0000-4000-8000-200000000001',
    status: 'open',
    question: day.ask.question,
    context: day.ask.context,
    options: [
      { key: 'ship', label: day.ask.ship },
      { key: 'wait', label: fill(day.ask.wait) },
    ],
    recommendation: 'ship',
    default_by: '2026-10-09',
    overdue: false,
    subject: { kind: 'project', id: '6f1c2d3e-0000-4000-8000-300000000001', title: meeting.project },
    links: [],
    waits_on_email: 'host@example.com',
    asked_by: meeting.agent,
    asked_by_email: 'agent@example.com',
    created_at: '2026-10-06T09:00:00.000Z',
    answer: null,
    answer_label: null,
    answer_note: null,
    answered_at: null,
    answered_by_email: null,
    core_decision_id: null,
  };

  /** The task nobody owns yet; Work's tour hands it to the agent. */
  const checklist: SampleTask = { id: 'checklist', title: call.agentTask.title, owner: null, due: call.agentTask.due };

  /** The project's GitHub issues, from the repository mapped to it. Typed by the contract Work reads. */
  const issues: CrmIssue[] = day.issues.map((issue) => {
    const assignee = login(issue.assignee);
    return {
      id: `${owner}/${day.repo}#${issue.number}`, number: issue.number, owner, repo: day.repo,
      title: issue.title, state: issue.closed ? 'closed' : 'open', url: `https://github.com/${owner}/${day.repo}/issues/${issue.number}`,
      labels: issue.label ? [issue.label] : [], assignee_login: assignee, assignees: [{ login: assignee, avatar_url: null }],
      author: { login: login(issue.by), avatar_url: null },
      created_at: '2026-10-01T09:00:00Z', updated_at: '2026-10-06T12:40:00Z', closed_at: issue.closed ? '2026-10-03T16:00:00Z' : null, state_reason: issue.closed ? 'completed' : null,
      issue_type: 'Task', milestone: meeting.project, comments: issue.comments, sub_issues: null,
    };
  });

  return {
    now: new Date(2026, 9, 6, ...day.now),
    decisionAsk,
    messages: [{ id: 'guest', from: meeting.guest.name, preview: day.guestNote, when: '12 min' }],
    /** The message that arrives while the visitor watches Home. */
    agentMessage: { id: 'agent', from: meeting.agent, preview: day.agentNote, when: 'Now' },
    invitation: { id: 'invitation', title: day.invitation.title, detail: `${day.invitation.when} · Proposed by ${meeting.guest.name}` },
    subjects: [
      { id: 'pilot', title: meeting.project, detail: `${meeting.partner} · Active`, kind: 'project' },
      { id: 'lead', title: day.lead, detail: 'Lead · Qualified', kind: 'lead' },
      { id: 'research', title: 'Research library', detail: 'Internal · Active', kind: 'project' },
    ] as const,
    checklist,
    tasks: [
      { id: 'late', title: day.late, owner: meeting.host.name, due: '1 day late', late: true },
      { id: 'today', title: day.today, owner: meeting.host.name, due: 'Today' },
      checklist,
    ] satisfies SampleTask[] as SampleTask[],
    proposedTask: { id: 'proposed', title: day.proposed, quote: meeting.lines.at(-1)!.text, from: meeting.title },
    mention: day.mention,
    talk: [
      { id: 't1', kind: 'message', who: meeting.guest.name, text: day.mention },
      { id: 't2', kind: 'event', text: `${meeting.title} filed here · Notes filed` },
      { id: 't3', kind: 'message', who: meeting.host.name, text: day.answer, mine: true },
      { id: 't4', kind: 'event', text: `GitHub: issue #${day.issues[0]!.number} opened: ${day.issues[0]!.title}` },
    ] as const,
    report: fill(day.report),
    issues,
    /** The issue the agent is assigned: Work's tour opens it. */
    handedIssue: issues.find((issue) => issue.assignee_login === login('agent'))!,
    day,
  };
}

export type SampleWorkspace = ReturnType<typeof sampleWorkspace>;

/** This visit's sample workspace: the day of the visit's call, with its host and guest (useSampleMeeting). */
export function useSampleWorkspace(): SampleWorkspace {
  const meeting = useSampleMeeting();
  return useMemo(() => sampleWorkspace(meeting), [meeting]);
}

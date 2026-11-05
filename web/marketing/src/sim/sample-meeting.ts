import { WORKSPACE_HOST_SUFFIX } from '@starlings/contracts/workspace-slug';
import type { MeetingDecisionCandidate, TranscriptSegment } from '@starlings/contracts';
import { makeAgentAvatarIdentity } from '@starlings/contracts/agent-avatar-values';
import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { t } from '@shared/i18n';

/*
 * The sample meetings the simulations draw. MeetingSim draws a new call from
 * a small pool on every visit and every loop: one of SAMPLE_CALLS, with a
 * host and two guests from SAMPLE_PEOPLE, in a workspace from
 * SAMPLE_WORKSPACES. The other simulations draw one pick per visit
 * (useSampleMeeting): a call, a workspace, a host and guests, the same in
 * every simulation on the page, and that call's day (sample-workspace.ts). The
 * prerendered page, and the first render, use the fixed default,
 * SAMPLE_MEETING: Sam Lee with Amara Okafor and Priya Nair of Northfield
 * Health, in Halden Studio. Surfaces that show it keep it invisible until the
 * visit's pick is drawn (useVisitDrawnClass), so no visitor sees the swap.
 *
 * The lines and the decision are typed by the workspace contracts, so a
 * change to their shape fails the marketing build instead of drifting from
 * the product. The workspace is a sample one, so no simulation shows a real
 * company's name or mark. The people and the companies are fictional; the
 * faces are generated pictures of people who do not exist (docs/DESIGN.md,
 * Public site). Every sentence goes through t() at import: the site loads
 * its strings before a page's modules (main.tsx).
 */

/** A sample agent's seeded face, from the same recipe the workspace uses. */
export function sampleAgentIdentity(name: string) {
  return makeAgentAvatarIdentity(`${name.toLowerCase().replace(/\s+/gu, '-')}@sample.${WORKSPACE_HOST_SUFFIX}`);
}

export const SAMPLE_PEOPLE = [
  { id: 'sam', name: 'Sam Lee', photo: '/faces/sam.webp', selfie: '/faces/sam-phone.webp' },
  { id: 'amara', name: 'Amara Okafor', photo: '/faces/amara.webp', selfie: '/faces/amara-phone.webp' },
  { id: 'priya', name: 'Priya Nair', photo: '/faces/priya.webp', selfie: '/faces/priya-phone.webp' },
  { id: 'lucas', name: 'Lucas Moreau', photo: '/faces/lucas.webp', selfie: '/faces/lucas-phone.webp' },
  { id: 'camila', name: 'Camila Ortiz', photo: '/faces/camila.webp', selfie: '/faces/camila-phone.webp' },
  { id: 'jonas', name: 'Jonas Berg', photo: '/faces/jonas.webp', selfie: '/faces/jonas-phone.webp' },
  { id: 'leila', name: 'Leila Haddad', photo: '/faces/leila.webp', selfie: '/faces/leila-phone.webp' },
  { id: 'mateo', name: 'Mateo Silva', photo: '/faces/mateo.webp', selfie: '/faces/mateo-phone.webp' },
  { id: 'amina', name: 'Amina Yusuf', photo: '/faces/amina.webp', selfie: '/faces/amina-phone.webp' },
  { id: 'noah', name: 'Noah Park', photo: '/faces/noah.webp', selfie: '/faces/noah-phone.webp' },
  { id: 'idris', name: 'Idris Bell', photo: '/faces/idris.webp', selfie: '/faces/idris-phone.webp' },
  { id: 'sofia', name: 'Sofia Nordin', photo: '/faces/sofia.webp', selfie: '/faces/sofia-phone.webp' },
] as const satisfies readonly { id: string; name: string; photo: string; selfie: string }[];

export type SamplePerson = (typeof SAMPLE_PEOPLE)[number];

/** The sample workspace each call happens in, drawn like the people. `slug` is the room address's subdomain. The default is Halden Studio. */
export const SAMPLE_WORKSPACES = [
  { name: 'Halden Studio', slug: 'halden' },
  { name: 'Thornbury Labs', slug: 'thornbury' },
  { name: 'Ostrander & Co', slug: 'ostrander' },
  { name: 'Meridian Works', slug: 'meridian' },
  { name: 'Fennick Partners', slug: 'fennick' },
  { name: 'Larkspur Collective', slug: 'larkspur' },
  { name: 'Calder Studio', slug: 'calder' },
  { name: 'Vela Research', slug: 'vela' },
  { name: 'Narrowfield Works', slug: 'narrowfield' },
  { name: 'Commonroom Collective', slug: 'commonroom' },
  { name: 'Alderwick Partners', slug: 'alderwick' },
  { name: 'Brightwell Studio', slug: 'brightwell' },
] as const satisfies readonly { name: string; slug: string }[];

export type SampleWorkspace = (typeof SAMPLE_WORKSPACES)[number];

/** The agent's name in each call, drawn like the people. The prerendered page's agent is Scout; each visit draws its own. */
export const SAMPLE_AGENT_NAMES = ['Atlas', 'Scout', 'Juniper', 'Ledger', 'Wren', 'Otto', 'Mica', 'Orbit', 'Tandem', 'Sable'] as const;

/** `guest` is the guest who joins in the tour; `other` is the second guest. */
type Speaker = 'host' | 'guest' | 'other' | 'agent';

/**
 * One call's script. `{host}` and `{guest}` in any text become first names,
 * and `{agent}` the agent's name.
 * A third guest, when the call has one, listens.
 * The agent line follows the host's ask; `decision` indexes the line the
 * decision quotes.
 */
type SampleCall = {
  title: string;
  project: string;
  partner: string;
  when: string;
  lines: readonly (readonly [Speaker, string])[];
  decision: { line: number; what: string };
  notes: readonly string[];
  /** The host's own commitment, then the one handed to the agent in the call. */
  hostTask: { title: string; quote: string; due: string };
  agentTask: { title: string; due: string; working: string; reply: string };
  /** The host's message on the project after the call. */
  hostNote: string;
};

export const SAMPLE_CALLS: readonly SampleCall[] = [
  {
    title: t('Pilot program workshop'),
    project: t('Pilot program'),
    partner: 'Northfield Health',
    when: t('Today, 14:30'),
    lines: [
      ['host', t('Thanks for joining. Shall we start with the pilot scope?')],
      ['guest', t('Yes. We want to try it with one client team first.')],
      ['host', t('Good. Then we keep the first project small and review it after four weeks.')],
      ['other', t('That works for us. Our IT team only needs a week’s notice.')],
      ['guest', t('Agreed. Can you send us the workshop brief by Friday?')],
      ['host', t('I’ll send it on Friday. {agent}, can you draft the onboarding checklist?')],
      ['agent', t('Yes. I’ll draft it from today’s notes and file it on the Pilot program.')],
      ['guest', t('Perfect. Then we have what we need for the kickoff.')],
    ],
    decision: { line: 2, what: t('Start the pilot with one client team and review it after four weeks.') },
    notes: [
      t('**Pilot scope.** One client team first, reviewed after four weeks.'),
      '',
      t('**Next steps**'),
      t('- {host} sends the workshop brief by Friday.'),
      t('- {agent} drafts the onboarding checklist. It started during the call.'),
    ],
    hostTask: { title: t('Send the workshop brief to Northfield Health'), quote: t('I’ll send it on Friday'), due: t('Fri') },
    agentTask: {
      title: t('Draft the onboarding checklist'),
      due: t('Fri'),
      working: t('Drafting the onboarding checklist'),
      reply: t('Done. The onboarding checklist is in Documents: 12 items in 4 sections, from the notes and the decision. {host}, can you review it before Friday?'),
    },
    hostNote: t('Thanks both. The brief is on its way.'),
  },
  {
    title: t('Brand refresh review'),
    project: t('Brand refresh'),
    partner: 'Brightwater Foods',
    when: t('Today, 11:00'),
    lines: [
      ['host', t('Thanks for making time. Did your team look at the three directions?')],
      ['guest', t('We did. Everyone keeps coming back to the second one.')],
      ['host', t('Good. Then we take the second direction forward and drop the other two.')],
      ['other', t('Marketing agrees. The second one also stands out better on the shelf.')],
      ['guest', t('Can we see it on real packaging before the board meets?')],
      ['host', t('I’ll book the photo shoot for next week. {agent}, can you list the packaging mockups we need?')],
      ['agent', t('Yes. I’ll list every pack size from the brief and file it on Brand refresh.')],
      ['guest', t('Great. That gives the board something concrete.')],
    ],
    decision: { line: 2, what: t('Take the second direction forward and drop the other two.') },
    notes: [
      t('**Direction.** The second direction goes forward. The other two are dropped.'),
      '',
      t('**Next steps**'),
      t('- {host} books the packaging photo shoot for next week.'),
      t('- {agent} lists the packaging mockups. It started during the call.'),
    ],
    hostTask: { title: t('Book the packaging photo shoot'), quote: t('I’ll book the photo shoot for next week'), due: t('Next week') },
    agentTask: {
      title: t('List the packaging mockups'),
      due: t('Tue'),
      working: t('Listing the packaging mockups'),
      reply: t('Done. The mockup list is in Documents: 9 pack sizes in 3 ranges, from the brief. {host}, shall I send it to the photo studio?'),
    },
    hostNote: t('Thanks all. The shoot is booked for Tuesday.'),
  },
  {
    title: t('Market scan check-in'),
    project: t('Market scan 2027'),
    partner: 'Kestrel Logistics',
    when: t('Today, 16:00'),
    lines: [
      ['host', t('Shall we start with what changed since the last scan?')],
      ['guest', t('Two new competitors launched in the Nordics. That worries us.')],
      ['host', t('Then we add the Nordics to the scan and report back in two weeks.')],
      ['other', t('Our sales team saw the same thing last month.')],
      ['guest', t('Could you include their pricing too?')],
      ['host', t('I’ll interview two analysts this week. {agent}, can you collect their public pricing?')],
      ['agent', t('Yes. I’ll collect it today and file a summary on Market scan 2027.')],
      ['guest', t('Perfect. Talk in two weeks, then.')],
    ],
    decision: { line: 2, what: t('Add the Nordics to the scan and report back in two weeks.') },
    notes: [
      t('**Scope.** The scan now covers the Nordics. Report in two weeks.'),
      '',
      t('**Next steps**'),
      t('- {host} interviews two logistics analysts this week.'),
      t('- {agent} collects competitor pricing. It started during the call.'),
    ],
    hostTask: { title: t('Interview two logistics analysts'), quote: t('I’ll interview two analysts this week'), due: t('Fri') },
    agentTask: {
      title: t('Collect competitor pricing'),
      due: t('Today'),
      working: t('Collecting competitor pricing'),
      reply: t('Done. The pricing summary is in Documents: 6 competitors and 14 plans, with sources. {host}, two of them only show prices after a demo.'),
    },
    hostNote: t('Thanks. The analyst calls are booked.'),
  },
  {
    title: t('Accessible route pilot check-in'),
    project: t('Accessible route pilot'),
    partner: 'Cedarline Mobility',
    when: t('Today, 09:30'),
    lines: [
      ['host', t('Thanks for joining. Shall we review the two routes?')],
      ['guest', t('We asked riders to try both. The second route was easier to follow.')],
      ['host', t('Then we test both routes with six riders and review the feedback before launch.')],
      ['other', t('Our operations team can staff the first week.')],
      ['guest', t('Could you share the question sheet before the first interviews?')],
      ['host', t('I’ll prepare it tomorrow. {agent}, can you draft the route checklist?')],
      ['agent', t('Yes. I’ll turn the route notes into a checklist and file it on the pilot.')],
      ['guest', t('Great. We’ll review the checklist together before launch.')],
    ],
    decision: { line: 2, what: t('Test both routes with six riders and review the feedback before launch.') },
    notes: [
      t('**Pilot.** Test both routes with six riders. Review the feedback before launch.'),
      '',
      t('**Next steps**'),
      t('- {host} prepares the rider interview sheet tomorrow.'),
      t('- {agent} drafts the route checklist from the notes.'),
    ],
    hostTask: { title: t('Prepare the rider interview sheet'), quote: t('I’ll prepare it tomorrow'), due: t('Tomorrow') },
    agentTask: {
      title: t('Draft the route accessibility checklist'),
      due: t('Thu'),
      working: t('Drafting the route accessibility checklist'),
      reply: t('Done. The checklist covers both routes, six rider sessions and the review before launch. {host}, can you check the interview questions tomorrow?'),
    },
    hostNote: t('Thanks, I’ll share the question sheet tomorrow.'),
  },
  {
    title: t('Teacher onboarding review'),
    project: t('Teacher onboarding pilot'),
    partner: 'Fable Grove Learning',
    when: t('Today, 13:00'),
    lines: [
      ['host', t('Shall we start with what teachers found hardest in setup?')],
      ['guest', t('They could start a class, but finding the lesson materials took too long.')],
      ['host', t('We’ll test a shorter setup with three schools and review it after four weeks.')],
      ['other', t('The school coordinators can introduce us to the teachers.')],
      ['guest', t('Can the first version include a one-page materials guide?')],
      ['host', t('I’ll ask the coordinators for dates. {agent}, can you draft the setup checklist?')],
      ['agent', t('Yes. I’ll use the pilot notes and file the checklist on Teacher onboarding pilot.')],
      ['guest', t('That gives us a clear version to try with the first schools.')],
    ],
    decision: { line: 2, what: t('Test the shorter setup with three schools and review it after four weeks.') },
    notes: [
      t('**Pilot.** Test a shorter setup with three schools. Review it after four weeks.'),
      '',
      t('**Next steps**'),
      t('- {host} asks the school coordinators for interview dates.'),
      t('- {agent} drafts the setup checklist and materials guide.'),
    ],
    hostTask: { title: t('Book teacher interviews'), quote: t('I’ll ask the coordinators for dates'), due: t('Fri') },
    agentTask: {
      title: t('Draft the teacher setup checklist'),
      due: t('Fri'),
      working: t('Drafting the teacher setup checklist'),
      reply: t('Done. The checklist has 8 setup steps and a one-page materials guide. {host}, can you confirm the school dates before Friday?'),
    },
    hostNote: t('Thanks all. I’ll ask the coordinators for dates today.'),
  },
  {
    title: t('Solar site handover'),
    project: t('Riverside installation'),
    partner: 'Blue Current Energy',
    when: t('Today, 15:00'),
    lines: [
      ['host', t('What still needs to be true before the first site can go live?')],
      ['guest', t('The inspection is booked. We are waiting for the grid connection date.')],
      ['host', t('Then we prepare the first site and keep the second on hold until the grid date is confirmed.')],
      ['other', t('The installer can reserve a crew for the first week of November.')],
      ['guest', t('Could you put the open dependencies in one handover list?')],
      ['host', t('I’ll confirm the inspection date with the installer. {agent}, can you prepare the handover list?')],
      ['agent', t('Yes. I’ll gather the owners and dependencies from the project notes.')],
      ['guest', t('Perfect. We can use that list at the readiness review.')],
    ],
    decision: { line: 2, what: t('Prepare the first site and hold the second until the grid date is confirmed.') },
    notes: [
      t('**Readiness.** Prepare the first site. Keep the second on hold until the grid date is confirmed.'),
      '',
      t('**Next steps**'),
      t('- {host} confirms the inspection date with the installer.'),
      t('- {agent} makes one handover list of owners and dependencies.'),
    ],
    hostTask: { title: t('Confirm the inspection date'), quote: t('I’ll confirm the inspection date with the installer'), due: t('Tomorrow') },
    agentTask: {
      title: t('Prepare the site handover list'),
      due: t('Thu'),
      working: t('Preparing the site handover list'),
      reply: t('Done. The handover list has 5 open dependencies, their owners and the inspection date. {host}, can you check the grid connection item before Thursday?'),
    },
    hostNote: t('Thanks. I’ll check the inspection date with the installer.'),
  },
];

const firstName = (person: SamplePerson) => person.name.split(' ')[0]!;
const initialsOf = (name: string) => name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();

const personOf = (id: SamplePerson['id']) => SAMPLE_PEOPLE.find((person) => person.id === id)!;
/** A person's camera: the laptop's landscape frame, or the phone's portrait selfie when they join from their phone. */
const faceOf = (person: SamplePerson, phones: readonly SamplePerson['id'][]) => {
  const selfie = phones.includes(person.id) ? person.selfie : null;
  return { id: person.id, name: person.name, initials: initialsOf(person.name), photo: selfie ?? person.photo, portrait: Boolean(selfie) };
};

/** One call with its people, in the shapes every simulation draws. The first guest is the one who joins in the tour. */
export function composeMeeting({ call: callIndex, workspace: workspaceSlug, host: hostID, guests: guestIDs, phones, agent: AGENT, agentSeed }: MeetingPick) {
  const call = SAMPLE_CALLS[callIndex]!;
  const workspace = SAMPLE_WORKSPACES.find((entry) => entry.slug === workspaceSlug)!;
  const hostPerson = personOf(hostID);
  const guestPerson = personOf(guestIDs[0]!);
  const fill = (text: string) => text.replaceAll('{host}', firstName(hostPerson)).replaceAll('{guest}', firstName(guestPerson)).replaceAll('{agent}', AGENT);
  const host = faceOf(hostPerson, phones);
  const guests = guestIDs.map((id) => faceOf(personOf(id), phones));
  const guest = guests[0]!;
  const nameOf: Record<Speaker, string> = { host: host.name, guest: guest.name, other: guests[1]!.name, agent: AGENT };
  const meetingID = `6f1c2d3e-0000-4000-8000-${String(callIndex + 1).padStart(12, '0')}`;
  const lines: TranscriptSegment[] = call.lines.map(([speaker, text], index) => ({
    id: `6f1c2d3e-0000-4000-8000-1000000${String(callIndex + 1).padStart(3, '0')}${String(index + 1).padStart(2, '0')}`,
    meeting_id: meetingID,
    speaker_id: speaker === 'other' ? guests[1]!.id : speaker === 'guest' ? guest.id : speaker === 'host' ? host.id : speaker,
    speaker_name: nameOf[speaker],
    language: 'en',
    starts_at_ms: index * 8000 + 4000,
    ends_at_ms: index * 8000 + 10000,
    text: fill(text),
    is_final: true,
  }));
  const decided = lines[call.decision.line]!;
  const decision: MeetingDecisionCandidate = {
    what: call.decision.what,
    quote: decided.text,
    at_ms: decided.starts_at_ms,
    decision_id: null,
    dismissed: false,
  };
  const handoff = call.lines.findIndex(([speaker]) => speaker === 'agent') - 1;
  /** What the agent does in the call, each after the line that prompts it. */
  const agentActions = [
    { afterLine: call.decision.line, kind: 'decision', status: t('Marked a decision'), text: t('{agent} marked a decision: {what}', { agent: AGENT, what: call.decision.what }) },
    { afterLine: handoff, kind: 'task', status: t('Created a task for {name}', { name: firstName(hostPerson) }), text: t('{agent} created a task for {name}: {task}', { agent: AGENT, name: firstName(hostPerson), task: call.hostTask.title }) },
    { afterLine: handoff + 1, kind: 'task', status: call.agentTask.working, text: t('{agent} took a task: {task}', { agent: AGENT, task: call.agentTask.title }) },
  ] as const;
  return {
    /** The index in SAMPLE_CALLS: the day the other simulations draw follows it (sample-workspace.ts). */
    call: callIndex,
    title: call.title,
    project: call.project,
    partner: call.partner,
    when: call.when,
    workspace: { name: workspace.name, markUrl: null },
    host,
    guest,
    /** Every guest, the one who joins first. */
    guests,
    agent: AGENT,
    /** A new seeded shape and colour per call; the default call keeps the agent's own face. */
    agentIdentity: agentSeed ? makeAgentAvatarIdentity(`${AGENT.toLowerCase()}-${agentSeed}@sample.${WORKSPACE_HOST_SUFFIX}`) : sampleAgentIdentity(AGENT),
    agentActions,
    room: { host: `${workspace.slug}.${WORKSPACE_HOST_SUFFIX}/room/`, slug: firstName(hostPerson).toLowerCase(), tail: '/k7f3q2' },
    lines,
    /** The line in which the host hands the agent its work. */
    handoffLine: handoff,
    decision,
    notes: call.notes.map(fill).join('\n'),
    /** The commitments the transcript proposes as tasks, each with its quote. */
    proposals: [
      { id: 'host', title: call.hostTask.title, quote: call.hostTask.quote, owner: host.name, due: call.hostTask.due },
      { id: 'agent', title: call.agentTask.title, quote: lines[handoff]!.text, owner: AGENT, due: call.agentTask.due },
    ] as const,
    agentWork: { working: call.agentTask.working, reply: fill(call.agentTask.reply) },
    hostNote: call.hostNote,
  };
}

export type SampleMeeting = ReturnType<typeof composeMeeting>;
export type SampleProposalID = SampleMeeting['proposals'][number]['id'];

/** A call key: which call, which workspace, which host, which guests, who joins from their phone, the agent's name, and its face seed (0 is its own). */
export type MeetingPick = { call: number; workspace: SampleWorkspace['slug']; host: SamplePerson['id']; guests: readonly SamplePerson['id'][]; phones: readonly SamplePerson['id'][]; agent: (typeof SAMPLE_AGENT_NAMES)[number]; agentSeed: number };

export const DEFAULT_PICK: MeetingPick = { call: 0, workspace: 'halden', host: 'sam', guests: ['amara', 'priya'], phones: ['priya'], agent: 'Scout', agentSeed: 0 };

/** Every call has the host and this many guests: three people. */
export const CALL_GUESTS = 2;

/** A new call for the next run: never the same call or workspace twice in a row. Always three people and one agent (MZ, 2026-10-08). */
export function nextPick(previous: MeetingPick): MeetingPick {
  const calls = SAMPLE_CALLS.map((_, index) => index).filter((index) => index !== previous.call);
  const call = calls[Math.floor(Math.random() * calls.length)]!;
  const workspaces = SAMPLE_WORKSPACES.filter((entry) => entry.slug !== previous.workspace);
  const workspace = workspaces[Math.floor(Math.random() * workspaces.length)]!.slug;
  const shuffled = [...SAMPLE_PEOPLE].sort(() => Math.random() - 0.5).map((person) => person.id);
  const guests = shuffled.slice(1, 1 + CALL_GUESTS);
  // About half the people join on the go, from their phone. The host's Mac
  // writes the captions, so the host is always on a laptop.
  const people = guests.length + 1;
  const phoneCount = Math.min(guests.length, Math.random() < 0.5 ? Math.floor(people / 2) : Math.ceil(people / 2));
  const phones = [...guests].sort(() => Math.random() - 0.5).slice(0, phoneCount);
  const agent = SAMPLE_AGENT_NAMES[Math.floor(Math.random() * SAMPLE_AGENT_NAMES.length)]!;
  return { call, workspace, host: shuffled[0]!, guests, phones, agent, agentSeed: 1 + Math.floor(Math.random() * 1_000_000) };
}

/** The fixed default the other simulations and the prerendered page draw. */
export const SAMPLE_MEETING = composeMeeting(DEFAULT_PICK);

/** A new pick on every load, the same for the whole visit. */
let visit: { pick: MeetingPick; meeting: SampleMeeting } | undefined;

/** A call, a workspace, a host, guests and an agent drawn for this visit. The agent keeps its own face. */
function drawVisit() {
  if (!visit) {
    const people = nextPick(DEFAULT_PICK);
    const workspace = SAMPLE_WORKSPACES[Math.floor(Math.random() * SAMPLE_WORKSPACES.length)]!.slug;
    const call = Math.floor(Math.random() * SAMPLE_CALLS.length);
    const pick: MeetingPick = { ...DEFAULT_PICK, call, workspace, host: people.host, guests: people.guests, phones: people.phones, agent: people.agent };
    visit = { pick, meeting: composeMeeting(pick) };
  }
  return visit;
}

const subscribe = () => () => {};
const visitPick = () => drawVisit().pick;
const visitMeeting = () => drawVisit().meeting;

/**
 * This visit's sample meeting. The prerender and hydration read
 * SAMPLE_MEETING, so the HTML matches; React then renders the visit's pick.
 * Draw it under useVisitDrawnClass, so the default never shows before the swap.
 */
export function useSampleMeeting(): SampleMeeting {
  return useSyncExternalStore(subscribe, visitMeeting, () => SAMPLE_MEETING);
}

/** This visit's pick, for a scene that draws its own calls from it (MeetingSim). */
export function useVisitPick(): MeetingPick {
  return useSyncExternalStore(subscribe, visitPick, () => DEFAULT_PICK);
}

/**
 * Whether this render is final: the home page is static HTML that never
 * hydrates outside its two mounted tours (hero.tsx), so its sample content
 * must show the default instead of waiting for a pick that never comes.
 * HomePage sets it around those static parts.
 */
const FinalRender = createContext(false);
export const StaticSample = ({ children }: { children: ReactNode }) => createElement(FinalRender.Provider, { value: true }, children);

/**
 * Classes for sample content: invisible in the prerendered page and the
 * hydrating render, faded in from the render that swaps in this visit's
 * pick (the same render as useSampleMeeting's). So the default (Halden
 * Studio) never shows before a different workspace replaces it (MZ,
 * 2026-10-31). Under StaticSample the default shows as it is.
 */
export function useVisitDrawnClass(): string {
  const final = useContext(FinalRender);
  const drawn = useSyncExternalStore(subscribe, () => true, () => false);
  if (final) return '';
  return drawn ? 'opacity-100 motion-safe:transition-opacity motion-safe:duration-300' : 'opacity-0';
}

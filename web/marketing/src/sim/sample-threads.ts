import type { AgentAvatarIdentity } from '@starlings/contracts/agent-avatar-values';
import { AGENT_ECOSYSTEM } from '../AgentEcosystem';
import { useMemo } from 'react';
import { SAMPLE_MEETING, sampleAgentIdentity, useSampleMeeting, type SampleMeeting } from './sample-meeting';
import { SAMPLE_DAYS } from './sample-workspace';

/*
 * The conversations ThreadsSim draws: the host's agents and colleagues on
 * the day of this visit's call, with its host and guest (useSampleThreads).
 * Each agent's work stays inside what its own row in AGENT_ECOSYSTEM says
 * it can do, and the row's status says whether Starlings works with it
 * today. A row that changes to "Working today" drops the Planned mark here
 * and on /why together.
 */

export type ThreadLine =
  | { kind: 'message'; from: 'me' | 'them'; text: string; via?: string; at: string }
  | { kind: 'event'; text: string }
  | { kind: 'working'; step: string }
  | { kind: 'question'; text: string; at: string; options: { id: string; label: string }[]; answer: string; reply: string };

export type SampleThread = {
  id: string;
  name: string;
  /** The line under the name: what the agent is, or who the person is. */
  detail: string;
  face: { kind: 'agent'; identity: AgentAvatarIdentity } | { kind: 'person' } | { kind: 'project' };
  /** False while Starlings cannot pair with this agent yet. */
  working: boolean;
  /** Lines shown before the tour reaches this conversation. */
  opening: number;
  lines: ThreadLine[];
};

/** The registry row for an agent, by name. A missing row fails the build, not the page. */
function ecosystem(name: string) {
  const row = AGENT_ECOSYSTEM.find((agent) => agent.name === name);
  if (!row) throw new Error(`No AGENT_ECOSYSTEM row named ${name}`);
  return { detail: row.kind, working: row.status === 'live' };
}

function agent(name: string, registryName: string): Pick<SampleThread, 'name' | 'detail' | 'face' | 'working'> {
  const row = ecosystem(registryName);
  return { name, detail: row.detail, working: row.working, face: { kind: 'agent', identity: sampleAgentIdentity(name) } };
}

/** This visit's conversations. Thread ids and the tour do not depend on the pick; the names do. */
export function useSampleThreads(): SampleThread[] {
  const meeting = useSampleMeeting();
  return useMemo(() => sampleThreads(meeting), [meeting]);
}

/** The conversations for one pick, by the same ids. The default pick's are SAMPLE_THREADS. */
function sampleThreads(meeting: SampleMeeting): SampleThread[] {
  const HOST = meeting.host.name;
  const GUEST = meeting.guest.name;
  const day = SAMPLE_DAYS[meeting.call]!;
  /** A time of day, minutes from the start of the call: ten minutes after Home's clock. */
  const at = (minutes: number) => {
    const start = day.now[0] * 60 + day.now[1] + 10 + minutes;
    return `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
  };
  return [
    {
      id: 'factory',
      ...agent(meeting.agent, 'Vercel Eve'),
      detail: 'Shared agent · runs on Eve',
      opening: 1,
      lines: [
        { kind: 'message', from: 'me', at: at(11), text: day.thread.ask },
        { kind: 'working', step: day.thread.step },
        { kind: 'message', from: 'them', at: at(14), text: day.thread.done },
        { kind: 'question', at: at(14), text: day.thread.question, options: [{ id: 'sam', label: HOST }, { id: 'ada', label: GUEST }, { id: 'factory', label: `${meeting.agent} drafts it for your review` }], answer: 'factory', reply: day.thread.reply },
      ],
    },
    {
      id: 'pilot',
      name: meeting.project,
      detail: `${meeting.partner} · Project`,
      face: { kind: 'project' },
      working: true,
      opening: 3,
      lines: [
        { kind: 'event', text: `${meeting.title} filed here · Notes filed` },
        { kind: 'message', from: 'them', at: at(22), text: day.thread.project[0]! },
        { kind: 'message', from: 'me', at: at(25), via: 'Claude', text: day.thread.project[1]! },
        { kind: 'event', text: `${meeting.agent} filed ${day.thread.filed} in Documents` },
      ],
    },
    {
      id: 'hermes',
      ...agent('Hermes', 'Hermes'),
      opening: 1,
      lines: [
        { kind: 'message', from: 'me', at: '09:10', text: 'Every Monday, scan new papers on agent evaluation and file a summary on Research library.' },
        { kind: 'working', step: 'Running the literature-scan skill' },
        { kind: 'message', from: 'them', at: '09:26', text: 'This week:\n\n- **Scanned**: 38 new papers\n- **Kept**: 6 that match the library\n- **Filed**: summary on Research library\n\nI saved the steps as a skill, so next Monday is faster.' },
      ],
    },
    {
      id: 'openclaw',
      ...agent('OpenClaw', 'OpenClaw'),
      opening: 1,
      lines: [
        { kind: 'message', from: 'me', at: '11:02', text: `Check the ${meeting.partner} site for new team pages and update the lead.` },
        { kind: 'working', step: 'Browsing examplepartners.test' },
        { kind: 'message', from: 'them', at: '11:09', text: '- **Browsed**: 14 pages\n- **Found**: 2 new people on the team page\n- **Proposed**: 2 contacts on the lead, waiting for your review' },
      ],
    },
    {
      id: 'grok',
      ...agent('Grok Bot', 'Grok Bot'),
      opening: 1,
      lines: [
        { kind: 'message', from: 'me', at: '08:00', text: `Post a digest of mentions of ${meeting.partner} here at 9:00 each day.` },
        { kind: 'working', step: 'Running the morning routine' },
        { kind: 'message', from: 'them', at: '09:00', text: 'Today: 3 mentions, 1 worth a reply. I drafted the reply and left it here. Nothing is posted until you approve it.' },
      ],
    },
    {
      id: 'muse',
      ...agent('Muse', 'Meta Muse'),
      opening: 1,
      lines: [
        { kind: 'message', from: 'me', at: at(35), text: `Turn the call notes into a one-page brief for ${GUEST}.` },
        { kind: 'working', step: 'Writing the brief' },
        { kind: 'message', from: 'them', at: at(38), text: `The brief is in Documents, in your voice. Nothing goes to ${GUEST} until you approve it.` },
      ],
    },
    {
      id: 'ada',
      name: GUEST,
      detail: `${meeting.partner} · Guest`,
      face: { kind: 'person' },
      working: true,
      opening: 2,
      lines: [
        { kind: 'message', from: 'them', at: at(-32), text: day.guestNote },
        { kind: 'message', from: 'me', at: at(-29), text: day.hostAnswer },
      ],
    },
  ];
}

export const SAMPLE_THREADS = sampleThreads(SAMPLE_MEETING);

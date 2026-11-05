import { useState, type ReactNode } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { railListClass } from './rail-list';
import { RailRow } from './SurfaceShell';
import { ChevronIcon } from './action-icons';
import { PeerAvatar } from './PeerAvatar';
import { plural, t } from './i18n';
import { workspaceBrand } from './workspace-brand';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { CopyEmailItem, RowMenuItems, StarItem } from './row-menu-items';
import { MenuIcon } from './menu-icons';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/ui/dropdown-menu';
import { railRowMenu, useRowMenu } from './use-row-menu';
import { isAgent, isCallable, isRingable, joinRoomSlug, peerDisplayName, statusLine, type Peer } from './team-presence';
import type { Responsible } from '@starlings/contracts/responsible';

/**
 * Who is on a conversation: the people who can read it, and the agents
 * attached to it. The web's `ConversationTeam` (Sources/ConversationTeam.swift,
 * docs/PRESENCE.md §A conversation's team): one shape for a Work subject,
 * Everyone and a group, drawn by one block in the inspector.
 *
 * People and agents are answered differently on purpose. Today every member
 * reads every subject, so a subject's people are the whole team. An agent is
 * on a conversation only when it is bound to it or is a member of it; an
 * @mention is a hand-off, not membership.
 */
export type ConversationTeam = {
  people: Peer[];
  /** An address the roster has not delivered is kept as the address. */
  agents: Array<Peer | { email: string; unknown: true }>;
  /** Who can read it, when that is a rule rather than a list. */
  access: string;
  /** A project's or lead's responsible person, chosen or suggested (docs/OWNERSHIP.md). */
  responsible?: Responsible | null;
};

/** You first, then the roster's order. */
function ordered(peers: Peer[]): Peer[] {
  return [...peers.filter((peer) => peer.is_self), ...peers.filter((peer) => !peer.is_self)];
}

/** Everyone: every member, and no agent — none is bound to the channel. */
export function everyoneTeam(peers: Peer[]): ConversationTeam {
  return { people: ordered(peers.filter((peer) => !isAgent(peer))), agents: [], access: t('All {workspace} members', { workspace: workspaceBrand().name }) };
}

/**
 * A Work subject: every member today, plus the agent Core binds to it. The
 * responsible person, when there is one, comes first.
 */
export function subjectTeam(agentEmail: string | null | undefined, peers: Peer[], responsible: Responsible | null = null): ConversationTeam {
  const email = agentEmail?.trim() ?? '';
  const agent = email ? peers.find((peer) => isAgent(peer) && peer.email.toLowerCase() === email.toLowerCase()) : undefined;
  const people = ordered(peers.filter((peer) => !isAgent(peer)));
  const answering = responsible ? people.findIndex((peer) => peer.email.toLowerCase() === responsible.email) : -1;
  if (answering > 0) people.unshift(...people.splice(answering, 1));
  return {
    people,
    agents: email ? [agent ?? { email, unknown: true }] : [],
    access: t('All {workspace} members', { workspace: workspaceBrand().name }),
    responsible,
  };
}

/** "Responsible" or "Responsible (suggested)" on the person's row, or nothing. */
function responsibleLabel(peer: Peer, responsible: Responsible | null | undefined): string | null {
  if (!responsible || peer.email.toLowerCase() !== responsible.email) return null;
  return responsible.source === 'chosen' ? t('Responsible') : t('Responsible (suggested)');
}

/** A group: exactly its members, you included. */
export function groupTeam(emails: string[], peers: Peer[]): ConversationTeam {
  const wanted = new Set(emails.map((email) => email.toLowerCase()));
  const members = peers.filter((peer) => peer.is_self || wanted.has(peer.email.toLowerCase()));
  return {
    people: ordered(members.filter((peer) => !isAgent(peer))),
    agents: members.filter((peer) => isAgent(peer)),
    access: t('Only these people'),
  };
}

/** The Mac inspector draws the first eight people and counts the rest. */
const SHOWN_PEOPLE = 8;

/** What a person or an agent row can do, beside opening the conversation. */
export type PeerActions = {
  onMessage: (email: string) => void;
  /** Absent where the page cannot wave (Work's inspector). */
  onWave?: (peer: Peer) => void;
  /** Absent where the page cannot call; `calling` while a call waits. */
  onCall?: (peer: Peer) => void;
  /** Join directly when the person's live meeting is already visible. */
  onJoinRoom?: (peer: Peer) => void;
  calling?: boolean;
  /** Send the clipboard to them without opening the chat. Absent where the page cannot. */
  onPasteAndSend?: (peer: Peer) => void;
  /** The conversation with them, starred when the person has no favorite of their own. */
  threadFor?: (peer: Peer) => string | undefined;
  /** On a project or lead: make this person responsible for it. Absent elsewhere. */
  onMakeResponsible?: (peer: Peer) => void;
  /** Who is chosen now, so their own row does not offer it again. */
  chosenResponsible?: string | null;
};

/**
 * A person's or an agent's row menu, the Mac's
 * `peerContextMenu`: Message, Wave, Call or Join room / Copy email / Star.
 * Each room action appears only for the status it handles. One star
 * per row, as on the row itself: the person's, else the
 * conversation's.
 */
export function peerMenuItems(peer: Peer, actions: PeerActions): ReactNode {
  const threadID = actions.threadFor?.(peer);
  const favorite = peer.favorite_ref
    ? { kind: isAgent(peer) ? 'meet.agent' as const : 'meet.person' as const, target_ref: peer.favorite_ref }
    : undefined;
  const items = <RowMenuItems kind="person" context={isAgent(peer) ? 'agent' : peer.is_self ? 'self' : 'peer'} facts={{
    canWave: !!actions.onWave && isRingable(peer),
    canCall: !!actions.onCall && isCallable(peer) && peer.status !== 'in_meeting' && !!peer.room_slug,
    canJoinRoom: !!actions.onJoinRoom && isCallable(peer) && !!joinRoomSlug(peer),
    hasEmail: !!peer.email,
    hasFavorite: !!favorite,
    hasThread: !favorite && !!threadID,
    canMakeResponsible: !!actions.onMakeResponsible && !isAgent(peer) && peer.email.toLowerCase() !== actions.chosenResponsible,
  }} run={{
    message: peer.is_self ? undefined : () => actions.onMessage(peer.email),
    wave: actions.onWave ? () => actions.onWave?.(peer) : undefined,
    call: actions.onCall ? () => actions.onCall?.(peer) : undefined,
    'join-room': actions.onJoinRoom ? () => actions.onJoinRoom?.(peer) : undefined,
    'make-responsible': actions.onMakeResponsible ? () => actions.onMakeResponsible?.(peer) : undefined,
  }} disabled={{ call: !!actions.calling }} render={{
    'copy-email': () => <CopyEmailItem email={peer.email} label={t('Copy email')} />,
    'star-person': favorite ? () => <StarItem target={favorite} /> : undefined,
    'star-thread': threadID && !favorite ? () => <StarItem target={{ kind: 'meet.thread', target_ref: threadID }} /> : undefined,
  }} />;
  if (!actions.onPasteAndSend || peer.is_self) return items;
  // Above the registry's own items, as on the Mac and the phone: the menu's
  // first line is the one-step drop, then the rest as it was.
  return (
    <>
      <DropdownMenuItem onSelect={() => actions.onPasteAndSend?.(peer)}>
        <MenuIcon name="paste" />
        {t('Paste and send')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {items}
    </>
  );
}

/**
 * TEAM, then AGENTS, each with presence. A row opens the conversation with
 * that person; your own row and an agent the roster does not know are static.
 * Each person and agent row has its menu (`peerMenuItems`).
 */
export function ConversationTeamBlock({ team, now, ...actions }: {
  team: ConversationTeam | null;
  now: number;
} & PeerActions) {
  const menu = useRowMenu();
  if (!team) {
    return <InspectorGroup title={t('TEAM')}><PlaceholderRows count={2} label={t('Loading team…')} /></InspectorGroup>;
  }
  const { onMessage } = actions;
  const around = team.people.filter((peer) => peer.status !== 'offline').length;
  const count = plural(team.people.length, { one: '{count} person', other: '{count} people' });
  const rowMenu = (peer: Peer) => railRowMenu(menu, peer.email, peerMenuItems(peer, actions));
  return (
    <>
      <InspectorGroup title={t('TEAM')}>
        <p className={inspectorNoteClass}>{count} · {t('{count} around', { count: around })} · {team.access}</p>
        <ul className={railListClass}>
          {team.people.slice(0, SHOWN_PEOPLE).map((peer) => (
            <RailRow
              key={peer.email}
              leading={<PeerAvatar peer={peer} />}
              title={peer.is_self ? t('{name} (you)', { name: peerDisplayName(peer) }) : peerDisplayName(peer)}
              subtitle={[responsibleLabel(peer, team.responsible), statusLine(peer, now)].filter(Boolean).join(' · ')}
              ariaLabel={peer.is_self ? peerDisplayName(peer) : t('Message {peer}', { peer: peerDisplayName(peer) })}
              onSelect={peer.is_self ? undefined : () => onMessage(peer.email)}
              menu={peer.is_self && !actions.onMakeResponsible ? undefined : rowMenu(peer)}
            />
          ))}
        </ul>
        {team.people.length > SHOWN_PEOPLE && (
          <p className={inspectorNoteClass}>{t('{count} more', { count: team.people.length - SHOWN_PEOPLE })}</p>
        )}
      </InspectorGroup>
      <InspectorGroup title={t('AGENTS')}>
        {team.agents.length === 0 ? (
          <p className={inspectorNoteClass}>{t('None attached. @mention an agent to bring it in.')}</p>
        ) : (
          <ul className={railListClass}>
            {team.agents.map((agent) => 'unknown' in agent ? (
              <RailRow key={agent.email} title={agent.email} subtitle={t('Not in the roster')} muted />
            ) : (
              <RailRow
                key={agent.email}
                leading={<PeerAvatar peer={agent} />}
                title={peerDisplayName(agent)}
                subtitle={statusLine(agent, now)}
                ariaLabel={t('Message {peer}', { peer: peerDisplayName(agent) })}
                onSelect={() => onMessage(agent.email)}
                menu={rowMenu(agent)}
              />
            ))}
          </ul>
        )}
      </InspectorGroup>
    </>
  );
}

/** A quiet line in a context group: a count, a loading line, an empty one. */
const inspectorNoteClass = 'text-xs text-muted-foreground';

/**
 * An inspector's context: the thing's name and one line under it, then its
 * `InspectorGroup`s. While it shows one, the inspector stands at the height
 * of its content (`SurfaceShell` reads `data-inspector-context`).
 */
export function InspectorContext({ title, subtitle, children }: { title: ReactNode; subtitle: ReactNode; children: ReactNode }) {
  return (
    <div data-inspector-context="">
      <header className="mt-0.5 mb-3.5">
        <h2 className="m-0 text-lg font-semibold [overflow-wrap:anywhere]">{title}</h2>
        <p className="mt-1 mb-0 text-[13px] text-muted-foreground">{subtitle}</p>
      </header>
      {children}
    </div>
  );
}

/**
 * One foldable group of an inspector's context: the Mac's `infoGroup`. The
 * body keeps `work-context-group-body` as a hook with no rule of its own: a
 * `RailRow` and its list read it to sit flat on the panel.
 */
export function InspectorGroup({ title, children }: { title: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <Collapsible className="group/context border-t py-2" open={expanded} onOpenChange={setExpanded}>
      <CollapsibleTrigger className="-mx-1 flex w-[calc(100%+0.5rem)] cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent p-1 text-left text-[11px] font-[650] tracking-[0.04em] text-muted-foreground hover-lift">
        <span className="inline-flex size-3 flex-none transition-transform duration-[120ms] group-data-[state=open]/context:rotate-90 motion-reduce:transition-none [&_svg]:size-3" aria-hidden="true"><ChevronIcon /></span>
        <span>{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="work-context-group-body pt-[3px] pl-[18px] text-[13px] text-foreground [overflow-wrap:anywhere] [&_p]:my-[5px]">{children}</CollapsibleContent>
    </Collapsible>
  );
}

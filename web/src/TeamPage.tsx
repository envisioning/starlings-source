import { SignInGate } from './SignInGate';
import { railListClass } from './rail-list';
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Alert } from '@/ui/alert';
import { Card } from '@/ui/card';
import { ControlRequestError, internalRoomPath } from './config';
import { RailRow, RailRowsPlaceholder, RailSection, railBlockProps, SurfaceShell, useRightSidebar } from './SurfaceShell';
import { StarredLeading } from './FavoriteToggle';
import { apiFetch } from './api';
import { track } from './analytics';
import { toast } from './Toast';
import { removeAvatar, uploadAvatar } from './avatars';
import { GroupAvatar, PeerAvatar } from './PeerAvatar';
import { Sheet, SheetContent, SheetTitle } from '@/ui/sheet';
import { useMediaQuery } from './use-media-query';
import { ConversationTeamBlock, InspectorContext, InspectorGroup, everyoneTeam, groupTeam, peerMenuItems, type ConversationTeam, type PeerActions } from './ConversationTeam';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { CopyTextItem, RowMenuItems, StarItem } from './row-menu-items';
import { railRowMenu, useRowMenu, type RowMenuController } from './use-row-menu';
import { useMenuTrigger } from './menu-focus';
import { ChevronIcon, CloseIcon, PlusIcon, VideoIcon } from './action-icons';
import type { FavoriteRow } from '@starlings/contracts/favorites';
import { isFavorite, useFavorites } from './favorites';
import { SurfaceCreate } from './SurfaceCreate';
import {
  callPeer,
  enterPeerRoom,
  clearIncomingRing,
  peerDevicesLine,
  APPEAR_OFFLINE_REMINDER,
  STATUS_OPTIONS,
  applyStatusOption,
  selectedStatusOption,
  type StatusOption,
  refreshPeers,
  subscribePeers,
  isAgent,
  isCallable,
  peerDisplayName,
  peerIsWithinWorkingHours,
  peerLocalTime,
  peerShortName,
  relativeTime,
  ringPeer,
  statusLine,
  STATUS_LABEL,
  type IncomingRing,
  type Peer,
  type PeersResponse,
  fetchPeerFreeBusy,
  orderTeamRail,
  strayConversations,
  type CalendarFreeBusyPerson,
  agentActivityLines,
  agentBuildLine,
  agentManifestLinks,
  agentToolEntry,
  joinRoomSlug,
} from './team-presence';
import { fetchMyWork, fetchPeerWork, isOverdue, planPeerWork, sharedSubjects, type CrmMyTask, type PeerWork } from './crm-work';
import { formatTime, formatDay } from './meeting-time';
import { AgentTile, ThreadPane, agentTileClass, agentTileDetailClass, agentTilesClass } from './ThreadPane';
import { TEAM_THREAD_TITLE, type AgentManifestDoc, type ThreadCreateInput } from '@starlings/contracts';
import { markThreadRead, setThreadArchived, setThreadMuted, threadHref, threadTitle, useThreads, useUnreadMessages, type ThreadSummary } from './messages';
import { refreshPoll } from './shared-poll';
import { useOwnerHeartbeat } from './use-owner-heartbeat';
import { ErrorNotice } from './ErrorNotice';
import { calendarFailureDetail, classifyCalendarFailure, logCalendarFailure, type CalendarFailureKind } from './calendar-failure';
import { t } from './i18n';
import { workspaceBrand } from './workspace-brand';
import { navigate, writeAddress } from './navigation';
import { parsePermalinkPath, peerPermalinkName } from '@starlings/contracts/permalinks';
import { TaskRow } from './WorkRows';
import { SubjectPicker } from './SubjectPicker';
import { peerHref, subjectHref, subjectTaskHref, teamThreadHref, workSubjectOf } from './work-hrefs';
import { PlaceholderBar, PlaceholderRows, PlaceholderStatus } from '@/ui/placeholder-rows';
import { plainPreview } from './markdown-parse';

/**
 * Team on the web — the same destination the Mac window and the iOS tab reach,
 * for a signed-in Envisioning member. People, agents, direct messages and
 * Everyone share this member workspace; agents are a roster category, not a
 * separate top-level destination.
 *
 * Everything here is member-gated at the Worker, not merely hidden: a visitor
 * who guesses this address gets a 403 from `/api/peers`, and the page says so
 * rather than pretending the roster is empty.
 */
export function TeamPage() {
  const { rows: favorites } = useFavorites();
  const threadStarred = (threadID: string | undefined) => Boolean(threadID) && isFavorite(favorites, { kind: 'meet.thread', target_ref: threadID! });
  const rightSidebar = useRightSidebar('team');
  const unread = useUnreadMessages(true);
  const threads = useThreads(true);
  const [requestedThread, setRequestedThread] = useState(() => {
    const record = parsePermalinkPath(window.location.pathname);
    return record?.surface === 'team' && record.kind === 'thread' ? record.id : null;
  });
  // Arriving on a thread's permalink lands on its newest line, or on the one
  // the hash names (`#thread-message-<id>`), flashed once.
  const [arrival] = useState(() => requestedThread
    ? { thread: requestedThread, focus: decodeURIComponent(window.location.hash.match(/^#thread-message-(.+)$/u)?.[1] ?? 'latest') }
    : undefined);
  const [conversation, setConversation] = useState<ThreadCreateInput | null>(null);
  /**
   * Who is being gathered into a new private conversation, while it is being
   * gathered. A group is opened by naming its people, so this is the naming —
   * and it empties the moment the conversation exists, because from then on
   * the conversation is addressed by the people already in it.
   */
  const [gathering, setGathering] = useState<string[] | null>(null);
  const callGeneration = useRef(0);
  const pendingCall = useRef<{ email: string; slug: string; deadline: number } | null>(null);
  const [calling, setCalling] = useState(false);
  const [roster, setRoster] = useState<PeersResponse | null>(null);
  const [selectedPeerEmail, setSelectedPeerEmail] = useState<string | null>(null);
  const [auth, setAuth] = useState<'loading' | 'needed' | 'ok'>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(() => Date.now());
  /** The shell's phone width: the inspector is a Sheet there, not a column. */
  const phone = useMediaQuery('(max-width: 760px)');
  /** One menu for every Team row and Lounge tile. */
  const rowMenu = useRowMenu();

  /** Closing the conversation closes the person beside it: the inspector
      was opened for that conversation, and it should not outlive it. */
  function closeConversation() {
    setConversation(null);
    setRequestedThread(null);
    setSelectedPeerEmail(null);
  }

  // A ref, not state: whether a roster has ever arrived decides only whether a
  // failure is worth an error banner, and reading it from state would rebuild
  // the subscription on every fetch.
  const hasLoaded = useRef(false);

  // One roster poll for the whole tab, shared with anything else reading it
  // (`shared-poll`): stopped while the tab is hidden, slowed while Meet is on
  // screen behind another app, at the cache's own beat while it is in front.
  // Every `/peers` fans out to a Durable Object per room, so a second poller
  // here would be a second DO request every thirty seconds, all day.
  useEffect(() => {
    return subscribePeers({
      onValue: (body) => {
        hasLoaded.current = true;
        setRoster(body);
        const pending = pendingCall.current;
        if (pending) {
          if (Date.now() >= pending.deadline) {
            pendingCall.current = null; setCalling(false); setNotice(t('No answer.'));
          } else if (body.peers.some(peer => peer.email === pending.email && peer.status === 'in_meeting')) {
            pendingCall.current = null; setCalling(false); enterPeerRoom(pending.slug);
          }
        }
        setAuth('ok');
        setError('');
        setNow(Date.now());
      },
      onError: (cause) => {
        if (cause instanceof ControlRequestError && (cause.status === 401 || cause.status === 403)) {
          setAuth('needed');
          setRoster(null);
          return;
        }
        // A stale roster beats an empty screen: only speak up when there has
        // never been one.
        if (!hasLoaded.current) {
          setError(cause instanceof Error ? cause.message : t('Couldn’t load your team.'));
        }
      },
    });
  }, []);

  useOwnerHeartbeat(auth === 'ok');

  const me = useMemo(() => roster?.peers.find((peer) => peer.is_self), [roster]);
  // Who `@` may name. Answered from the roster this page already polls, so
  // naming a colleague costs nothing and needs no second request. Only the
  // email matters — a mention matches its local part or the whole address,
  // never a display name. See `mentionHandleMatches` in ThreadPane.tsx.
  const mentionable = useMemo(() => (roster?.peers ?? [])
    .filter((peer) => !peer.is_self)
    .map((peer) => ({ email: peer.email })), [roster]);
  const others = useMemo(() => roster?.peers.filter((peer) => !peer.is_self) ?? [], [roster]);
  // People and software are kept apart inside Team. An agent is permanently
  // addressable, so counting it as "around" would report somebody here on a
  // day when nobody is.
  const people = useMemo(() => others.filter((peer) => !isAgent(peer)), [others]);
  const agents = useMemo(() => others.filter((peer) => isAgent(peer)), [others]);
  const selectedPeer = useMemo(
    () => roster?.peers.find((peer) => peer.email === selectedPeerEmail) ?? null,
    [roster, selectedPeerEmail],
  );
  const directThreads = useMemo(() => threads
    .filter((thread) => thread.kind === 'dm' && (thread.peers?.length ?? 0) <= 1 && thread.peer_email !== me?.email),
    [threads, me?.email]);
  const teamThread = threads.find((thread) => thread.kind === 'team');
  /**
   * Groups with something in them, addressed the way the composer addresses
   * them so opening a row and gathering the same people land in the same
   * conversation. A group hangs off nothing — no roster row — so it is the
   * one kind of conversation that needs a row of its own.
   */
  const groupThreads = useMemo(() => threads
    .filter((thread) => thread.kind === 'dm' && (thread.peers?.length ?? 0) > 1)
    .map((thread) => {
      const address = threadAddress(thread);
      const entry = conversationListEntry(address, others);
      return entry ? { thread, address, entry } : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null),
    [threads, others]);
  /** PEOPLE and AGENTS in the rail's one order — `orderTeamRail`. */
  const railPeople = useMemo(() => orderTeamRail(people, directThreads), [people, directThreads]);
  const railAgents = useMemo(() => orderTeamRail(agents, directThreads), [agents, directThreads]);
  const strays = useMemo(() => strayConversations(directThreads, others, me?.email), [directThreads, others, me?.email]);

  /**
   * A group just gathered has no thread yet and nowhere to stand, so it gets
   * a row at the top of GROUPS until its first message gives it one.
   */
  const openGroup = useMemo(() => {
    if (!conversation || ('kind' in conversation) || !('peer_emails' in conversation)) return null;
    if (groupThreads.some(({ address }) => sameConversation(address, conversation))) return null;
    return conversationListEntry(conversation, others);
  }, [conversation, groupThreads, others]);
  async function onStatus(option: StatusOption) {
    try {
      await applyStatusOption(option);
      toast(option.key === 'offline' ? APPEAR_OFFLINE_REMINDER : t('Status: {label}', { label: option.label }));
      await refreshPeers();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t change your status.'));
    }
  }

  async function onRing(peer: Peer) {
    try {
      await ringPeer(peer.email);
      toast(t('Waved at {peer}', { peer: peerShortName(peer) }));
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : t('Couldn’t wave at them.'), 'danger');
    }
  }

  async function onCall(peer: Peer) {
    if (!isCallable(peer) || !peer.room_slug || pendingCall.current || calling) return;
    setCalling(true);
    const generation = ++callGeneration.current;
    try {
      const joinSlug = joinRoomSlug(peer);
      if (joinSlug) { enterPeerRoom(joinSlug); return; }
      await callPeer(peer.email);
      if (generation !== callGeneration.current) return;
      pendingCall.current = { email: peer.email, slug: peer.room_slug, deadline: Date.now() + 45_000 };
      setNotice(t('Asking {peer} to open their room…', { peer: peerShortName(peer) }));
    } catch (cause) { setCalling(false); setError(cause instanceof Error ? cause.message : t('Couldn’t call them.')); }
  }

  function openPeer(peer: Peer) {
    setSelectedPeerEmail(peer.email);
    setConversation({ peer_email: peer.email });
  }

  useEffect(() => {
    if (selectedPeerEmail && !selectedPeer) setSelectedPeerEmail(null);
  }, [selectedPeer, selectedPeerEmail]);

  // A person or an agent the address names, by name (`/team/person/ada`,
  // `/team/agent/vocab`), with an optional `?do=wave|call` from
  // the ⌘K palette ( decision 7). The person opens, and the verb runs
  // once the roster can answer whether they are callable; a call that cannot
  // be made leaves the person open, which is what Enter would have done.
  const requestedPerson = useRef<{ kind: 'person' | 'agent'; name: string; verb: string | null } | null>((() => {
    const record = parsePermalinkPath(window.location.pathname);
    if (record?.surface !== 'team' || record.kind === 'thread') return null;
    return { kind: record.kind, name: record.id.toLowerCase(), verb: new URLSearchParams(window.location.search).get('do') };
  })());
  useEffect(() => {
    const request = requestedPerson.current;
    if (!request || !roster) return;
    requestedPerson.current = null;
    const peer = roster.peers.find((candidate) => isAgent(candidate) === (request.kind === 'agent')
      && peerPermalinkName(candidate.email) === request.name);
    if (!peer) {
      writeAddress('/team');
      setNotice(t('That person isn’t on the team.'));
      return;
    }
    if (peer.is_self) { setConversation({ peer_email: peer.email }); return; }
    openPeer(peer);
    if (request.verb === 'wave' && !isAgent(peer)) void onRing(peer);
    if (request.verb === 'call' && isCallable(peer) && peer.room_slug) void onCall(peer);
  }, [roster]); // eslint-disable-line react-hooks/exhaustive-deps

  // The address names what is open: a person or an agent at
  // their permalink, a group or the team channel at its thread's, else
  // `/team`. Null while the open thing has no address yet: a group before
  // its thread exists, a person before the roster names them. The address a
  // link arrived with is rewritten in place; every later open is a history
  // entry, so Back returns to the one before.
  const openAddress: string | null = conversation
    ? ('peer_email' in conversation
      ? (() => {
        const peer = roster?.peers.find((candidate) => candidate.email === conversation.peer_email);
        return peer ? peerHref(peer) : null;
      })()
      : ('kind' in conversation
        ? (teamThread ? teamThreadHref(teamThread.id) : null)
        : (() => {
          const group = groupThreads.find((entry) => sameConversation(entry.address, conversation));
          return group ? teamThreadHref(group.thread.id) : null;
        })()))
    : requestedThread ? teamThreadHref(requestedThread) : '/team';
  const arrivedOnRecord = useRef(requestedPerson.current !== null || requestedThread !== null);
  // Read at render, not in the effect: the person effect above clears the
  // ref in the same commit, before this render's state holds the person.
  const personPending = requestedPerson.current !== null;
  useEffect(() => {
    if (personPending || openAddress === null) return;
    const current = window.location.pathname;
    // `/agents` and a plain `/team` stay as they are while nothing is open.
    if (openAddress === '/team' && parsePermalinkPath(current)?.surface !== 'team') return;
    const push = !arrivedOnRecord.current;
    arrivedOnRecord.current = false;
    if (current !== openAddress || window.location.search) writeAddress(openAddress, { push });
  }, [openAddress, personPending]);

  if (auth === 'loading') {
    return <TeamSkeleton />;
  }

  if (auth === 'needed') {
    return (
      <SignInGate title={t('Team')} onSignedIn={refreshPeers} />
    );
  }

  const threadOpen = Boolean(conversation || requestedThread);
  const isOpen = threadOpen || Boolean(selectedPeer);
  // The tab: the open conversation, else the open person.
  const openTitle = conversation
    ? ('kind' in conversation
      ? (conversation.kind === 'team' ? t(TEAM_THREAD_TITLE) : null)
      : ('peer_email' in conversation && conversation.peer_email === me?.email
        ? (me ? peerDisplayName(me) : null)
        : conversationListEntry(conversation, others)?.title ?? null))
    : selectedPeer ? peerDisplayName(selectedPeer) : null;

  function showLounge() {
    closeConversation();
    setSelectedPeerEmail(null);
  }

  /**
   * Everyone or a group: the inspector says who is on it, the Mac's TEAM
   * block (docs/PRESENCE.md §A conversation's team). A person's conversation
   * keeps the person panel. Above the phone only: on the phone the column is
   * the conversation, and a sheet over it on every open would hide it.
   */
  const conversationTeam = !roster || !conversation ? null
    : 'kind' in conversation
      ? (conversation.kind === 'team' ? { title: t(TEAM_THREAD_TITLE), subtitle: t('Everybody at {workspace}', { workspace: workspaceBrand().name }), about: t('Everyone at {workspace} can read and reply.', { workspace: workspaceBrand().name }), team: everyoneTeam(roster.peers) } : null)
      : 'peer_emails' in conversation
        ? { title: conversationListEntry(conversation, others)?.title ?? t('Group'), subtitle: t('Private conversation'), about: t('Only the people listed here can read and reply.'), team: groupTeam(conversation.peer_emails, roster.peers) }
        : null;
  /** The person a one-to-one conversation is with: on the phone the head
      names them, and pressing it brings their Sheet back (meet#483). */
  const personInConversation = conversation && 'peer_email' in conversation
    ? roster?.peers.find((peer) => peer.email === conversation.peer_email) ?? null
    : null;
  const messagePerson = (email: string) => {
    const peer = roster?.peers.find((candidate) => candidate.email === email);
    if (peer) openPeer(peer);
  };

  const peerPanel = selectedPeer && (
    <PeerInfoPanel
      peer={selectedPeer}
      now={now}
      refreshKey={roster}
      onClose={() => setSelectedPeerEmail(null)}
      onMessage={() => openPeer(selectedPeer)}
      leading={<PeerAvatar peer={selectedPeer} />}
    />
  );

  /**
   * The clipboard, sent to this person or agent without opening the chat
   *. Reading it asks the browser's permission, which is expected.
   * The toast offers Open, which lands on the thread.
   */
  async function pasteAndSend(peer: Peer) {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) { toast(t('Nothing to paste.'), 'danger'); return; }
      const opened = await apiFetch<{ thread: ThreadSummary }>('/threads', {
        method: 'POST', body: { peer_email: peer.email }, fallbackError: t('Couldn’t open this conversation.'),
      });
      await apiFetch(`/threads/${encodeURIComponent(opened.thread.id)}/messages`, {
        method: 'POST', body: { text, mentions: [], attachments: [] }, fallbackError: t('Couldn’t send your message.'),
      });
      track('Message sent');
      toast(t('Sent to {name}', { name: peerDisplayName(peer) }), 'neutral', {
        label: t('Open'),
        run: () => openPeer(peer),
      });
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : t('Couldn’t send your message.'), 'danger');
    }
  }

  const directThreadID = (peer: Peer) => directThreads.find((thread) => thread.peer_email?.toLowerCase() === peer.email.toLowerCase())?.id;
  /** What a person's row menu can do here: all of it, as the person panel. */
  const peerActions: PeerActions = {
    onMessage: messagePerson,
    onWave: (peer) => void onRing(peer),
    onCall: (peer) => void onCall(peer),
    onJoinRoom: (peer) => {
      const slug = joinRoomSlug(peer);
      if (slug) enterPeerRoom(slug);
    },
    calling,
    onPasteAndSend: (peer) => void pasteAndSend(peer),
    threadFor: directThreadID,
  };
  /** A conversation row's menu, with the same read and delivery controls as its open pane. */
  const threadMenu = (thread: ThreadSummary | undefined) => thread
    ? railRowMenu(rowMenu, `thread:${thread.id}`, <RowMenuItems kind="conversation" context="row" facts={{ hasUnread: thread.unread, hasInboundAddress: !!thread.inbound_address }}
      run={{
        'mark-read': () => { void markThreadRead(thread.id).then(() => refreshPoll('threads.all')).catch((cause: unknown) => toast(cause instanceof Error ? cause.message : t('Couldn’t mark this conversation read.'), 'danger')); },
        mute: () => { const until = thread.muted_until ? null : Date.now() + 7 * 24 * 3600 * 1000; void setThreadMuted(thread.id, { until }).then(() => refreshPoll('threads.all')).catch((cause: unknown) => toast(cause instanceof Error ? cause.message : t('Couldn’t change that.'), 'danger')); },
        archive: () => { void setThreadArchived(thread.id, { archived: true }).then(() => refreshPoll('threads.all')).catch((cause: unknown) => toast(cause instanceof Error ? cause.message : t('Couldn’t change that.'), 'danger')); },
      }} labels={{ mute: thread.muted_until ? t('Unmute') : t('Mute') }} render={{
        'copy-forwarding-address': thread.inbound_address ? () => <CopyTextItem text={thread.inbound_address!} label={t('Copy forwarding address')} copied={t('Address copied')} failed={t('Couldn’t copy the address.')} /> : undefined,
        star: () => <StarItem target={{ kind: 'meet.thread', target_ref: thread.id }} />,
      }} />)
    : undefined;

  const peerRow = (peer: Peer) => (
    <PeerRow
      key={peer.email}
      peer={peer}
      now={now}
      menu={railRowMenu(rowMenu, `peer:${peer.email}`, peerMenuItems(peer, peerActions))}
      threadID={directThreadID(peer)}
      preview={isAgent(peer) ? directThreads.find((thread) => thread.peer_email?.toLowerCase() === peer.email.toLowerCase())?.last_message_preview : undefined}
      unread={unread.some((thread) => thread.kind === 'dm' && (thread.peers?.length ?? 0) <= 1 && thread.peer_email === peer.email)}
      onSelect={() => openPeer(peer)}
      active={selectedPeerEmail === peer.email || Boolean(conversation && 'peer_email' in conversation && conversation.peer_email === peer.email)}
      gathering={gathering !== null && !isAgent(peer)}
      chosen={gathering?.includes(peer.email) ?? false}
      onChoose={() => setGathering((current) => {
        if (current === null) return current;
        return current.includes(peer.email)
          ? current.filter((email) => email !== peer.email)
          : [...current, peer.email];
      })}
    />
  );

  /* The Mac rail, block for block (`TeamWindowController`): Lounge, YOU,
     CONVERSATIONS, PEOPLE, AGENTS. */
  const rail = (
    <>
      <ul className={cn(railListClass, 'mb-3.5')} aria-label={t('Team')}>
        <RailRow title={t('Lounge')} subtitle={t('Who is around')} active={!isOpen} onSelect={showLounge} />
      </ul>
      {me && (
        <RailSection title={t('You')} {...railBlockProps('team', 'you')}>
          <ul className={railListClass}>
            <RailRow
              leading={<PeerAvatar peer={me} />}
              title={peerDisplayName(me)}
              subtitle={me.invisible ? APPEAR_OFFLINE_REMINDER : statusLine(me, now)}
              unread={unread.some((thread) => thread.kind === 'dm' && thread.peer_email === me.email)}
              active={Boolean(conversation && 'peer_email' in conversation && conversation.peer_email === me.email)}
              ariaLabel={t('{me}, notes to self', { me: peerDisplayName(me) })}
              onSelect={() => setConversation({ peer_email: me.email })}
              menu={railRowMenu(rowMenu, 'self', <SelfMenuItems peer={me} now={now} onOpen={() => setConversation({ peer_email: me.email })} onStatus={onStatus} />)}
              // The status lives in the row's own menu, as on the Mac: a
              // second switcher beside it answered the same question twice.
              starred={peerStarred(favorites, me)}
            />
          </ul>
        </RailSection>
      )}
      <RailSection
        title={t('Groups')}
        {...railBlockProps('team', 'groups')}
        count={groupThreads.length + 1 + (openGroup ? 1 : 0)}
      >
        <ul className={railListClass}>
          <RailRow
            title={t(TEAM_THREAD_TITLE)}
            leading={<GroupAvatar />}
            unread={unread.some((thread) => thread.kind === 'team')}
            active={Boolean(conversation && 'kind' in conversation && conversation.kind === 'team')}
            onSelect={() => setConversation({ kind: 'team' })}
            menu={threadMenu(teamThread)}
            starred={threadStarred(teamThread?.id)}
          />
          {openGroup && <RailRow
            title={openGroup.title}
            leading={openGroup.leading}
            active
            onSelect={() => setConversation(conversation)}
          />}
          {groupThreads.map(({ thread, address, entry }) => (
            <RailRow
              key={thread.id}
              title={entry.title}
              subtitle={thread.last_message_preview ? plainPreview(thread.last_message_preview) : undefined}
              leading={entry.leading}
              unread={thread.unread}
              active={sameConversation(address, conversation)}
              onSelect={() => setConversation(address)}
              menu={threadMenu(thread)}
              starred={threadStarred(thread.id)}
            />
          ))}
        </ul>
      </RailSection>
      {gathering !== null && <div className="inline-flex flex-wrap items-center gap-2">
        <span role="status" className="text-muted-foreground">
          {gathering.length === 0
            ? t('Choose people')
            : `${gathering.length} selected`}
        </span>
        <Button
          disabled={gathering.length < 2}
          // Two people is a DM, and the DM button is already on their row.
          onClick={() => { setConversation({ peer_emails: gathering }); setGathering(null); }}
        >{t('Open')}</Button>
        <Button variant="secondary" onClick={() => setGathering(null)}>{t('Cancel')}</Button>
      </div>}
      <RailSection title={t('People')} {...railBlockProps('team', 'people')} count={railPeople.length + strays.length}>
        <ul className={railListClass}>
          {railPeople.map(peerRow)}
          {/* Conversations that outlived the row that started them: hiding
              somebody in Admin takes away the way to start a new one, never
              the one already open. Named from the thread. */}
          {strays.map((thread) => {
            const address = threadAddress(thread);
            const entry = conversationListEntry(address, others);
            return entry && (
              <RailRow
                key={thread.id}
                title={entry.title}
                subtitle={thread.last_message_preview ? plainPreview(thread.last_message_preview) : undefined}
                leading={entry.leading}
                unread={thread.unread}
                active={sameConversation(address, conversation)}
                onSelect={() => setConversation(address)}
                menu={threadMenu(thread)}
                starred={threadStarred(thread.id)}
              />
            );
          })}
        </ul>
      </RailSection>
      <RailSection title={t('Agents')} {...railBlockProps('team', 'agents')} count={railAgents.length}>
        <ul className={railListClass}>{railAgents.map(peerRow)}</ul>
      </RailSection>
    </>
  );

  return (
    <SurfaceShell
      surface="team"
      title={t('Team')}
      openTitle={openTitle}
      open={isOpen}
      onBack={showLounge}
      backLabel="Lounge"
      rail={rail}
      rightSidebar={{ open: rightSidebar.open, onToggle: rightSidebar.toggle }}
      create={<SurfaceCreate label={t('New group…')} items={[{ label: t('New group…'), onSelect: () => setGathering([]) }]} />}
      inspector={phone ? undefined : conversationTeam
        ? <ConversationContextPanel {...conversationTeam} now={now} actions={peerActions} />
        : peerPanel}
      before={<>
        {roster?.incoming_ring && (
          <RingBanner ring={roster.incoming_ring} onDone={() => { void clearIncomingRing().then(refreshPeers); }} />
        )}
        {error && <ErrorNotice message={error} />}
        {notice && <p className="mt-3 mb-0 text-[13px] text-muted-foreground" role="status">{notice}</p>}
        {calling && <Button variant="secondary" onClick={() => { callGeneration.current++; pendingCall.current = null; setCalling(false); setNotice(t('Stopped waiting.')); }}>{t('Cancel call')}</Button>}
      </>}
    >
      {threadOpen ? (
        <ThreadPane
          address={conversation ?? undefined}
          threadID={conversation ? undefined : requestedThread ?? undefined}
          focus={!conversation && arrival?.thread === requestedThread ? arrival.focus : undefined}
          mentionable={mentionable}
          agent={conversation && 'peer_email' in conversation ? agents.find((peer) => peer.email === conversation.peer_email) : undefined}
          agents={agents}
          fill
          sidebarToggle
          onClose={closeConversation}
          onOpenPerson={phone && personInConversation ? () => setSelectedPeerEmail(personInConversation.email) : undefined}
        />
      ) : (
        <TeamLounge
          me={me ?? null}
          people={people}
          agents={agents}
          now={now}
          rowMenu={rowMenu}
          peerActions={peerActions}
          onOpen={openPeer}
          onStatus={onStatus}
          selfHasUnread={unread.some((thread) => thread.kind === 'dm' && thread.peer_email === me?.email)}
          strays={unread.filter(thread => thread.kind !== 'project' && thread.kind !== 'lead' && thread.kind !== 'organization' && thread.kind !== 'event' && thread.kind !== 'team' && !(me && thread.kind === 'dm' && thread.peer_email === me.email))}
        />
      )}
      {/* On the phone the person slides over the column, the iOS sheet;
          the panel's own Close is the way out, so the Sheet draws none. */}
      {phone && (
        <Sheet open={Boolean(peerPanel) && !conversationTeam} onOpenChange={(open) => { if (!open) setSelectedPeerEmail(null); }}>
          <SheetContent
            side="right"
            showCloseButton={false}
            aria-describedby={undefined}
            className="w-full gap-0 overflow-y-auto p-0 sm:max-w-sm"
            // The sheet takes focus, not its first control: Close is the
            // first control, and focus there would put keyboard input on it.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              (event.currentTarget as HTMLElement | null)?.focus();
            }}
          >
            <SheetTitle className="sr-only">{selectedPeer ? peerDisplayName(selectedPeer) : t('Team')}</SheetTitle>
            {peerPanel}
          </SheetContent>
        </Sheet>
      )}
    </SurfaceShell>
  );
}

/**
 * Who is around — the Mac's `WorkLoungeView` for Team, block for block: the
 * heading and the Team Room door, your own strip with the status control,
 * then PEOPLE and AGENTS as tile grids. It is what the column shows while no
 * conversation is open, and the Lounge row brings it back.
 */
function TeamLounge({ me, people, agents, now, rowMenu, peerActions, onOpen, onStatus, selfHasUnread, strays }: {
  me: Peer | null;
  people: Peer[];
  agents: Peer[];
  now: number;
  rowMenu: RowMenuController;
  peerActions: PeerActions;
  onOpen: (peer: Peer) => void;
  onStatus: (option: StatusOption) => Promise<void>;
  selfHasUnread: boolean;
  strays: ThreadSummary[];
}) {
  const { rows: favorites } = useFavorites();

  const tile = (peer: Peer) => {
    const threadID = peerActions.threadFor?.(peer);
    const starred = peerStarred(favorites, peer, threadID);
    const key = `lounge:${peer.email}`;
    const menu = {
      rowProps: rowMenu.rowProps(key),
      targetProps: { 'data-row-target': '' },
      panel: rowMenu.panel(key, peerMenuItems(peer, peerActions), { className: 'absolute right-2 bottom-2 z-10' }),
    };
    return (
      // A Card with the face and its presence dot, the face at tile size.
      <li key={peer.email} {...menu?.rowProps} className={cn('relative', menu?.rowProps.className)}>
        <Card className={cn(LOUNGE_TILE, 'hover-lift hover-edge')}>
          {/* hover: the Card around it lifts */}
          {/* shadcn: the whole lounge tile is the target */}
          <button
            type="button"
            className="flex w-full min-w-0 cursor-pointer appearance-none flex-col items-center gap-0.5 border-0 bg-transparent p-0 text-center text-inherit"
            onClick={() => onOpen(peer)}
            {...menu?.targetProps}
          >
            <StarredLeading starred={starred}><PeerAvatar peer={peer} size="tile" /></StarredLeading>
            {starred && <span className="sr-only">{t('Starred')}</span>}
            <strong className="max-w-full truncate text-sm font-semibold">{peerDisplayName(peer)}</strong>
            {statusLine(peer, now) && <small className="text-xs text-muted-foreground">{statusLine(peer, now)}</small>}
          </button>
          {menu?.panel}
        </Card>
      </li>
    );
  };

  // The rail's section eyebrow (`RailSection`), stated in utilities.
  const section = (title: string, peers: Peer[]) => peers.length > 0 && (
    <section className="mb-4" aria-label={title}>
      <h3 className={LOUNGE_HEADING}>{title}</h3>
      <ul className={LOUNGE_GRID}>{peers.map(tile)}</ul>
    </section>
  );

  return (
    <section aria-label={t('Lounge')}>
      <LoungeHeader />
      {strays.map(thread => <p key={thread.id}><a href={threadHref(thread)}>{threadTitle(thread)} · {t('Unread')}</a></p>)}
      {me && (
        <SelfCard
          peer={me}
          now={now}
          onStatus={onStatus}
          onSelect={() => onOpen(me)}
          hasUnread={selfHasUnread}
        />
      )}
      {people.length === 0 && agents.length === 0 ? (
        <p className="lede">{t('Nobody else is here yet.')}</p>
      ) : (
        <>
          {section(t('People'), people)}
          {section(t('Agents'), agents)}
        </>
      )}
    </section>
  );
}

/** The lounge's pieces, shared by the loaded lounge and its skeleton. */
const LOUNGE_HEADING = "mt-0 mb-2 text-xs font-medium tracking-[.08em] text-muted-foreground uppercase";
const LOUNGE_GRID = 'm-0 grid list-none grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-2.5 p-0';
const LOUNGE_TILE = 'h-full items-center gap-2.5 rounded-xl px-3 py-3.5 shadow-none';
const SELF_STRIP = 'mb-[18px] flex items-center justify-between gap-2.5 rounded-lg px-1.5 py-1';

/**
 * The lounge header is the Mac's (`TeamWindowController`): a plain title
 * over a one-line subtitle, not the surface's display heading.
 */
function LoungeHeader() {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <h2 className="m-0 text-[22px] leading-tight font-semibold">{t('Team')}</h2>
        <p className="mt-0.5 mb-0 text-[13px] text-muted-foreground">{t('People and agents')}</p>
      </div>
      <Button asChild><a className="mb-0.5 flex-none" href={internalRoomPath}>
        <VideoIcon />
        {t('Team Room')}
      </a></Button>
    </div>
  );
}

/**
 * Team while the session opens, drawn in the page's own columns: the rail's
 * Lounge, YOU, GROUPS, PEOPLE and AGENTS, and the lounge with your strip and
 * the two tile grids. The same containers as the loaded page, so nothing
 * moves when it lands.
 */
function TeamSkeleton() {
  const tiles = (count: number) => (
    <ul className={LOUNGE_GRID} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <li key={index}>
          <Card className={LOUNGE_TILE}>
            <span className="flex w-full flex-col items-center gap-1.5">
              <PlaceholderBar immediate className="mb-2 size-14 rounded-full" />
              <PlaceholderBar immediate className={cn('h-3 rounded-full', index % 2 ? 'w-[52%]' : 'w-[64%]')} />
              <PlaceholderBar immediate className="h-2.5 w-[40%] rounded-full" />
            </span>
          </Card>
        </li>
      ))}
    </ul>
  );
  const rail = (
    <>
      <ul className={cn(railListClass, 'mb-3.5')} aria-hidden="true">
        <RailRow title={t('Lounge')} subtitle={t('Who is around')} active />
      </ul>
      <RailSection title={t('You')} {...railBlockProps('team', 'you')}>
        <RailRowsPlaceholder count={1} mark="avatar" immediate />
      </RailSection>
      <RailSection title={t('Groups')} {...railBlockProps('team', 'groups')}>
        <RailRowsPlaceholder count={2} mark="avatar" immediate />
      </RailSection>
      <RailSection title={t('People')} {...railBlockProps('team', 'people')}>
        <RailRowsPlaceholder count={5} mark="avatar" immediate />
      </RailSection>
      <RailSection title={t('Agents')} {...railBlockProps('team', 'agents')}>
        <RailRowsPlaceholder count={2} mark="avatar" immediate />
      </RailSection>
    </>
  );
  return (
    <SurfaceShell surface="team" title={t('Team')} rail={rail}>
      <PlaceholderStatus label={t('Opening…')} />
      <section>
        <LoungeHeader />
        <div className={SELF_STRIP} aria-hidden="true">
          <span className="flex min-w-0 flex-auto items-center gap-2.5">
            <PlaceholderBar immediate className="size-[38px] rounded-full" />
            <PlaceholderBar immediate className="h-3.5 w-36 rounded-full" />
          </span>
          <PlaceholderBar immediate className="h-8 w-28 rounded-md" />
        </div>
        <section className="mb-4">
          <h3 className={LOUNGE_HEADING}>{t('People')}</h3>
          {tiles(6)}
        </section>
        <section className="mb-4">
          <h3 className={LOUNGE_HEADING}>{t('Agents')}</h3>
          {tiles(3)}
        </section>
      </section>
    </SurfaceShell>
  );
}

/**
 * Everyone's or a group's inspector: the head, TEAM and AGENTS, then ABOUT —
 * the Mac's `teamConversationInfo` and `groupConversationInfo`.
 */
function ConversationContextPanel({ title, subtitle, about, team, now, actions }: {
  title: string;
  subtitle: string;
  about: string;
  team: ConversationTeam;
  now: number;
  actions: PeerActions;
}) {
  return (
    <InspectorContext title={title} subtitle={subtitle}>
      <ConversationTeamBlock team={team} now={now} {...actions} />
      <InspectorGroup title={t('ABOUT')}>
        <p>{about}</p>
      </InspectorGroup>
    </InspectorContext>
  );
}

/**
 * The web equivalent of the native person inspector/About surface. The roster
 * poll is its refresh signal, so this detail never creates a second presence
 * timer or quietly keeps fetching while the tab is hidden.
 */
function PeerInfoPanel({
  peer,
  now,
  refreshKey,
  leading,
  onClose,
  onMessage,
}: {
  peer: Peer;
  now: number;
  refreshKey: PeersResponse | null;
  leading: React.ReactNode;
  onClose: () => void;
  onMessage: () => void;
}) {
  const [work, setWork] = useState<PeerWork | null>(null);
  // Your own open tasks, for the subjects you share with this person.
  const [myTasks, setMyTasks] = useState<CrmMyTask[] | null>(null);
  const [schedule, setSchedule] = useState<CalendarFreeBusyPerson | null>(null);
  const [workError, setWorkError] = useState(false);
  // Why the schedule did not load: a neutral state or a real failure with the detail Copy carries.
  const [scheduleError, setScheduleError] = useState<{ kind: CalendarFailureKind; message: string; detail: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const [choosingTaskSubject, setChoosingTaskSubject] = useState(false);

  useEffect(() => {
    setWork(null);
    setMyTasks(null);
    setSchedule(null);
    setWorkError(false);
    setScheduleError(null);
    setChoosingTaskSubject(false);
  }, [peer.email]);

  useEffect(() => {
    let stopped = false;
    async function load() {
      if (isAgent(peer)) return;
      const [workResult, scheduleResult, mineResult] = await Promise.allSettled([
        fetchPeerWork(peer.email),
        fetchPeerFreeBusy(peer.email),
        fetchMyWork(),
      ]);
      if (stopped) return;
      if (mineResult.status === 'fulfilled') setMyTasks(mineResult.value.tasks);

      if (workResult.status === 'fulfilled') {
        setWork(workResult.value);
        setWorkError(false);
      } else {
        setWorkError(true);
      }
      if (scheduleResult.status === 'fulfilled') {
        setSchedule(scheduleResult.value);
        setScheduleError(null);
      } else {
        const cause: unknown = scheduleResult.reason;
        const kind = classifyCalendarFailure(cause);
        if (kind === 'cancelled') return;
        const message = cause instanceof Error && cause.message ? cause.message : t('Couldn’t load their calendar.');
        logCalendarFailure('team schedule', cause, 1, 'shown');
        setScheduleError({ kind, message, detail: calendarFailureDetail(cause, message) });
      }
    }
    void load();
    return () => { stopped = true; };
  }, [peer.email, peer, refreshKey, retry]);

  const title = peerDisplayName(peer);
  const openWork = useMemo(() => work ? planPeerWork(work.tasks, work.issues).order : [], [work]);
  const shared = useMemo(() => work && myTasks ? sharedSubjects(myTasks, work.tasks) : null, [work, myTasks]);
  const blocks = schedule && !schedule.error ? peerDaySchedule(schedule) : [];
  const localTime = peerLocalTime(peer, now);
  const withinHours = peerIsWithinWorkingHours(peer, now);

  return (
    <aside aria-label={`About ${title}`}>
      <header className="flex items-start justify-between gap-3 border-b bg-(--surface-raised) p-4">
        <div className="flex min-w-0 items-center gap-3">
          {leading}
          <div className="min-w-0">
            <h2 className="m-0 text-base font-semibold">{title}</h2>
            <small className={personNoteClass}>{peer.email}</small>
          </div>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label={`Close About ${title}`}>
          <CloseIcon />
        </Button>
      </header>

      {isAgent(peer) ? (
        <>
          {peer.activity && (
            <section className={personSectionClass}>
              <h3>{t('Activity')}</h3>
              {agentActivityLines(peer.activity, now).map((line) => <p key={line}>{line}</p>)}
            </section>
          )}
          {peer.manifest && (
            <section className={personSectionClass}>
              <h3>{t('About')}</h3>
              <p>{peer.manifest.description}</p>
              {peer.manifest.model && <small>{t('Runs on {model}', { model: peer.manifest.model })}</small>}
              {agentBuildLine(peer.manifest, now) && <small>{agentBuildLine(peer.manifest, now)}</small>}
              <TeamManifestList title={t('What it can do')} entries={(peer.manifest.skills ?? []).map((skill) => ({ name: skill.name, detail: skill.description }))} />
              <TeamManifestList title={t('Tools')} entries={(peer.manifest.tools ?? []).map(agentToolEntry)} />
              <TeamManifestDocs docs={peer.manifest.docs ?? []} />
              <TeamManifestList title={t('Connections')} entries={(peer.manifest.connections ?? []).map((connection) => ({ name: connection.name, detail: connection.protocol }))} />
              <TeamManifestList title={t('Schedules')} entries={(peer.manifest.schedules ?? []).map((schedule) => ({ name: schedule.cron, detail: schedule.description }))} />
              <TeamManifestKeys keys={peer.manifest.keys ?? []} />
              {agentManifestLinks(peer.manifest).length > 0 && (
                <>
                <h4>{t('Links')}</h4>
                <p className="flex gap-4">
                  {agentManifestLinks(peer.manifest).map((link) => <a key={link.title} href={link.url} target="_blank" rel="noreferrer noopener">{link.title}</a>)}
                </p>
                </>
              )}
            </section>
          )}
          <section className={personSectionClass}>
            <Button type="button" variant="secondary" onClick={onMessage}>{t('Message')}</Button>
          </section>
        </>
      ) : (
        <>
          <section className={personSectionClass}>
            <h3>{t('Reaching them')}</h3>
            <p>{statusLine(peer, now)}</p>
            {peer.clients.length > 0 && <small>{peerDevicesLine(peer)}</small>}
            {localTime && <small>{withinHours === false ? t('{time} their time · outside their hours', { time: localTime }) : t('{time} their time', { time: localTime })}</small>}
            {peer.status === 'offline' && peer.last_seen_at && <small>{t('Last seen {time}', { time: relativeTime(peer.last_seen_at, now) })}</small>}
            <Button className="mt-3" type="button" variant="secondary" onClick={onMessage}>{t('Message')}</Button>
          </section>

          <section className={personSectionClass}>
            <h3>{t('Today’s schedule')}</h3>
            {!schedule && !scheduleError && <PlaceholderRows count={2} glyph={false} label={t('Loading calendar…')} />}
            {scheduleError?.kind === 'not_connected' && <p>{t('Connect Google Calendar in Settings to see their schedule.')}</p>}
            {scheduleError?.kind === 'google_expired' && <p>{t('Your Google Calendar access expired. Reconnect it in Settings.')}</p>}
            {scheduleError && scheduleError.kind !== 'not_connected' && scheduleError.kind !== 'google_expired' && (
              <ErrorNotice
                message={t('Couldn’t load their calendar.')}
                copyText={scheduleError.detail}
                action={<Button type="button" variant="secondary" size="xs" onClick={() => setRetry((count) => count + 1)}>{t('Retry')}</Button>}
              />
            )}
            {!scheduleError && schedule?.error && <p>{peerScheduleNote(schedule.error)}</p>}
            {schedule && !schedule.error && !scheduleError && (
              blocks.length > 0 ? (
                <ul className={personListClass}>
                  {blocks.map((block) => (
                    <li key={`${block.kind}-${block.start.toISOString()}`} className="flex min-w-0 items-baseline justify-between gap-3">
                      <span className="text-[13px] text-foreground">{block.kind === 'busy' ? 'Busy' : 'Available'}</span>
                      <small className={personNoteClass}>{scheduleTime(block.start, block.end)}</small>
                    </li>
                  ))}
                </ul>
              ) : <p>{t('No schedule available.')}</p>
            )}
          </section>

          <section className={personSectionClass}>
            <div className="flex items-center justify-between gap-2">
              <h3>{t('Between us')}</h3>
              <span className="relative flex-none">
                <Button type="button" variant="outline" size="xs" onClick={() => setChoosingTaskSubject(true)}>
                  <PlusIcon />
                  {t('New task')}
                </Button>
                {choosingTaskSubject && (
                  <SubjectPicker
                    kinds={['project', 'lead', 'organization']}
                    onPick={(_, subject) => {
                      setChoosingTaskSubject(false);
                      navigate(subjectHref(subject, { pane: 'tasks', new: 'task' }));
                    }}
                    onClose={() => setChoosingTaskSubject(false)}
                  />
                )}
              </span>
            </div>
            {!work && !workError && <PlaceholderRows count={2} label={t('Loading work…')} />}
            {workError && <>
              <p>{t('Couldn’t load this record.')}</p>
              <Button type="button" variant="secondary" onClick={() => setRetry((value) => value + 1)}>{t('Retry')}</Button>
            </>}
            {work && !workError && (!work.matched ? (
              <p>{t('{name} has no record.', { name: title })}</p>
            ) : openWork.length === 0 ? (
              <p>{t('Nothing open for {name}.', { name: title })}</p>
            ) : (
              <ul className={cn('team-person-work-list', personListClass)}>
                {openWork.slice(0, 8).map((row) => {
                  if (row.origin === 'issue' && row.issue) {
                    const issue = row.issue;
                    return (
                      <li key={row.id} className="min-w-0 rounded-[9px] border bg-card">
                        <a className="block rounded-[9px] p-3 text-[13px] leading-[1.35] text-foreground no-underline [overflow-wrap:anywhere] hover:underline hover:decoration-(--hover-border) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" href={issue.url} target="_blank" rel="noreferrer noopener">
                          <strong className="block font-[550]">{issue.title}</strong>
                          <small className={personNoteClass}>{issue.repo} #{issue.number}</small>
                          {issue.labels.length > 0 && (
                            <span className="mt-2 flex flex-wrap gap-1.5">
                              {issue.labels.slice(0, 2).map((label) => (
                                <Badge key={label} variant="outline" className="rounded-full bg-(--surface-sunken) px-2 py-0.5 text-[10px] font-normal text-muted-foreground">{label}</Badge>
                              ))}
                            </span>
                          )}
                        </a>
                      </li>
                    );
                  }
                  const task = row.myTask;
                  if (!task) return null;
                  const href = peerTaskWorkHref(task);
                  return (
                    <TaskRow
                      key={row.id}
                      title={task.title}
                      metadata={peerTaskDetail(task)}
                      late={Boolean(task.due_date && isOverdue(task.due_date))}
                      onOpen={() => {
                        if (!href) {
                          toast(t('Couldn’t open that Work link.'), 'danger');
                          return;
                        }
                        navigate(href);
                      }}
                    />
                  );
                })}
                {openWork.length > 8 && <li className="min-w-0"><small className={personNoteClass}>{openWork.length - 8} more</small></li>}
              </ul>
            ))}
          </section>

          {/* What you are both on, clickable: the point of naming a shared project beside a conversation is going to it. */}
          {work?.matched && shared && (
            <section className={personSectionClass}>
              <h3>{t('Shared work')}</h3>
              {shared.length === 0 ? (
                <p>{t('No open work in common.')}</p>
              ) : (
                <ul className={railListClass}>
                  {shared.slice(0, 6).map((row) => (
                    <RailRow
                      key={`${row.subject.kind}:${row.subject.id}`}
                      title={row.title}
                      subtitle={t('them {theirs}, you {mine}', { theirs: row.theirs, mine: row.mine })}
                      onSelect={() => navigate(subjectHref(row.subject, { pane: 'tasks' }))}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </aside>
  );
}

/** A quiet line in the person panel: an address, a time, a count. */
const personNoteClass = 'block text-xs text-muted-foreground [overflow-wrap:anywhere]';

/**
 * One block of the person panel, flat on the inspector or the Sheet it
 * sits in: the inspector is already the panel, so no Card frame. A title,
 * eyebrows for its lists, muted lines.
 */
const personSectionClass = cn(
  'm-0 border-b p-4 last:border-b-0',
  '[&_h3]:mt-0 [&_h3]:mb-[.55rem] [&_h3]:text-[13px] [&_h3]:font-semibold',
  '[&_h4]:mt-[.9rem] [&_h4]:mb-[.55rem] [&_h4]:text-[11px] [&_h4]:font-semibold [&_h4]:tracking-[.04em] [&_h4]:text-muted-foreground [&_h4]:uppercase',
  '[&_p]:my-[.35rem] [&_p]:text-[13px] [&_p]:leading-[1.45] [&_p]:text-muted-foreground',
  '[&>small]:block [&>small]:text-xs [&>small]:text-muted-foreground [&>small]:[overflow-wrap:anywhere]',
);

/** The panel's lists: schedule blocks, tasks, issues. */
const personListClass = 'm-0 grid list-none gap-[.55rem] p-0';

function peerTaskDetail(task: PeerWork['tasks'][number]): string {
  const status = task.status.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const due = formatDay(task.due_date) || null;
  return [status, due, task.subject_title, due && isOverdue(task.due_date) ? t('Late') : null].filter(Boolean).join(' · ');
}

function peerTaskWorkHref(task: PeerWork['tasks'][number]): string | null {
  const subject = workSubjectOf(task);
  return subject ? subjectTaskHref(task.id, subject) : null;
}

/**
 * Why a teammate's day came back unreadable. Google answers `notFound` for a
 * calendar the caller may not see (another domain that shares no free/busy);
 * that is a state of the world, not a failure, so it is a sentence, not red.
 */
function peerScheduleNote(error: string): string {
  return error === 'not_shared' || error === 'notFound'
    ? t('Their calendar isn’t shared with you.')
    : t('Their calendar isn’t available to you.');
}

function peerDaySchedule(person: CalendarFreeBusyPerson, now = new Date()): Array<{ kind: 'available' | 'busy'; start: Date; end: Date }> {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const busy = person.busy
    .map((interval) => ({ start: new Date(interval.start), end: new Date(interval.end) }))
    .filter((interval) => !Number.isNaN(interval.start.valueOf()) && !Number.isNaN(interval.end.valueOf()) && interval.end > interval.start && interval.start < end && interval.end > start)
    .map((interval) => ({ start: new Date(Math.max(interval.start.valueOf(), start.valueOf())), end: new Date(Math.min(interval.end.valueOf(), end.valueOf())) }))
    .sort((left, right) => left.start.valueOf() - right.start.valueOf());

  const merged: Array<{ start: Date; end: Date }> = [];
  for (const interval of busy) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = new Date(Math.max(previous.end.valueOf(), interval.end.valueOf()));
    else merged.push(interval);
  }

  const blocks: Array<{ kind: 'available' | 'busy'; start: Date; end: Date }> = [];
  let cursor = start;
  for (const interval of merged) {
    if (cursor < interval.start) blocks.push({ kind: 'available', start: cursor, end: interval.start });
    blocks.push({ kind: 'busy', start: interval.start, end: interval.end });
    cursor = new Date(Math.max(cursor.valueOf(), interval.end.valueOf()));
  }
  if (cursor < end) blocks.push({ kind: 'available', start: cursor, end });
  return blocks;
}

function scheduleTime(start: Date, end: Date): string {
  const dayEnd = new Date(start);
  dayEnd.setHours(0, 0, 0, 0);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const endLabel = end.valueOf() === dayEnd.valueOf() ? '24:00' : formatTime(end);
  return `${formatTime(start)}–${endLabel}`;
}

/**
 * Somebody asked for you. No sound and no push by design — this is why the
 * banner explains itself rather than behaving like a ringing phone.
 */
function RingBanner({ ring, onDone }: { ring: IncomingRing; onDone: () => void }) {
  const who = ring.caller_name?.trim() || ring.caller_email;
  return (
    <Alert className="my-4 flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-(--surface-raised) px-4 py-3.5">
      <div>
        <strong className="block text-[15px]">{ring.kind === 'call' ? t('{who} wants to talk', { who }) : t('{who} waved at you', { who })}</strong>
        {ring.kind === 'call' && <p>{t('Open Starlings to answer.')}</p>}
        <small className="text-xs text-muted-foreground">{relativeTime(ring.created_at)}</small>
      </div>
      <div className="flex gap-2">
        {ring.kind !== 'call' && ring.room_slug && (
          <Button asChild><a href={`/room/${encodeURIComponent(ring.room_slug)}`}>
            <VideoIcon /> Join their room
          </a></Button>
        )}
        <Button type="button" variant="secondary" onClick={onDone}>
          {ring.kind === 'call' ? 'Not now' : 'Dismiss'}
        </Button>
      </div>
    </Alert>
  );
}

/**
 * The lounge's self strip — the Mac `WorkLoungeSelfStrip`: face, name, the
 * status control on the right. The rail's YOU row carries the status in its
 * row menu instead (`SelfMenuItems`).
 */
function SelfCard({ peer, now, onStatus, onSelect, active = false, hasUnread = false }: {
  peer: Peer;
  now: number;
  onStatus: (option: StatusOption) => Promise<void>;
  onSelect: () => void;
  active?: boolean;
  hasUnread?: boolean;
}) {
  return (
    <section
      className={cn(SELF_STRIP, 'hover-lift', active && 'shadow-[inset_3px_0_var(--accent)]')}
      aria-label={t('You')}
    >
      {/* The strip is the Message button, as on the Mac: clicking a person
          opens the conversation everywhere else in Meet, and an explicit
          Message beside it would say the row does something else. */}
      {/* hover: the self strip's section lifts */}
      {/* shadcn: the whole self strip is the target */}
      <button
        type="button"
        className="flex min-w-0 flex-auto cursor-pointer items-center gap-2.5 border-0 bg-transparent p-0 text-left text-inherit"
        aria-current={active ? 'page' : undefined}
        onClick={onSelect}
      >
        <PeerAvatar peer={peer} />
        <div>
          <strong className="block text-[15px] font-semibold">
            {peerDisplayName(peer)}
            {hasUnread && <span className="ml-1.5 inline-block size-2 rounded-full bg-foreground align-middle" aria-label={t('Unread notes to self')} />}
          </strong>
          {/* Your own roster looks ordinary to you; this is the one line
              that says nobody else sees you. */}
          {peer.invisible && <small className="mt-0.5 block text-xs text-muted-foreground italic">{APPEAR_OFFLINE_REMINDER}</small>}
        </div>
      </button>
      <StatusMenu peer={peer} now={now} onStatus={onStatus} />
    </section>
  );
}

/**
 * One menu, one answer — the Mac's status control verbatim: the current
 * status on the trigger.
 */
function StatusMenu({ peer, now, onStatus }: {
  peer: Peer;
  now: number;
  onStatus: (option: StatusOption) => Promise<void>;
}) {
  const current = selectedStatusOption(peer, now);
  const [open, setOpen] = useState(false);
  const menu = useMenuTrigger();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button ref={menu.trigger} type="button" variant="secondary" size="sm">
            <span>{current.label}</span>
            <ChevronIcon expanded={open} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={menu.onCloseAutoFocus}>
          <DropdownMenuRadioGroup
            value={current.key}
            onValueChange={(key) => {
              const option = STATUS_OPTIONS.find((candidate) => candidate.key === key);
              if (option) void onStatus(option);
            }}
          >
            {STATUS_OPTIONS.map((option) => (
              <DropdownMenuRadioItem key={option.key} value={option.key}>{option.label}</DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Your own row's menu, the Mac's `selfStatusMenu`: Notes to self
 * / the status, the current one checked / Star / the appear-offline
 * reminder while it applies.
 */
function SelfMenuItems({ peer, now, onOpen, onStatus }: {
  peer: Peer;
  now: number;
  onOpen: () => void;
  onStatus: (option: StatusOption) => Promise<void>;
}) {
  const current = selectedStatusOption(peer, now);
  return <>
    <RowMenuItems kind="person" context="self" facts={{ hasFavorite: !!peer.favorite_ref }} run={{ 'notes-self': onOpen }} render={{
      'set-status': () => <DropdownMenuRadioGroup value={current.key} onValueChange={(key) => {
        const option = STATUS_OPTIONS.find((candidate) => candidate.key === key);
        if (option) void onStatus(option);
      }}>
        {STATUS_OPTIONS.map((option) => <DropdownMenuRadioItem key={option.key} value={option.key}>{option.label}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>,
      'star-person': peer.favorite_ref ? () => <StarItem target={{ kind: 'meet.person', target_ref: peer.favorite_ref! }} /> : undefined,
    }} />
    {peer.invisible && <><DropdownMenuSeparator /><DropdownMenuItem disabled>{APPEAR_OFFLINE_REMINDER}</DropdownMenuItem></>}
  </>;
}

/** The star and a control after a rail row's title. */
const peerActionsClass = 'inline-flex items-center gap-0.5';

/**
 * How the composer would address this thread. Derived from `peers` rather than
 * from the id, because the id is a hash nobody can invert — and the composer
 * re-derives the same id from the same addresses, so a list row and a roster
 * click open one conversation instead of two.
 */
function threadAddress(thread: ThreadSummary): Exclude<ThreadCreateInput, { kind: string }> {
  const emails = (thread.peers ?? []).map((peer) => peer.email);
  if (emails.length > 1) return { peer_emails: emails };
  return { peer_email: emails[0] ?? thread.peer_email ?? '' };
}

/** Whether the open conversation is this one, so it is not drawn twice. */
function sameConversation(
  address: Exclude<ThreadCreateInput, { kind: string }>,
  open: ThreadCreateInput | null,
): boolean {
  if (!open || 'kind' in open) return false;
  const left = 'peer_email' in address ? [address.peer_email] : address.peer_emails;
  const right = 'peer_email' in open ? [open.peer_email] : open.peer_emails;
  if (left.length !== right.length) return false;
  const sorted = [...right].sort();
  return [...left].sort().every((email, index) => email === sorted[index]);
}

function conversationListEntry(conversation: Exclude<ThreadCreateInput, { kind: string }>, peers: Peer[]) {
  const emails = 'peer_email' in conversation ? [conversation.peer_email] : conversation.peer_emails;
  const selected = emails.map((email) => peers.find((peer) => peer.email === email));
  const names = emails.map((email, index) => selected[index] ? peerDisplayName(selected[index]!) : email.split('@')[0]);
  if (names.length === 0) return null;
  return {
    title: names.join(', '),
    leading: selected.length === 1 && selected[0] ? <PeerAvatar peer={selected[0]} /> : <GroupAvatar />,
  };
}

/** A person or agent is starred by their own favorite; the conversation's
 * favorite stands in only for a peer with no favorite ref. The menu changes it. */
function peerStarred(favorites: FavoriteRow[], peer: Peer, threadID?: string) {
  if (peer.favorite_ref) return isFavorite(favorites, { kind: isAgent(peer) ? 'meet.agent' : 'meet.person', target_ref: peer.favorite_ref });
  return Boolean(threadID) && isFavorite(favorites, { kind: 'meet.thread', target_ref: threadID! });
}

export function PeerRow({ peer, now, threadID, preview, unread = false, active = false, gathering = false, chosen = false, onChoose, onSelect, menu }: {
  peer: Peer;
  now: number;
  threadID?: string;
  /** An agent's last line in your conversation with it: its second line unless it is working. */
  preview?: string | null;
  unread?: boolean;
  active?: boolean;
  /** A group is being gathered, so the row offers being in it. Person
      actions live in the row menu — a row click opens their conversation. */
  gathering?: boolean;
  chosen?: boolean;
  onChoose?: () => void;
  onSelect: () => void;
  /** The row's menu (`peerMenuItems`); Team passes it, Agents does not. */
  menu?: ComponentProps<typeof RailRow>['menu'];
}) {
  const { rows: favorites } = useFavorites();
  return (
    <RailRow
      menu={menu}
      starred={peerStarred(favorites, peer, threadID)}
      title={peerDisplayName(peer)}
      subtitle={isAgent(peer) && peer.status !== 'busy' ? (preview ? plainPreview(preview) : undefined) : statusLine(peer, now)}
      leading={<PeerAvatar peer={peer} />}
      unread={unread}
      active={active}
      onSelect={onSelect}
      trailing={(
        <span className={peerActionsClass}>
          {gathering && (
            <Button type="button" variant={chosen ? 'default' : 'secondary'} aria-pressed={chosen} onClick={onChoose}>
              {chosen ? 'In' : 'Add'}
            </Button>
          )}
        </span>
      )}
    />
  );
}

/**
 * The account picture control shared by Settings' Account section and the
 * other member-facing account surfaces. Team only draws the picture; editing
 * it belongs in Settings.
 */
export function AvatarControl({ peer, onChanged }: { peer: Peer; onChanged: () => void }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('Couldn’t change your picture.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {/* shadcn: a hidden file input; a Button opens it */}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void run(() => uploadAvatar(file));
        }}
      />
      <Button
        type="button" variant="secondary"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {peer.avatar_updated_at === null ? t('Add a picture') : t('Change picture')}
      </Button>
      {peer.avatar_updated_at !== null && (
        <Button
          type="button" variant="secondary"
          disabled={busy}
          onClick={() => void run(removeAvatar)}
        >
          {t('Remove')}
        </Button>
      )}
      {error && <ErrorNotice inline message={error} />}
    </div>
  );
}

/**
 * The runtime's environment keys as pills — names and set/unset only, never a
 * value. A red pill is the answer to "why is it not responding" nine times out
 * of ten, which is why this is drawn and not left to a log.
 */
function TeamManifestKeys({ keys }: { keys: { name: string; set: boolean }[] }) {
  if (keys.length === 0) return null;
  const missing = keys.filter((key) => !key.set).length;
  return (
    <>
      <h4>{t('Keys')}</h4>
      <ul className="m-0 flex list-none flex-wrap gap-1 p-0" aria-label={missing > 0 ? `${keys.length} keys, ${missing} missing` : `${keys.length} keys, all set`}>
        {keys.map((key) => (
          <li
            key={key.name}
            className={cn(
              'inline-flex h-5 items-center rounded-[10px] border px-[7px]',
              key.set
                ? 'border-[color-mix(in_srgb,#3fb950_40%,transparent)] bg-[color-mix(in_srgb,#3fb950_16%,transparent)] text-[color-mix(in_srgb,#3fb950_70%,var(--ink))]'
                : 'border-(--error-border) bg-(--error-bg) text-(--danger-ink)',
            )}
            title={key.set ? t('Set') : t('Missing')}
          >
            <code className="font-mono text-[11px] leading-none font-medium tracking-[0.01em]">{key.name}</code>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * The house documents the runtime reads before it works, in the runtime's own
 * words: title, what it governs, and the links to read and to edit it. A
 * required doc is the one it obeys on every job — a VOICE.md for a writer —
 * so it is marked, and listed first.
 */
function TeamManifestDocs({ docs }: { docs: AgentManifestDoc[] }) {
  if (docs.length === 0) return null;
  const ordered = [...docs.filter((doc) => doc.required), ...docs.filter((doc) => !doc.required)];
  return (
    <>
      <h4>{t('Docs')}</h4>
      <ul className={agentTilesClass}>
        {ordered.map((doc) => (
          <li key={doc.name} className={agentTileClass}>
            {/* The title links to the doc; the mark says it is read on every
                job; the source line says where it lives and where a person edits it. */}
            <strong className="block text-sm font-[560] text-foreground [overflow-wrap:anywhere]">
              {doc.view_url
                ? <a className="underline decoration-border underline-offset-2 hover:decoration-current" href={doc.view_url} target="_blank" rel="noreferrer noopener">{doc.title ?? doc.name}</a>
                : (doc.title ?? doc.name)}
              {doc.required && (
                <span className="ml-1.5 inline-block rounded-[9px] border border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] px-1.5 py-px align-[2px] text-[10px] leading-[1.4] font-medium tracking-[0.02em] text-foreground uppercase">
                  {t('Read on every job')}
                </span>
              )}
            </strong>
            {doc.description && <small className={agentTileDetailClass}>{doc.description}</small>}
            {(doc.source || doc.edit_url) && (
              <small className="mt-1 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                {doc.source && <code className="font-mono text-[11px] leading-[1.4] font-medium [overflow-wrap:anywhere]">{doc.source}</code>}
                {doc.edit_url && <a href={doc.edit_url} target="_blank" rel="noreferrer noopener">{t('Edit')}</a>}
              </small>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function TeamManifestList({ title, entries }: { title: string; entries: { name: string; detail?: string }[] }) {
  if (entries.length === 0) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul className={agentTilesClass}>
        {entries.map((entry) => (
          <li key={entry.name}>
            <AgentTile entry={entry} />
          </li>
        ))}
      </ul>
    </>
  );
}

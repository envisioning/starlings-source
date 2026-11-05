import { Tip } from './Tip';
import { MAC_DOWNLOAD_URL } from '@starlings/contracts/deployment';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '@/ui/button';
import { roomPermalink } from './config';
import { OwnerAgendaCard, OwnerClock } from './OwnerToday';
import { OwnerHomeEvents, OwnerHomeInbox, OwnerHomeWork } from './OwnerHomeCards';
import { OwnerHomeCommercial } from './OwnerHomeCommercial';
import { useHomeLayout } from './home-layout';
import { useWorkModulesState } from './work-modules';
import { useHomeKeys } from './home-keys';
import { HomeColumns } from './HomeColumns';
import { homeModuleDraws, mergeHomeRecentRows, visibleHomeModules, type HomeModuleID } from '@starlings/contracts/home-layout-values';
import { parseSearchDoor, searchRowKey, type SearchDoor, type SearchRow } from '@starlings/contracts/search-values';
import { HOME_RECENT_LIMIT, SEARCH_RECENTS_EVENT, hrefForDoor, isExternalDoor, loadRecents, reconcileAgentRecents } from './search-doors';
import { GlyphMark, SubjectMark } from './SubjectMark';
import { IdentityAvatar } from './PeerAvatar';
import { QuickNotesPanel } from './QuickNotesPanel';
import { SetupCard } from './SetupCard';
import { useUnreadMessages } from './messages';
import { useInboxBesideTalk } from './crm-work';
import { useFavorites } from './favorites';
import { subscribePeers, type Peer } from './team-presence';
import { type WebOwner, type WebOwnerRoom, type OwnerRoomState } from './owner-session';
import { useOwnerHeartbeat } from './use-owner-heartbeat';
import { useMyRoomOpen } from './use-my-room';
import { AppShell } from './SiteChrome';
import {
  CalendarIcon,
  CopyLinkIcon,
  DesktopIcon,
  CheckCircleIcon,
  TaskIcon,
  TasksIcon,
  NoteIcon,
  DocsIcon,
  GearIcon,
  VideoIcon,
} from './action-icons';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { cn } from '@/lib/utils';
import { Item } from '@/ui/item';
import { Badge } from '@/ui/badge';
import { HomeCard, HomeCardHead, HomeRow, HomeRowText, homeRowMenuOptions } from './HomeModule';
import { useRowMenu } from './use-row-menu';
import { CopyLinkItem, MenuGroups, OpenItem, StarItem, favoriteTargetForDoor } from './row-menu-items';
import { StarredLeading } from './FavoriteToggle';

/**
 * Home for a signed-in member — and Home is *today*, the same answer the iOS
 * Home tab gives: the clock, then what is next, then the room itself. The
 * destinations (Work, Team) live in the workspace nav, not in a list of
 * buttons on this card, while the room/Meet flow stays part of Home.
 */
export function OwnerWebHome({ owner, room, roomState }: {
  owner: WebOwner;
  room?: WebOwnerRoom;
  roomState: OwnerRoomState;
}) {
  const roomURL = room ? `/room/${encodeURIComponent(room.slug)}` : undefined;
  const [copied, setCopied] = useState(false);
  // ↓ ↑ walk the rows of every module, whatever set and order the owner chose (`home-keys.ts`).
  const homeModules = useRef<HTMLDivElement>(null);
  useHomeKeys(homeModules);

  // Signed in and looking at Home counts as being around, whether or not Team
  // is the page in front of you.
  useOwnerHeartbeat(true);
  // Hosting is the Mac's job — this page can never start a room. What it can
  // do is notice when one is running and offer the door, which a member walks
  // straight through.
  const roomIsOpen = useMyRoomOpen(Boolean(room));
  // One accent per screen: the agenda card says when its hero's Join is on
  // screen, and the room card's primary steps down to neutral for as long.
  const [heroHoldsAccent, setHeroHoldsAccent] = useState(false);
  const primaryVariant = heroHoldsAccent ? 'secondary' : 'default';
  // The order is the person's, not this file's: `HomeLayout`
  // (fixtures/home-layout.json) decides which modules draw and in what
  // order — the same list the Mac and the phone read. A card with nothing
  // to say still draws nothing; that is the card's own rule.
  const { layout } = useHomeLayout(true);
  // A module whose work module is off is not drawn (docs/WORK_MODEL.md).
  // Until the workspace's answer is known, a gated module waits: drawing it
  // and then folding it is the flash a turned-off module must never show.
  const workModulesState = useWorkModulesState();
  const workModules = workModulesState.known ? workModulesState.modules ?? undefined : [];

  async function copyRoomLink() {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(roomPermalink(room.slug));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard permission denied, or an insecure context. The link is on
      // screen either way, so this is not worth an error banner.
    }
  }

  // Work and Team carry their unread count on the header nav: the tab says
  // how many, the INBOX card says who.
  // A subject channel (project, lead) belongs to Work; everything else is Team.
  const unread = useUnreadMessages(true);
  const unreadTalk = unread.filter((thread) => thread.kind === 'project' || thread.kind === 'lead' || thread.kind === 'organization' || thread.kind === 'event').length;
  // INBOX is the one count of what needs you: the talk plus the
  // proposals, notes, touches and comments the Work window's INBOX badge shows.
  const inboxBesideTalk = useInboxBesideTalk(true, unread.length);
  const unreadWork = unreadTalk + inboxBesideTalk.length;
  const unreadTeam = unread.length - unreadTalk;

  const roomCard = (
    <HomeCard>
      <HomeCardHead title={t('Your room')} className="items-center">
        {room && (
          <span className="inline-flex items-center gap-1">
            <Tip label={copied ? t('Copied') : t('Copy room link')}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={() => void copyRoomLink()}
                aria-label={copied ? t('Copied') : t('Copy room link')}
              >
                <CopyLinkIcon copied={copied} />
              </Button>
            </Tip>
          </span>
        )}
      </HomeCardHead>
      {room ? (
        // Your room's slug tile is a Home row like the others; the slug is its title.
        <HomeRow className="mb-2.5">
          <HomeRowText
            title={room.slug}
            wrap="title"
            titleClassName="text-2xl"
            detail={roomPermalink(room.slug)}
          >
            <small className="truncate text-xs text-muted-foreground">
              {roomIsOpen
                ? t('Your room is open.')
                : t('Ready to host.')}
            </small>
          </HomeRowText>
        </HomeRow>
      ) : roomState === 'unmapped' ? (
        // A verified member without a row in OWNER_ROOM_MAP. A state with
        // a next step, not an error: the rest of the workspace works.
        <HomeRow className="mb-2.5" role="status">
          <HomeRowText
            title={t('No room yet')}
            wrap="detail"
            detailClassName="max-w-[44rem] leading-normal"
            detail={
              t('Your account is verified, but no room is mapped to {email}. Ask the workspace admin to add one. Calendar, Work, and Team work without it.', { email: owner.email })
            }
          />
        </HomeRow>
      ) : (
        <ErrorNotice role="status" message={t('Couldn’t load your room right now. Reload to try again.')} />
      )}
      <div className="grid gap-2.5">
        {roomIsOpen && roomURL ? (
          <Button asChild size="lg" variant={primaryVariant} className="w-full"><a data-home-row href={roomURL}>
            <VideoIcon /> {t('Start room')}
          </a></Button>
        ) : (
          // A download, not the room: the quiet style, never the accent.
          <Button asChild size="lg" variant="secondary" className="w-full"><a data-home-row href={MAC_DOWNLOAD_URL}>
            <DesktopIcon /> Open Starlings for Mac
          </a></Button>
        )}
      </div>
    </HomeCard>
  );

  const modules: Record<HomeModuleID, ReactNode> = {
    messages: <OwnerHomeInbox />,
    work: <OwnerHomeWork />,
    commercial: <OwnerHomeCommercial />,
    notes: <QuickNotesPanel owner={owner.sub} />,
    agenda: <OwnerAgendaCard onHeroAccent={setHeroHoldsAccent} />,
    events: <OwnerHomeEvents />,
    room: roomCard,
    recent: <OwnerHomeRecent />,
  };

  return (
    <AppShell variant="wide" member="home" memberNavUnread={{ work: unreadWork, team: unreadTeam }}>
      {/* The Home lattice lives at the app-shell level so it uses the actual
          window edges; this stage keeps the clock and the module strip
          centred on top, and fills the space down to the footer. */}
      <div className="relative flex w-full min-w-0 flex-1 flex-col">
        <div className="relative z-1 mx-auto grid w-full max-w-[912px] min-w-0 gap-3.5 min-[744px]:max-w-[856px]">
          {/* The clock is Home's header on every surface; it is not a module and never moves. */}
          <section className="flex min-w-0 flex-col" aria-label={t('Today')}>
            <OwnerClock />
          </section>
          {/* The shortcut into Settings → Home, where the modules below are
              ordered and switched: one quiet gear on the strip's top right,
              the same corner the Mac and the phone give it. */}
          <Tip label={t('Home settings')}>
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              className="absolute top-0 right-0 z-1 rounded-full text-muted-foreground opacity-70 hover:text-foreground hover:opacity-100"
            >
              <a href="/settings#settings-home" aria-label={t('Home settings')}>
                <GearIcon />
              </a>
            </Button>
          </Tip>
          {/* The setup checklist (docs/ONBOARDING.md): not a Home module, so it
              is not in the person's order; it draws above them until the
              steps are done, hidden or turned off. */}
          <SetupCard owner={owner.sub} />
          {/* Two columns once two fit at 340 (`OwnerLaunchView.minColumnWidth`),
              growing to the Mac's 420 + 16 + 420 and never wider. Which column
              a card goes to is `packHomeColumns`, the Mac's and the phone's
              packer, from measured heights; the saved order holds inside each
              column. Quick Access is not packed: it spans below both. */}
          <div className="min-w-0" ref={homeModules}>
            <HomeColumns
              modules={visibleHomeModules(layout, workModules).filter((module) => module !== 'recent')}
              nodes={modules}
            />
            {visibleHomeModules(layout, workModules).includes('recent') && (
              <div data-home-module="recent">{modules.recent}</div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

/**
 * One jump list across the owner's starred things and this browser's recent
 * items. The Work sidebar's priority rule applies here: starred rows first,
 * then the recent order. Overlaps appear once.
 */
function OwnerHomeRecent() {
  const [recentRows, setRecentRows] = useState<SearchRow[]>(() => loadRecents().slice(0, HOME_RECENT_LIMIT));
  const { starredRows } = useFavorites();
  useEffect(() => {
    const refresh = () => setRecentRows(loadRecents().slice(0, HOME_RECENT_LIMIT));
    window.addEventListener(SEARCH_RECENTS_EVENT, refresh);
    const stopPeers = subscribePeers({ onValue: ({ peers }) => {
      const agentEmails = new Set(peers.filter((peer) => peer.kind === 'agent').map((peer) => peer.email.toLowerCase()));
      setRecentRows(reconcileAgentRecents(agentEmails).slice(0, HOME_RECENT_LIMIT));
    } });
    return () => {
      window.removeEventListener(SEARCH_RECENTS_EVENT, refresh);
      stopPeers();
    };
  }, []);
  const starredKeys = new Set(starredRows.map(searchRowKey));
  return <SearchRowTiles
    label={t('Quick access')}
    rows={mergeHomeRecentRows(recentRows, starredRows)}
    starredKeys={starredKeys}
  />;
}

/**
 * A full-width card of quick-access tiles. A subject's logo rides
 * on the row (`image`); a person's face comes from the roster by email;
 * the rest wear their kind's glyph. A row opens through the palette's door.
 * No rows, no card.
 */
function SearchRowTiles({ label, rows, starredKeys }: { label: string; rows: SearchRow[]; starredKeys: ReadonlySet<string> }) {
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => subscribePeers({ onValue: (roster) => setPeers(roster.peers) }), []);
  // Open, Copy link, and Star where the door names the favorite (`favoriteTargetForDoor`).
  const menu = useRowMenu();
  if (!homeModuleDraws('recent', rows.length > 0)) return null;

  const mark = (row: SearchRow, door: SearchDoor) => {
    if (door.to === 'person' || door.to === 'agent') {
      const peer = peers.find((candidate) => candidate.email.toLowerCase() === door.id.toLowerCase());
      return <IdentityAvatar
        email={door.id}
        name={row.title}
        avatarUpdatedAt={peer?.avatar_updated_at ?? null}
        agentAvatar={peer?.kind === 'agent' ? peer.agent_avatar : null}
      />;
    }
    if (door.to === 'subject') {
      return <SubjectMark subject={{ kind: door.subjectKind, organization_logo_url: row.image ?? null }} size={36} />;
    }
    return <GlyphMark size={36} shape={row.kind === 'task' || row.kind === 'issue' || row.kind === 'goal' || row.kind === 'decision' ? 'square' : 'round'}><SearchKindGlyph kind={row.kind} /></GlyphMark>;
  };

  return (
    <HomeCard aria-label={label} className="min-[744px]:mt-3.5 min-[744px]:[column-span:all]">
      <HomeCardHead title={label} />
      <ul className="m-0 flex list-none flex-nowrap gap-2.5 overflow-x-auto overflow-y-hidden overscroll-x-contain p-0 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {rows.flatMap((row) => {
          const door = parseSearchDoor(row.door);
          const href = door ? hrefForDoor(door, { roomSlug: null }) : null;
          if (!door || !href) return [];
          const key = searchRowKey(row);
          const isStarred = starredKeys.has(key);
          const favorite = favoriteTargetForDoor(door);
          const rowProps = menu.rowProps(key);
          return [(
            <li key={key} {...rowProps} className={cn(rowProps.className, 'relative flex-none')}>
              <Item asChild size="sm" className="w-[104px] flex-col flex-nowrap gap-2 rounded-[10px] px-2 py-3 text-inherit no-underline hover-lift">
                <a href={href} {...(isExternalDoor(door) ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>
                  <StarredLeading starred={isStarred}>{mark(row, door)}</StarredLeading>
                  {isStarred && <span className="sr-only">{t('Starred')}</span>}
                  <strong className="line-clamp-2 max-w-full text-center text-[11px] font-medium [overflow-wrap:anywhere]">{row.title}</strong>
                  <Badge variant="outline" className="h-[18px] max-w-full truncate bg-(--surface-raised) px-[7px] py-0.5 text-[9px] leading-none text-muted-foreground">
                    {homeTileTypeLabel(row, door)}
                  </Badge>
                </a>
              </Item>
              {menu.panel(key, (
                <MenuGroups groups={[
                  [<OpenItem key="open" href={href} external={isExternalDoor(door)} />, <CopyLinkItem key="copy" href={href} />],
                  favorite ? [<StarItem key="star" target={favorite} />] : [],
                ]} />
              ), { className: 'absolute top-1 right-1' })}
            </li>
          )];
        })}
      </ul>
    </HomeCard>
  );
}

/** The subject kind a subject tile opens, or the kind of another search row. */
function homeTileTypeLabel(row: SearchRow, door: SearchDoor): string {
  if (row.kind === 'subject' && door.to === 'subject') {
    return t(({ project: 'Project', lead: 'Lead', organization: 'Partner', event: 'Event' })[door.subjectKind]);
  }
  switch (row.kind) {
    case 'subject': return t('Subject');
    case 'person': return t('Person');
    case 'agent': return t('Agent');
    case 'thread': return t('Conversation');
    case 'document': return t('Document');
    case 'folder': return t('Folder');
    case 'event': return t('Event');
    case 'task': return t('Task');
    case 'issue': return t('Issue');
    case 'goal': return t('Goal');
    case 'decision': return t('Decision');
    case 'milestone': return t('Milestone');
    case 'call': return t('Call');
    case 'core': return t('Records');
    case 'destination': return t('Destination');
    case 'settings': return t('Settings');
    case 'verb': return t('Other');
    default: return t(row.kind);
  }
}

/** The kind's glyph for a tile with no picture: a conversation, a document, an event, a task, an issue. */
function SearchKindGlyph({ kind }: { kind: SearchRow['kind'] }) {
  const common = { width: 18, height: 18, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true as const };
  switch (kind) {
    case 'thread':
      // bubble.left.fill
      return <svg {...common}><path d="M8 2C4.4 2 1.5 4.4 1.5 7.4c0 1.5.7 2.9 1.9 3.9L2.6 14l3.2-1.4c.7.2 1.4.3 2.2.3 3.6 0 6.5-2.4 6.5-5.4S11.6 2 8 2Z" /></svg>;
    case 'document':
      // doc.text.fill
      return <svg {...common}><path d="M4 1.5h5l3.5 3.5v8.5A1 1 0 0 1 11.5 14.5h-7.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Zm1.5 6v1h5v-1h-5Zm0 2.5v1h5v-1h-5Z" /></svg>;
    case 'event':
      return <CalendarIcon />;
    case 'task':
      return <TaskIcon size={18} />;
    case 'issue':
      return <CheckCircleIcon size={18} />;
    case 'goal':
      return <TasksIcon />;
    case 'decision':
      return <NoteIcon />;
    default:
      return <DocsIcon />;
  }
}

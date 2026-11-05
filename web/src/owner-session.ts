import { startTransition, useEffect, useState } from 'react';
import { apiBase } from './config';
import { purgeOwnerLocalState } from './owner-local-state';
import { t } from './i18n';
import { readStored, removeStored, StorageKeys, writeStored } from './storage';

/**
 * Who is signed in, and which room is theirs.
 *
 * Every member surface asks the same two questions before it can draw anything,
 * so they ask them here rather than each re-implementing the 401-is-not-an-error
 * rule. A visitor is the normal case, not a failure: account discovery must
 * never block or noisily fail the public join door, so a lookup that breaks
 * resolves to `visitor` and the room code form appears as usual.
 */
export type WebOwner = {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  /** May open Admin. Hides the door only; the Worker checks every Admin read. */
  isAdmin?: boolean;
};

export type WebOwnerRoom = {
  slug: string;
  kind: string;
  ownerName?: string | null;
};

/**
 * Why there is no room, when there is none. A verified member whose address is
 * not in `OWNER_ROOM_MAP` is `unmapped` — a real state with a next step, not
 * an error — while a lookup that failed for any other reason is `unavailable`
 * and says nothing about whether a room exists.
 */
export type OwnerRoomState = 'mapped' | 'unmapped' | 'unavailable';

export type OwnerSessionState =
  | { kind: 'loading' }
  | { kind: 'visitor' }
  | { kind: 'owner'; owner: WebOwner; room?: WebOwnerRoom; roomState: OwnerRoomState };

/**
 * The last answer this document got, shared by every caller. Pages come and
 * go under one header now (web/src/navigation.ts), so the page after the
 * first draws the session it already knows and checks it again quietly,
 * rather than drawing a signed-out header while it asks.
 */
let known: OwnerSessionState | null = savedSession();
let inflight: Promise<OwnerSessionState> | null = null;

/**
 * The owner this browser last saw, for the first frame after a page load:
 * Home draws its cards (from their own snapshots) while `/auth/me` checks
 * the session behind it, instead of a loading screen for two round trips.
 * Only a head start — the Worker decides every read, and a 401 purges this
 * with the rest of the owner's local state (docs/CACHING.md).
 */
function savedSession(): OwnerSessionState | null {
  if (!wasMember()) return null;
  try {
    const saved = JSON.parse(readStored(StorageKeys.ownerSession)) as OwnerSessionState;
    return saved?.kind === 'owner' && typeof saved.owner?.email === 'string' ? saved : null;
  } catch {
    return null;
  }
}

function sameSession(a: OwnerSessionState, b: OwnerSessionState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'owner' || b.kind !== 'owner') return true;
  return a.owner.sub === b.owner.sub
    && a.owner.email === b.owner.email
    && a.owner.name === b.owner.name
    && a.owner.picture === b.owner.picture
    && a.owner.isAdmin === b.owner.isAdmin
    && a.room?.slug === b.room?.slug
    && a.room?.kind === b.room?.kind
    && a.room?.ownerName === b.room?.ownerName
    && a.roomState === b.roomState;
}

async function lookUpSession(): Promise<OwnerSessionState> {
  // A browser that was a member's asks both questions at once, which saves a
  // round trip in a row. A visitor's asks only the first: the public door
  // does not send a read that can only answer 401.
  const readRoom = () => fetch(`${apiBase}/owner/room`, { cache: 'no-store' });
  const earlyRoom = wasMember() ? readRoom() : null;
  // Settled here so a failure while `/auth/me` is still out is not an
  // unhandled rejection; the await below still sees it.
  earlyRoom?.catch(() => undefined);
  try {
    const response = await fetch(`${apiBase}/auth/me`, { cache: 'no-store' });
    // The Worker says nobody is signed in. Whatever this browser kept
    // for an owner is the last one's, so it goes now — not
    // when a list happens to ask next. A visitor with nothing kept
    // loses nothing. A network failure is not this: it says nothing
    // about the session and purges nothing.
    if (response.status === 401) {
      purgeOwnerLocalState();
      return { kind: 'visitor' };
    }
    if (!response.ok) throw new Error(t('Account lookup failed.'));
    const body = await response.json() as { owner?: WebOwner; is_admin?: boolean };
    if (!body?.owner) return { kind: 'visitor' };
    const owner: WebOwner = { ...body.owner, isAdmin: body.is_admin === true };
    const roomResponse = await (earlyRoom ?? readRoom());
    const roomBody = roomResponse.ok
      ? await roomResponse.json() as { room?: WebOwnerRoom }
      : undefined;
    const roomState: OwnerRoomState = roomBody?.room
      ? 'mapped'
      : roomResponse.status === 404 ? 'unmapped' : 'unavailable';
    return { kind: 'owner', owner, room: roomBody?.room, roomState };
  } catch {
    // Account discovery must never block the public join door. A failure
    // that is not a 401 says nothing about the session, so an owner already
    // drawn from the saved answer stays drawn.
    return known?.kind === 'owner' ? known : { kind: 'visitor' };
  }
}

/** One request at a time, however many callers mount together. */
function refreshSession(): Promise<OwnerSessionState> {
  inflight ??= lookUpSession().then((next) => {
    inflight = null;
    // Keep the object a caller already holds when nothing changed, so a
    // quiet re-check does not redraw the page.
    if (!known || !sameSession(known, next)) known = next;
    rememberMember(known);
    return known;
  });
  return inflight;
}

/**
 * Whether this browser was signed in as a member the last time it asked. Only
 * a hint for the first frame after a page load (`MemberLoadingShell`): it
 * decides whether the header shows the workspace tabs while the real answer
 * is on its way, never what a page may read or do.
 */
export function wasMember(): boolean {
  return readStored(StorageKeys.memberHint) === '1';
}

function rememberMember(session: OwnerSessionState) {
  if (session.kind === 'owner') {
    writeStored(StorageKeys.memberHint, '1');
    writeStored(StorageKeys.ownerSession, JSON.stringify(session));
  } else {
    removeStored(StorageKeys.memberHint);
    removeStored(StorageKeys.ownerSession);
  }
}

/** The session, outside a component: the same one request every hook shares. */
export function ownerSession(): Promise<OwnerSessionState> {
  return refreshSession();
}

export function useOwnerSession(): OwnerSessionState {
  const [state, setState] = useState<OwnerSessionState>(() => known ?? { kind: 'loading' });

  useEffect(() => {
    let active = true;
    void refreshSession().then((next) => {
      // A transition: a page whose code is still on its way (Home, once the
      // session says owner) keeps the wait on screen instead of falling back
      // to a blank one.
      if (active) startTransition(() => setState(next));
    });
    return () => { active = false; };
  }, []);

  return state;
}

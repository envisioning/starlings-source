import type { JoinRequestReceipt, LobbyStatusValue } from '@starlings/contracts';
import { loadMeetMediaPreferences } from './meet-media-preferences';
import type { JoinIdentity, LocalUserChoices } from './meeting-types';

/** LiveKit components-core key (`lk-user-choices`) — keep in sync if they rename it. */
const LIVEKIT_USER_CHOICES_KEY = 'lk-user-choices';

/**
 * Tab-scoped lobby receipt so an admitted (or still-waiting) guest can reload
 * and re-exchange without knocking again. sessionStorage dies with the tab;
 * leave / reject / meeting-end clear it explicitly.
 */
export type GuestLobbySession = {
  slug: string;
  requestId: string;
  lobbyToken: string;
  status: LobbyStatusValue;
  waitingCount: number;
  name: string;
  email: string;
};

const memory = new Map<string, string>();

function storageKey(slug: string): string {
  return `meet-guest-lobby:${slug}`;
}

function readRaw(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? memory.get(key) ?? '';
  } catch {
    return memory.get(key) ?? '';
  }
}

function writeRaw(key: string, value: string): void {
  memory.set(key, value);
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Memory fallback already holds it for this tab.
  }
}

function removeRaw(key: string): void {
  memory.delete(key);
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Ignore private-mode / SecurityError.
  }
}

function isLobbyStatus(value: unknown): value is LobbyStatusValue {
  return (
    value === 'waiting'
    || value === 'admitted'
    || value === 'rejected'
    || value === 'joined'
    || value === 'expired'
    || value === 'removed'
  );
}

function parseSession(raw: string, slug: string): GuestLobbySession | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<GuestLobbySession>;
    if (
      parsed.slug !== slug
      || typeof parsed.requestId !== 'string'
      || typeof parsed.lobbyToken !== 'string'
      || !parsed.requestId
      || !parsed.lobbyToken
      || !isLobbyStatus(parsed.status)
      || typeof parsed.name !== 'string'
      || typeof parsed.email !== 'string'
      || typeof parsed.waitingCount !== 'number'
    ) {
      return undefined;
    }
    // Terminal statuses are not resumable — next visit should knock fresh.
    // `removed` is terminal for the same reason from the other direction: the
    // control plane already refuses to exchange it.
    if (parsed.status === 'rejected' || parsed.status === 'expired' || parsed.status === 'removed') {
      return undefined;
    }
    return {
      slug: parsed.slug,
      requestId: parsed.requestId,
      lobbyToken: parsed.lobbyToken,
      status: parsed.status,
      waitingCount: parsed.waitingCount,
      name: parsed.name,
      email: parsed.email,
    };
  } catch {
    return undefined;
  }
}

export function readGuestLobbySession(slug: string): GuestLobbySession | undefined {
  const key = storageKey(slug);
  const session = parseSession(readRaw(key), slug);
  if (!session) {
    removeRaw(key);
    return undefined;
  }
  return session;
}

export function writeGuestLobbySession(session: GuestLobbySession): void {
  if (session.status === 'rejected' || session.status === 'expired' || session.status === 'removed') {
    clearGuestLobbySession(session.slug);
    return;
  }
  writeRaw(storageKey(session.slug), JSON.stringify(session));
}

export function clearGuestLobbySession(slug: string): void {
  removeRaw(storageKey(slug));
}

export function receiptFromSession(session: GuestLobbySession): JoinRequestReceipt {
  return {
    requestId: session.requestId,
    lobbyToken: session.lobbyToken,
    status: session.status,
    waitingCount: session.waitingCount,
  };
}

export function identityFromSession(session: GuestLobbySession): JoinIdentity {
  return {
    name: session.name,
    email: session.email,
  };
}

/** Rebuild device prefs from LiveKit + Meet media storage so reload can skip Prejoin. */
export function mediaChoicesForResume(username: string): LocalUserChoices {
  const stored = readLiveKitUserChoices();
  const media = loadMeetMediaPreferences();
  return {
    username: username.trim() || stored.username || '',
    // Off unless this browser has said otherwise before: a resume must not
    // switch on a device the guest never opted into. Same default as Prejoin.
    audioEnabled: stored.audioEnabled ?? false,
    videoEnabled: stored.videoEnabled ?? false,
    audioDeviceId: stored.audioDeviceId || 'default',
    videoDeviceId: stored.videoDeviceId || 'default',
    backgroundEffect: media.backgroundEffect,
  };
}

function readLiveKitUserChoices(): Partial<{
  username: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
  audioDeviceId: string;
  videoDeviceId: string;
}> {
  try {
    const raw = localStorage.getItem(LIVEKIT_USER_CHOICES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      username: typeof parsed.username === 'string' ? parsed.username : undefined,
      audioEnabled: typeof parsed.audioEnabled === 'boolean' ? parsed.audioEnabled : undefined,
      videoEnabled: typeof parsed.videoEnabled === 'boolean' ? parsed.videoEnabled : undefined,
      audioDeviceId: typeof parsed.audioDeviceId === 'string' ? parsed.audioDeviceId : undefined,
      videoDeviceId: typeof parsed.videoDeviceId === 'string' ? parsed.videoDeviceId : undefined,
    };
  } catch {
    return {};
  }
}

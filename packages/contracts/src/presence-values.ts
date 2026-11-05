import type { PeerClient, PeerStatus } from './index';

/**
 * The words a roster shows for presence. The ids are the wire's
 * (`PEER_STATUSES`, `PEER_CLIENTS`, `PEER_INTENTS` in `index.ts`); the web
 * reads these tables and the generator writes the Swift `label` of
 * `PeerStatus`, `PeerClient` and `PeerIntent` from them
 * (`Sources/Generated/PresenceValuesRegistry.swift`).
 */
export const PEER_STATUS_LABELS: Record<PeerStatus, string> = {
  // `dnd` on the wire: they asked not to be interrupted.
  dnd: 'Unavailable',
  in_meeting: 'In a meeting',
  busy: 'Busy',
  available: 'Available',
  active: 'Active',
  offline: 'Offline',
};

/** Named for where the person is, not for what we build. */
export const PEER_CLIENT_LABELS: Record<PeerClient, string> = {
  mac: 'Desktop',
  ios: 'Mobile',
  web: 'Web',
};

export const PEER_INTENT_LABELS: Record<'available' | 'focused', string> = {
  available: 'Available',
  focused: 'Focused',
};

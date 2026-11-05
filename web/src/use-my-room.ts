import { useEffect, useState } from 'react';
import { subscribePeers } from './team-presence';

/**
 * "Is my own room open right now?"
 *
 * Read off the team roster's own `is_self` row rather than a second endpoint:
 * `in_meeting` already means an open meeting with a live host lease, which is
 * exactly the condition under which a signed-in member's knock walks straight
 * in. So a button drawn from this never promises more than the door will give.
 *
 * Shares the tab's single roster poll rather than starting one — see
 * `shared-poll` for the cadence, which stops with the tab and slows while Meet
 * is behind another app. Failures leave the last answer alone: a stale "open"
 * costs one knock that lands in the waiting room, and a banner would be worse.
 */
export function useMyRoomOpen(enabled: boolean): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setOpen(false);
      return;
    }
    return subscribePeers({
      onValue: (roster) => {
        setOpen(roster.peers.some((peer) => peer.is_self && peer.status === 'in_meeting'));
      },
    });
  }, [enabled]);

  return open;
}

import { useEffect, useMemo, useRef } from 'react';
import type { GuestPresenceStage } from '@starlings/contracts';
import { GUEST_PRESENCE_HEARTBEAT_MILLISECONDS } from '@starlings/contracts/limits';
import { apiFetch } from './api';
import { guestClient } from './guest-client';
import { t } from './i18n';

const storageKey = (slug: string) => `meet.guestPresence.${slug}`;

/** Stable per-tab presence id so heartbeats upsert the same lurker row. */
export function presenceIdForRoom(slug: string): string {
  try {
    const existing = sessionStorage.getItem(storageKey(slug));
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem(storageKey(slug), id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export function clearPresenceId(slug: string): void {
  try {
    sessionStorage.removeItem(storageKey(slug));
  } catch {
    // sessionStorage may be blocked; ignore.
  }
}

/**
 * Heartbeats pre-knock stage to the control plane while the guest is on the
 * join page. Stops once they knock (or leave the knock path).
 */
export function useGuestPresence(options: {
  room: string;
  active: boolean;
  stage: GuestPresenceStage;
  name?: string;
  bookingToken?: string;
  /** Bump to start a fresh visit after an intentional leave. */
  resetKey?: number;
}): string {
  const presenceId = useMemo(
    () => (options.room ? presenceIdForRoom(options.room) : ''),
    [options.room, options.resetKey],
  );
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (!options.room || !options.active || !presenceId) return;

    let cancelled = false;

    async function beat() {
      const { room, active, stage, name, bookingToken } = latest.current;
      if (!active || cancelled) return;
      try {
        await apiFetch(`/rooms/${room}/guest-presence`, {
          body: {
            presence_id: presenceId,
            stage,
            ...(name?.trim() ? { name: name.trim() } : {}),
            ...(bookingToken?.trim() ? { booking_token: bookingToken.trim() } : {}),
            client: guestClient(),
          },
          fallbackError: t('Presence update failed.'),
          keepalive: true,
        });
      } catch {
        // Best-effort — host simply won't see this tab until the next beat.
      }
    }

    // A hidden tab is not somebody standing at the door, so it stops beating
    // and goes stale in the host's list — the same answer the Mac gives when
    // its screen locks. Becoming visible beats immediately rather than waiting
    // out an interval, so coming back re-announces within one round trip.
    let timer: number | undefined;

    const start = () => {
      window.clearInterval(timer);
      void beat();
      timer = window.setInterval(() => void beat(), GUEST_PRESENCE_HEARTBEAT_MILLISECONDS);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else window.clearInterval(timer);
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [options.room, options.active, options.stage, options.name, options.bookingToken, options.resetKey, presenceId]);

  return presenceId;
}

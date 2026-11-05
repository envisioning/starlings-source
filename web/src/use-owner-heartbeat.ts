import { useEffect } from 'react';
import { heartbeatIntervalMs, sendHeartbeat } from './team-presence';

/**
 * "This browser has Meet open."
 *
 * Beats only while the tab is visible and only while a member session is known
 * to exist. Without this the web is invisible to presence: a colleague who
 * lives in the browser reads as offline to the whole team, and their last-seen
 * is stuck at whenever they last opened the Mac.
 *
 * Best-effort throughout — a dropped beat costs one status for one minute, so
 * failures are swallowed rather than surfaced.
 */
export function useOwnerHeartbeat(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;

    const beat = () => {
      if (document.visibilityState !== 'visible') return;
      void sendHeartbeat().catch(() => {});
    };

    const start = () => {
      window.clearInterval(timer);
      beat();
      timer = window.setInterval(beat, heartbeatIntervalMs);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else window.clearInterval(timer);
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);
}

import { useEffect } from 'react';
import { CALENDAR_REFRESH_SECONDS } from '@starlings/contracts/limits';

/** Poll while the page is in front, the way the agenda does. A card that must stay closer to live passes its own interval. */
export function useForegroundPoll(load: () => Promise<void>, intervalMs = CALENDAR_REFRESH_SECONDS * 1_000): void {
  useEffect(() => {
    let timer: number | undefined;
    const run = () => {
      if (document.visibilityState !== 'visible') return;
      void load();
    };
    const start = () => {
      window.clearInterval(timer);
      run();
      timer = window.setInterval(run, intervalMs);
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
    // Mounting once is the point: the poll owns its own lifecycle.
}, []);
}

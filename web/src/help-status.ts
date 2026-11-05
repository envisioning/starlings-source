import { useCallback, useEffect, useState } from 'react';
import type { HelpStatusResponse } from '@starlings/contracts';
import { apiFetch } from './api';

/*
 * The Help button's unread count. Light on purpose: the header is
 * on the guest entry path, and the Help panel itself loads only when opened.
 */

const STATUS_POLL_MS = 5 * 60 * 1000;

/** The Help button's unread count, read on load, every five minutes and when the tab comes back. */
export function useHelpUnread(): [number, () => void] {
  const [unread, setUnread] = useState(0);
  const refresh = useCallback(() => {
    apiFetch<HelpStatusResponse>('/help/status', { fallbackError: '' }).then(
      (status) => setUnread(status.available ? status.unread : 0),
      () => setUnread(0),
    );
  }, []);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, STATUS_POLL_MS);
    const onFocus = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onFocus);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onFocus); };
  }, [refresh]);
  return [unread, refresh];
}


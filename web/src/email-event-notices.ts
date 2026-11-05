import { useEffect } from 'react';
import type { PendingCalendarEvent, PendingCalendarEventsResponse } from '@starlings/contracts';
import { apiFetch } from './api';
import { t } from './i18n';
import { navigate } from './navigation';
import { PENDING_EVENTS_POLL_KEY, subscribePoll } from './shared-poll';
import { toast } from './Toast';

/**
 * Events from mail forwarded to calendar@ land in Inbox; this says so, the
 * same words the Mac and the phone use: "2 events from your email". A tab
 * with focus gets a toast with Open. A tab behind another window gets the
 * browser's own notification, once the member allowed it, which the first
 * Open asks for. Only while a Starlings tab is open: there is no web push.
 *
 * The seen set lives here, not in a component, so moving between pages does
 * not announce the same rows again. The first answer records and does not
 * announce, like the Mac.
 */
let seen: Set<string> | null = null;

async function fetchPending(): Promise<PendingCalendarEvent[]> {
  const body = await apiFetch<PendingCalendarEventsResponse>('/calendar/pending', { fallbackError: t('Couldn’t load events from email.'), noStore: true });
  return body.events;
}

export function emailEventNotice(events: readonly PendingCalendarEvent[]): { title: string; body: string } | null {
  const first = events[0];
  if (!first) return null;
  if (events.length === 1) return { title: t('Event from your email'), body: first.title };
  return { title: t('{count} events from your email', { count: events.length }), body: events.map((event) => event.title).join(', ') };
}

function openInbox(): void {
  navigate('/work');
}

function announce(events: PendingCalendarEvent[]): void {
  const notice = emailEventNotice(events);
  if (!notice) return;
  const canNotify = typeof Notification !== 'undefined';
  if (!document.hasFocus() && canNotify && Notification.permission === 'granted') {
    const banner = new Notification(notice.title, { body: notice.body, tag: 'starlings-email-events' });
    banner.onclick = () => {
      window.focus();
      openInbox();
      banner.close();
    };
    return;
  }
  toast(notice.title, 'neutral', {
    label: t('Open'),
    run: () => {
      // A click is the gesture the browser wants before it asks.
      if (canNotify && Notification.permission === 'default') void Notification.requestPermission();
      openInbox();
    },
  });
}

export function useEmailEventNotices(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    return subscribePoll(PENDING_EVENTS_POLL_KEY, fetchPending, {
      onValue: (events) => {
        const fresh = seen ? events.filter((event) => !seen?.has(event.id)) : [];
        seen = new Set(events.map((event) => event.id));
        announce(fresh);
      },
      // A missed read is a missed banner; the rows still wait in Inbox.
    });
  }, [enabled]);
}

// A ⌘K event row opens the event whatever week Calendar has loaded
// (meet#191): the week moves to the event, or the page says why it cannot.
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebCalendarEvent } from './owner-agenda';

vi.mock('./owner-agenda', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./owner-agenda')>();
  return {
    ...actual,
    fetchEventsInRange: vi.fn(),
    fetchCalendarSources: vi.fn(async () => []),
    fetchSubscriptionEventsInRange: vi.fn(async () => []),
    fetchCalendarPreferences: vi.fn(async () => undefined),
    fetchCalendarLayers: vi.fn(async () => ({ items: [], degraded: new Set() })),
  };
});
vi.mock('./owner-session', () => ({
  wasMember: () => true,
  useOwnerSession: () => ({ kind: 'owner', owner: { sub: 'x', email: 'rosa@example.com', name: 'Rosa' }, roomState: 'mapped', room: { slug: 'rosa', kind: 'personal' } }),
}));
vi.mock('./use-owner-heartbeat', () => ({ useOwnerHeartbeat: () => {} }));
vi.mock('./SiteChrome', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('./CalendarEventEditor', () => ({
  CalendarEventEditor: ({ event }: { event?: WebCalendarEvent }) => <div data-testid="editor">{event?.title ?? 'new'}</div>,
}));

const { fetchEventsInRange } = await import('./owner-agenda');
const { CalendarPage } = await import('./CalendarPage');

function event(id: string, start: Date): WebCalendarEvent {
  return {
    id,
    title: `Event ${id}`,
    start: start.toISOString(),
    end: new Date(start.getTime() + 3_600_000).toISOString(),
    calendarId: 'primary',
    calendarSummary: 'Envisioning',
    location: '',
    platform: 'none',
    conferenceUrl: '',
    joinUrl: '',
    htmlLink: '',
    roomSlug: '',
    attendees: [],
    demoted: false,
    allDay: false,
  };
}

/** Answers the current week with `week`, and any wider span with `wide`. */
function answerRanges(week: WebCalendarEvent[], wide: WebCalendarEvent[] | Error) {
  vi.mocked(fetchEventsInRange).mockImplementation(async (from: Date, to: Date) => {
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
    if (days <= 7) return week;
    if (wide instanceof Error) throw wide;
    return wide;
  });
}

// Each test waits for the end state it expects (findBy*), not for a count of
// microtask turns: the `?event=` path is a chain of loads and lookups whose
// length changes whenever `load` gains an await.
async function open(url: string) {
  window.history.replaceState(null, '', url);
  await act(async () => { render(<CalendarPage />); });
}

beforeEach(() => {
  vi.mocked(fetchEventsInRange).mockReset();
});

describe('an event permalink on the web calendar (meet#581)', () => {
  it('opens an event in the loaded week and keeps its address', async () => {
    const near = event('primary:near', new Date(Date.now() + 3_600_000));
    answerRanges([near], []);
    await open('/calendar/event/primary%3Anear');
    expect((await screen.findByTestId('editor')).textContent).toBe('Event primary:near');
    expect(screen.queryByRole('button', { name: 'Star' })).toBeNull();
    expect(window.location.pathname).toBe('/calendar/event/primary%3Anear');
  });

  it('moves the week to an event outside it, then opens it', async () => {
    const far = event('primary:far', new Date(Date.now() + 20 * 86_400_000));
    // The first week has nothing; the wide window has the event; the week
    // the page moves to has it too.
    const farStart = Date.parse(far.start);
    const weekRanges: Array<{ from: number; to: number }> = [];
    vi.mocked(fetchEventsInRange).mockImplementation(async (from: Date, to: Date) => {
      const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
      if (days > 7) return [far];
      const range = { from: from.getTime(), to: to.getTime() };
      weekRanges.push(range);
      return range.from <= farStart && farStart < range.to ? [far] : [];
    });
    await open('/calendar/event/primary%3Afar');
    expect((await screen.findByTestId('editor')).textContent).toBe('Event primary:far');
    expect(window.location.pathname).toBe('/calendar/event/primary%3Afar');
    expect(weekRanges.some(({ from, to }) => from <= farStart && farStart < to)).toBe(true);
  });

  it('says when the event is not in the range Search covers, and keeps the address until dismissed', async () => {
    answerRanges([], []);
    await open('/calendar/event/primary%3Agone');
    expect(await screen.findByText('That event is not in the calendar range Search covers.')).toBeTruthy();
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(window.location.pathname).toBe('/calendar/event/primary%3Agone');
    await act(async () => { screen.getByText('Dismiss').click(); });
    expect(window.location.pathname).toBe('/calendar');
    expect(screen.queryByText('That event is not in the calendar range Search covers.')).toBeNull();
  });

  it('tells a failed lookup apart from a missing event, with Retry', async () => {
    answerRanges([], new Error('offline'));
    await open('/calendar/event/primary%3Alater');
    expect(await screen.findByText('Couldn’t look for that event.')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
    expect(window.location.pathname).toBe('/calendar/event/primary%3Alater');
  });
});

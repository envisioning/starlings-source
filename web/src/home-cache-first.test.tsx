// docs/CACHING.md, meet#691: the first frame of every Home module comes from
// the snapshot, read before any request starts; the live read revalidates
// behind it. Each test holds every request open (a network that never
// answers) and records what the page already showed when the first one left.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook } from '@testing-library/react';

vi.mock('./api', () => ({ apiFetch: vi.fn() }));
const { apiFetch } = await import('./api');
const { purgeSnapshots, saveSnapshot } = await import('./snapshot-store');
const { HOME_SNAPSHOT } = await import('./home-snapshots');
// The cards load here, at collection, not inside a test: OwnerHomeCards pulls
// a large module graph, and under the full `pnpm test:web` run its first
// import alone passed the 5s test timeout. Each card reads its snapshot when
// it renders, never when its module loads, so loading early changes nothing.
const { OwnerHomeCommercial } = await import('./OwnerHomeCommercial');
const { OwnerHomeEvents } = await import('./OwnerHomeCards');
const { OwnerAgendaCard } = await import('./OwnerToday');

/** The page's text at the moment the first request went out. */
let shownAtFirstRequest: string | null = null;

function holdEveryRequest(): void {
  shownAtFirstRequest = null;
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(() => {
    shownAtFirstRequest ??= document.body.textContent ?? '';
    return new Promise(() => {});
  });
}

function inDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

beforeEach(() => {
  localStorage.clear();
  purgeSnapshots();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  holdEveryRequest();
});

describe('Home paints from the snapshot before it asks', () => {
  it('COMMERCIAL: the saved summary, never the placeholder bar', async () => {
    saveSnapshot('crm/commercial-summary', {
      lookback_months: 12,
      offers: 7,
      sales_amount: 1200,
      pipeline_amount: 800,
      new_licenses: 3,
      currency_code: 'EUR',
      points: [],
    });
    const { container } = render(<OwnerHomeCommercial />);

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(shownAtFirstRequest).toContain('Offers & sales');
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('EVENTS: the saved rows, before the feed is read again', async () => {
    saveSnapshot(HOME_SNAPSHOT.publicEvents, [
      { id: 'summit', title: 'Signals Summit', date: inDays(3), starts_at: null, ends_at: null, is_all_day: true, location: null, signup_url: null },
    ]);
    render(<OwnerHomeEvents />);

    expect(apiFetch).toHaveBeenCalled();
    expect(shownAtFirstRequest).toContain('Signals Summit');
  });

  it('UPCOMING: a saved empty day is an answer, not "Loading your day…"', async () => {
    saveSnapshot(HOME_SNAPSHOT.upcoming, []);
    const { container } = render(<OwnerAgendaCard />);

    expect(apiFetch).toHaveBeenCalled();
    expect(shownAtFirstRequest).not.toContain('Loading your day');
    expect(container.textContent).not.toContain('Loading your day');
  });
});

describe('the Home layout on a cold start', () => {
  it('draws the saved order before the Worker is asked for it', async () => {
    const saved = [
      { id: 'agenda', enabled: true },
      { id: 'messages', enabled: false },
    ];
    localStorage.setItem('meet-home-layout', JSON.stringify(saved));
    // The cache is read when the module loads: a fresh copy, as a page load.
    vi.resetModules();
    const api = await import('./api');
    let drawn: string[] = [];
    let orderAtFirstRequest: string[] | null = null;
    const layoutModule = await import('./home-layout');
    vi.mocked(api.apiFetch).mockImplementation(() => {
      orderAtFirstRequest ??= drawn;
      return new Promise(() => {});
    });
    const hook = renderHook(() => {
      const value = layoutModule.useHomeLayout(true);
      drawn = value.layout.map((row) => row.id);
      return value;
    });

    expect(hook.result.current.layout[0]).toEqual({ id: 'agenda', enabled: true });
    expect(hook.result.current.layout.find((row) => row.id === 'messages')?.enabled).toBe(false);
    expect(api.apiFetch).toHaveBeenCalledWith('/home/preferences', expect.anything());
    expect(orderAtFirstRequest?.[0]).toBe('agenda');
  });
});

import { meetActivity, meetBuild } from 'virtual:meet-version';

const DAY_MS = 86_400_000;

/** One day: a faint well when empty, then the accent in four quartile steps over the raised card. */
const DAY = [
  'aspect-square rounded-[2px] bg-foreground/6',
  'data-[level=future]:bg-transparent',
  'data-[level=1]:bg-[color-mix(in_srgb,var(--accent)_30%,var(--surface-raised))]',
  'data-[level=2]:bg-[color-mix(in_srgb,var(--accent)_55%,var(--surface-raised))]',
  'data-[level=3]:bg-[color-mix(in_srgb,var(--accent)_80%,var(--surface-raised))]',
  'data-[level=4]:bg-(--accent)',
].join(' ');
const MAX_WEEKS = 52;

function utcDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Monday-first weekday index, 0..6. */
function weekday(ms: number): number {
  return (new Date(ms).getUTCDay() + 6) % 7;
}

/**
 * Commits per day since the first commit, one column per week, Monday at the
 * top. The shade steps by quartile of the busiest days so a single spike does
 * not wash out the rest. No tooltips, per the web rule; the figure's label
 * carries the totals and each cell its own count for assistive tech.
 */
export function ChangelogActivity() {
  if (meetActivity.length === 0) return null;

  const counts = new Map(meetActivity);
  const today = utcDay(isoDay(Date.now()));
  const first = utcDay(meetActivity[0][0]);
  // Start on the Monday of the first commit's week, but never further back
  // than a year.
  const earliest = Math.max(first - weekday(first) * DAY_MS, today - (MAX_WEEKS * 7 - 1) * DAY_MS);
  const start = earliest - weekday(earliest) * DAY_MS;

  const sorted = [...counts.values()].sort((a, b) => a - b);
  const step = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const thresholds = [step(0.25), step(0.5), step(0.75)];
  const level = (n: number) => (n === 0 ? 0 : 1 + thresholds.filter((t) => n > t).length);

  const weeks: number[][] = [];
  for (let ms = start; ms <= today; ms += 7 * DAY_MS) {
    weeks.push(Array.from({ length: 7 }, (_, i) => ms + i * DAY_MS));
  }

  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const days = Math.round((today - first) / DAY_MS) + 1;
  const label = `${meetBuild === '0' ? total : meetBuild} commits in ${days} days`;

  return (
    <figure className="mt-6 mb-2 grid gap-2" aria-label={label}>
      {/* Cells shrink to fit a year across the document, and stop at 12px
          when there are fewer weeks than that. */}
      <div className="grid auto-cols-[minmax(0,1fr)] grid-flow-col gap-[3px]" role="img" aria-hidden="true" style={{ maxWidth: weeks.length * 15 - 3 }}>
        {weeks.map((days) => (
          <div className="grid grid-rows-7 gap-[3px]" key={days[0]}>
            {days.map((ms) => {
              const n = ms > today ? 0 : counts.get(isoDay(ms)) ?? 0;
              return <span className={DAY} data-level={ms > today ? 'future' : level(n)} key={ms} />;
            })}
          </div>
        ))}
      </div>
      <figcaption className="text-xs tabular-nums">{label}</figcaption>
    </figure>
  );
}

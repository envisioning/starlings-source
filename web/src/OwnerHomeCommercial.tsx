import { useEffect, useState, type ReactNode } from 'react';
import type { CommercialSummary } from '@starlings/contracts';
import { apiFetch } from './api';
import { loadSnapshot, saveSnapshot } from './snapshot-store';

/** The phone keeps the same answer under the same name. */
const COMMERCIAL_SNAPSHOT = 'crm/commercial-summary';
import { ChartIcon, ChevronRightIcon } from './action-icons';
import { t, uiLocale } from './i18n';
import { HomeCard, HomeCardHead, HomeMore } from './HomeModule';
import { PlaceholderBar } from '@/ui/placeholder-rows';

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat(uiLocale, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

/** One figure: a small uppercase label over the value. The second row reads smaller. */
function Stat({ label, small = false, children }: { label: string; small?: boolean; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] tracking-[.08em] text-muted-foreground uppercase">{label}</dt>
      <dd className={`m-0 mt-0.5 leading-[1.1] font-[650] text-foreground ${small ? 'text-[14px]' : 'text-[18px]'}`}>{children}</dd>
    </div>
  );
}

function CommercialBars({ summary }: { summary: CommercialSummary }) {
  const maximum = Math.max(...summary.points.map((point) => point.total), 0);
  return (
    <div className="flex h-[52px] items-end gap-1" role="img" aria-label={t('Monthly offer value for the latest {months} months', { months: summary.lookback_months })}>
      {summary.points.map((point) => {
        const accepted = Math.max(point.positive, 0);
        const expired = Math.max(point.negative, 0);
        const active = Math.max(point.total - accepted - expired, 0);
        const scale = maximum > 0 ? 100 / maximum : 0;
        return (
          <div className="flex h-full min-w-0 flex-[1_1_0] flex-col-reverse" key={point.key} title={point.label + ': ' + formatCurrency(point.total, summary.currency_code)}>
            <span className="block min-h-0 w-full bg-foreground" style={{ height: String(accepted * scale) + '%' }} />
            <span className="block min-h-0 w-full bg-[var(--accent)]" style={{ height: String(active * scale) + '%' }} />
            <span className="block min-h-0 w-full bg-muted-foreground opacity-[.42]" style={{ height: String(expired * scale) + '%' }} />
            <span className="sr-only">{point.label}: {formatCurrency(point.total, summary.currency_code)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function OwnerHomeCommercial() {
  // Last known first (docs/CACHING.md): the chart draws the last summary
  // while Core is read again.
  const [summary, setSummary] = useState(() => loadSnapshot<CommercialSummary>(COMMERCIAL_SNAPSHOT)?.value ?? null);
  const [loaded, setLoaded] = useState(() => summary !== null);

  useEffect(() => {
    let cancelled = false;
    void apiFetch<CommercialSummary>('/crm/commercial-summary', {
      fallbackError: t('Couldn’t load commercial history.'),
      noStore: true,
    }).then((next) => {
      saveSnapshot(COMMERCIAL_SNAPSHOT, next);
      if (!cancelled) setSummary(next);
    }).catch(() => undefined).finally(() => {
      if (!cancelled) setLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  if (!loaded) {
    return (
      <HomeCard className="gap-0" aria-busy="true">
        <HomeCardHead title={t('Commercial')} count={t('12 months')} />
        <PlaceholderBar className="mt-3 h-[150px] w-full" />
      </HomeCard>
    );
  }

  if (!summary) return null;

  return (
    <HomeCard className="gap-0" aria-label={t('Commercial')}>
      <HomeCardHead title={<><ChartIcon /> {t('Commercial')}</>} count={t('{months} months', { months: summary.lookback_months })} />
      <p className="mx-0 mt-[-7px] mb-0 text-[13px] text-muted-foreground">{t('Offers & sales')}</p>
      <dl className="mx-0 mt-4 mb-3.5 grid grid-cols-2 gap-x-3.5 gap-y-2.5">
        <Stat label={t('Offers')}>{summary.offers}</Stat>
        <Stat label={t('Sales')}>{formatCurrency(summary.sales_amount, summary.currency_code)}</Stat>
        <Stat label={t('Pipeline')} small>{formatCurrency(summary.pipeline_amount, summary.currency_code)}</Stat>
        <Stat label={t('New licenses')} small>{summary.new_licenses ?? '—'}</Stat>
      </dl>
      <CommercialBars summary={summary} />
      <div className="mt-1 flex justify-between text-[9px] text-muted-foreground" aria-hidden="true">
        <span>{summary.points[0]?.label}</span>
        <span>{summary.points.at(-1)?.label}</span>
      </div>
      <HomeMore className="mt-3" href="/work">{t('View Sales in Work')} <ChevronRightIcon /></HomeMore>
    </HomeCard>
  );
}

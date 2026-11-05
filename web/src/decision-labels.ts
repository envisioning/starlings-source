import { decisionAskOptionLabel, type DecisionAsk } from '@starlings/contracts/decision-asks';
import { dateLocale, t } from './i18n';

/*
 * The words a decision ask is shown with, on Home, in Work's Inbox and in
 * its dialog. No data of their own, so the product site draws the same
 * lines.
 */

/** "Default by 3 Oct" — a civil day, read as the day it names wherever the reader is. */
export function decisionDefaultByLabel(ask: Pick<DecisionAsk, 'default_by'>): string {
  const day = new Date(`${ask.default_by}T12:00:00Z`);
  const label = Number.isNaN(day.getTime()) ? ask.default_by : day.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return t('Default by {day}', { day: label });
}

/**
 * "Decision · Recommended: Behind a flag · Default by 3 Oct", or "Overdue · …"
 * past that day. Mac: `DecisionAsk.detailLabel`.
 */
export function decisionDetail(ask: DecisionAsk): string {
  const recommended = decisionAskOptionLabel(ask, ask.recommendation) ?? ask.recommendation;
  return [ask.overdue ? t('Overdue') : t('Decision'), t('Asked by {who}', { who: ask.asked_by }), t('Recommended: {label}', { label: recommended }), decisionDefaultByLabel(ask)].join(' · ');
}

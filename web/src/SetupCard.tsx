import { useCallback, useEffect, useState } from 'react';
import { setupStep, type SetupResponse, type SetupStepState } from '@starlings/contracts/setup';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { apiFetch } from './api';
import { CheckCircleIcon, TaskIcon } from './action-icons';
import { ErrorNotice } from './ErrorNotice';
import { HomeCard, HomeCardHead, HomeList, HomeRow, HomeRowMark, HomeRowText } from './HomeModule';
import { readStored, StorageKeys, writeStored } from './storage';
import { t } from './i18n';

/** Hidden for this browser session: sessionStorage, with memory when storage is blocked. */
const HIDDEN_KEY = 'meet.setupHidden';
let hiddenInMemory = false;

function hiddenThisSession(): boolean {
  try {
    return hiddenInMemory || sessionStorage.getItem(HIDDEN_KEY) === '1';
  } catch {
    return hiddenInMemory;
  }
}

function hideThisSession() {
  hiddenInMemory = true;
  try {
    sessionStorage.setItem(HIDDEN_KEY, '1');
  } catch {
    // Memory holds it until the page reloads.
  }
}

/**
 * Home's setup checklist (docs/ONBOARDING.md §The setup checklist). The steps,
 * their order and their words are the registry (`@starlings/contracts/setup`);
 * which are done is `GET /api/setup`, computed from data. Hide puts the card
 * away for this session: it comes back next session while a required step is
 * open. Skip clears one open step for this person on every client
 * (`PUT /api/setup/skip`). An admin can turn it off for everyone. When every required step is
 * done it says so once, on this browser, and then draws nothing.
 */
export function SetupCard({ owner }: { owner: string }) {
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(hiddenThisSession);
  const [busy, setBusy] = useState(false);
  const doneKey = `${StorageKeys.setupDone}${owner}`;
  // Read before the answer lands, so the visit that says "set up" keeps saying it.
  const [doneSaid] = useState(() => readStored(doneKey) === '1');

  const load = useCallback((signal?: AbortSignal) => {
    setError(null);
    apiFetch<SetupResponse>('/setup', { fallbackError: t('Couldn’t load your setup steps.'), noStore: true, signal })
      .then(setSetup)
      .catch((cause) => { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
  }, []);

  useEffect(() => {
    if (hidden) return;
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [hidden, load]);

  useEffect(() => {
    if (setup?.on && setup.complete && !doneSaid) writeStored(doneKey, '1');
  }, [setup, doneSaid, doneKey]);

  async function skip(step: string) {
    setBusy(true);
    setError(null);
    try {
      setSetup(await apiFetch<SetupResponse>('/setup/skip', { method: 'PUT', body: { step, skipped: true }, fallbackError: t('Couldn’t skip that step.') }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      setSetup(await apiFetch<SetupResponse>('/admin/setup', { method: 'PUT', body: { on: false }, fallbackError: t('Couldn’t turn the checklist off.') }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;
  if (error && !setup) {
    return (
      <HomeCard aria-label={t('Get started')}>
        <ErrorNotice message={error} action={<Button type="button" variant="outline" size="xs" onClick={() => load()}>{t('Retry')}</Button>} />
      </HomeCard>
    );
  }
  if (!setup || !setup.on) return null;
  if (setup.complete && doneSaid) return null;

  const steps = setup.steps.filter((step) => setupStep(step.id) !== undefined);
  if (steps.length === 0) return null;

  return (
    <HomeCard aria-label={t('Get started')}>
      <HomeCardHead title={t('Get started')}>
        <span className="inline-flex items-center gap-1">
          {setup.can_turn_off && !setup.complete && (
            <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => void turnOff()}>{t('Turn off for everyone')}</Button>
          )}
          <Button type="button" variant="ghost" size="xs" onClick={() => { hideThisSession(); setHidden(true); }}>{t('Hide')}</Button>
        </span>
      </HomeCardHead>
      {setup.complete ? (
        <p className="m-0 text-[15px] font-[560] text-foreground" role="status">{t('You’re set up.')}</p>
      ) : (
        <HomeList>
          {steps.map((step) => (
            <li key={step.id} className="flex items-center gap-1">
              <SetupRow step={step} next={step.id === setup.next} />
              {!step.done && (
                <Button type="button" variant="ghost" size="xs" className="flex-none text-muted-foreground" disabled={busy} onClick={() => void skip(step.id)}>{t('Skip')}</Button>
              )}
            </li>
          ))}
        </HomeList>
      )}
      {error && <ErrorNotice message={error} inline className="text-sm" />}
    </HomeCard>
  );
}

function SetupRow({ step, next }: { step: SetupStepState; next: boolean }) {
  const spec = setupStep(step.id)!;
  const external = /^https?:\/\//u.test(spec.route);
  const title = t(spec.title);
  // The reason is the Worker's sentence, in English like its errors.
  const detail = step.blocked?.reason;
  const content = (
    <>
      <HomeRowMark ink={step.done ? 'muted' : next ? 'primary' : 'muted'}>
        {step.done ? <TaskIcon size={16} /> : <CheckCircleIcon size={16} />}
      </HomeRowMark>
      <HomeRowText
        title={<>{title}{step.done && <span className="sr-only"> {t('Done')}</span>}</>}
        titleClassName={cn(step.done && 'text-muted-foreground line-through decoration-1')}
        detail={detail}
        wrap="detail"
      />
      {!step.required && !step.done && (
        <Badge variant="outline" className="flex-none self-center text-[11px] text-muted-foreground">{t('Optional')}</Badge>
      )}
    </>
  );
  // A done or blocked step has nothing to open; an open one goes where it is done.
  if (step.done || step.blocked) return <HomeRow className="min-w-0 flex-1">{content}</HomeRow>;
  return (
    <HomeRow asChild className={cn('min-w-0 flex-1', next && 'border-foreground/30')}>
      <a data-home-row href={spec.route} {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>{content}</a>
    </HomeRow>
  );
}

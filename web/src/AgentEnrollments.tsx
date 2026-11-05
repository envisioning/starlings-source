import { useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import {
  formatAgentEnrollmentCode,
  normalizeAgentEnrollmentCode,
  type AdminAgentEnrollment,
  type AdminAgentEnrollmentDecisionResponse,
  type AdminAgentEnrollmentsResponse,
} from '@starlings/contracts/agent-enrollment';
import { apiFetch } from './api';
import { ErrorNotice } from './ErrorNotice';
import { Note, SectionCard } from './SectionCard';
import { t } from './i18n';

/**
 * Admin › Agents: agents asking to join Team (docs/AGENTS_SURFACE.md
 * §Enrollment). A runtime enrolls itself and shows a code; the admin checks
 * the code here matches and approves. The runtime then collects its own keys.
 * The request's link is `?code=<code>`, which opens this page on it.
 */
export function AgentEnrollments() {
  const [rows, setRows] = useState<AdminAgentEnrollment[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const linked = normalizeAgentEnrollmentCode(new URLSearchParams(window.location.search).get('code') ?? '');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const body = await apiFetch<AdminAgentEnrollmentsResponse>('/admin/agent-enrollments', {
          fallbackError: t('Couldn’t load agent requests.'),
          noStore: true,
        });
        if (!cancelled) {
          setRows(body.enrollments);
          setError('');
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t load agent requests.'));
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function decide(row: AdminAgentEnrollment, approve: boolean) {
    setBusy(row.user_code);
    setError('');
    try {
      const body = await apiFetch<AdminAgentEnrollmentDecisionResponse>(
        `/admin/agent-enrollments/${row.user_code}/${approve ? 'approve' : 'deny'}`,
        { method: 'POST', body: {}, fallbackError: approve ? t('Couldn’t approve the agent.') : t('Couldn’t deny the agent.'), noStore: true },
      );
      setRows((current) => current?.map((item) => item.id === body.enrollment.id ? body.enrollment : item) ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : approve ? t('Couldn’t approve the agent.') : t('Couldn’t deny the agent.'));
    } finally {
      setBusy('');
    }
  }

  const pending = rows?.filter((row) => row.status === 'pending') ?? [];
  const decided = rows?.filter((row) => row.status !== 'pending') ?? [];
  return (
    <SectionCard id="admin-agent-requests" title={t('Agent requests')}>
      {error && <ErrorNotice message={error} />}
      {rows && pending.length === 0 && <Note>{t('No agent is asking to join.')}</Note>}
      {pending.length > 0 && (
        <ul className="m-0 grid list-none gap-3 p-0">
          {pending.map((row) => (
            <li
              key={row.id}
              className={cn('grid gap-2 rounded-md border p-3', linked && row.user_code === linked && 'border-primary')}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <strong>{row.requested_name}</strong>
                <span className="font-mono text-sm tracking-wider">{formatAgentEnrollmentCode(row.user_code)}</span>
              </div>
              {row.description && <p className="m-0 text-sm">{row.description}</p>}
              <div className="break-all text-xs text-muted-foreground">
                {[row.runtime, new URL(row.endpoint).host].filter(Boolean).join(' · ')}
              </div>
              <Note>{t('Approve only if the agent shows this code. It joins Team and gets its own keys.')}</Note>
              <div className="flex gap-2">
                <Button type="button" size="xs" disabled={busy !== ''} onClick={() => void decide(row, true)}>
                  {t('Approve')}
                </Button>
                <Button type="button" size="xs" variant="secondary" disabled={busy !== ''} onClick={() => void decide(row, false)}>
                  {t('Deny')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {decided.length > 0 && (
        <ul className="m-0 grid list-none gap-1 p-0 text-sm text-muted-foreground">
          {decided.map((row) => (
            <li key={row.id}>
              {row.status === 'approved'
                ? t('{name} joined as {email}', { name: row.requested_name, email: row.agent_email ?? '—' })
                : row.status === 'denied'
                  ? t('{name} was denied', { name: row.requested_name })
                  : t('{name} expired', { name: row.requested_name })}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

import { useEffect, useState } from 'react';
import type {
  AdminInvitation,
  AdminInvitationActionResponse,
  AdminInvitationsResponse,
  AdminInviteResponse,
  InvitationRefusal,
  InvitationRole,
} from '@starlings/contracts/invitations';
import { Button } from '@/ui/button';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Textarea } from '@/ui/textarea';
import { cn } from '@/lib/utils';
import { apiFetch } from './api';
import { ErrorNotice } from './ErrorNotice';
import { Note, SectionCard } from './SectionCard';
import { dateLocale, t } from './i18n';

/** Addresses from what the admin typed: commas, spaces, semicolons or new lines between them. */
export function inviteAddresses(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/u).map((part) => part.trim().toLowerCase()).filter(Boolean))];
}

const REFUSAL: Record<InvitationRefusal, string> = {
  member: 'Already a member.',
  revoked: 'Revoked. Restore them in People.',
  agent: 'An agent cannot be invited.',
};

function expiry(invitation: AdminInvitation): string {
  const day = new Date(invitation.expires_at).toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' });
  return invitation.state === 'lapsed' ? t('Lapsed {day}', { day }) : t('Until {day}', { day });
}

/**
 * Admin › People › Invite (docs/ONBOARDING.md §Invitations). An
 * admin invites addresses with a role; each gets a mail with the sign-in
 * link. Open invitations list below with Resend and Revoke. Everyone sees
 * the list; only an admin can change it.
 */
export function AdminInvitations({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<AdminInvitation[] | null>(null);
  const [text, setText] = useState('');
  const [role, setRole] = useState<InvitationRole>('member');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [refused, setRefused] = useState<AdminInviteResponse['refused']>([]);

  useEffect(() => {
    if (!canEdit) return;
    const controller = new AbortController();
    apiFetch<AdminInvitationsResponse>('/admin/invitations', { fallbackError: t('Couldn’t load the invitations.'), noStore: true, signal: controller.signal })
      .then((body) => setRows(body.invitations))
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('Couldn’t load the invitations.')); });
    return () => controller.abort();
  }, [canEdit]);

  if (!canEdit) return null;

  const addresses = inviteAddresses(text);

  async function invite() {
    setBusy('invite');
    setError('');
    setRefused([]);
    try {
      const body = await apiFetch<AdminInviteResponse>('/admin/invitations', {
        method: 'POST',
        body: { emails: addresses, role },
        fallbackError: t('Couldn’t send the invitations.'),
        noStore: true,
      });
      setRows((current) => [...body.invitations, ...(current ?? []).filter((row) => !body.invitations.some((item) => item.id === row.id))]);
      setRefused(body.refused);
      setText('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t send the invitations.'));
    } finally {
      setBusy('');
    }
  }

  async function act(row: AdminInvitation, action: 'resend' | 'revoke') {
    setBusy(row.id);
    setError('');
    try {
      const body = await apiFetch<AdminInvitationActionResponse>(`/admin/invitations/${action}`, {
        method: 'POST',
        body: { id: row.id },
        fallbackError: action === 'resend' ? t('Couldn’t resend the invitation.') : t('Couldn’t revoke the invitation.'),
        noStore: true,
      });
      setRows((current) => action === 'revoke'
        ? current?.filter((item) => item.id !== row.id) ?? null
        : current?.map((item) => item.id === row.id ? body.invitation : item) ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : action === 'resend' ? t('Couldn’t resend the invitation.') : t('Couldn’t revoke the invitation.'));
    } finally {
      setBusy('');
    }
  }

  return (
    <SectionCard id="admin-invitations" title={t('Invite')}>
      <form
        className="grid gap-3"
        onSubmit={(event) => { event.preventDefault(); if (addresses.length > 0) void invite(); }}
      >
        <Label htmlFor="invite-addresses" className="sr-only">{t('Addresses')}</Label>
        <Textarea
          id="invite-addresses"
          value={text}
          rows={2}
          placeholder="ana@example.com, joao@example.com"
          onChange={(event) => setText(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="invite-role" className="sr-only">{t('Role')}</Label>
          <NativeSelect id="invite-role" size="sm" value={role} onChange={(event) => setRole(event.target.value as InvitationRole)}>
            <NativeSelectOption value="member">{t('Member')}</NativeSelectOption>
            <NativeSelectOption value="admin">{t('Admin')}</NativeSelectOption>
          </NativeSelect>
          <Button type="submit" size="sm" disabled={busy !== '' || addresses.length === 0}>
            {t('Invite')}
          </Button>
        </div>
      </form>
      {error && <ErrorNotice message={error} />}
      {refused.length > 0 && (
        <ErrorNotice message={refused.map((row) => `${row.email}: ${t(REFUSAL[row.reason])}`).join('\n')} />
      )}
      {rows && rows.length === 0 && <Note>{t('No open invitations.')}</Note>}
      {rows && rows.length > 0 && (
        <ul className="m-0 grid list-none gap-2 p-0 text-[13px]">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className={cn(row.state === 'lapsed' && 'text-muted-foreground')}>
                <strong className="font-[560]">{row.email}</strong>
                {' · '}{row.role === 'admin' ? t('Admin') : t('Member')}
                {' · '}{expiry(row)}
                {row.mailed_at === null && <span className="text-destructive">{' · '}{t('Mail not sent')}</span>}
              </span>
              <span className="flex gap-2">
                <Button type="button" size="xs" variant="outline" disabled={busy !== ''} onClick={() => void act(row, 'resend')}>
                  {t('Resend')}
                </Button>
                <Button type="button" size="xs" variant="outline" className="text-destructive hover:text-destructive" disabled={busy !== ''} onClick={() => void act(row, 'revoke')}>
                  {t('Revoke')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

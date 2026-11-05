import { useEffect, useId, useState } from 'react';
import type { GrantRole, SubjectAccessResponse, SubjectGrant, SubjectGrantUpdate, SubjectVisibility } from '@starlings/contracts/subject-access';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { CopyLinkIcon } from './action-icons';
import { ErrorNotice } from './ErrorNotice';
import { FormRow } from './form-row';
import { t } from './i18n';
import { SegmentedControl } from './SegmentedControl';
import { putSubjectGrant, readSubjectAccess, revokeSubjectGrant, setSubjectVisibility } from './subject-access-api';
import { Tip } from './Tip';
import { toast } from './Toast';

type Who = 'member' | 'agent' | 'guest' | 'peer_workspace';

const WHO_LABEL: Record<Who, string> = {
  member: 'Member',
  agent: 'Agent',
  guest: 'Guest',
  peer_workspace: 'Organization',
};
const ROLE_LABEL: Record<GrantRole, string> = { read: 'Can read', write: 'Can write', manage: 'Can manage' };

/** The roles each kind may hold: an agent, a guest and an organization never manage. */
function rolesFor(who: Who): GrantRole[] {
  return who === 'member' ? ['read', 'write', 'manage'] : ['read', 'write'];
}

/**
 * Share a subject (docs/ACCESS.md): who reaches it, and, for a `manage`
 * holder or an admin, the controls that change that. Visibility is
 * `workspace` (every member) or `restricted` (the people below). A guest's
 * link and an organization's token are shown once, here, after the grant.
 */
export function SubjectShareDialog({ subject, onClose, onChanged }: {
  subject: { kind: string; id: string; title: string };
  onClose: () => void;
  onChanged?: (access: SubjectAccessResponse) => void;
}) {
  const [access, setAccess] = useState<SubjectAccessResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState<Who>('member');
  const [address, setAddress] = useState('');
  const [role, setRole] = useState<GrantRole>('write');
  const [secret, setSecret] = useState<{ label: string; value: string; detail?: string } | null>(null);
  const addressId = useId();

  useEffect(() => {
    let cancelled = false;
    readSubjectAccess(subject).then(
      (answer) => { if (!cancelled) setAccess(answer); },
      (cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t load who has access.')); },
    );
    return () => { cancelled = true; };
  }, [subject.kind, subject.id]);

  const manages = access?.level === 'manage';
  const apply = async (change: () => Promise<SubjectAccessResponse>) => {
    setBusy(true);
    setError('');
    try {
      const answer = await change();
      setAccess(answer);
      onChanged?.(answer);
      return answer;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t share it.'));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const value = address.trim();
    if (!value) return;
    const update: SubjectGrantUpdate = who === 'peer_workspace'
      ? { principal_kind: 'peer_workspace', peer: { name: value }, role }
      : { principal_kind: who, email: value.toLowerCase(), role };
    const answer = await apply(() => putSubjectGrant(subject, update));
    if (!answer) return;
    setAddress('');
    if (answer.guest_link) setSecret({ label: t('Guest link'), value: answer.guest_link });
    else if (answer.peer_token) setSecret({ label: t('Organization token'), value: answer.peer_token, detail: answer.peer_mcp_url });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="gap-4 p-4 sm:max-w-lg" aria-describedby={undefined}>
        <DialogTitle>{t('Share {subject}', { subject: subject.title })}</DialogTitle>
        {!access && !error && <p className="text-sm text-muted-foreground">{t('Loading…')}</p>}
        {access && (
          <>
            <SegmentedControl<SubjectVisibility>
              label={t('Who can see it')}
              value={access.visibility}
              disabled={!manages || busy}
              options={[
                { value: 'workspace', label: t('Everyone here') },
                { value: 'restricted', label: t('Only people added') },
              ]}
              onChange={(visibility) => { void apply(() => setSubjectVisibility(subject, visibility)); }}
            />
            <ul className="flex flex-col gap-2" aria-label={t('People with access')}>
              {access.grants.length === 0 && <li className="text-sm text-muted-foreground">{t('Nobody added.')}</li>}
              {access.grants.map((grant) => (
                <GrantRow
                  key={grant.id}
                  grant={grant}
                  editable={manages && !busy}
                  onRole={(next) => { void changeRole(grant, next); }}
                  onRemove={() => { void apply(() => revokeSubjectGrant(subject, grant.id)); }}
                />
              ))}
            </ul>
            {manages && (
              <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void add(); }}>
                <div className="flex flex-wrap gap-2">
                  <NativeSelect aria-label={t('Kind')} value={who} onChange={(event) => { const next = event.target.value as Who; setWho(next); if (!rolesFor(next).includes(role)) setRole('write'); }}>
                    {(Object.keys(WHO_LABEL) as Who[]).map((kind) => <NativeSelectOption key={kind} value={kind}>{t(WHO_LABEL[kind])}</NativeSelectOption>)}
                  </NativeSelect>
                  <Input
                    id={addressId}
                    className="min-w-48 flex-1"
                    aria-label={who === 'peer_workspace' ? t('Organization name') : t('Email address')}
                    placeholder={who === 'peer_workspace' ? t('Organization name') : t('Email address')}
                    type={who === 'peer_workspace' ? 'text' : 'email'}
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                  />
                  <NativeSelect aria-label={t('Access')} value={role} onChange={(event) => setRole(event.target.value as GrantRole)}>
                    {rolesFor(who).map((value) => <NativeSelectOption key={value} value={value}>{t(ROLE_LABEL[value])}</NativeSelectOption>)}
                  </NativeSelect>
                  <Button type="submit" disabled={busy || !address.trim()}>{t('Add')}</Button>
                </div>
              </form>
            )}
            {secret && <SecretField label={secret.label} value={secret.value} detail={secret.detail} />}
          </>
        )}
        {error && <ErrorNotice message={error} />}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>{t('Done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  async function changeRole(grant: SubjectGrant, next: GrantRole) {
    const update: SubjectGrantUpdate | null = grant.principal_kind === 'peer_workspace'
      ? { principal_kind: 'peer_workspace', peer: { organization_id: grant.principal_id }, role: next }
      : grant.principal_kind === 'guest' || !grant.email
        ? null
        : { principal_kind: grant.principal_kind, email: grant.email, role: next };
    // A guest's role changes with a new link; that is Add again, not this.
    if (!update) return;
    await apply(() => putSubjectGrant(subject, update));
  }
}

function GrantRow({ grant, editable, onRole, onRemove }: {
  grant: SubjectGrant;
  editable: boolean;
  onRole: (role: GrantRole) => void;
  onRemove: () => void;
}) {
  const who = grant.principal_kind as Who;
  const label = grant.name?.trim() || grant.email || grant.principal_id;
  return (
    <li className="flex items-center gap-2 text-sm">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Badge variant="outline">{t(WHO_LABEL[who])}</Badge>
      {editable && who !== 'guest'
        ? (
          <NativeSelect aria-label={t('Access for {name}', { name: label })} value={grant.role} onChange={(event) => onRole(event.target.value as GrantRole)}>
            {rolesFor(who).map((value) => <NativeSelectOption key={value} value={value}>{t(ROLE_LABEL[value])}</NativeSelectOption>)}
          </NativeSelect>
        )
        : <span className="text-muted-foreground">{t(ROLE_LABEL[grant.role])}</span>}
      {editable && <Button type="button" variant="ghost" size="sm" onClick={onRemove}>{t('Remove')}</Button>}
    </li>
  );
}

/** A guest's link or an organization's token: shown once, whole and selectable, with Copy. */
function SecretField({ label, value, detail }: { label: string; value: string; detail?: string | undefined }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(value).then(
      () => { setCopied(true); toast(t('Copied')); window.setTimeout(() => setCopied(false), 1200); },
      () => toast(t('Couldn’t copy it.'), 'danger'),
    );
  };
  return (
    <FormRow id={id} label={label}>
      <span className="flex flex-col gap-1">
        <span className="flex items-center gap-2">
          <Input id={id} readOnly value={value} className="flex-1" onFocus={(event) => event.currentTarget.select()} />
          <Tip label={t('Copy')}><Button type="button" variant="secondary" size="icon" aria-label={t('Copy')} onClick={copy}><CopyLinkIcon copied={copied} /></Button></Tip>
        </span>
        <span className="text-xs text-muted-foreground">
          {detail ? t('Shown once. Use it at {url}.', { url: detail }) : t('Shown once.')}
        </span>
      </span>
    </FormRow>
  );
}

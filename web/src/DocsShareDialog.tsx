import { ORG_WEB_HOST } from '@starlings/contracts/deployment';
import { useCallback, useEffect, useId, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { Textarea } from '@/ui/textarea';
import { cn } from '@/lib/utils';
import { CopyLinkIcon } from './action-icons';
import {
  cancelDocsSignatureRequest,
  createDocsGrant,
  createDocsSignatureRequest,
  docsShareURL,
  fetchDocsAccessEvents,
  fetchDocsGrants,
  fetchDocsSignatureRequests,
  revokeDocsGrant,
  setDocsVisibility,
  type DocsAccessEvent,
  type DocsDocumentDetail,
  type DocsGrant,
  type DocsSignatureRequest,
} from './docs';
import { ErrorNotice } from './ErrorNotice';
import { CheckRow, FormRow } from './form-row';
import { dateLocale, plural, t } from './i18n';
import { formatTime } from './meeting-time';
import { Tip } from './Tip';
import { toast } from './Toast';
import { isEnvisioningWorkspace } from './workspace-brand';

type ShareTab = 'share' | 'sign' | 'activity';

/**
 * Sharing and signing a document: the staff drawer
 * Docs web had, in Meet's /docs. Share holds the www switch (Envisioning's
 * workspace only: the reader on the organisation's site reads Envisioning's Docs)
 * and the share links; Signatures sends the document for signature;
 * Activity is its access log. A transcript stays internal, so its Share and
 * Signatures tabs say so and offer nothing.
 */
export function DocsShareDialog({ document: doc, onClose, onDocumentChange }: {
  document: DocsDocumentDetail;
  onClose: () => void;
  /** The detail Docs answered after the www switch moved, so the page agrees. */
  onDocumentChange: (document: DocsDocumentDetail) => void;
}) {
  const [tab, setTab] = useState<ShareTab>('share');
  const internalOnly = doc.transcript === true;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="gap-3 p-4 sm:max-w-lg"
        aria-describedby={undefined}
        // Ours to close; the page's Escape (back to the list) must not fire too.
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <DialogTitle className="truncate pr-8">{t('Share “{title}”', { title: doc.title })}</DialogTitle>
        <Tabs value={tab} onValueChange={(value) => setTab(value as ShareTab)} className="min-w-0 gap-3">
          <TabsList aria-label={t('Sharing')}>
            <TabsTrigger value="share">{t('Share')}</TabsTrigger>
            <TabsTrigger value="sign">{t('Signatures')}</TabsTrigger>
            <TabsTrigger value="activity">{t('Activity')}</TabsTrigger>
          </TabsList>
          <TabsContent value="share" className="min-w-0">
            {internalOnly ? <InternalOnly /> : <ShareTabPanel document={doc} onDocumentChange={onDocumentChange} />}
          </TabsContent>
          <TabsContent value="sign" className="min-w-0">
            {internalOnly ? <InternalOnly /> : <SignTabPanel document={doc} />}
          </TabsContent>
          <TabsContent value="activity" className="min-w-0">
            <ActivityTabPanel documentID={doc.id} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function InternalOnly() {
  return <p className="m-0 text-sm text-muted-foreground">{t('A transcript stays internal.')}</p>;
}

/** One list from Docs, read when the tab opens and again after each change. */
function useDocsList<T>(load: () => Promise<T[]>, fallback: string) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    try {
      setRows(await load());
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
    }
  }, [load, fallback]);
  useEffect(() => { void reload(); }, [reload]);
  return { rows, error, setError, reload };
}

function copyLink(url: string) {
  void navigator.clipboard.writeText(url).then(
    () => toast(t('Link copied')),
    () => toast(t('Couldn’t copy the link.'), 'danger'),
  );
}

function CopyButton({ url, label }: { url: string; label: string }) {
  return (
    <Tip label={t('Copy link')}>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={label} onClick={() => copyLink(url)}>
        <CopyLinkIcon copied={false} />
      </Button>
    </Tip>
  );
}

const ROLE_LABEL: Record<string, string> = {
  commenter: t('Can comment'),
  viewer: t('Read only'),
  signer: t('Signer'),
};

function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return '';
  return date.toLocaleDateString(dateLocale, {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });
}

const sectionHeadClass = 'm-0 mb-1.5 text-xs font-normal tracking-[0.06em] text-muted-foreground uppercase';
const rowListClass = 'm-0 flex list-none flex-col gap-1 p-0';
const rowClass = 'flex min-w-0 items-center gap-2 rounded-md py-1 text-sm';

function ShareTabPanel({ document: doc, onDocumentChange }: {
  document: DocsDocumentDetail;
  onDocumentChange: (document: DocsDocumentDetail) => void;
}) {
  const wwwAllowed = isEnvisioningWorkspace();
  const shared = doc.visibility === 'link' || doc.visibility === 'public';
  const wwwLink = docsShareURL(doc.id);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'commenter' | 'viewer'>('commenter');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => fetchDocsGrants(doc.id), [doc.id]);
  const grants = useDocsList<DocsGrant>(load, t('Couldn’t load the share links.'));
  const wwwID = useId();
  const emailID = useId();

  // On is `link`; off is always `internal`. A `public` document counts as on.
  async function setShared(on: boolean) {
    setSwitching(true);
    setSwitchError('');
    try {
      onDocumentChange(await setDocsVisibility(doc.id, on ? 'link' : 'internal'));
      if (on) copyLink(wwwLink);
    } catch (cause) {
      setSwitchError(cause instanceof Error ? cause.message : t('Couldn’t change who can read it.'));
    } finally {
      setSwitching(false);
    }
  }

  async function create() {
    if (busy) return;
    setBusy(true);
    grants.setError('');
    try {
      const address = email.trim();
      await createDocsGrant(doc.id, { role, ...(address ? { email: address } : {}) });
      setEmail('');
      await grants.reload();
    } catch (cause) {
      grants.setError(cause instanceof Error ? cause.message : t('Couldn’t create the link.'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(grant: DocsGrant) {
    grants.setError('');
    try {
      await revokeDocsGrant(doc.id, grant.id);
      await grants.reload();
    } catch (cause) {
      grants.setError(cause instanceof Error ? cause.message : t('Couldn’t revoke the link.'));
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {wwwAllowed && (
        <section className="flex min-w-0 flex-col gap-1">
          <CheckRow id={wwwID} label={t('Share on {host}', { host: ORG_WEB_HOST })} className="my-0">
            <Checkbox id={wwwID} checked={shared} disabled={switching} onCheckedChange={(checked) => void setShared(checked === true)} />
          </CheckRow>
          {shared && (
            <div className="flex min-w-0 items-center gap-1">
              <Input readOnly value={wwwLink} aria-label={t('Link on {host}', { host: ORG_WEB_HOST })} className="h-8 min-w-0 flex-1 text-xs" onFocus={(event) => event.currentTarget.select()} />
              <CopyButton url={wwwLink} label={t('Copy the link on {host}', { host: ORG_WEB_HOST })} />
            </div>
          )}
          {switchError && <ErrorNotice message={switchError} />}
        </section>
      )}

      <section className="flex min-w-0 flex-col gap-2">
        <h3 className={sectionHeadClass}>{t('Share links')}</h3>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <FormRow id={emailID} label={t('Email (optional)')} className="my-0 min-w-48 flex-1">
            <Input id={emailID} type="email" value={email} maxLength={320} className="h-8" onChange={(event) => setEmail(event.target.value)} />
          </FormRow>
          <NativeSelect size="sm" aria-label={t('Access')} value={role} onChange={(event) => setRole(event.target.value as 'commenter' | 'viewer')}>
            <NativeSelectOption value="commenter">{t('Can comment')}</NativeSelectOption>
            <NativeSelectOption value="viewer">{t('Read only')}</NativeSelectOption>
          </NativeSelect>
          <Button type="submit" size="sm" disabled={busy}>{t('Create link')}</Button>
        </form>
        {grants.error && <ErrorNotice message={grants.error} />}
        {grants.rows === null && !grants.error && <PlaceholderRows count={2} glyph={false} label={t('Loading…')} />}
        {grants.rows?.length === 0 && <p className="m-0 text-sm text-muted-foreground">{t('No links yet.')}</p>}
        {grants.rows && grants.rows.length > 0 && (
          <ul className={rowListClass} aria-label={t('Share links')}>
            {grants.rows.map((grant) => {
              const who = grant.email ?? t('Anyone with the link');
              return (
                <li key={grant.id} className={cn(rowClass, grant.revoked_at && 'text-muted-foreground')}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{who}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {roleLabel(grant.role)}
                      {' · '}
                      {plural(grant.use_count, { one: 'Opened {count} time', other: 'Opened {count} times' })}
                    </span>
                  </span>
                  {grant.revoked_at
                    ? <Badge variant="outline" className="font-normal text-muted-foreground">{t('Revoked')}</Badge>
                    : (
                      <>
                        <CopyButton url={grant.url} label={t('Copy the link for {who}', { who })} />
                        <Button type="button" variant="ghost" size="sm" onClick={() => void revoke(grant)}>{t('Revoke')}</Button>
                      </>
                    )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

const REQUEST_STATUS: Record<string, string> = {
  pending: t('Waiting'),
  completed: t('Signed'),
  declined: t('Declined'),
  cancelled: t('Cancelled'),
  expired: t('Expired'),
};

const PARTY_STATUS: Record<string, string> = {
  pending: t('Not opened'),
  viewed: t('Opened'),
  signed: t('Signed'),
  declined: t('Declined'),
};

function statusLabel(table: Record<string, string>, status: string): string {
  return table[status] ?? status;
}

/** Signer addresses as typed: one per line, or separated by commas. */
function signerEmails(text: string): string[] {
  return [...new Set(text.split(/[,\n]/u).map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function SignTabPanel({ document: doc }: { document: DocsDocumentDetail }) {
  const [emails, setEmails] = useState('');
  const [subject, setSubject] = useState(() => t('Please sign: {title}', { title: doc.title }));
  const [ordered, setOrdered] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => fetchDocsSignatureRequests(doc.id), [doc.id]);
  const requests = useDocsList<DocsSignatureRequest>(load, t('Couldn’t load the signature requests.'));
  const emailsID = useId();
  const subjectID = useId();
  const orderedID = useId();
  const signers = signerEmails(emails);

  async function send() {
    if (busy || signers.length === 0) return;
    setBusy(true);
    requests.setError('');
    try {
      await createDocsSignatureRequest(doc.id, {
        ...(subject.trim() ? { subject: subject.trim() } : {}),
        ordered,
        parties: signers.map((email, index) => ({ email, sequence: ordered ? index : 0 })),
      });
      setEmails('');
      await requests.reload();
    } catch (cause) {
      requests.setError(cause instanceof Error ? cause.message : t('Couldn’t send it for signature.'));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(request: DocsSignatureRequest) {
    requests.setError('');
    try {
      await cancelDocsSignatureRequest(doc.id, request.id);
      await requests.reload();
    } catch (cause) {
      requests.setError(cause instanceof Error ? cause.message : t('Couldn’t cancel the request.'));
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <form className="flex min-w-0 flex-col" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <FormRow id={emailsID} label={t('Signer emails, one per line')} className="mt-0">
          <Textarea id={emailsID} rows={3} value={emails} onChange={(event) => setEmails(event.target.value)} />
        </FormRow>
        <FormRow id={subjectID} label={t('Subject')}>
          <Input id={subjectID} type="text" value={subject} maxLength={300} className="h-8" onChange={(event) => setSubject(event.target.value)} />
        </FormRow>
        <CheckRow id={orderedID} label={t('Sign in order')}>
          <Checkbox id={orderedID} checked={ordered} onCheckedChange={(checked) => setOrdered(checked === true)} />
        </CheckRow>
        <div>
          <Button type="submit" size="sm" disabled={busy || signers.length === 0}>{t('Send for signature')}</Button>
        </div>
      </form>
      {requests.error && <ErrorNotice message={requests.error} />}

      <section className="flex min-w-0 flex-col gap-2">
        <h3 className={sectionHeadClass}>{t('Requests')}</h3>
        {requests.rows === null && !requests.error && <PlaceholderRows count={2} glyph={false} label={t('Loading…')} />}
        {requests.rows?.length === 0 && <p className="m-0 text-sm text-muted-foreground">{t('No signature requests yet.')}</p>}
        {requests.rows && requests.rows.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label={t('Signature requests')}>
            {requests.rows.map((request) => (
              <li key={request.id} className="flex min-w-0 flex-col gap-1">
                <div className={rowClass}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{request.subject ?? t('Signature request')}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {statusLabel(REQUEST_STATUS, request.status)}
                      {shortDate(request.created_at) && ` · ${shortDate(request.created_at)}`}
                    </span>
                  </span>
                  {request.certificate_url && (
                    // The certificate is a page of the Docs app; it stays there.
                    <Button asChild variant="ghost" size="sm">
                      <a href={request.certificate_url} target="_blank" rel="noreferrer">{t('Certificate')}</a>
                    </Button>
                  )}
                  {request.status === 'pending' && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => void cancel(request)}>{t('Cancel request')}</Button>
                  )}
                </div>
                <ul className={cn(rowListClass, 'pl-3')} aria-label={t('Signers')}>
                  {request.parties.map((party) => (
                    <li key={party.id} className={cn(rowClass, 'py-0')}>
                      <span className="min-w-0 flex-1 truncate">{party.name?.trim() || party.email}</span>
                      <span className="flex-none text-xs text-muted-foreground">{statusLabel(PARTY_STATUS, party.status)}</span>
                      {party.url && request.status === 'pending' && (
                        <CopyButton url={party.url} label={t('Copy the signing link for {who}', { who: party.email })} />
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const EVENT_KIND: Record<string, string> = {
  view: t('Viewed'),
  download: t('Downloaded'),
  annotate: t('Commented'),
  sign: t('Signed'),
  decline: t('Declined'),
  edit: t('Edited'),
  share: t('Shared'),
};

function ActivityTabPanel({ documentID }: { documentID: string }) {
  const load = useCallback(() => fetchDocsAccessEvents(documentID), [documentID]);
  const events = useDocsList<DocsAccessEvent>(load, t('Couldn’t load the activity.'));

  if (events.error) return <ErrorNotice message={events.error} />;
  if (events.rows === null) return <PlaceholderRows count={3} glyph={false} label={t('Loading…')} />;
  if (events.rows.length === 0) return <p className="m-0 text-sm text-muted-foreground">{t('No activity yet.')}</p>;

  return (
    <ul className={cn(rowListClass, 'max-h-80 overflow-y-auto')} aria-label={t('Activity')}>
      {events.rows.map((event) => {
        const when = new Date(event.created_at);
        const valid = !Number.isNaN(when.valueOf());

        return (
          <li key={event.id} className={rowClass}>
            <span className="w-28 flex-none text-xs text-muted-foreground tabular-nums">
              {valid ? `${shortDate(event.created_at)} ${formatTime(when)}` : ''}
            </span>
            <span className="min-w-0 flex-1 truncate">{event.actor ?? t('Anonymous')}</span>
            <span className="flex-none text-xs">{EVENT_KIND[event.kind] ?? event.kind}</span>
            {event.timezone && <span className="hidden flex-none text-xs text-muted-foreground sm:inline">{event.timezone}</span>}
          </li>
        );
      })}
    </ul>
  );
}

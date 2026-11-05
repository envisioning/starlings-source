import { cn } from '@/lib/utils';
import { railListClass } from './rail-list';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Checkbox } from '@/ui/checkbox';
import { Button } from '@/ui/button';
import { useEffect, useRef, useState } from 'react';
import type { CrmIssue, CrmIssueDetail, CrmIssueDetailResponse, CrmIssueFacetsResponse, CrmIssuesResponse, IssueImageResponse, PullItem, PullsResponse } from '@starlings/contracts';
import { ISSUE_IMAGE_MAX_BYTES } from '@starlings/contracts';
import { apiFetch, apiUpload } from './api';
import { formatTime } from './meeting-time';
import { IssueRow, PullRow } from './WorkRows';
import { useRowMenu } from './use-row-menu';
import { HOME_ROW_ATTRIBUTE } from './home-keys';
import { createIssue, setIssueState } from './crm-work';
import { CopyLinkItem, coreSubjectDoor, issueFavoriteTarget, RowMenuItems, StarItem } from './row-menu-items';
import { ErrorNotice } from './ErrorNotice';
import { t, dateLocale } from './i18n';
import { Spinner } from '@/ui/spinner';
import { PlaceholderBar } from '@/ui/placeholder-rows';
import { detailTitleClass, PlanHead, SheetActions, SheetCard, SheetField } from './work-parts';

/** An issue's body and a comment: GitHub's text as written, line breaks kept. */
const issueBodyClass = 'whitespace-pre-wrap [overflow-wrap:anywhere]';
/** Labels and Assignees: a group of checkboxes on the edit sheet. */
const facetClass = 'm-0 flex min-w-0 flex-wrap gap-x-4 gap-y-1.5 border-0 p-0';
const facetLegendClass = 'mb-1.5 p-0 text-xs text-muted-foreground';
const checkLabelClass = 'flex items-center gap-2 text-sm font-normal leading-normal';

export type IssueReference = Pick<CrmIssue, 'owner' | 'repo' | 'number'>;
const queryFor = (issue: IssueReference) => new URLSearchParams({ owner: issue.owner, repo: issue.repo, number: String(issue.number) });
const failure = (cause: unknown) => cause instanceof Error ? cause.message : t('Couldn’t reach GitHub.');

export function IssueWorkspace({ projectID, startCreating = false, onCreateStarted }: { projectID: string; startCreating?: boolean; onCreateStarted?: () => void }) {
  const [issues, setIssues] = useState<CrmIssue[]>([]);
  const [state, setState] = useState('open');
  const [sort, setSort] = useState('updated');
  const [label, setLabel] = useState('');
  const [assignee, setAssignee] = useState('');
  const [page, setPage] = useState(1);
  const [linked, setLinked] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<IssueReference | null>(null);
  // Open on the composer when a palette verb asked for it.
  const [creating, setCreating] = useState(startCreating);
  // The request can arrive after mount (a Work link resolves its subject
  // first, or the pane is already open), so follow it, then hand it back.
  useEffect(() => {
    if (!startCreating) return;
    setCreating(true);
    onCreateStarted?.();
  }, [startCreating]); // eslint-disable-line react-hooks/exhaustive-deps
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  useEffect(() => {
    let cancelled = false;
    setBusy(true); setError('');
    const query = new URLSearchParams({ project_id: projectID, state, sort, direction: 'desc', page: String(page), labels: label, assignee });
    void apiFetch<CrmIssuesResponse>(`/crm/issues?${query}`, { noStore: true, fallbackError: t('Couldn’t load issues.') }).then(result => {
      if (cancelled) return;
      setIssues(current => page === 1 ? result.issues : [...new Map([...current, ...result.issues].map(issue => [issue.id, issue])).values()]);
      setLinked(result.linked);
      setHasMore(result.has_more === true);
    }).catch(cause => { if (!cancelled) setError(failure(cause)); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [projectID, state, sort, label, assignee, page, revision]);
  function refresh() { setPage(1); setRevision(value => value + 1); }
  // Close or reopen from the row's menu, the same items as Mine's rows.
  const rowMenu = useRowMenu({ target: `[${HOME_ROW_ATTRIBUTE}]` });
  function issueMenu(issue: CrmIssue) {
    const key = `issue:${issue.id}`;
    return {
      rowProps: rowMenu.rowProps(key),
      targetProps: { [HOME_ROW_ATTRIBUTE]: '' },
      panel: rowMenu.panel(key, <RowMenuItems kind="issue" context="row" facts={{ isOpen: issue.state === 'open', hasRepo: true, hasCore: !!projectID }}
        run={{
          'close-issue': () => { setError(''); void setIssueState(issue, 'close', projectID).then(refresh, cause => setError(failure(cause))); },
          'close-not-planned': () => { setError(''); void setIssueState(issue, 'close_not_planned', projectID).then(refresh, cause => setError(failure(cause))); },
          'reopen-issue': () => { setError(''); void setIssueState(issue, 'reopen', projectID).then(refresh, cause => setError(failure(cause))); },
          open: () => setSelected(issue),
        }} doors={{
          'open-github': { href: issue.url, external: true },
          'open-core': coreSubjectDoor('project', projectID),
        }} render={{
          'copy-link': () => <CopyLinkItem href={issue.url} />,
          star: () => <StarItem target={issueFavoriteTarget(issue)} />,
        }} />, { className: 'mr-1.5' }),
    };
  }
  async function create() {
    setBusy(true); setError('');
    try {
      const issue = await createIssue({ project_id: projectID, title: title.trim(), body });
      setCreating(false); setTitle(''); setBody(''); setSelected(issue); refresh();
    } catch (cause) { setError(failure(cause)); }
    finally { setBusy(false); }
  }
  if (selected) {
    return <IssueDetail key={`${selected.owner}/${selected.repo}/${selected.number}`} issue={selected} projectID={projectID} onClose={() => setSelected(null)} onChange={refresh} />;
  }
  return <section>
    <PlanHead>{t('Issues')}</PlanHead>
    <div className="mb-2 flex flex-wrap items-end gap-2">
      <SheetField label={t('State')}><NativeSelect value={state} onChange={event => { setState(event.target.value); setPage(1); }}><NativeSelectOption value="open">{t('Open')}</NativeSelectOption><NativeSelectOption value="closed">{t('Closed')}</NativeSelectOption><NativeSelectOption value="all">{t('All')}</NativeSelectOption></NativeSelect></SheetField>
      <SheetField label={t('Order')}><NativeSelect value={sort} onChange={event => { setSort(event.target.value); setPage(1); }}><NativeSelectOption value="updated">{t('Recently updated')}</NativeSelectOption><NativeSelectOption value="created">{t('Newest')}</NativeSelectOption><NativeSelectOption value="comments">{t('Most commented')}</NativeSelectOption></NativeSelect></SheetField>
      <SheetField label={t('Label')}><Input value={label} onChange={event => { setLabel(event.target.value); setPage(1); }} /></SheetField>
      <SheetField label={t('Assignee')}><Input value={assignee} onChange={event => { setAssignee(event.target.value); setPage(1); }} placeholder={t('GitHub username')} /></SheetField>
      <Button disabled={!linked} onClick={() => setCreating(true)}>{t('New issue')}</Button>
    </div>
    {error && <ErrorNotice message={error} action={<Button type="button" variant="outline" size="xs" onClick={refresh}>{t('Retry')}</Button>} />}
    {creating && <SheetCard className="mb-3" title={t('New issue')} onSubmit={event => { event.preventDefault(); void create(); }}>
      <SheetField label={t('Title')}><Input required maxLength={250} value={title} onChange={event => setTitle(event.target.value)} /></SheetField>
      <SheetField label={t('Description')}><Textarea rows={6} maxLength={20000} value={body} onChange={event => setBody(event.target.value)} /></SheetField>
      <div>
        <IssueImageAttach
          disabled={busy}
          onAttached={markdown => setBody(current => (current ? `${current}\n\n${markdown}` : markdown))}
          onError={setError}
        />
      </div>
      <SheetActions>
        <Button variant="secondary" type="button" disabled={busy} onClick={() => setCreating(false)}>{t('Cancel')}</Button>
        <Button disabled={busy || !title.trim()}>{t('Create issue')}</Button>
      </SheetActions>
    </SheetCard>}
    <ul className={railListClass} aria-label={t('Issues')} aria-busy={busy}>
      {issues.map(issue => (
        <IssueRow
          key={issue.id}
          issue={issue}
          metadata={`${issue.owner}/${issue.repo} #${issue.number} · ${issue.state} · ${issue.labels.join(', ')}`}
          onOpen={() => setSelected(issue)}
          menu={issueMenu(issue)}
        />
      ))}
    </ul>
    {!busy && !issues.length && <p>{linked ? t('No issues match these filters.') : t('No GitHub repository is linked to this project. Link one from the native app.')}</p>}
    {hasMore && <Button variant="secondary" disabled={busy} onClick={() => setPage(value => value + 1)}>{t('Load more')}</Button>}
    <PullList projectID={projectID} />
  </section>;
}

/**
 * The second list under a project with a repository: its pull
 * requests, from Meet's own sync rather than through Core. Open and draft
 * first; merged and closed after, so the standup reads top down. Absent
 * entirely while no repository is mapped, so a project without code shows
 * nothing here.
 */
function PullList({ projectID }: { projectID: string }) {
  const [pulls, setPulls] = useState<PullItem[]>([]);
  const [mapped, setMapped] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void apiFetch<PullsResponse>(`/crm/pulls?project_id=${encodeURIComponent(projectID)}`, { noStore: true, fallbackError: t('Couldn’t load pull requests.') }).then(result => {
      if (cancelled) return;
      setPulls(result.pulls);
      setMapped(result.mapped);
    }).catch(() => { if (!cancelled) setMapped(false); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [projectID]);
  if (!mapped) return null;
  const open = pulls.filter(pull => pull.state === 'open' || pull.state === 'draft');
  const done = pulls.filter(pull => pull.state === 'merged' || pull.state === 'closed');
  const visible = showClosed ? [...open, ...done] : open;
  return <>
    <PlanHead className="mt-6">{t('Pull requests')}</PlanHead>
    <ul className={railListClass} aria-label={t('Pull requests')} aria-busy={busy}>
      {visible.map(pull => <PullRow key={pull.id} pull={pull} />)}
    </ul>
    {!busy && !pulls.length && <p>{t('No pull requests have been read yet.')}</p>}
    {!busy && !open.length && pulls.length > 0 && !showClosed && <p>{t('Nothing open.')}</p>}
    {done.length > 0 && (
      <Button variant="secondary" type="button" onClick={() => setShowClosed(value => !value)}>
        {showClosed ? t('Hide merged and closed') : t('Show merged and closed ({count})', { count: done.length })}
      </Button>
    )}
  </>;
}

/**
 * Attach a picture to an issue.
 *
 * GitHub has no public API for putting a file *in* an issue, so the bytes are
 * kept by Meet and the body gets a markdown image link. The address is readable
 * without a session, because github.com renders the body for whoever is looking
 * at it — see `services/control-plane/src/issue-images.ts`.
 *
 * Appended to the description rather than inserted at the caret: a textarea's
 * selection is lost the moment the file chooser takes focus, and guessing where
 * somebody meant it to go is worse than putting it somewhere predictable.
 */
function IssueImageAttach({ disabled, onAttached, onError }: {
  disabled?: boolean;
  onAttached: (markdown: string) => void;
  onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const send = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > ISSUE_IMAGE_MAX_BYTES) {
      onError(t('That image is too large — 8 MB is the limit.'));
      return;
    }
    setUploading(true);
    onError('');
    try {
      const stored = await apiUpload<IssueImageResponse>(
        '/issue-images',
        file,
        t('Couldn’t attach that image.'),
      );
      // The alt text is the filename because it is the only description anybody
      // has given it, and an image with no alt text is one a screen reader
      // reads as "image".
      onAttached(`![${file.name.replace(/[[\]]/gu, '')}](${stored.url})`);
    } catch (cause) {
      onError(failure(cause));
    } finally {
      setUploading(false);
    }
  };

  return <>
    <Button
      type="button"
      variant="secondary"
      disabled={disabled || uploading}
      onClick={() => input.current?.click()}
   >
      {uploading && <Spinner aria-hidden />}
      {uploading ? t('Attaching…') : t('Attach image')}
    </Button>
    {/* shadcn: a hidden file input; the Button above opens it */}
    <input
      ref={input}
      type="file"
      accept="image/png,image/jpeg,image/webp"
      hidden
      onChange={event => {
        const file = event.target.files?.[0];
        // Cleared so the same file can be chosen twice.
        event.target.value = '';
        void send(file);
      }}
    />
  </>;
}

/**
 * `projectID` is what lets a close or a reopen leave a line in the project's
 * channel — GitHub's issue does not know which of our projects it belongs to,
 * so the client has to say. Optional because this sheet also opens from Mine,
 * which lists issues across every project and knows no single one; a change
 * made there simply goes unreported until Core's webhook covers it.
 */
export function IssueDetail({ issue, projectID, onClose, onChange }: { issue: IssueReference; projectID?: string; onClose: () => void; onChange: () => void }) {
  const [detail, setDetail] = useState<CrmIssueDetail | null>(null);
  const [facets, setFacets] = useState<CrmIssueFacetsResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [comment, setComment] = useState('');
  const [draft, setDraft] = useState<{ title: string; body: string; labels: string[]; assignees: string[]; milestone: number | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void apiFetch<CrmIssueDetailResponse>(`/crm/issue?${queryFor(issue)}`, { noStore: true, fallbackError: t('Couldn’t load this issue.') }).then(result => { if (!cancelled) { setDetail(result.issue); setError(''); } }).catch(cause => { if (!cancelled) setError(failure(cause)); });
    void apiFetch<CrmIssueFacetsResponse>(`/crm/issue-facets?${queryFor(issue)}`, { noStore: true, fallbackError: t('Couldn’t load repository options.') }).then(result => { if (!cancelled) setFacets(result); }).catch(() => {});
    return () => { cancelled = true; };
  }, [issue.owner, issue.repo, issue.number, revision]);
  async function write(patch: object) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await apiFetch<CrmIssueDetailResponse>('/crm/issue', { method: 'PATCH', body: { ...issue, project_id: projectID, ...patch }, fallbackError: t('Couldn’t update this issue. Your draft is still here.') });
      setDetail(result.issue); setDraft(null); setComment(''); onChange(); return true;
    } catch (cause) { setError(failure(cause)); return false; }
    finally { setBusy(false); }
  }
  const activity = detail ? [
    ...(detail.comments_list ?? []).map(row => ({ id: `comment-${row.id}`, at: row.created_at, title: row.author, text: row.body })),
    ...(detail.timeline ?? []).map(row => ({ id: `event-${row.id}`, at: row.created_at ?? '', title: row.actor ?? t('GitHub'), text: [row.kind.replaceAll('_', ' '), row.subject, row.label?.name].filter(Boolean).join(' · ') })),
  ].sort((a, b) => a.at.localeCompare(b.at)) : [];
  // In the column, not over it: an issue reads where a task reads, with
  // Back where a task has Back. The page owns nothing modal.
  return <section className="py-1" aria-label={t('Issue details')}>
    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>{t('← Back')}</Button>
    <h2 className={cn(detailTitleClass, 'mt-3 mb-2')}>{detail?.title ?? <PlaceholderBar label={t('Opening issue…')} className="inline-block h-[1em] w-64 max-w-full rounded-full align-middle" />}</h2>
    {error && (
      <ErrorNotice
        message={error}
        action={<Button type="button" variant="outline" size="xs" onClick={() => setRevision(value => value + 1)}>{t('Retry')}</Button>}
      />
    )}
    {detail && <>
      <p>{issue.owner}/{issue.repo} #{issue.number} · {detail.state} · <a href={detail.url} target="_blank" rel="noreferrer">{t('Open in GitHub')}</a></p>
      {draft ? <SheetCard onSubmit={event => { event.preventDefault(); void write(facets ? draft : { title: draft.title, body: draft.body }); }}>
        <SheetField label={t('Title')}><Input required maxLength={250} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></SheetField>
        <SheetField label={t('Description')}><Textarea rows={8} maxLength={20000} value={draft.body} onChange={event => setDraft({ ...draft, body: event.target.value })} /></SheetField>
        {facets && <>
          <fieldset className={facetClass}><legend className={facetLegendClass}>{t('Labels')}</legend>{facets.labels.map(label => <Label key={label.name} className={checkLabelClass}><Checkbox checked={draft.labels.includes(label.name)} onCheckedChange={checked => setDraft({ ...draft, labels: checked === true ? [...draft.labels, label.name] : draft.labels.filter(value => value !== label.name) })} />{label.name}</Label>)}</fieldset>
          <fieldset className={facetClass}><legend className={facetLegendClass}>{t('Assignees')}</legend>{facets.assignees.map(person => <Label key={person.login} className={checkLabelClass}><Checkbox checked={draft.assignees.includes(person.login)} onCheckedChange={checked => setDraft({ ...draft, assignees: checked === true ? [...draft.assignees, person.login] : draft.assignees.filter(value => value !== person.login) })} />{person.login}</Label>)}</fieldset>
          <SheetField label={t('Milestone')}><NativeSelect value={draft.milestone ?? ''} onChange={event => setDraft({ ...draft, milestone: event.target.value ? Number(event.target.value) : null })}><NativeSelectOption value="">{t('None')}</NativeSelectOption>{facets.milestones.filter(milestone => milestone.number !== null).map(milestone => <NativeSelectOption key={milestone.number} value={milestone.number!}>{milestone.title}</NativeSelectOption>)}</NativeSelect></SheetField>
        </>}
        <SheetActions>
          <Button variant="secondary" type="button" disabled={busy} onClick={() => setDraft(null)}>{t('Cancel')}</Button>
          <Button disabled={busy || !draft.title.trim()}>{t('Save')}</Button>
        </SheetActions>
      </SheetCard> : <>
        <p className={issueBodyClass}>{detail.body || 'No description.'}</p>
        <p>{detail.labels.join(' · ')}{detail.milestone ? ` · ${detail.milestone}` : ''}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => setDraft({ title: detail.title, body: detail.body, labels: detail.labels, assignees: detail.assignees?.map(person => person.login) ?? (detail.assignee_login ? [detail.assignee_login] : []), milestone: detail.milestone_detail?.number ?? null })}>{t('Edit issue')}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => { void write({ state: detail.state === 'open' ? 'closed' : 'open', ...(detail.state === 'open' ? { state_reason: 'completed' } : {}) }); }}>{detail.state === 'open' ? t('Close issue') : t('Reopen issue')}</Button>
        </div>
      </>}
      <PlanHead className="mt-6">{t('Activity')}</PlanHead>
      {activity.map(row => {
        const at = row.at ? new Date(row.at) : null;
        return <article key={row.id}><small>{row.title} · {at ? `${at.toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })} ${formatTime(at)}` : ''}</small><p className={issueBodyClass}>{row.text}</p></article>;
      })}
      {detail.comments > (detail.comments_list ?? []).length && <p><a href={detail.url} target="_blank" rel="noreferrer">{t('Read the remaining comments in GitHub')}</a></p>}
      <form className="flex max-w-[520px] flex-col items-start gap-2" onSubmit={event => { event.preventDefault(); void write({ comment: comment.trim() }); }}><SheetField className="self-stretch" label={t('Comment')}><Textarea rows={3} required maxLength={20000} value={comment} onChange={event => setComment(event.target.value)} /></SheetField><Button disabled={busy || !!draft || !comment.trim()}>{t('Comment')}</Button></form>
    </>}
  </section>;
}

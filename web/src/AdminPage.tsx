import { SignInGate } from './SignInGate';
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AdminAgentRemoveResponse } from '@starlings/contracts/agent-enrollment';
import { confirmDataLoss } from './ConfirmDataLoss';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Item, ItemDescription, ItemGroup, ItemHeader } from '@/ui/item';
import { cn } from '@/lib/utils';
import { apiFetch } from './api';
import { CountryFlag } from './country-flag';
import { ControlRequestError } from './config';
import { formatMeetingDuration } from './meeting-duration';
import { formatTime } from './meeting-time';
import { AppShell } from './SiteChrome';
import { wasMember } from './owner-session';
import { ErrorNotice } from './ErrorNotice';
import { Note, PAGE, SectionCard, TableFrame } from './SectionCard';
import { useDocumentTitle } from './document-title';
import { plural, t, dateLocale, uiLocale } from './i18n';
import { AdminHeader, ADMIN_SECTIONS, adminSectionLabel, type AdminSection } from './AdminNav';
import { ConnectorsGrid, GranolaConnectorNote } from './ConnectorsPage';
import { VisitorHomeSettings } from './VisitorHomeSettings';
import { BookingNdaSettings } from './BookingNdaSettings';
import { WorkModulesSettings } from './WorkModulesSettings';
import { SetupChecklistSettings } from './SetupChecklistSettings';
import { PeerOrganizations } from './PeerOrganizations';
import { WorkspaceBrandSettings } from './WorkspaceBrandSettings';
import { WorkspacePlanSettings } from './WorkspacePlanSettings';
import { rememberViewerAdmin } from './workspace-plan';
import type { AdminAgentActivityResponse, OwnerDeviceSummary, AdminAgentFreezeResponse, AdminOverview, ChannelRemoveResponse, ChannelRestoreResponse, ChannelSubjectKind, DeadJobsResponse, ModelUsageResponse, OpsFailuresResponse, ModelUsageRow, NotesOwedResponse, NotesOwedRetryResponse, NotesOwedRow, OrphanChannel, OrphanChannelsResponse, RemovedChannel, ReplayJobsResponse } from '@starlings/contracts';
import type { McpCallEntry } from '@starlings/contracts/mcp';
import { Spinner } from '@/ui/spinner';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { IdentityAvatar } from './PeerAvatar';
import { AgentEnrollments } from './AgentEnrollments';
import { AdminInvitations } from './AdminInvitations';
import { isAgent, subscribePeers, type Peer } from './team-presence';

type Band = 'green' | 'amber' | 'red';

/** Admin's layout vocabulary on Tailwind: every section is a SectionCard. */
const TILES = 'grid grid-cols-1 gap-3 sm:grid-cols-3';
const STATS = 'grid grid-cols-1 gap-3 sm:grid-cols-4';
const LABEL = 'text-xs font-medium tracking-[0.04em] text-muted-foreground uppercase';
const FIGURE = "leading-none font-[620]";
const ROOM_ROW = 'gap-x-5 gap-y-3 bg-card text-[13px] text-foreground/80';
const FILTER = 'grid gap-1.5 text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase leading-normal items-stretch';
const FILTER_SELECT = 'min-w-40 tracking-normal normal-case';
/** A job's control: the button, then its answer under it. */
/** A pill beside a roster row: Hide, Admin, a device count, Revoke. Pressed reads muted. */
const PILL = 'rounded-full aria-pressed:text-muted-foreground';
const DANGER = 'text-destructive hover:text-destructive';
/** The S and C marks in a meeting's status: summary written, CRM synced. Off reads muted. */
const TICK = 'mr-1.5 inline-block font-[560]';
const NOTICE = 'grid justify-items-start gap-2.5';
/** Elevated, not alarmed: a grey bar reads as worth a look, distinct from
 * the on-track lime and the red band's real alarm. */
const BAND_FILL: Record<Band, string> = {
  green: 'bg-[var(--accent)]',
  amber: 'bg-foreground/45',
  red: 'bg-destructive',
};

type Role = 'member' | 'admin';

type Person = {
  email: string;
  name: string | null;
  kind: 'human' | 'agent';
  hidden: boolean;
  role: Role;
  root: boolean;
  retired: boolean;
  revoked: boolean;
  devices: number;
  last_seen_at: number;
  room_slug: string | null;
  calendar_connected: boolean;
  last_client: string | null;
  meetings_hosted: number;
};

type PersonDevice = OwnerDeviceSummary;

type AuditEntry = {
  ts: number;
  actor_email: string;
  action: string;
  subject: string | null;
  detail: string | null;
};


/** `GET /api/admin/overview`, as the Worker answers it (`adminOverviewSchema`). */
type Overview = AdminOverview;

const ALL = 'all';

/**
 * Which of Admin's five sections this is (`AdminNav.tsx`).
 *
 * They were one page, and the seam showed: a read-only operations dashboard
 * with an org-wide write control buried in it. Looking at the numbers and
 * changing what every member sees are different acts with different
 * authorization (docs/ADMIN.md §11), so they are different destinations.
 *
 * One fetch and one ten-second poll still serve the sections: the overview
 * carries the roster, the audit trail and the viewer's own role, and splitting
 * the request as well as the page would buy nothing.
 */
export function AdminPage({ section = 'people' }: { section?: AdminSection }) {
  useDocumentTitle(adminSectionLabel(section), t('Admin'));
  const [overview, setOverview] = useState<Overview | null>(null);
  const [auth, setAuth] = useState<'loading' | 'needed' | 'ok'>('loading');
  const [error, setError] = useState('');
  const [host, setHost] = useState(ALL);
  const [month, setMonth] = useState(ALL);
  const [category, setCategory] = useState(ALL);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    async function load() {
      try {
        const body = await apiFetch<Overview>('/admin/overview', {
          fallbackError: t('Couldn’t load admin.'),
          noStore: true,
        });
        if (cancelled) return;
        setOverview(body);
        rememberViewerAdmin(body.viewer.is_admin);
        setAuth('ok');
        setError('');
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof ControlRequestError && (cause.status === 401 || cause.status === 403)) {
          setAuth('needed');
          setOverview(null);
          return;
        }
        setAuth('ok');
        setError(cause instanceof Error ? cause.message : t('Couldn’t load admin.'));
      }
    }
    const start = () => {
      window.clearInterval(timer);
      if (document.visibilityState !== 'visible') return;
      void load();
      timer = window.setInterval(
        () => void load(),
        (document.hasFocus() ? 30 : 120) * 1_000,
      );
    };
    start();
    const retune = () => start();
    document.addEventListener('visibilitychange', retune);
    window.addEventListener('focus', retune);
    window.addEventListener('blur', retune);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', retune);
      window.removeEventListener('focus', retune);
      window.removeEventListener('blur', retune);
    };
  }, []);

  async function refreshAfterSignIn() {
    const body = await apiFetch<Overview>('/admin/overview', {
      fallbackError: t('Couldn’t load admin.'),
      noStore: true,
    });
    setOverview(body);
    setAuth('ok');
    setError('');
  }

  /**
   * Optimistic on purpose: the ten-second poll is the source of truth and will
   * correct this, but a toggle that waits a full round-trip to move reads as
   * broken. A failure puts the row back and says why.
   */
  async function setPersonHidden(email: string, hidden: boolean) {
    setOverview((current) => current && applyHidden(current, email, hidden));
    try {
      await apiFetch<{ email: string; hidden: boolean }>('/admin/people/visibility', {
        method: 'POST',
        body: { email, hidden },
        fallbackError: hidden ? t('Couldn’t hide that person.') : t('Couldn’t show that person.'),
        noStore: true,
      });
      setError('');
    } catch (cause) {
      setOverview((current) => current && applyHidden(current, email, !hidden));
      setError(cause instanceof Error ? cause.message : t('Couldn’t change that person’s visibility.'));
    }
  }

  /**
   * Role is not optimistic. Hiding a row is reversible with the same click;
   * making somebody an admin is not the kind of change to draw before the
   * server has agreed to it, and the server owns two refusals the button
   * cannot know about (the last admin, a room owner).
   */
  /**
   * The most consequential control on this page, so it confirms first and
   * reports what it did. Revoking signs every device out; the access token
   * already in their browser survives until it expires, which is at most eight
   * hours and is a property of a stateless JWT rather than something the
   * button can fix. Saying so beats implying an instant cut-off.
   */
  async function setPersonAccess(email: string, revoked: boolean) {
    try {
      const body = await apiFetch<{ email: string; revoked: boolean; devices_signed_out: number }>(
        '/admin/people/access',
        {
          method: 'POST',
          body: { email, revoked },
          fallbackError: revoked ? t('Couldn’t revoke that person.') : t('Couldn’t restore that person.'),
          noStore: true,
        },
      );
      setOverview((current) => current && applyAccess(current, email, revoked, revoked ? 0 : undefined));
      setError(revoked && body.devices_signed_out > 0
        ? t('{email} revoked — {devices} signed out.', { email, devices: plural(body.devices_signed_out, { one: '{count} device', other: '{count} devices' }) })
        : '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t change that person’s access.'));
    }
  }

  async function setPersonRole(email: string, role: Role) {
    try {
      await apiFetch<{ email: string; role: Role }>('/admin/people/role', {
        method: 'POST',
        body: { email, role },
        fallbackError: t('Couldn’t change that role.'),
        noStore: true,
      });
      setOverview((current) => current && applyRole(current, email, role));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t change that role.'));
    }
  }

  if (auth === 'loading') {
    return (
      <AppShell variant="wide" member={wasMember() ? 'home' : undefined} memberNavCurrent={null}>
        <div className={PAGE}>
          <h1>{t('Admin')}</h1>
          <PlaceholderRows count={5} label={t('Opening…')} />
        </div>
      </AppShell>
    );
  }

  if (auth === 'needed') {
    return (
      <SignInGate title={t('Admin')} onSignedIn={refreshAfterSignIn} />
    );
  }

  if (!overview) {
    return (
      <AppShell variant="wide" member="home" memberNavCurrent={null}>
        <div className={PAGE}>
          <h1>{t('Admin')}</h1>
          {error && <ErrorNotice message={error} />}
        </div>
      </AppShell>
    );
  }

  return (
    <LoadedAdmin
      section={section}
      overview={overview}
      error={error}
      host={host}
      month={month}
      category={category}
      onHost={setHost}
      onMonth={setMonth}
      onCategory={setCategory}
      onPersonHidden={setPersonHidden}
      onPersonRole={setPersonRole}
      onPersonAccess={setPersonAccess}
      onPersonDevices={(email, devices) => setOverview((current) => current && applyDevices(current, email, devices))}
    />
  );
}

function LoadedAdmin({
  section,
  overview,
  error,
  host,
  month,
  category,
  onHost,
  onMonth,
  onCategory,
  onPersonHidden,
  onPersonRole,
  onPersonAccess,
  onPersonDevices,
}: {
  section: AdminSection;
  overview: Overview;
  error: string;
  host: string;
  month: string;
  category: string;
  onHost: (value: string) => void;
  onMonth: (value: string) => void;
  onCategory: (value: string) => void;
  onPersonHidden: (email: string, hidden: boolean) => void;
  onPersonRole: (email: string, role: Role) => void;
  onPersonAccess: (email: string, revoked: boolean) => void;
  onPersonDevices: (email: string, devices: number) => void;
}) {
  const hosts = useMemo(
    () => [...new Set(overview.meetings.map((row) => row.host_email))].sort(),
    [overview.meetings],
  );
  const months = useMemo(() => {
    const keys = new Set(overview.meetings.map((row) => monthKey(row.started_at)));
    return [...keys].sort().reverse();
  }, [overview.meetings]);
  const categories = useMemo(() => {
    const keys = new Set(
      overview.meetings.map((row) => row.meeting_kind).filter((value): value is string => Boolean(value)),
    );
    return [...keys].sort();
  }, [overview.meetings]);

  const meetings = overview.meetings.filter((row) => {
    if (host !== ALL && row.host_email !== host) return false;
    if (month !== ALL && monthKey(row.started_at) !== month) return false;
    if (category !== ALL && row.meeting_kind !== category) return false;
    return true;
  });

  const monthStats = overview.this_month;
  const downstreamUsage = overview.downstream_usage;
  const hasDownstreamMeasurement = (downstreamUsage?.reporting_sessions ?? 0) > 0;
  const usedRatio = monthStats.participant_minutes_limit <= 0
    ? 0
    : monthStats.participant_minutes / monthStats.participant_minutes_limit;

  // Admin sits under the workspace tabs the way Settings does: a member
  // place with no tab of its own.
  return (
    <AppShell variant="wide" member="home" memberNavCurrent={null}>
      <div className={PAGE}>
        <AdminHeader section={section} />
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        {error && <ErrorNotice message={error} />}

        {section === 'connectors' && <>
        <AdminConfiguration configuration={overview.configuration} />
        <ConnectorsGrid />
        </>}

        {section === 'jobs' && <AdminJobs overview={overview} />}

        {section === 'agents' && <>
          {overview.viewer.is_admin && <AgentEnrollments />}
          <AgentActivity isAdmin={overview.viewer.is_admin} />
        </>}

        {section === 'operations' && <>
        <SectionCard id="admin-now" title={t('Now')}>
          {overview.degraded.length > 0 && (
            <ErrorNotice
              message={plural(overview.degraded.length, { one: 'Room {rooms} unavailable.', other: 'Rooms {rooms} unavailable.' }).replace('{rooms}', overview.degraded.join(', '))}
            />
          )}
          <div className={TILES}>
            <Tile label={t('Rooms in session')} value={String(overview.now.rooms_in_session)} />
            <Tile label={t('Participants connected')} value={String(overview.now.participants_connected)} />
            <Tile label={t('Waiting')} value={String(overview.now.waiting)} />
          </div>
          {overview.now.rooms.length > 0 && (
            <ItemGroup className="gap-2">
              {overview.now.rooms.map((room) => (
                <Item key={room.slug} role="listitem" variant="outline" size="sm" className={ROOM_ROW}>
                  <strong className="text-foreground">{room.slug}</strong>
                  <span>
                    {overview.degraded.includes(room.slug)
                      ? t('Unreachable')
                      : room.in_session ? t('In meeting') : t('Idle')}
                  </span>
                  <span>{room.participants} connected</span>
                  <span>{room.waiting} waiting</span>
                </Item>
              ))}
            </ItemGroup>
          )}
        </SectionCard>

        <OpsFailures />

        <SectionCard id="admin-month" title={t('This month')}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Card className="grid grid-cols-1 items-end gap-5 bg-popover px-5.5 py-5 shadow-none sm:grid-cols-[minmax(0,1fr)_minmax(120px,0.4fr)]">
              <div>
                <p className={`m-0 ${LABEL}`}>{t('Participant-minutes')}</p>
                <p className={`mt-1.5 mb-2 text-[clamp(36px,5vw,52px)] ${FIGURE}`}>
                  {formatNumber(monthStats.participant_minutes)}
                  <small className="text-[0.45em] text-muted-foreground"> / {formatNumber(monthStats.participant_minutes_limit)}</small>
                </p>
                <p className="m-0 text-sm text-foreground/80">
                  {t('{percent}% used · projected {minutes} by month end', { percent: Math.round(usedRatio * 100), minutes: formatNumber(monthStats.projected_minutes) })}
                </p>
              </div>
              <Sparkline
                values={monthStats.sparkline.map((point) => point.minutes)}
                label={t('Participant-minutes, last 30 days')}
              />
            </Card>
            <Card className="grid content-between gap-4 bg-popover px-5.5 py-5 shadow-none">
              <div>
                <p className={`m-0 ${LABEL}`}>{t('Downstream RTP received')}</p>
                <p className={`mt-1.5 mb-2 text-[clamp(36px,5vw,52px)] ${FIGURE}`}>
                  {hasDownstreamMeasurement
                    ? <>{formatGigabytes(downstreamUsage!.received_bytes)}<small className="text-[0.45em] text-muted-foreground"> GB</small></>
                    : '—'}
                </p>
                <p className="m-0 text-sm text-foreground/80">
                  {downstreamUsage == null
                    ? t('Usage measurement unavailable.')
                    : downstreamUsage.last_reported_at === null
                      ? t('No client reports yet this month.')
                      : t('Latest report {time}', { time: formatTime(new Date(downstreamUsage.last_reported_at)) })}
                </p>
              </div>
              <p className="m-0 text-xs text-muted-foreground">
                {t('RTP receive bytes reported by clients; LiveKit totals may include additional traffic.')}
              </p>
            </Card>
          </div>
          <div className={STATS}>
            <Stat
              label={t('Meetings')}
              value={String(monthStats.meetings)}
              delta={delta(monthStats.meetings, monthStats.prior_meetings)}
            />
            <Stat label={t('Hosts')} value={String(monthStats.unique_hosts)} />
            <Stat label={t('Guests')} value={String(monthStats.unique_guests)} />
            <Stat
              label={t('Average duration')}
              value={monthStats.average_duration_ms ? formatMeetingDuration(monthStats.average_duration_ms) : '—'}
            />
          </div>
        </SectionCard>

        <SectionCard id="admin-thresholds" title={t('Thresholds')}>
          <ItemGroup className="gap-2.5">
            {overview.thresholds.map((row) => (
              <Item key={row.id} role="listitem" variant="outline" size="sm" className="gap-2">
                <ItemHeader className="gap-3 text-sm">
                  <strong>{row.label}</strong>
                  <span>
                    {formatNumber(row.used)}
                    {row.projected != null ? t(' · proj. {projected}', { projected: formatNumber(row.projected) }) : ''}
                    {' / '}
                    {formatNumber(row.limit)}
                    {row.unit ? ` ${row.unit}` : ''}
                  </span>
                </ItemHeader>
                <div className="h-1.5 basis-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <span className={cn('block h-full rounded-full', BAND_FILL[row.band])} style={{ width: `${barWidth(row.projected ?? row.used, row.limit)}%` }} />
                </div>
                <ItemDescription className="line-clamp-none basis-full text-xs font-medium">{row.source}</ItemDescription>
              </Item>
            ))}
          </ItemGroup>
        </SectionCard>

        </>}

        {section === 'people' && <>
        <AdminInvitations canEdit={overview.viewer.is_admin} />

        <Roster
          id="admin-people"
          title={t('People')}
          rows={overview.people}
          empty="Nobody has signed in yet."
          onToggle={onPersonHidden}
          onRole={onPersonRole}
          onAccess={onPersonAccess}
          onDevicesChanged={onPersonDevices}
          viewer={overview.viewer}
        />

        <WorkspaceBrandSettings canEdit={overview.viewer.is_admin} />

        <WorkspacePlanSettings viewer={overview.viewer} />

        <WorkModulesSettings canEdit={overview.viewer.is_admin} />

        <SetupChecklistSettings canEdit={overview.viewer.is_admin} />

        <VisitorHomeSettings people={overview.people} canEdit={overview.viewer.is_admin} />

        <BookingNdaSettings canEdit={overview.viewer.is_admin} />

        <PeerOrganizations canEdit={overview.viewer.is_admin} />

        <AdminTrail entries={overview.audit} />
        <McpTrail entries={overview.mcp_calls ?? []} />
        </>}

        {section === 'operations' && <>
        <SectionCard id="admin-meetings" title={t('Meetings')}>
          <MeetingsSource source={overview.meetings_source} />
          <GranolaConnectorNote />
          <div className="flex flex-wrap gap-3">
            <Label className={FILTER}>
              {t('Host')}
              <NativeSelect className={FILTER_SELECT} value={host} onChange={(event) => onHost(event.target.value)}>
                <NativeSelectOption value={ALL}>{t('All')}</NativeSelectOption>
                {hosts.map((value) => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}
              </NativeSelect>
            </Label>
            <Label className={FILTER}>
              {t('Month')}
              <NativeSelect className={FILTER_SELECT} value={month} onChange={(event) => onMonth(event.target.value)}>
                <NativeSelectOption value={ALL}>{t('All')}</NativeSelectOption>
                {months.map((value) => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}
              </NativeSelect>
            </Label>
            <Label className={FILTER}>
              {t('Category')}
              <NativeSelect className={FILTER_SELECT} value={category} onChange={(event) => onCategory(event.target.value)}>
                <NativeSelectOption value={ALL}>{t('All')}</NativeSelectOption>
                {categories.map((value) => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}
              </NativeSelect>
            </Label>
          </div>
          <TableFrame>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Date')}</TableHead>
                  <TableHead>{t('Host')}</TableHead>
                  <TableHead>{t('Title')}</TableHead>
                  <TableHead>{t('Duration')}</TableHead>
                  <TableHead>{t('People')}</TableHead>
                  <TableHead>{t('Entry')}</TableHead>
                  <TableHead>{t('Quality')}</TableHead>
                  <TableHead>{t('Status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {meetings.map((row) => (
                  <TableRow key={row.meeting_id}>
                    <TableCell>{formatDate(row.started_at)}</TableCell>
                    <TableCell>{row.host_email}</TableCell>
                    <TableCell>{row.ended_at != null && row.room_slug ? <a href={`/meetings/${row.room_slug}/${row.meeting_id}`}>{row.title || '—'}</a> : (row.title || '—')}</TableCell>
                    <TableCell>{row.duration_ms != null ? formatMeetingDuration(row.duration_ms) : 'live'}</TableCell>
                    <TableCell>
                      {row.participant_count}
                      {row.guest_domains.length > 0 ? ` · ${row.guest_domains.join(', ')}` : ''}
                    </TableCell>
                    <TableCell>{row.was_booked ? t('Invited') : 'Walk-up'}</TableCell>
                    <TableCell>{row.worst_quality || '—'}</TableCell>
                    <TableCell>
                      <span className={cn(TICK, !row.summary_generated && 'text-muted-foreground')}>S</span>
                      <span className={cn(TICK, !row.crm_synced && 'text-muted-foreground')}>C</span>
                      {overview.viewer.is_admin && row.ended_at != null && (
                        <RegenerateNotes roomSlug={row.room_slug} meetingId={row.meeting_id} />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        </SectionCard>

        <SectionCard id="admin-funnel" title={t('Funnel')}>
          <div className={STATS}>
            <Stat label={t('On the page → knock')} value={String(overview.funnel.knocks)} />
            <Stat label={t('Admitted')} value={String(overview.funnel.admitted)} />
            <Stat label={t('Joined')} value={String(overview.funnel.joined)} />
            <Stat label={t('Abandon rate')} value={`${Math.round(overview.funnel.abandon_rate * 100)}%`} />
          </div>
          <Breakdown title={t('Client')} counts={overview.funnel.by_client} />
          <Breakdown title={t('Country')} counts={overview.funnel.by_country} />
        </SectionCard>

        {overview.viewer.is_admin && <ModelUsage />}

        <SectionCard id="admin-health" title={t('Health')}>
          <div className={STATS}>
            <Stat label={t('Ended without summary')} value={String(overview.health.ended_without_summary)} />
            <Stat label={t('Poor quality participants')} value={String(overview.health.poor_quality_participants)} />
            <Stat label={t('Reconnects')} value={String(overview.health.reconnects)} />
            <Stat label={t('Records sync')} value={CRM_SYNC_LABEL[overview.health.crm_sync]} />
          </div>
        </SectionCard>
        </>}
        </div>
      </div>
    </AppShell>
  );
}

function applyHidden(overview: Overview, email: string, hidden: boolean): Overview {
  const patch = (rows: Person[]) => rows.map((row) => row.email === email ? { ...row, hidden } : row);
  return { ...overview, people: patch(overview.people), agents: patch(overview.agents) };
}

function applyRole(overview: Overview, email: string, role: Role): Overview {
  const patch = (rows: Person[]) => rows.map((row) => row.email === email ? { ...row, role } : row);
  return { ...overview, people: patch(overview.people), agents: patch(overview.agents) };
}

function applyDevices(overview: Overview, email: string, devices: number): Overview {
  const patch = (rows: Person[]) => rows.map((row) => row.email === email ? { ...row, devices } : row);
  return { ...overview, people: patch(overview.people), agents: patch(overview.agents) };
}

function applyAccess(overview: Overview, email: string, revoked: boolean, devices?: number): Overview {
  const patch = (rows: Person[]) => rows.map((row) => row.email === email
    ? { ...row, revoked, ...(devices === undefined ? {} : { devices }) }
    : row);
  return { ...overview, people: patch(overview.people), agents: patch(overview.agents) };
}

/**
 * One roster table. People and Agents are the same shape and the same
 * controls — they are split because they are not the same thing, and a list
 * that mixes colleagues with runtimes answers neither question well.
 */
function Roster({ id, title, rows, empty, onToggle, onRole, onAccess, onDevicesChanged, viewer, roles = true }: {
  id: string;
  title: string;
  rows: Person[];
  empty: string;
  onToggle: (email: string, hidden: boolean) => void;
  onRole: (email: string, role: Role) => void;
  onAccess: (email: string, revoked: boolean) => void;
  onDevicesChanged: (email: string, devices: number) => void;
  viewer: Overview['viewer'];
  /** Agents can hold no role, so their table does not draw the column. */
  roles?: boolean;
}) {
  const hidden = rows.filter((row) => row.hidden).length;
  // The device list under a row (docs/ADMIN.md §5a). Fetched when opened;
  // signing one out is the one admin write allowed on yourself and on a
  // root admin, because a lost phone is not a lockout.
  const [openDevices, setOpenDevices] = useState<string | undefined>();
  const [devices, setDevices] = useState<Record<string, PersonDevice[]>>({});
  const [deviceError, setDeviceError] = useState<string | undefined>();

  async function toggleDevices(email: string) {
    if (openDevices === email) { setOpenDevices(undefined); return; }
    setOpenDevices(email);
    setDeviceError(undefined);
    try {
      const body = await apiFetch<{ devices: PersonDevice[] }>(
        `/admin/people/devices?email=${encodeURIComponent(email)}`,
        { fallbackError: t('Couldn’t load that person’s devices.'), noStore: true },
      );
      setDevices((current) => ({ ...current, [email]: body.devices }));
    } catch (cause) {
      setDeviceError(cause instanceof Error ? cause.message : t('Couldn’t load that person’s devices.'));
    }
  }

  async function signOutDevice(email: string, device: PersonDevice) {
    const name = device.label ?? (device.platform === 'android' ? 'Android' : device.client === 'ios' ? 'iPhone' : 'Mac');
    setDeviceError(undefined);
    try {
      const body = await apiFetch<{ devices: PersonDevice[] }>('/admin/devices/revoke', {
        method: 'POST',
        body: { device_id: device.device_id },
        fallbackError: t('Couldn’t sign that device out.'),
        noStore: true,
      });
      setDevices((current) => ({ ...current, [email]: body.devices }));
      onDevicesChanged(email, body.devices.length);
    } catch (cause) {
      setDeviceError(cause instanceof Error ? cause.message : t('Couldn’t sign that device out.'));
    }
  }

  return (
    <SectionCard
      id={id}
      title={<>{title} <span className="text-xs font-normal tracking-[0.02em] text-muted-foreground">{rows.length}{hidden > 0 ? ` · ${hidden} hidden` : ''}</span></>}
    >
      {rows.length === 0 ? (
        <Note>{empty}</Note>
      ) : (
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Name')}</TableHead>
                <TableHead>{t('Email')}</TableHead>
                <TableHead>{t('Last seen')}</TableHead>
                <TableHead>{t('Room')}</TableHead>
                <TableHead>{t('Calendar')}</TableHead>
                <TableHead>{t('Hosted')}</TableHead>
                {roles && <TableHead>{t('Role')}</TableHead>}
                <TableHead>{t('Roster')}</TableHead>
                {roles && <TableHead>{t('Devices')}</TableHead>}
                {roles && <TableHead>{t('Access')}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((person) => (
                <Fragment key={person.email}>
                <TableRow
                  className={person.revoked ? 'line-through decoration-border opacity-55' : person.hidden ? 'text-foreground/40' : undefined}
                >
                  <TableCell>{person.name || '—'}</TableCell>
                  <TableCell>{person.email}</TableCell>
                  <TableCell>{formatRelative(person.last_seen_at)}</TableCell>
                  <TableCell>{person.room_slug || 'no room'}</TableCell>
                  <TableCell>{person.calendar_connected ? t('Connected') : '—'}</TableCell>
                  <TableCell>{person.meetings_hosted}</TableCell>
                  {roles && (
                    <TableCell>
                      {person.root ? (
                        <span>{t('Admin · root')}</span>
                      ) : !viewer.is_admin || person.email === viewer.email ? (
                        <span>{person.role === 'admin' ? 'Admin' : '—'}</span>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          className={PILL}
                          aria-pressed={person.role === 'admin'}
                          onClick={() => onRole(person.email, person.role === 'admin' ? 'member' : 'admin')}
                        >
                          {person.role === 'admin' ? 'Admin' : 'Member'}
                        </Button>
                      )}
                    </TableCell>
                  )}
                  <TableCell>
                    {viewer.is_admin ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        className={PILL}
                        aria-pressed={person.hidden}
                        onClick={() => onToggle(person.email, !person.hidden)}
                      >
                        {person.hidden ? t('Show') : t('Hide')}
                      </Button>
                    ) : (
                      <span>{person.hidden ? t('Hidden') : '—'}</span>
                    )}
                  </TableCell>
                  {roles && (
                    <TableCell>
                      {viewer.is_admin && person.devices > 0 ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          className={PILL}
                          aria-expanded={openDevices === person.email}
                          onClick={() => void toggleDevices(person.email)}
                        >
                          {person.devices}
                        </Button>
                      ) : (
                        <span>{person.devices || '—'}</span>
                      )}
                    </TableCell>
                  )}
                  {roles && (
                    <TableCell>
                      {person.root ? (
                        <span>{t('Permanent')}</span>
                      ) : !viewer.is_admin || person.email === viewer.email ? (
                        <span>{person.revoked ? t('Revoked') : '—'}</span>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          className={cn(PILL, !person.revoked && DANGER)}
                          onClick={() => onAccess(person.email, !person.revoked)}
                        >
                          {person.revoked ? t('Restore') : t('Revoke')}
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
                {roles && openDevices === person.email && (
                  <TableRow>
                    <TableCell colSpan={10} className="pt-0">
                      {devices[person.email] === undefined ? (
                        deviceError ? <Note as="span">{deviceError}</Note> : <PlaceholderRows count={2} />
                      ) : devices[person.email]!.length === 0 ? (
                        <Note as="span">{t('No device is signed in.')}</Note>
                      ) : (
                        <ul className="m-0 grid list-none gap-1.5 p-0 pb-2 text-[13px]">
                          {devices[person.email]!.map((device) => (
                            <li key={device.device_id} className="flex items-center justify-between gap-3">
                              <span>
                                <strong>{device.label ?? (device.platform === 'android' ? 'Android' : device.client === 'ios' ? 'iPhone' : 'Mac')}</strong>
                                {' '}· {device.platform === 'android' ? 'Android' : device.client === 'ios' ? 'iOS' : 'Mac'}
                                {device.app_version && <> · {device.app_version}</>}
                                {' '}· {t('renewed {time}', { time: formatRelative(device.renewed_at) })}
                              </span>
                              <Button
                                type="button"
                                variant="outline"
                                size="xs"
                                className={cn(PILL, DANGER)}
                                onClick={() => void signOutDevice(person.email, device)}
                              >
                                {t('Sign out')}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {deviceError && devices[person.email] !== undefined && (
                        <Note as="span">{deviceError}</Note>
                      )}
                    </TableCell>
                  </TableRow>
                )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      )}
    </SectionCard>
  );
}

const CRM_SYNC_LABEL: Record<'on' | 'off' | 'not_configured', string> = {
  on: 'On',
  off: t('Off — kill switch'),
  not_configured: t('Not configured'),
};

/**
 * What the account is configured to do, and where each value is set.
 *
 * Read-only, and that is the finding rather than an omission: every line here
 * lives in `wrangler.jsonc` or in a code constant, so changing any of them is
 * an edit and a deploy. Adding a colleague's room, or moving off the LiveKit
 * free tier, should not require reading the deploy to find out what the
 * current answer is — which until now it did.
 */
function AdminConfiguration({ configuration }: { configuration: Overview['configuration'] }) {
  const rows: Array<{ label: string; value: string; source: string }> = [
    {
      label: t('Rooms'),
      value: configuration.rooms.length === 0
        ? t('None')
        : configuration.rooms.map((room) => `${room.slug} · ${room.owner_email}`).join('\n'),
      source: t('OWNER_ROOM_MAP (wrangler.jsonc)'),
    },
    {
      label: t('LiveKit participant-minutes'),
      value: t('{livekit_minutes_limit} / month', { livekit_minutes_limit: formatNumber(configuration.livekit_minutes_limit) }),
      source: t('LIVEKIT_PARTICIPANT_MINUTES_PER_MONTH (code constant)'),
    },
    {
      label: t('Participant cap'),
      value: String(configuration.concurrent_participant_cap),
      source: t('CONCURRENT_PARTICIPANT_CAP (code constant)'),
    },
    {
      label: t('Records sync'),
      value: CRM_SYNC_LABEL[configuration.crm_sync],
      source: t('CRM_SYNC_MODE + INTERNAL_REQUEST_SECRET'),
    },
    {
      label: t('Meeting notes'),
      value: configuration.notes.engine === 'claude'
        ? t('Claude · {model}', { model: configuration.notes.model })
        : configuration.notes.engine === 'workers-ai'
          ? t('Workers AI · {model} — set ANTHROPIC_API_KEY for Claude', { model: configuration.notes.model })
          : t('Off — a dated placeholder, no model call'),
      source: t('ANTHROPIC_API_KEY (secret) + NOTES_MODEL, else SUMMARY_MODE + SUMMARY_MODEL'),
    },
    {
      label: t('Identity domains'),
      value: configuration.identity_domains.join(', '),
      source: t('IDENTITY_DOMAINS (wrangler.jsonc)'),
    },
    {
      label: t('Bot check'),
      value: configuration.features.bot_check ? t('On') : t('Off for this workspace'),
      source: t('TURNSTILE_SECRET_KEY (secret) + VITE_TURNSTILE_SITE_KEY'),
    },
    {
      label: t('Bug reports to GitHub'),
      value: configuration.features.bug_reports ? t('On') : t('Off for this workspace. Reports copy to the clipboard.'),
      source: t('GITHUB_ISSUES_TOKEN (secret) + GITHUB_ISSUES_REPO'),
    },
    {
      label: t('GitHub connector'),
      value: configuration.features.github_connector ? t('On') : t('Off for this workspace'),
      source: t('Connectors › GitHub › Connect GitHub'),
    },
    { label: t('Environment'), value: configuration.environment, source: t('ENVIRONMENT (wrangler.jsonc)') },
  ];

  return (
    <SectionCard id="admin-configuration" title={t('Configured')}>
      <TableFrame>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Setting')}</TableHead>
              <TableHead>{t('Value')}</TableHead>
              <TableHead>{t('Set in')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.label}>
                <TableCell>{row.label}</TableCell>
                <TableCell className="whitespace-pre-line">{row.value}</TableCell>
                <TableCell><code>{row.source}</code></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableFrame>
    </SectionCard>
  );
}

/**
 * Where the meeting history came from, and how to fix it when the answer is
 * the wrong one.
 *
 * The fan-out reads the rooms named in OWNER_ROOM_MAP right now: correct for
 * those, blind to any room that has left the map, and re-read on every load.
 * Saying so is the point — the difference between the two sources is invisible
 * in the numbers themselves, and it is exactly the difference between "the
 * account" and "the rooms we can still reach".
 */
/**
 * One-off after: every meeting titled "**Summary**" (the summary's
 * first heading, before the fix) gets a title from its summary, and Docs and
 * Core follow. Idempotent — a retitled meeting no longer matches.
 */
/**
 * One meeting's notes, written again with the engine configured now — the way
 * to put Meet's note beside Granola's for the same meeting ( claim 2).
 */
function RegenerateNotes({ roomSlug, meetingId }: { roomSlug: string; meetingId: string }) {
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle');
  const [error, setError] = useState('');

  async function run() {
    setState('running');
    setError('');
    try {
      await apiFetch<{ title: string; engine: string; synced: boolean }>('/admin/regenerate-notes', {
        method: 'POST',
        body: { room_slug: roomSlug, meeting_id: meetingId },
        fallbackError: t('Couldn’t regenerate the notes.'),
        noStore: true,
      });
      // The ten-second poll picks up the new title; nothing to reload here.
      setState('done');
    } catch (cause) {
      setState('idle');
      setError(cause instanceof Error ? cause.message : t('Couldn’t regenerate the notes.'));
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size="xs" className="ml-2" onClick={() => void run()} disabled={state !== 'idle'}>
        {state === 'running' ? 'Writing…' : state === 'done' ? 'Rewritten' : 'Rewrite notes'}
      </Button>
      {error && <ErrorNotice message={error} inline className="text-[13px]" />}
    </>
  );
}

/**
 * Notes the fallback model wrote in the last 30 days, queued to be written
 * again with Claude. The queue does the work, so the answer is a
 * count, not the new notes.
 */
function RegenerateFallbackNotes() {
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  async function run() {
    setState('running');
    try {
      const body = await apiFetch<{ rooms: number; queued: number }>('/admin/regenerate-fallback-notes', {
        method: 'POST',
        body: { since_ms: Date.now() - 30 * 24 * 60 * 60 * 1000 },
        fallbackError: t('Couldn’t queue the notes.'),
        noStore: true,
      });
      setState('done');
      setFailed(false);
      setMessage(t('Queued {meetings} across {rooms}.', {
        meetings: plural(body.queued, { one: '{count} meeting', other: '{count} meetings' }),
        rooms: plural(body.rooms, { one: '{count} room', other: '{count} rooms' }),
      }));
    } catch (cause) {
      setState('idle');
      setFailed(true);
      setMessage(cause instanceof Error ? cause.message : t('Couldn’t queue the notes.'));
    }
  }

  return (
    <div className={NOTICE}>
      <Button type="button" variant="secondary" onClick={() => void run()} disabled={state !== 'idle'}>
        {state === 'running' && <Spinner aria-hidden />}
        {state === 'running' ? t('Queuing…') : state === 'done' ? t('Queued') : t('Rewrite fallback notes')}
      </Button>
      {message && failed && <ErrorNotice message={message} />}
      {message && !failed && <Note role="status">{message}</Note>}
    </div>
  );
}

function RetitleMeetings() {
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  async function run() {
    setState('running');
    try {
      const body = await apiFetch<{ rooms: number; considered: number; retitled: Array<{ from: string | null; to: string }>; degraded: string[] }>('/admin/retitle-meetings', {
        method: 'POST',
        fallbackError: t('Couldn’t retitle the meetings.'),
        noStore: true,
      });
      setState('done');
      setFailed(false);
      const sample = body.retitled.slice(0, 3).map((row) => `“${row.to}”`).join(', ');
      setMessage([
        t('Retitled {retitled} of {meetings} across {rooms}', {
          retitled: body.retitled.length,
          meetings: plural(body.considered, { one: '{count} meeting', other: '{count} meetings' }),
          rooms: plural(body.rooms, { one: '{count} room', other: '{count} rooms' }),
        }),
        sample ? ` — ${sample}` : '',
        body.degraded.length ? t('; {count} couldn’t be synced', { count: body.degraded.length }) : '',
        '.',
      ].join(''));
    } catch (cause) {
      setState('idle');
      setFailed(true);
      setMessage(cause instanceof Error ? cause.message : t('Couldn’t retitle the meetings.'));
    }
  }

  return (
    <div className={NOTICE}>
      <Button type="button" variant="secondary" onClick={() => void run()} disabled={state !== 'idle'}>
        {state === 'running' ? 'Retitling…' : state === 'done' ? 'Retitled' : 'Retitle “Summary” meetings'}
      </Button>
      {message && failed && <ErrorNotice message={message} />}
      {message && !failed && <Note role="status">{message}</Note>}
    </div>
  );
}

/**
 * One-off behind the five-minute rule (docs/OPERATIONS.md): meetings that
 * ran under five minutes before the rule existed are discarded the way the
 * artifact job now does it. Idempotent.
 */
function DiscardShortMeetings() {
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  async function run() {
    if (!await confirmDataLoss({
      title: t('Discard every meeting under five minutes?'),
      body: t('They leave Admin and the ledger, and a transcript they filed moves to the Docs archive. This can’t be undone.'),
      action: t('Discard'),
    })) return;
    setState('running');
    try {
      const body = await apiFetch<{ rooms: number; discarded: Array<{ transcript_archived: boolean }>; degraded: string[] }>('/admin/discard-short-meetings', {
        method: 'POST',
        fallbackError: t('Couldn’t discard the meetings.'),
        noStore: true,
      });
      setState('done');
      setFailed(false);
      const archived = body.discarded.filter((row) => row.transcript_archived).length;
      setMessage([
        t('Discarded {meetings} across {rooms}', {
          meetings: plural(body.discarded.length, { one: '{count} meeting', other: '{count} meetings' }),
          rooms: plural(body.rooms, { one: '{count} room', other: '{count} rooms' }),
        }),
        archived ? plural(archived, { one: ', {count} transcript archived', other: ', {count} transcripts archived' }) : '',
        body.degraded.length ? t('; {count} failed', { count: body.degraded.length }) : '',
        '.',
      ].join(''));
    } catch (cause) {
      setState('idle');
      setFailed(true);
      setMessage(cause instanceof Error ? cause.message : t('Couldn’t discard the meetings.'));
    }
  }

  return (
    <div className={NOTICE}>
      <Button type="button" variant="secondary" onClick={() => void run()} disabled={state !== 'idle'}>
        {state === 'running' ? 'Discarding…' : state === 'done' ? 'Discarded' : 'Discard meetings under five minutes'}
      </Button>
      {message && failed && <ErrorNotice message={message} />}
      {message && !failed && <Note role="status">{message}</Note>}
    </div>
  );
}

/**
 * The dead-letter shelf: queue jobs that failed every retry, kept
 * in D1 by the dead queue's consumer. One button sends them all back.
 */
function ReplayDeadJobs() {
  const [count, setCount] = useState<number | null>(null);
  const [state, setState] = useState<'idle' | 'running'>('idle');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  async function load() {
    try {
      const body = await apiFetch<DeadJobsResponse>('/admin/dead-jobs', { fallbackError: t('Couldn’t read the dead jobs.'), noStore: true });
      setCount(body.count);
    } catch (cause) {
      setFailed(true);
      setMessage(cause instanceof Error ? cause.message : t('Couldn’t read the dead jobs.'));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function run() {
    setState('running');
    try {
      const body = await apiFetch<ReplayJobsResponse>('/admin/replay-jobs', {
        method: 'POST',
        body: { dead: true },
        fallbackError: t('Couldn’t replay the jobs.'),
        noStore: true,
      });
      setFailed(false);
      setMessage(t('Queued {jobs}.', { jobs: plural(body.queued, { one: '{count} job', other: '{count} jobs' }) }));
      await load();
    } catch (cause) {
      setFailed(true);
      setMessage(cause instanceof Error ? cause.message : t('Couldn’t replay the jobs.'));
    } finally {
      setState('idle');
    }
  }

  return (
    <div className={NOTICE}>
      <Note>
        {count === null ? '—' : plural(count, { one: '{count} dead job', other: '{count} dead jobs' })}
      </Note>
      <Button type="button" variant="secondary" onClick={() => void run()} disabled={state !== 'idle' || !count}>
        {state === 'running' && <Spinner aria-hidden />}
        {state === 'running' ? t('Queuing…') : t('Replay dead jobs')}
      </Button>
      {message && failed && <ErrorNotice message={message} />}
      {message && !failed && <Note role="status">{message}</Note>}
    </div>
  );
}

/**
 * What the Worker counted about itself in the last seven days:
 * refused signatures, Core's events gone quiet, a route answering 5xx, a
 * deploy check that could not run, and every other failure kind that mails
 * the alert address. A kind that was counted and has not been mailed says so.
 */
function OpsFailures() {
  const [data, setData] = useState<OpsFailuresResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    apiFetch<OpsFailuresResponse>('/admin/ops-failures', { fallbackError: t('Couldn’t read the failure counts.'), noStore: true })
      .then((body) => { if (live) setData(body); })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : t('Couldn’t read the failure counts.')); });
    return () => { live = false; };
  }, []);

  return (
    <SectionCard id="admin-failures" title={t('Failures')}>
      {error && <ErrorNotice message={error} />}
      {!data && !error && <PlaceholderRows count={2} />}
      {data && (
        <>
          <Note>
            {data.release
              ? t('Released: Starlings {version}, published {time}.', { version: data.release.version, time: formatRelative(data.release.published_at) })
              : t('The update feed couldn’t be read.')}
          </Note>
          <Note>
            {data.core_last_accepted_at === null
              ? t('No webhook call on record yet.')
              : t('Last webhook call accepted {time}.', { time: formatDate(data.core_last_accepted_at) })}
          </Note>
          {data.failures.length === 0 ? (
            <Note>{t('Nothing failed in the last seven days.')}</Note>
          ) : (
            <TableFrame>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Kind')}</TableHead>
                    <TableHead>{t('Today')}</TableHead>
                    <TableHead>{t('7 days')}</TableHead>
                    <TableHead>{t('Last')}</TableHead>
                    <TableHead>{t('Detail')}</TableHead>
                    <TableHead>{t('Mail')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.failures.map((row) => (
                    <TableRow key={row.kind}>
                      <TableCell>{row.kind}</TableCell>
                      <TableCell>{row.count_today}</TableCell>
                      <TableCell>{row.count_7d}</TableCell>
                      <TableCell>{formatDate(row.last_at)}</TableCell>
                      <TableCell>{row.last_detail ?? '—'}</TableCell>
                      <TableCell>{row.mailed ? t('Sent') : row.kind === 'deploy_check_skipped' || row.kind === 'testflight_check_skipped' ? t('Not mailed') : t('Due')}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableFrame>
          )}
        </>
      )}
    </SectionCard>
  );
}

/**
 * Meetings the owed-notes sweep gave up on. Retry resets the
 * attempts; the next five-minute sweep enqueues the job.
 */
function NotesOwed() {
  const [rows, setRows] = useState<NotesOwedRow[] | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  async function load() {
    try {
      const body = await apiFetch<NotesOwedResponse>('/admin/notes-owed', { fallbackError: t('Couldn’t read the meetings owed notes.'), noStore: true });
      setRows(body.stuck);
    } catch (cause) {
      setFailed(true);
      setMessage(cause instanceof Error ? cause.message : t('Couldn’t read the meetings owed notes.'));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function retry(row: NotesOwedRow) {
    setBusy(row.meeting_id);
    try {
      await apiFetch<NotesOwedRetryResponse>('/admin/notes-owed/retry', {
        method: 'POST',
        body: { room_slug: row.room_slug, meeting_id: row.meeting_id },
        fallbackError: t('Couldn’t retry the meeting.'),
        noStore: true,
      });
      setFailed(false);
      setMessage(t('Sent again within five minutes.'));
      await load();
    } catch (cause) {
      setFailed(true);
      setMessage(cause instanceof Error ? cause.message : t('Couldn’t retry the meeting.'));
    } finally {
      setBusy('');
    }
  }

  return (
    <div className={NOTICE}>
      {rows === null ? <Note>—</Note> : rows.length === 0 ? (
        <Note>{t('None.')}</Note>
      ) : (
        <ItemGroup className="gap-2 justify-self-stretch">
          {rows.map((row) => (
            <Item key={`${row.room_slug}/${row.meeting_id}`} role="listitem" variant="outline" size="sm" className={ROOM_ROW}>
              <a href={`/meetings/${row.room_slug}/${row.meeting_id}`}>{row.room_slug}</a>
              <span>{formatDate(row.owed_at)}</span>
              <Button type="button" variant="secondary" onClick={() => void retry(row)} disabled={busy !== ''}>
                {busy === row.meeting_id && <Spinner aria-hidden />}
                {busy === row.meeting_id ? t('Queuing…') : t('Retry')}
              </Button>
            </Item>
          ))}
        </ItemGroup>
      )}
      {message && failed && <ErrorNotice message={message} />}
      {message && !failed && <Note role="status">{message}</Note>}
    </div>
  );
}

/** The word for a subject channel's kind. */
function channelKindLabel(kind: ChannelSubjectKind): string {
  switch (kind) {
    case 'lead': return t('Lead');
    case 'project': return t('Project');
    case 'organization': return t('Partner');
    case 'event': return t('Event');
  }
}

/**
 * Channels whose subject Core no longer has. The Worker asks Core
 * for each subject by id, a bounded number per call; a channel Core could not
 * answer for is counted, never listed. Remove hides the channel for everyone
 * and keeps its messages; Restore brings it back.
 */
function ChannelsWithoutSubject() {
  const [orphans, setOrphans] = useState<OrphanChannel[] | null>(null);
  const [removed, setRemoved] = useState<RemovedChannel[]>([]);
  const [notChecked, setNotChecked] = useState(0);
  const [checkFailed, setCheckFailed] = useState(0);
  const [next, setNext] = useState(0);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  /** `from` 0 starts over; a later offset adds the next batch to what is listed. */
  async function load(from = 0) {
    setBusy(from === 0 ? 'load' : 'more');
    try {
      const body = await apiFetch<OrphanChannelsResponse>(`/admin/channels/orphans${from ? `?offset=${from}` : ''}`, {
        fallbackError: t('Couldn’t read the channels.'),
        noStore: true,
      });
      setOrphans((current) => from === 0 ? body.orphans : [...(current ?? []), ...body.orphans]);
      setRemoved(body.removed);
      setNotChecked(body.not_checked);
      setCheckFailed((current) => (from === 0 ? 0 : current) + body.check_failed);
      setNext(from + body.checked + body.check_failed);
      if (from === 0) { setFailed(false); setMessage(''); }
    } catch (cause) {
      setFailed(true);
      setMessage(cause instanceof Error ? cause.message : t('Couldn’t read the channels.'));
    } finally {
      setBusy('');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function act(threadId: string, path: 'remove' | 'restore') {
    setBusy(`${path}:${threadId}`);
    try {
      if (path === 'remove') {
        await apiFetch<ChannelRemoveResponse>('/admin/channels/remove', {
          method: 'POST', body: { thread_id: threadId }, fallbackError: t('Couldn’t remove the channel.'), noStore: true,
        });
      } else {
        await apiFetch<ChannelRestoreResponse>('/admin/channels/restore', {
          method: 'POST', body: { thread_id: threadId }, fallbackError: t('Couldn’t restore the channel.'), noStore: true,
        });
      }
      setFailed(false);
      setMessage('');
      await load();
    } catch (cause) {
      setFailed(true);
      setMessage(cause instanceof Error ? cause.message : path === 'remove' ? t('Couldn’t remove the channel.') : t('Couldn’t restore the channel.'));
      setBusy('');
    }
  }

  return (
    <div className={NOTICE}>
      {orphans === null ? <Note>—</Note> : orphans.length === 0 ? (
        <Note>{t('None.')}</Note>
      ) : (
        <ItemGroup className="gap-2 justify-self-stretch">
          {orphans.map((row) => (
            <Item key={row.thread_id} role="listitem" variant="outline" size="sm" className={ROOM_ROW}>
              <span className="grid gap-0.5">
                <strong>{row.title ?? '—'}</strong>
                <small className="text-[11px] text-foreground/60">
                  {[
                    channelKindLabel(row.kind),
                    t('Created {time}', { time: formatDate(row.created_at) }),
                    row.last_message_at === null ? t('No messages') : t('Last message {time}', { time: formatDate(row.last_message_at) }),
                    row.message_count === null ? null : plural(row.message_count, { one: '{count} message', other: '{count} messages' }),
                  ].filter(Boolean).join(' · ')}
                </small>
              </span>
              <Button type="button" variant="secondary" className={DANGER} onClick={() => void act(row.thread_id, 'remove')} disabled={busy !== ''}>
                {busy === `remove:${row.thread_id}` && <Spinner aria-hidden />}
                {busy === `remove:${row.thread_id}` ? t('Removing…') : t('Remove')}
              </Button>
            </Item>
          ))}
        </ItemGroup>
      )}
      {checkFailed > 0 && <Note>{plural(checkFailed, { one: '{count} channel couldn’t be checked.', other: '{count} channels couldn’t be checked.' })}</Note>}
      {notChecked > 0 && (
        <>
          <Note>{plural(notChecked, { one: '{count} channel not checked yet.', other: '{count} channels not checked yet.' })}</Note>
          <Button type="button" variant="secondary" onClick={() => void load(next)} disabled={busy !== ''}>
            {busy === 'more' && <Spinner aria-hidden />}
            {t('Check more')}
          </Button>
        </>
      )}
      {removed.length > 0 && (
        <ItemGroup className="gap-2 justify-self-stretch">
          {removed.map((row) => (
            <Item key={row.thread_id} role="listitem" variant="outline" size="sm" className={ROOM_ROW}>
              <span className="grid gap-0.5">
                <strong>{row.title ?? '—'}</strong>
                <small className="text-[11px] text-foreground/60">
                  {[
                    channelKindLabel(row.kind),
                    t('Removed {time}', { time: formatRelative(row.removed_at) }),
                    row.removed_by,
                  ].filter(Boolean).join(' · ')}
                </small>
              </span>
              <Button type="button" variant="secondary" onClick={() => void act(row.thread_id, 'restore')} disabled={busy !== ''}>
                {busy === `restore:${row.thread_id}` && <Spinner aria-hidden />}
                {busy === `restore:${row.thread_id}` ? t('Restoring…') : t('Restore')}
              </Button>
            </Item>
          ))}
        </ItemGroup>
      )}
      {message && failed && <ErrorNotice message={message} />}
    </div>
  );
}

/**
 * Facts Meet observed at agent boundaries; runtime work and provider costs are
 * not included. An admin can freeze an agent here: nothing reaches
 * it or comes from it from its next call, with no deploy.
 */
function AgentActivity({ isAdmin }: { isAdmin: boolean }) {
  const [activity, setActivity] = useState<AdminAgentActivityResponse | null>(null);
  const [error, setError] = useState('');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [busy, setBusy] = useState('');

  async function setFrozen(email: string, frozen: boolean) {
    setBusy(email);
    setError('');
    try {
      const body = await apiFetch<AdminAgentFreezeResponse>(`/admin/agents/${encodeURIComponent(email)}/${frozen ? 'freeze' : 'unfreeze'}`, {
        method: 'POST',
        body: {},
        fallbackError: frozen ? t('Couldn’t freeze the agent.') : t('Couldn’t unfreeze the agent.'),
        noStore: true,
      });
      setActivity((current) => current && {
        ...current,
        agents: current.agents.map((agent) => agent.agent_email === body.agent_email
          ? { ...agent, frozen_at: body.frozen_at, frozen_by_email: body.frozen_by_email }
          : agent),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : frozen ? t('Couldn’t freeze the agent.') : t('Couldn’t unfreeze the agent.'));
    } finally {
      setBusy('');
    }
  }

  async function remove(email: string, name: string) {
    if (!await confirmDataLoss({
      title: t('Remove {name} from Team?', { name }),
      body: t('Its keys stop working at once. Its conversations stay. To bring it back, the agent enrolls again. This can’t be undone.'),
      action: t('Remove'),
    })) return;
    setBusy(email);
    setError('');
    try {
      await apiFetch<AdminAgentRemoveResponse>(`/admin/agents/${encodeURIComponent(email)}/remove`, {
        method: 'POST',
        body: {},
        fallbackError: t('Couldn’t remove the agent.'),
        noStore: true,
      });
      setActivity((current) => current && { ...current, agents: current.agents.filter((agent) => agent.agent_email !== email) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t remove the agent.'));
    } finally {
      setBusy('');
    }
  }

  useEffect(() => subscribePeers({ onValue: (roster) => setPeers(roster.peers) }), []);

  const agentsByEmail = useMemo(
    () => new Map(peers.filter(isAgent).map((peer) => [peer.email.toLowerCase(), peer])),
    [peers],
  );

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    async function load() {
      try {
        const body = await apiFetch<AdminAgentActivityResponse>('/admin/agent-activity', {
          fallbackError: t('Couldn’t load agent activity.'),
          noStore: true,
        });
        if (!cancelled) {
          setActivity(body);
          setError('');
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t load agent activity.'));
      }
    }
    const start = () => {
      window.clearInterval(timer);
      if (document.visibilityState !== 'visible') return;
      void load();
      timer = window.setInterval(() => void load(), (document.hasFocus() ? 30 : 120) * 1_000);
    };
    start();
    document.addEventListener('visibilitychange', start);
    window.addEventListener('focus', start);
    window.addEventListener('blur', start);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', start);
      window.removeEventListener('focus', start);
      window.removeEventListener('blur', start);
    };
  }, []);

  const totals = activity?.totals;
  const deliveryIssues = (totals?.rejected ?? 0) + (totals?.delivery_failed ?? 0);
  return (
    <div className="grid gap-5">
      <SectionCard id="admin-agent-activity" title={t('Agent activity')}>
        {error && <ErrorNotice message={error} />}
        <div className={STATS}>
          <Tile label={t('Handoffs')} value={totals ? formatNumber(totals.handoffs) : '—'} />
          <Tile label={t('Accepted by runtime')} value={totals ? formatNumber(totals.accepted) : '—'} />
          <Tile label={t('Replies observed')} value={totals ? formatNumber(totals.replies) : '—'} />
          <Tile label={t('Delivery issues')} value={totals ? formatNumber(deliveryIssues) : '—'} />
        </div>
        <Note>
          {t('A frozen agent gets no messages, cannot read Starlings and cannot post, from its next call. Unfreeze it to let it back in.')}
        </Note>
        <Note>
          {t('This view records handoffs and finalized replies observed by Starlings. It does not show work inside an agent runtime or model costs.')}
          {activity && <> {' '}{t('Updated {time}.', { time: formatRelative(activity.generated_at) })}</>}
        </Note>
      </SectionCard>

      <SectionCard id="admin-agent-summary" title={t('By agent')}>
        {!activity ? <PlaceholderRows count={4} label={t('Loading agent activity…')} /> : activity.agents.length === 0 ? (
          <Note>{t('No agents are configured.')}</Note>
        ) : (
          <TableFrame>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Agent')}</TableHead>
                  <TableHead>{t('Handoffs')}</TableHead>
                  <TableHead>{t('Accepted by runtime')}</TableHead>
                  <TableHead>{t('Replies observed')}</TableHead>
                  <TableHead>{t('Delivery issues')}</TableHead>
                  <TableHead>{t('Watchdog resets')}</TableHead>
                  <TableHead>{t('Last activity')}</TableHead>
                  <TableHead>{t('State')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activity.agents.map((agent) => (
                  <TableRow key={agent.agent_email}>
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-3">
                        <IdentityAvatar
                          email={agent.agent_email}
                          name={agent.agent_name || agent.agent_email}
                          avatarUpdatedAt={agentsByEmail.get(agent.agent_email.toLowerCase())?.avatar_updated_at ?? null}
                          agentAvatar={agentsByEmail.get(agent.agent_email.toLowerCase())?.agent_avatar}
                        />
                        <div className="min-w-0">
                          <strong>{agent.agent_name || agent.agent_email}</strong>
                          {agent.agent_name && <div className="text-xs text-muted-foreground">{agent.agent_email}</div>}
                          <div className="break-all text-xs text-muted-foreground">
                            {t('Endpoint')}: {agent.endpoint_origin ?? t('None')}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{formatNumber(agent.handoffs)}</TableCell>
                    <TableCell>{formatNumber(agent.accepted)}</TableCell>
                    <TableCell>{formatNumber(agent.replies)}</TableCell>
                    <TableCell>{formatNumber(agent.rejected + agent.delivery_failed)}</TableCell>
                    <TableCell>{formatNumber(agent.watchdog_resets + agent.watchdog_reset_failures)}</TableCell>
                    <TableCell>{agent.last_activity_at == null ? '—' : formatRelative(agent.last_activity_at)}</TableCell>
                    <TableCell>
                      <div className="grid justify-items-start gap-1">
                        {agent.frozen_at != null && (
                          <span className="text-xs text-muted-foreground">
                            {t('Frozen {time} by {email}', { time: formatRelative(agent.frozen_at), email: agent.frozen_by_email ?? '—' })}
                          </span>
                        )}
                        {isAdmin ? (
                          <Button
                            type="button"
                            variant="secondary"
                            size="xs"
                            className={agent.frozen_at == null ? DANGER : undefined}
                            disabled={busy !== ''}
                            onClick={() => void setFrozen(agent.agent_email, agent.frozen_at == null)}
                          >
                            {agent.frozen_at == null ? t('Freeze') : t('Unfreeze')}
                          </Button>
                        ) : null}
                        {isAdmin && agent.source === 'enrolled' ? (
                          <Button
                            type="button"
                            variant="secondary"
                            size="xs"
                            className={DANGER}
                            disabled={busy !== ''}
                            onClick={() => void remove(agent.agent_email, agent.agent_name || agent.agent_email)}
                          >
                            {t('Remove')}
                          </Button>
                        ) : !isAdmin && agent.frozen_at == null && <span>{t('Running')}</span>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableFrame>
        )}
      </SectionCard>

      <SectionCard id="admin-agent-recent" title={t('Recent activity')}>
        {!activity ? <PlaceholderRows count={6} label={t('Loading agent activity…')} /> : activity.events.length === 0 ? (
          <Note>{t('No agent activity observed in the last 30 days.')}</Note>
        ) : (
          <>
            <TableFrame>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('When')}</TableHead>
                    <TableHead>{t('Agent')}</TableHead>
                    <TableHead>{t('Activity')}</TableHead>
                    <TableHead>{t('Delivery')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activity.events.map((event, index) => (
                    <TableRow key={`${event.agent_email}/${event.kind}/${event.occurred_at}/${index}`}>
                      <TableCell>{formatRelative(event.occurred_at)}</TableCell>
                      <TableCell>{event.agent_name || event.agent_email}</TableCell>
                      <TableCell>{agentActivityLabel(event.kind)}</TableCell>
                      <TableCell>
                        {event.duration_ms == null ? '—' : formatAgentLatency(event.duration_ms)}
                        {event.response_status == null ? '' : ` · ${t('HTTP {status}', { status: event.response_status })}`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableFrame>
            {activity.events_truncated && <Note>{t('Showing the latest 100 events. The totals include all events in this period.')}</Note>}
          </>
        )}
      </SectionCard>
    </div>
  );
}

function agentActivityLabel(kind: AdminAgentActivityResponse['events'][number]['kind']): string {
  switch (kind) {
    case 'handoff': return t('Handoff sent');
    case 'accepted': return t('Accepted by runtime');
    case 'rejected': return t('Rejected by runtime');
    case 'delivery_failed': return t('Couldn’t reach runtime');
    case 'reply': return t('Final reply observed');
    case 'watchdog_reset': return t('Watchdog reset accepted');
    case 'watchdog_reset_failed': return t('Watchdog reset not accepted');
  }
}

function formatAgentLatency(milliseconds: number): string {
  if (milliseconds < 1_000) return `${formatNumber(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

/**
 * Model calls and tokens per day, last 30 days. Anthropic counts
 * are the provider's; Workers AI tokens are an estimate. Admins only: the
 * route refuses a member.
 */
function ModelUsage() {
  const [rows, setRows] = useState<ModelUsageRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    apiFetch<ModelUsageResponse>('/admin/model-usage?days=30', { fallbackError: t('Couldn’t read the model usage.'), noStore: true })
      .then((body) => { if (!cancelled) setRows(body.rows); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t read the model usage.')); });
    return () => { cancelled = true; };
  }, []);

  return (
    <SectionCard id="admin-model-usage" title={t('Model usage')}>
      {error && <ErrorNotice message={error} />}
      {rows !== null && rows.length === 0 && <Note>{t('No model calls in the last 30 days.')}</Note>}
      {rows !== null && rows.length > 0 && (
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Day')}</TableHead>
                <TableHead>{t('Provider')}</TableHead>
                <TableHead>{t('Model')}</TableHead>
                <TableHead>{t('Purpose')}</TableHead>
                <TableHead>{t('Calls')}</TableHead>
                <TableHead>{t('Tokens')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.day}/${row.provider}/${row.model}/${row.purpose}`}>
                  <TableCell>{row.day}</TableCell>
                  <TableCell>{row.provider}</TableCell>
                  <TableCell>{row.model}</TableCell>
                  <TableCell>{row.purpose}</TableCell>
                  <TableCell>{formatNumber(row.calls)}</TableCell>
                  <TableCell>{formatNumber(row.input_tokens + row.output_tokens)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      )}
    </SectionCard>
  );
}

function MeetingsSource({ source }: { source: 'ledger' | 'rooms' }) {
  if (source === 'ledger') return null;
  return (
    <div className={NOTICE}>
      <Note>
        {t('Ledger empty. Showing live room data.')} <a href="/admin/jobs">{t('Fill the ledger')}</a>
      </Note>
    </div>
  );
}

/**
 * Jobs — the one-off actions, off Operations so Operations can stay a read
 * (docs/ADMIN.md §10). Each row says what it touches; the button runs it.
 * Admins only: a member sees the list and why it is closed.
 */
function AdminJobs({ overview }: { overview: Overview }) {
  const rows: Array<{ id: string; title: string; touches: string; control: ReactNode }> = [
    {
      id: 'job.backfill',
      title: t('Fill the ledger'),
      touches: overview.meetings_source === 'ledger'
        ? t('The ledger is filled; Operations reads from it.')
        : t('Reads every room in OWNER_ROOM_MAP into the meetings ledger. Idempotent.'),
      control: <FillLedger />,
    },
    {
      id: 'job.retitle-meetings',
      title: t('Retitle “Summary” meetings'),
      touches: t('Every finalized meeting titled after a section name gets a title from its summary; Docs and filed records follow. Idempotent.'),
      control: <RetitleMeetings />,
    },
    {
      id: 'job.discard-short-meetings',
      title: t('Discard meetings under five minutes'),
      touches: t('Meetings that ran under five minutes before the rule existed leave Admin and the ledger; a filed transcript is archived in Docs.'),
      control: <DiscardShortMeetings />,
    },
    {
      id: 'job.replay-dead-jobs',
      title: t('Replay dead jobs'),
      touches: t('Jobs that failed every retry on the queue. They stay here until replayed; each leaves the list once it is sent.'),
      control: <ReplayDeadJobs />,
    },
    {
      id: 'job.retry-notes-owed',
      title: t('Meetings owed notes'),
      touches: t('Meetings whose notes job was sent again three times and still has no summary. Retry sends the job again within five minutes.'),
      control: <NotesOwed />,
    },
    {
      id: 'job.remove-channel',
      title: t('Channels without a subject'),
      touches: t('Channels whose subject is gone. Remove hides one for everyone; its messages stay.'),
      control: <ChannelsWithoutSubject />,
    },
    {
      id: 'job.regenerate-fallback-notes',
      title: t('Rewrite fallback notes'),
      touches: t('Meetings in the last 30 days whose notes the small model wrote get new notes from Claude; Docs and filed records follow.'),
      control: <RegenerateFallbackNotes />,
    },
  ];
  return (
    <SectionCard id="admin-jobs" title={t('Jobs')}>
      {!overview.viewer.is_admin && <Note>{t('Jobs run as an admin; you can see them, not run them.')}</Note>}
      <TableFrame>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('Job')}</TableHead>
              <TableHead>{t('Touches')}</TableHead>
              <TableHead>{t('Last run')}</TableHead>
              <TableHead>{t('Run')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-semibold whitespace-nowrap">{row.title}</TableCell>
                <TableCell>{row.touches}</TableCell>
                <TableCell><LastRun run={overview.jobs?.[row.id]} /></TableCell>
                <TableCell>{overview.viewer.is_admin ? row.control : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableFrame>
    </SectionCard>
  );
}

/**
 * When this job last ran, and who ran it.
 *
 * Never is its own answer, not a zero: an idempotent job nobody has run yet
 * and one run last March are different situations, and the difference is the
 * whole reason to look at this column before pressing the button.
 */
function LastRun({ run }: { run?: AuditEntry }) {
  if (!run) return <span className="text-foreground/55">{t('Never')}</span>;
  return (
    <span title={formatMoment(run.ts)}>
      {formatRelative(run.ts)}
      <small className="block text-[11px] text-foreground/60">{run.actor_email}{run.detail ? ` · ${run.detail}` : ''}</small>
    </span>
  );
}

function FillLedger() {
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  async function backfill() {
    setState('running');
    try {
      const body = await apiFetch<{ rooms: number; meetings: number; degraded: string[] }>('/admin/backfill', {
        method: 'POST',
        fallbackError: t('Couldn’t fill the ledger.'),
        noStore: true,
      });
      setState('done');
      setFailed(false);
      setMessage(t('Read {meetings} from {rooms}.', {
        meetings: plural(body.meetings, { one: '{count} meeting', other: '{count} meetings' }),
        rooms: plural(body.rooms, { one: '{count} room', other: '{count} rooms' }),
      }));
    } catch (cause) {
      setState('idle');
      setFailed(true);
      setMessage(cause instanceof Error ? cause.message : t('Couldn’t fill the ledger.'));
    }
  }

  return (
    <div className={NOTICE}>
      <Button type="button" variant="secondary" onClick={() => void backfill()} disabled={state !== 'idle'}>
        {state === 'running' ? 'Filling…' : state === 'done' ? 'Filled' : 'Fill the ledger'}
      </Button>
      {message && failed && <ErrorNotice message={message} />}
      {message && !failed && <Note role="status">{message}</Note>}
    </div>
  );
}

/**
 * What changed here, and who changed it.
 *
 * Every control on this page is org-wide: hiding a colleague or granting admin.
 * Before this list, the
 * only way to find out who had done any of that was `wrangler tail`, and only
 * if you were watching at the time.
 */
function AdminTrail({ entries }: { entries: AuditEntry[] }) {
  return (
    <SectionCard id="admin-trail" title={t('Changes')}>
      {entries.length === 0 ? (
        <Note>{t('Nothing has been changed yet.')}</Note>
      ) : (
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('When')}</TableHead>
                <TableHead>{t('Who')}</TableHead>
                <TableHead>{t('Change')}</TableHead>
                <TableHead>{t('Subject')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={`${entry.ts}-${entry.action}-${entry.subject ?? ''}`}>
                  <TableCell>{formatRelative(entry.ts)}</TableCell>
                  <TableCell>{entry.actor_email}</TableCell>
                  <TableCell>{describeAction(entry)}</TableCell>
                  <TableCell>{entry.subject ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      )}
    </SectionCard>
  );
}

/**
 * The record of what paired Claudes did (docs/MCP.md §The record). The
 * argument column is the tool's input, never its output; a refused call
 * prints its reason in place of the duration.
 */
function McpTrail({ entries }: { entries: McpCallEntry[] }) {
  return (
    <SectionCard id="admin-mcp-trail" title={t('Connector calls')}>
      {entries.length === 0 ? (
        <Note>{t('No connector has called yet.')}</Note>
      ) : (
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('When')}</TableHead>
                <TableHead>{t('Who')}</TableHead>
                <TableHead>{t('Client')}</TableHead>
                <TableHead>{t('Call')}</TableHead>
                <TableHead>{t('Arguments')}</TableHead>
                <TableHead>{t('Outcome')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{formatRelative(entry.ts)}</TableCell>
                  <TableCell>{entry.actor_email}</TableCell>
                  <TableCell>{entry.client_name ?? '—'}</TableCell>
                  <TableCell><code>{entry.name}</code></TableCell>
                  <TableCell>{entry.args ?? '—'}</TableCell>
                  <TableCell>
                    {entry.outcome === 'ok' ? `${entry.duration_ms} ms` : `${entry.outcome}${entry.detail ? ` · ${entry.detail}` : ''}`}
                    {entry.replayed ? ` · ${t('Replayed')}` : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      )}
    </SectionCard>
  );
}

/** Prose for the trail. An unknown action still prints, rather than vanishing. */
function describeAction(entry: AuditEntry): string {
  switch (entry.action) {
    case 'person.hide': return 'Hidden from the roster';
    case 'person.show': return 'Shown on the roster';
    case 'person.role': return entry.detail === 'admin' ? 'Made an admin' : 'Made a member';
    case 'person.revoke': return `Access revoked${entry.detail ? ` — ${entry.detail}` : ''}`;
    case 'person.restore': return 'Access restored';
    case 'invitation.send': return `Invited${entry.detail ? ` as ${entry.detail}` : ''}`;
    case 'invitation.resend': return 'Invitation sent again';
    case 'invitation.revoke': return 'Invitation revoked';
    // The jobs write the same trail as every other admin action, so Changes
    // reads as one history rather than two (docs/ADMIN.md §10).
    case 'job.backfill': return `Filled the ledger${entry.detail ? ` — ${entry.detail}` : ''}`;
    case 'job.retitle-meetings': return `Retitled meetings${entry.detail ? ` — ${entry.detail}` : ''}`;
    case 'job.regenerate-fallback-notes': return `Rewrote fallback notes${entry.detail ? ` — ${entry.detail}` : ''}`;
    case 'job.remove-channel': return `Removed a channel${entry.detail ? ` — ${entry.detail}` : ''}`;
    case 'job.restore-channel': return `Restored a channel${entry.detail ? ` — ${entry.detail}` : ''}`;
    case 'job.discard-short-meetings': return `Discarded short meetings${entry.detail ? ` — ${entry.detail}` : ''}`;
    // Connector writes (Granola, Slack, GitHub): each changes what the whole
    // company sees, so each is on the trail.
    case 'granola.backfill': return `Started the Granola backfill${entry.detail ? ` — ${entry.detail}` : ''}`;
    case 'granola.import': return `Imported Granola notes${entry.detail ? ` — ${entry.detail}` : ''}`;
    case 'granola.file': return `Filed a Granola note${entry.detail ? ` — ${entry.detail}` : ''}`;
    case 'slack.map': return `Mapped a Slack channel${entry.detail ? ` — ${entry.detail}` : ''}`;
    case 'slack.reverse': return `Removed a Slack channel's import${entry.detail ? ` — ${entry.detail}` : ''}`;
    case 'github.map': return `Mapped a GitHub repository${entry.detail ? ` — ${entry.detail}` : ''}`;
    case 'github.reverse': return `Removed a GitHub repository's import${entry.detail ? ` — ${entry.detail}` : ''}`;
    default: return entry.detail ? `${entry.action} — ${entry.detail}` : entry.action;
  }
}

/** One figure under its label, a Card of its own. `Tile` for Now, `Stat` for the rest. */
function Stat({ label, value, delta }: { label: string; value: string; delta?: string }) {
  return (
    <Card className="gap-0 bg-popover px-4.5 py-4 shadow-none">
      <span className={LABEL}>{label}</span>
      <strong className={`mt-2 block text-[28px] sm:text-[32px] ${FIGURE}`}>{value}</strong>
      {delta && <small className="mt-1.5 block text-xs text-muted-foreground">{delta}</small>}
    </Card>
  );
}

const Tile = Stat;

function Breakdown({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return (
    <p className="m-0 flex flex-wrap gap-x-3.5 gap-y-2 text-[13px] text-foreground/80">
      <span className="text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">{title}</span>
      {entries.map(([key, value]) => (
        <span key={key} className="inline-flex items-center gap-1.5">
          <CountryFlag country={title === 'Country' ? key : null} />
          <span>{value}</span>
        </span>
      ))}
    </p>
  );
}

function Sparkline({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1, ...values);
  const points = values.map((value, index) => {
    const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 100;
    const y = 28 - (value / max) * 26;
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg className="h-16 w-full text-[var(--accent)]" viewBox="0 0 100 30" role="img" aria-label={label}>
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={points} />
    </svg>
  );
}

function barWidth(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

function formatNumber(value: number): string {
  return value >= 100 ? String(Math.round(value)) : String(value);
}

function formatGigabytes(bytes: number): string {
  return new Intl.NumberFormat(uiLocale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(bytes / 1_000_000_000);
}

function formatDate(ms: number): string {
  const date = new Date(ms);
  return `${date.toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })} ${formatTime(date)}`;
}

/**
 * The exact moment behind a relative label, for a tooltip. `formatDate` is
 * the same spelling without the year; a job's last run can be months back,
 * and the year is the whole point of reading the tooltip. The clock goes
 * through `formatTime`, which is 24-hour whatever the browser's locale says.
 */
function formatMoment(ms: number): string {
  const date = new Date(ms);
  const day = date.toLocaleDateString(dateLocale, { year: 'numeric', month: 'short', day: 'numeric' });
  return `${day} ${formatTime(date)}`;
}

function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return t('{minutes}m ago', { minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('{hours}h ago', { hours });
  const days = Math.round(hours / 24);
  return t('{days}d ago', { days });
}

function monthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

function delta(current: number, prior: number): string {
  if (prior === 0 && current === 0) return 'no prior month';
  const change = current - prior;
  if (change === 0) return 'same as last month';
  return `${change > 0 ? '+' : ''}${change} vs last month`;
}

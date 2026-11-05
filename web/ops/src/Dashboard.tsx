// The product dashboard on the ops host (docs/OPS_CONSOLE.md
// §Dashboard): the whole of Starlings at a glance, then each workspace and
// its records. Built from the web app's shadcn parts.
import { WORKSPACE_HOST_SUFFIX } from '@starlings/contracts/workspace-slug';
import { Fragment, useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import {
  Activity, AlertTriangle, Bot, CalendarCheck, Check, CircleDollarSign, LogIn, Minus, MonitorSmartphone, RefreshCw, Users, Video,
} from 'lucide-react';
import { OPS_PAGES, type OpsFleet, type OpsTally } from '@starlings/contracts/ops';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/ui/card';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/ui/chart';
import { Skeleton } from '@/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';
import { cn } from '@/lib/utils';
import {
  activationOf, countOf, DAILY_METRICS, dailySeries, HISTORY_METRICS, historySeries, FEATURES, fleetTotals, formatDay, formatNumber, formatUSD, formatUTC, liveWorkspaces,
  loadFleet, mergeTallies, mix, moduleAdoption, percent, recordLabels, serviceLabels, serviceOf, scopeFleet, serviceTotals, SERVICE_KINDS, utcMonth, type DailyMetric, type FleetLoad, type LiveWorkspace,
} from './fleet';
import { inAppClick, useLocation, type Route } from './router';

/** The console reads every workspace on each load; five minutes keeps the page current without asking all the time. */
const REFRESH_MS = 5 * 60_000;
const SERIES_COLORS = ['var(--ui-chart-1)', 'var(--ui-chart-2)', 'var(--ui-chart-3)', 'var(--ui-chart-4)', 'var(--ui-chart-5)'];
const CLIENT_LABELS: Record<string, string> = { web: 'Web', mac: 'Mac', ios: 'iOS', macos: 'macOS', watchos: 'watchOS', unknown: 'Unknown' };

/** The nav entry a route belongs to; a workspace's own page sits under Workspaces. */
function activeHref(route: Route): string | null {
  switch (route.page) {
    case 'overview': return '/';
    case 'workspaces': case 'workspace': return '/workspaces';
    case 'records': return '/records';
    default: return null;
  }
}

function pageTitle(route: Route): string {
  switch (route.page) {
    case 'overview': return 'Overview';
    case 'workspaces': return 'Workspaces';
    case 'workspace': return route.slug;
    case 'records': return 'Records';
    default: return 'Not found';
  }
}

export function Dashboard() {
  const [load, setLoad] = useState<FleetLoad>({ state: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const { location, route, navigate, setParam } = useLocation();

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      const fleet = await loadFleet(signal);
      setLoad({ state: 'ready', fleet });
    } catch (error) {
      if (signal?.aborted) return;
      setLoad((current) => current.state === 'ready'
        ? current
        : { state: 'error', message: error instanceof Error ? error.message : 'The console did not answer.' });
    } finally {
      if (!signal?.aborted) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, REFRESH_MS);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    document.title = `${pageTitle(route)} · Starlings ops`;
  }, [route]);

  const fleet = load.state === 'ready' ? load.fleet : null;
  const active = activeHref(route);
  const link = (event: MouseEvent<HTMLAnchorElement>) => inAppClick(event, navigate);
  const metricParam = new URLSearchParams(location.search).get('metric');
  const metric = DAILY_METRICS.some((entry) => entry.key === metricParam) ? metricParam as DailyMetric : 'signins';
  const setMetric = (value: DailyMetric) => setParam('metric', value === 'signins' ? null : value);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 md:px-6">
      <header className="flex flex-col gap-4 border-b pb-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <a href="/" onClick={link} className="text-lg font-semibold tracking-tight">Starlings ops</a>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {fleet ? `Checked ${formatUTC(fleet.checked_at)}` : 'Reading every workspace'}
            </span>
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
              <RefreshCw className={cn(refreshing && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>
        <nav className="-mx-1 flex flex-wrap items-center gap-1" aria-label="Pages">
          {OPS_PAGES.map((entry) => (
            <Button key={entry.href} asChild variant={entry.href === active ? 'secondary' : 'ghost'} size="sm">
              <a href={entry.href} onClick={entry.dashboard ? link : undefined} aria-current={entry.href === active ? 'page' : undefined}>
                {entry.label}
                {entry.href === '/requests' && fleet?.pending_requests ? <Badge className="ml-1">{fleet.pending_requests}</Badge> : null}
              </a>
            </Button>
          ))}
        </nav>
      </header>

      {load.state === 'error' && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{load.message}</AlertTitle>
          <AlertDescription>Reload the page to sign in again.</AlertDescription>
        </Alert>
      )}
      {load.state === 'loading' && <Loading />}
      {fleet && <Page fleet={fleet} route={route} link={link} metric={metric} setMetric={setMetric} />}
    </div>
  );
}

function Loading() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-36 rounded-xl" />)}
      <Skeleton className="h-80 rounded-xl sm:col-span-2 lg:col-span-4" />
    </div>
  );
}

type LinkHandler = (event: MouseEvent<HTMLAnchorElement>) => void;

function Page({ fleet, route, link, metric, setMetric }: {
  fleet: OpsFleet;
  route: Route;
  link: LinkHandler;
  metric: DailyMetric;
  setMetric: (value: DailyMetric) => void;
}) {
  const slug = route.page === 'workspace' ? route.slug : null;
  const scoped = useMemo(() => scopeFleet(fleet, slug), [fleet, slug]);
  const live = useMemo(() => liveWorkspaces(scoped), [scoped]);

  if (route.page === 'not-found' || (slug !== null && scoped.workspaces.length === 0)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{slug ? `No workspace ${slug}` : 'Not found'}</CardTitle>
          <CardDescription><a href="/" onClick={link} className="underline underline-offset-4">Overview</a></CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const heading = route.page === 'workspace'
    ? { title: live[0]?.metadata.name ?? route.slug, description: `${route.slug}.${WORKSPACE_HOST_SUFFIX}` }
    : route.page === 'overview'
      ? { title: 'Overview', description: `All ${fleet.workspaces.length} workspaces added up` }
      : route.page === 'workspaces'
        ? { title: 'Workspaces', description: `${fleet.workspaces.length} bound to the console` }
        : { title: 'Records', description: 'Rows in each workspace’s D1, Docs and Keep' };

  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{heading.title}</h1>
        <p className="text-sm text-muted-foreground">{heading.description}</p>
      </div>
      {(route.page === 'overview' || route.page === 'workspace') && <ScopeSwitcher fleet={fleet} slug={slug} link={link} />}
      <FleetAlerts fleet={scoped} />
      {(route.page === 'overview' || route.page === 'workspace') && (
        <Overview fleet={scoped} live={live} metric={metric} setMetric={setMetric} link={link} />
      )}
      {route.page === 'workspace' && <RecordsCard fleet={scoped} live={live} />}
      {route.page === 'workspaces' && (
        <>
          <WorkspacesTable fleet={fleet} live={live} link={link} />
          <FeaturesCard live={live} />
        </>
      )}
      {route.page === 'records' && <RecordsCard fleet={fleet} live={live} />}
    </>
  );
}

/** All workspaces, or one: each a link, so the scope is in the URL. */
function ScopeSwitcher({ fleet, slug, link }: { fleet: OpsFleet; slug: string | null; link: LinkHandler }) {
  const entries = [{ href: '/', label: 'All workspaces', on: slug === null }, ...fleet.workspaces.map((row) => ({
    href: `/workspaces/${row.slug}`,
    label: row.ok ? row.metadata.name : row.slug,
    on: row.slug === slug,
  }))];
  return (
    <div className="flex flex-wrap gap-2" role="navigation" aria-label="Workspace">
      {entries.map((entry) => (
        <Button key={entry.href} asChild variant={entry.on ? 'default' : 'outline'} size="sm">
          <a href={entry.href} onClick={link} aria-current={entry.on ? 'page' : undefined}>{entry.label}</a>
        </Button>
      ))}
    </div>
  );
}

function FleetAlerts({ fleet }: { fleet: OpsFleet }) {
  const failing = fleet.workspaces.filter((row) => !row.ok);
  const totals = fleetTotals(fleet);
  return (
    <>
      {failing.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{failing.length === 1 ? '1 workspace did not answer' : `${failing.length} workspaces did not answer`}</AlertTitle>
          <AlertDescription>
            {failing.map((row) => <span key={row.slug}>{row.slug}: {row.ok ? '' : row.error}</span>)}
          </AlertDescription>
        </Alert>
      )}
      {totals.withoutProduct > 0 && (
        <Alert>
          <Activity />
          <AlertTitle>
            {totals.withoutProduct === 1 ? '1 workspace runs a build without usage data' : `${totals.withoutProduct} workspaces run a build without usage data`}
          </AlertTitle>
          <AlertDescription>Its numbers show n/a until it runs a release with usage data.</AlertDescription>
        </Alert>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Overview

function Overview({ fleet, live, metric, setMetric, link }: {
  fleet: OpsFleet;
  live: LiveWorkspace[];
  metric: DailyMetric;
  setMetric: (value: DailyMetric) => void;
  link: LinkHandler;
}) {
  const t = fleetTotals(fleet);
  const products = live.flatMap((workspace) => workspace.product ? [workspace.product] : []);
  const health = t.errors7d + t.failures7d + t.deadJobs;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Users />}
          title="Members"
          value={formatNumber(t.members)}
          badge={t.joined30d > 0 ? `+${formatNumber(t.joined30d)} in 30 days` : null}
          footer={`${formatNumber(t.agents)} agents in ${formatNumber(t.answering)} of ${formatNumber(t.workspaces)} workspaces`}
        />
        <StatCard
          icon={<Activity />}
          title="Active, 30 days"
          value={formatNumber(t.active.month)}
          badge={`${percent(t.active.month, t.members)} of members`}
          footer={`${formatNumber(t.active.day)} today, ${formatNumber(t.active.week)} in 7 days. Daily over monthly: ${percent(t.active.day, t.active.month)}`}
        />
        <StatCard
          icon={<LogIn />}
          title="Sign-ins, 7 days"
          value={formatNumber(t.signins.week)}
          footer={`${formatNumber(t.signins.day)} today, ${formatNumber(t.signins.month)} in 30 days`}
        />
        <StatCard
          icon={<MonitorSmartphone />}
          title="Devices, 30 days"
          value={formatNumber(t.devices.active)}
          badge={t.devices.outdated > 0 ? `${formatNumber(t.devices.outdated)} outdated` : null}
          tone={t.devices.outdated > 0 ? 'warn' : 'default'}
          footer={`${formatNumber(t.devices.total)} native devices signed in`}
        />
        <StatCard
          icon={<Video />}
          title="Meetings, 30 days"
          value={formatNumber(t.meetings30d)}
          footer={`${formatNumber(t.guests30d)} guests let in, ${formatNumber(t.calendar)} members with a calendar`}
        />
        <StatCard
          icon={<Bot />}
          title="Agent connections"
          value={formatNumber(t.mcp.active)}
          badge={`${formatNumber(t.mcp.grants)} granted`}
          footer={`${formatNumber(t.mcp.calls7d)} MCP calls in 7 days`}
        />
        <StatCard
          icon={<CircleDollarSign />}
          title="Cost this month"
          value={formatUSD(t.costThisMonth)}
          footer={fleet.shared_usd > 0 ? `To date, with ${formatUSD(fleet.shared_usd)} of shared plans` : 'To date, before shared plans'}
        />
        <StatCard
          icon={<AlertTriangle />}
          title="Errors, 7 days"
          value={formatNumber(t.errors7d)}
          tone={health > 0 ? 'warn' : 'ok'}
          badge={t.degraded > 0 ? `${t.degraded} D1 not answering` : null}
          footer={`${formatNumber(t.failures7d)} job failures, ${formatNumber(t.deadJobs)} dead jobs`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <GrowthChart live={live} />
        <ActivationCard live={live} now={fleet.checked_at} link={link} />
      </div>

      <ActivityChart live={live} metric={metric} setMetric={setMetric} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Clients</CardTitle>
            <CardDescription>Members seen on each client, 30 days</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <BarList items={mergeTallies(products.map((product) => product.active_clients))} />
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">Sign-ins by client</h3>
              <BarList items={mergeTallies(products.map((product) => product.signin_clients))} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Devices</CardTitle>
            <CardDescription>Native devices active in 30 days</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <BarList items={mergeTallies(products.map((product) => product.device_platforms))} />
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">App versions</h3>
              <BarList items={mergeTallies(products.map((product) => product.app_versions)).slice(0, 8)} raw />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Work modules</CardTitle>
            <CardDescription>Workspaces with each module on</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-3">
              {moduleAdoption(live).map((module) => (
                <li key={module.key} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span>{module.label}</span>
                    <span className="text-muted-foreground tabular-nums">{module.on.length} of {live.length}</span>
                  </div>
                  <Meter value={module.on.length} max={live.length} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {SERVICE_KINDS.map(({ kind, label }) => {
          const totals = serviceTotals(fleet, kind);
          return (
            <Card key={kind}>
              <CardHeader>
                <CardTitle>{label}</CardTitle>
                <CardDescription>
                  In {totals.workspaces} of {fleet.workspaces.length} workspaces
                  {totals.answering < totals.workspaces ? `, ${totals.workspaces - totals.answering} not answering` : ''}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {totals.counts.length === 0
                  ? <p className="text-sm text-muted-foreground">No data</p>
                  : (
                    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
                      {totals.counts.map((count) => (
                        <div key={count.key} className="contents">
                          <dt className="text-muted-foreground">{count.key}</dt>
                          <dd className="text-right tabular-nums">{formatNumber(count.value)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Plans and setup</CardTitle>
          <CardDescription>How the workspaces are set up</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 sm:grid-cols-3">
          <MixList title="Plan" items={mix(products.map((product) => product.plan))} />
          <MixList title="Suite" items={mix(products.map((product) => product.suite))} />
          <MixList title="Store" items={mix(live.map((workspace) => workspace.metadata.work_store))} />
        </CardContent>
      </Card>
    </>
  );
}

function StatCard({ icon, title, value, badge = null, footer, tone = 'default' }: {
  icon: ReactNode;
  title: string;
  value: string;
  badge?: string | null;
  footer: string;
  tone?: 'default' | 'ok' | 'warn';
}) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardDescription className="flex items-center gap-2 [&_svg]:size-4">{icon}{title}</CardDescription>
        <CardTitle className={cn('text-3xl font-semibold tabular-nums', tone === 'warn' && 'text-warn', tone === 'ok' && 'text-ok')}>
          {value}
        </CardTitle>
        {badge && (
          <CardAction>
            <Badge variant="outline" className={cn(tone === 'warn' && 'border-warn/50 text-warn')}>{badge}</Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardFooter className="text-sm text-muted-foreground">{footer}</CardFooter>
    </Card>
  );
}

function ActivityChart({ live, metric, setMetric }: { live: LiveWorkspace[]; metric: DailyMetric; setMetric: (value: DailyMetric) => void }) {
  const data = useMemo(() => dailySeries(live, metric), [live, metric]);
  const series = live.filter((workspace) => workspace.product);
  const config = Object.fromEntries(series.map((workspace, index) => [
    workspace.slug,
    { label: workspace.metadata.name, color: SERIES_COLORS[index % SERIES_COLORS.length] },
  ])) satisfies ChartConfig;
  const total = data.reduce((sum, row) => sum + series.reduce((inner, workspace) => inner + Number(row[workspace.slug] ?? 0), 0), 0);
  const label = DAILY_METRICS.find((entry) => entry.key === metric)?.label ?? '';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>{formatNumber(total)} {label.toLowerCase()} in 30 days, by workspace</CardDescription>
        <CardAction>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={metric}
            onValueChange={(value) => { if (value) setMetric(value as DailyMetric); }}
          >
            {DAILY_METRICS.map((entry) => (
              <ToggleGroupItem key={entry.key} value={entry.key} className="px-3">{entry.label}</ToggleGroupItem>
            ))}
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="aspect-auto h-72 w-full">
          <BarChart data={data} margin={{ left: 0, right: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={(day: string) => formatDay(day)} />
            <YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent labelFormatter={(_, payload) => formatDay(String(payload[0]?.payload?.day ?? ''))} />}
            />
            <ChartLegend content={<ChartLegendContent />} />
            {series.map((workspace, index) => (
              <Bar
                key={workspace.slug}
                dataKey={workspace.slug}
                stackId="fleet"
                fill={`var(--color-${workspace.slug})`}
                radius={index === series.length - 1 ? [4, 4, 0, 0] : 0}
              />
            ))}
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

const HISTORY_CONFIG = {
  members: { label: 'Members', color: 'var(--ui-chart-3)' },
  active_month: { label: 'Active, 30 days', color: 'var(--ui-chart-1)' },
  active_week: { label: 'Active, 7 days', color: 'var(--ui-chart-2)' },
  active_day: { label: 'Active that day', color: 'var(--ui-chart-4)' },
} satisfies ChartConfig;

/** Members and active members per day, from each workspace's `ops_daily`. */
function GrowthChart({ live }: { live: LiveWorkspace[] }) {
  const data = useMemo(() => historySeries(live), [live]);
  const first = data[0]?.day;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Growth</CardTitle>
        <CardDescription>
          {first ? `Members and active members per day since ${formatDay(String(first))}` : 'Members and active members per day'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.length < 2 ? (
          <p className="text-sm text-muted-foreground">
            History starts with this release. Each workspace writes one row a day, so the line appears from the second day.
          </p>
        ) : (
          <ChartContainer config={HISTORY_CONFIG} className="aspect-auto h-64 w-full">
            <LineChart data={data} margin={{ left: 0, right: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={(day: string) => formatDay(day)} />
              <YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, payload) => formatDay(String(payload[0]?.payload?.day ?? ''))} />} />
              <ChartLegend content={<ChartLegendContent />} />
              {HISTORY_METRICS.map(({ key }) => (
                <Line key={key} dataKey={key} type="monotone" stroke={`var(--color-${key})`} strokeWidth={2} dot={false} />
              ))}
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

/** Time to value: each workspace's milestones, or one workspace's timeline. */
function ActivationCard({ live, now, link }: { live: LiveWorkspace[]; now: number; link: LinkHandler }) {
  const rows = live.flatMap((workspace) => {
    const activation = activationOf(workspace, now);
    return activation ? [{ workspace, activation }] : [];
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activation</CardTitle>
        <CardDescription>Days from the first sign-in to each first. Alive at day 14: three members active in week two.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 && <p className="text-sm text-muted-foreground">No data</p>}
        {rows.length === 1 && <MilestoneTimeline activation={rows[0]!.activation} />}
        {rows.length > 1 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead className="text-right">Age</TableHead>
                <TableHead className="text-right">Reached</TableHead>
                <TableHead>Next</TableHead>
                <TableHead>Day 14</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ workspace, activation }) => (
                <TableRow key={workspace.slug}>
                  <TableCell>
                    <a href={`/workspaces/${workspace.slug}`} onClick={link} className="font-medium hover:underline">{workspace.metadata.name}</a>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{activation.ageDays === null ? 'n/a' : `${formatNumber(activation.ageDays)} d`}</TableCell>
                  <TableCell className="text-right tabular-nums">{activation.reached} of {activation.total}</TableCell>
                  <TableCell className="text-muted-foreground">{activation.next?.label ?? 'All reached'}</TableCell>
                  <TableCell><AliveBadge alive={activation.aliveDay14} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function AliveBadge({ alive }: { alive: boolean | null }) {
  if (alive === null) return <span className="text-sm text-muted-foreground">n/a</span>;
  return alive
    ? <Badge variant="outline" className="border-ok/50 text-ok">Alive</Badge>
    : <Badge variant="outline" className="border-warn/50 text-warn">Not alive</Badge>;
}

function MilestoneTimeline({ activation }: { activation: NonNullable<ReturnType<typeof activationOf>> }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>{activation.reached} of {activation.total} reached{activation.ageDays === null ? '' : `, ${formatNumber(activation.ageDays)} days old`}</span>
        <span className="flex items-center gap-2">Day 14 <AliveBadge alive={activation.aliveDay14} /></span>
      </div>
      <ol className="flex flex-col gap-2">
        {activation.milestones.map((entry) => (
          <li key={entry.key} className="flex items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2">
              {entry.at !== null
                ? <Check aria-label="Reached" className="size-4 text-ok" />
                : <Minus aria-label="Not reached" className="size-4 text-muted-foreground" />}
              {entry.label}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {entry.unknown ? 'In Core' : entry.at === null ? 'Not yet' : `Day ${formatNumber(entry.day ?? 0)}, ${formatUTC(entry.at).slice(0, 10)}`}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Rows of a label, a bar and a count, the bar relative to the largest. */
function BarList({ items, raw = false }: { items: OpsTally[]; raw?: boolean }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">Nothing in 30 days.</p>;
  const max = Math.max(...items.map((item) => item.value));
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.key} className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className={cn(raw && 'font-mono text-xs')}>{raw ? item.key : CLIENT_LABELS[item.key] ?? item.key}</span>
            <span className="text-muted-foreground tabular-nums">{formatNumber(item.value)}</span>
          </div>
          <Meter value={item.value} max={max} />
        </li>
      ))}
    </ul>
  );
}

function Meter({ value, max }: { value: number; max: number }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-chart-2" style={{ width: max > 0 ? `${(value / max) * 100}%` : '0%' }} />
    </div>
  );
}

function MixList({ title, items }: { title: string; items: OpsTally[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="flex flex-wrap gap-2">
        {items.length === 0
          ? <span className="text-sm text-muted-foreground">No data</span>
          : items.map((item) => <Badge key={item.key} variant="secondary" className="capitalize">{item.key} {item.value}</Badge>)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspaces

function WorkspacesTable({ fleet, live, link }: { fleet: OpsFleet; live: LiveWorkspace[]; link: LinkHandler }) {
  const month = utcMonth(fleet.checked_at);
  const costOf = (slug: string) => fleet.costs.find((cost) => cost.slug === slug && cost.month === month)?.usd ?? null;
  const bySlug = new Map(live.map((workspace) => [workspace.slug, workspace]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspaces</CardTitle>
        <CardDescription>{fleet.workspaces.length} bound to the console</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workspace</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead className="text-right">Members</TableHead>
              <TableHead className="text-right">Active 7d</TableHead>
              <TableHead className="text-right">Active 30d</TableHead>
              <TableHead className="text-right">Sign-ins 7d</TableHead>
              <TableHead className="text-right">Devices</TableHead>
              <TableHead className="text-right">Agents</TableHead>
              <TableHead className="text-right">Meetings 30d</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead>Release</TableHead>
              <TableHead>Health</TableHead>
              <TableHead>Last activity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fleet.workspaces.map((row) => {
              const workspace = bySlug.get(row.slug);
              if (!row.ok || !workspace) {
                return (
                  <TableRow key={row.slug}>
                    <TableCell><WorkspaceName slug={row.slug} host={row.host} link={link} /></TableCell>
                    <TableCell colSpan={12} className="text-destructive">No answer: {row.ok ? '' : row.error}</TableCell>
                  </TableRow>
                );
              }
              const { metadata: m, product: p } = workspace;
              const cost = costOf(row.slug);
              return (
                <TableRow key={row.slug}>
                  <TableCell><WorkspaceName slug={row.slug} host={row.host} name={m.name} store={m.work_store} link={link} /></TableCell>
                  <TableCell className="capitalize">{p?.plan ?? 'n/a'}</TableCell>
                  <Num value={m.members} />
                  <Num value={p?.active.week} />
                  <Num value={p?.active.month} />
                  <Num value={p?.signins.week} />
                  <Num value={p?.devices.active_30d} />
                  <Num value={m.agents} />
                  <Num value={countOf(m, 'Meetings, 30 days')} />
                  <TableCell className="text-right tabular-nums">{cost === null ? 'n/a' : formatUSD(cost)}</TableCell>
                  <TableCell>
                    <code className="text-xs" title={m.build}>{m.build === 'unknown' ? 'unknown' : m.build.slice(0, 7)}</code>
                    <div className="max-w-48 truncate font-mono text-xs text-muted-foreground" title={m.migration ?? ''}>{m.migration ?? 'None'}</div>
                  </TableCell>
                  <TableCell>
                    {m.migration === null
                      ? <Badge variant="destructive">D1 not answering</Badge>
                      : <Badge variant="outline" className="border-ok/50 text-ok">OK</Badge>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatUTC(m.last_activity_at)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** The workspace's page here, and its own host beside it. */
function WorkspaceName({ slug, host, name, store, link }: { slug: string; host: string; name?: string; store?: string; link: LinkHandler }) {
  return (
    <div className="flex flex-col">
      <a href={`/workspaces/${slug}`} onClick={link} className="font-medium hover:underline">{name ?? slug}</a>
      <span className="text-xs text-muted-foreground">
        <a href={`https://${host}/`} className="hover:underline">{host}</a>{store ? `, ${store}` : ''}
      </span>
    </div>
  );
}

function Num({ value }: { value: number | undefined }) {
  return <TableCell className="text-right tabular-nums">{value === undefined ? 'n/a' : formatNumber(value)}</TableCell>;
}

function FeaturesCard({ live }: { live: LiveWorkspace[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Features</CardTitle>
        <CardDescription>What each deployment has turned on</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Feature</TableHead>
              {live.map((workspace) => <TableHead key={workspace.slug} className="text-center">{workspace.slug}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {FEATURES.map((feature) => (
              <TableRow key={feature.key}>
                <TableCell>{feature.label}</TableCell>
                {live.map((workspace) => {
                  const on = workspace.product?.features.find((entry) => entry.key === feature.key)?.on;
                  return (
                    <TableCell key={workspace.slug} className="text-center">
                      {on === undefined
                        ? <span className="text-muted-foreground">n/a</span>
                        : on
                          ? <Check aria-label="On" className="mx-auto size-4 text-ok" />
                          : <Minus aria-label="Off" className="mx-auto size-4 text-muted-foreground" />}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
            <TableRow>
              <TableCell>Calendar connected</TableCell>
              {live.map((workspace) => (
                <TableCell key={workspace.slug} className="text-center tabular-nums">
                  <CalendarCheck className="mr-1 inline size-4 text-muted-foreground" />
                  {workspace.product ? formatNumber(workspace.product.connections.calendar) : 'n/a'}
                </TableCell>
              ))}
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Records

function RecordsCard({ fleet, live }: { fleet: OpsFleet; live: LiveWorkspace[] }) {
  const labels = recordLabels(live);
  const columns = live.length + 2;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Records</CardTitle>
        <CardDescription>Rows in each workspace&apos;s D1, Docs and Keep. A Core workspace keeps its organizations, projects, leads and tasks in Core.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Record</TableHead>
              {live.map((workspace) => <TableHead key={workspace.slug} className="text-right">{workspace.slug}</TableHead>)}
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Members</TableCell>
              {live.map((workspace) => <TableCell key={workspace.slug} className="text-right tabular-nums">{formatNumber(workspace.metadata.members)}</TableCell>)}
              <TableCell className="text-right font-medium tabular-nums">{formatNumber(live.reduce((sum, workspace) => sum + workspace.metadata.members, 0))}</TableCell>
            </TableRow>
            {labels.map((label) => (
              <RecordRow
                key={label}
                label={label}
                values={live.map((workspace) => {
                  const value = workspace.metadata.counts.find((count) => count.label === label)?.value;
                  return value === undefined ? 'Core' : value;
                })}
                slugs={live.map((workspace) => workspace.slug)}
              />
            ))}
            {SERVICE_KINDS.map(({ kind, label: serviceLabel }) => (
              <Fragment key={kind}>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableCell className="font-medium">{serviceLabel}</TableCell>
                  {live.map((workspace) => {
                    const row = serviceOf(fleet, workspace.slug, kind);
                    return (
                      <TableCell key={workspace.slug} className="text-right">
                        {!row
                          ? <span className="text-muted-foreground">Off</span>
                          : !row.ok || row.metadata.migration === null
                            ? <Badge variant="destructive" title={row.ok ? 'D1 not answering' : row.error}>{row.ok ? 'D1 not answering' : 'No answer'}</Badge>
                            : <Badge variant="outline" className="border-ok/50 text-ok" title={row.metadata.migration}>OK</Badge>}
                      </TableCell>
                    );
                  })}
                  <TableCell />
                </TableRow>
                {serviceLabels(fleet, kind).map((label) => (
                  <RecordRow
                    key={`${kind}-${label}`}
                    label={label}
                    values={live.map((workspace) => {
                      const row = serviceOf(fleet, workspace.slug, kind);
                      if (!row) return 'Off';
                      if (!row.ok) return 'n/a';
                      return row.metadata.counts.find((count) => count.label === label)?.value ?? 0;
                    })}
                    slugs={live.map((workspace) => workspace.slug)}
                  />
                ))}
              </Fragment>
            ))}
            {labels.length === 0 && (
              <TableRow><TableCell colSpan={columns} className="text-muted-foreground">No counts yet.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** One record across the workspaces: a number, or a word when the workspace does not hold it here. */
function RecordRow({ label, values, slugs }: { label: string; values: (number | string)[]; slugs: string[] }) {
  const total = values.reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
  return (
    <TableRow>
      <TableCell>{label}</TableCell>
      {values.map((value, index) => (
        <TableCell key={slugs[index]} className="text-right tabular-nums">
          {typeof value === 'number' ? formatNumber(value) : <span className="text-muted-foreground">{value}</span>}
        </TableCell>
      ))}
      <TableCell className="text-right font-medium tabular-nums">{formatNumber(total)}</TableCell>
    </TableRow>
  );
}

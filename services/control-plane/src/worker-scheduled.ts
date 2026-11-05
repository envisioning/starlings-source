import { pruneEnrollments } from './agent-enrollment';
import { drainFavoriteSyncQueue } from './favorite-sync';
import { resetStuckAgents, pruneAgentActivity } from './agents';
import { sweepDeliveries } from './deliveries';
import { sweepMeetingAgentCommits } from './meeting-agent-tools';
import { pruneDiagnostics } from './diagnostics';
import { enqueueGithubSync } from './github-connector';
import { pruneMcpCalls, pruneMcpIdempotency } from './mcp';
import { pruneMcpAuth } from './mcp-auth';
import { pruneAdminAudit } from './admin-audit';
import { pruneFormSubmissions } from './forms';
import { pruneUsageEvents } from './ledger';
import { checkModelSpend, isDailyTick } from './model-usage';
import { isReminderTick, sendOfferExpiryReminders } from './offer-expiry-reminders';
import { sweepOwedNotes } from './notes-owed';
import { pruneDownstreamUsage } from './downstream-usage';
import { pruneOperationalErrors } from './operational-errors';
import { sweepPendingEvents } from './pending-calendar-events';
import { runDailyBackup } from './backups';
import { pruneOpsDaily, recordOpsDaily } from './ops-history';
import { enqueueSlackSync } from './slack-connector';
import { sendDueReminders } from './event-signup-mail';
import { sendSetupReminder } from './setup';
import {
  D1_UNREACHABLE_KIND,
  checkCoreSilence,
  checkDeployStale,
  checkReleaseStale,
  checkRoute5xx,
  checkTestflightStale,
  deployCheckBlocker,
  isHourlyTick,
  isTransientD1Error,
  recordFailure,
  sendDueAlerts,
  testflightCheckBlocker,
} from './ops';
import { log } from './route-util';
import { crmSyncEnabled } from './crm';

/** How long a step that lost D1 waits before its one more run. */
const D1_RETRY_DELAY_MS = 2_000;

/**
 * The agent watchdog. Every tick is a no-op unless an agent's hand-off has
 * sat unanswered past AGENT_STUCK_RESET_MILLISECONDS — see resetStuckAgents
 * in agents.ts for why this exists and docs/AGENTS_SURFACE.md for the
 * runtime contract it enforces.
 */
export async function runScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  // Each step logs its failure and counts it in D1: the log line
  // is sampled away 99 times in 100, the count is what mails a person. A step
  // that lost D1 runs once more; lost twice, it counts as `d1_unreachable`.
  const step = (kind: string, run: () => Promise<unknown>) => {
    ctx.waitUntil(run().catch(async (error: unknown) => {
      if (!isTransientD1Error(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, D1_RETRY_DELAY_MS));
      return run();
    }).catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unknown error';
      log('error', kind, { error: message });
      if (isTransientD1Error(error)) await recordFailure(env, D1_UNREACHABLE_KIND, `${kind}: ${message}`);
      else await recordFailure(env, kind, message);
    }));
  };
  if (env.FAVORITES_SYNC_ENABLED === 'true') {
    step('favorites.sync.failed', () => drainFavoriteSyncQueue(env, Date.now()));
  }
  step('agents.watchdog.failed', () => resetStuckAgents(env, Date.now()));
  // Deliveries the queue went quiet on go out again.
  step('delivery.sweep.failed', () => sweepDeliveries(env));
  // A committed agent result survives interruption before the delivery ledger write.
  step('meeting-agent.commit.sweep.failed', () => sweepMeetingAgentCommits(env));
  // Meetings owed notes whose job went quiet are enqueued again.
  step('notes.owed.sweep.failed', () => sweepOwedNotes(env, Date.now()));
  // Event sign-ups: one reminder per registration an hour before the
  // start (docs/SESSIONS.md §0). On the fleet the dispatch Worker's cron fans
  // out to this handler, so there is no second scheduler.
  step('event.reminders.failed', () => sendDueReminders(env, Date.now()));
  // Offers about to expire: Core's daily 08:00 UTC job, here once the group moved.
  if (isReminderTick(controller.scheduledTime)) step('offer.reminders.failed', () => sendOfferExpiryReminders(env, Date.now()));
  // Proposed events nobody answered leave after a week.
  step('calendar.pending.sweep.failed', () => sweepPendingEvents(env));
  // The GitHub connector's hourly pass; gated inside, so the
  // other four ticks an hour cost one D1 read.
  step('github.sync.tick.failed', () => enqueueGithubSync(env, Date.now()));
  // The MCP record keeps 90 days (docs/MCP.md §The record). One index
  // range per tick; after the first, each deletes five minutes of rows.
  step('mcp.record.prune.failed', () => pruneMcpCalls(env, Date.now()));
  // MCP write results are kept only through the configured replay window.
  step('mcp.idempotency.prune.failed', () => pruneMcpIdempotency(env, Date.now()));
  // Today's row of how many people use the workspace, for the operator
  // dashboard's history (docs/OPS_CONSOLE.md §History). One upsert a tick.
  step('ops.daily.snapshot.failed', () => recordOpsDaily(env, Date.now()));
  // Device diagnostics keep 30 days.
  step('diagnostics.prune.failed', () => pruneDiagnostics(env, Date.now()));
  if (isDailyTick(controller.scheduledTime)) {
    step('downstream_usage.prune.failed', () => pruneDownstreamUsage(env, Date.now()));
  }
  // Aggregated operational errors keep 30 UTC days.
  if (isDailyTick(controller.scheduledTime)) {
    step('operational_errors.prune.failed', () => pruneOperationalErrors(env, Date.now()));
    step('agents.activity.prune.failed', () => pruneAgentActivity(env, Date.now()));
    step('agents.enrollments.prune.failed', () => pruneEnrollments(env, Date.now()));
    // Spent and expired OAuth codes, and clients nobody allowed in a week.
    step('mcp.auth.prune.failed', () => pruneMcpAuth(env, Date.now()));
    // Retention decided 2026-10-01: audit 2 years, usage events 13 months.
    step('admin_audit.prune.failed', () => pruneAdminAudit(env));
    step('usage_events.prune.failed', () => pruneUsageEvents(env));
    step('ops.daily.prune.failed', () => pruneOpsDaily(env, Date.now()));
    // Each form keeps its submissions for its own `keepDays` (docs/FORMS.md).
    step('form_submissions.prune.failed', () => pruneFormSubmissions(env, Date.now()));
  }
  // Mail E5: on day 3 of a new workspace, an admin with setup still open
  // hears their next step, once (docs/ONBOARDING.md §Mails). Hourly; a
  // workspace outside days 3 to 7 costs one read.
  if (isHourlyTick(controller.scheduledTime)) step('setup.reminder.failed', () => sendSetupReminder(env, Date.now()));
  // The Slack import's hourly pass, gated the same way.
  step('slack.sync.tick.failed', () => enqueueSlackSync(env, Date.now()));
  // Once an hour: is `main` ahead of this build for more than 45 minutes
  //? A stale deploy is counted inside; a GitHub failure here
  // is only logged, so a broken check does not mail every hour.
  if (isHourlyTick(controller.scheduledTime)) {
    ctx.waitUntil(checkDeployStale(env, Date.now()).catch((error) => {
      log('error', 'deploy.check.failed', { error: error instanceof Error ? error.message : 'Unknown error' });
    }));
    // A check that cannot run is not a pass. Once a day it is counted, in a
    // kind that is shown on Admin › Operations and not mailed.
    const blocker = deployCheckBlocker(env);
    if (blocker && isDailyTick(controller.scheduledTime)) {
      ctx.waitUntil(recordFailure(env, 'deploy_check_skipped', blocker));
    }
    // The released Mac version more than eight days old.
    // A feed that cannot be read is only logged, like the deploy check.
    ctx.waitUntil(checkReleaseStale(env, Date.now()).catch((error) => {
      log('error', 'release.check.failed', { error: error instanceof Error ? error.message : 'Unknown error' });
    }));
    // Core's events gone quiet for 72 hours, and a route answering 5xx
    // over and over, are counted so the alert mail reaches somebody. Silence
    // is only news on a workspace that syncs with Core.
    if (crmSyncEnabled(env)) step('core.silence.check.failed', () => checkCoreSilence(env, Date.now()));
    step('route.5xx.check.failed', () => checkRoute5xx(env, Date.now()));
  }
  // Once a day: the newest TestFlight build against its 90-day expiry
  //. A check that cannot run is counted, not mailed.
  if (isDailyTick(controller.scheduledTime)) {
    const blocked = testflightCheckBlocker(env);
    if (blocked) ctx.waitUntil(recordFailure(env, 'testflight_check_skipped', blocked));
    else step('testflight.check.failed', () => checkTestflightStale(env, Date.now()));
  }
  // Once a day, after 00:00 UTC: yesterday's model tokens against
  // SPEND_ALERT_DAILY_TOKENS. Recorded, never cut off.
  if (isDailyTick(controller.scheduledTime)) step('model.spend.check.failed', () => checkModelSpend(env, Date.now()));
  // The daily text backup of every room and thread to R2;
  // gated inside to once a day after 03:00 UTC.
  step('backup.run.failed', () => runDailyBackup(env, Date.now()));
  // The mail for what failed until now. A failure counted in
  // this tick is mailed on the next one.
  ctx.waitUntil(sendDueAlerts(env, Date.now()).catch((error) => {
    log('error', 'ops.alerts.failed', { error: error instanceof Error ? error.message : 'Unknown error' });
  }));
}

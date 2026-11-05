import type { ControlPlaneJob } from './contracts';
import { processArtifactJob } from './artifacts';
import { processBackupJob } from './backups';
import { granolaBridgeEnabled, ingestGranolaNote, processGranolaPage, suggestGranolaNote } from './granola';
import { CrmSyncError } from './crm';
import { processGithubRepoJob } from './github-connector';
import { DEAD_IMPORT_JOBS_QUEUE, DEAD_JOBS_QUEUE, recordFailure, shelveDeadJobs } from './ops';
import { log } from './route-util';
import { processSlackChannelJob } from './slack-connector';

export async function processQueue(batch: MessageBatch<ControlPlaneJob>, env: Env): Promise<void> {
  // The dead queue: what failed every retry is kept in D1 until an admin
  // replays it.
  if (batch.queue === DEAD_JOBS_QUEUE || batch.queue === DEAD_IMPORT_JOBS_QUEUE) {
    await shelveDeadJobs(batch.messages, env);
    return;
  }
  for (const message of batch.messages) {
    const job = message.body;
    try {
      // The imports (Granola, GitHub, Slack) have their own queue since
      //, but this consumer still runs their kinds: a message queued
      // on the notes queue before the split is dispatched by `kind`.
      // A Granola job queued while the bridge was on waits on the dead queue
      // while it is off, rather than reaching Core or Granola.
      if ((job.kind === 'granola' || job.kind === 'granola-page' || job.kind === 'granola-suggest') && !granolaBridgeEnabled(env)) {
        throw new CrmSyncError('The Granola bridge is off.', 503, 'not_configured');
      }
      if (job.kind === 'granola') await ingestGranolaNote(env, job.noteId);
      else if (job.kind === 'granola-page') await processGranolaPage(env, job);
      else if (job.kind === 'granola-suggest') await suggestGranolaNote(env, job.noteId);
      else if (job.kind === 'github-repo') await processGithubRepoJob(env, job);
      else if (job.kind === 'slack-channel') await processSlackChannelJob(env, job);
      else if (job.kind === 'backup-object') await processBackupJob(env, job);
      else await processArtifactJob(job, env);
      message.ack();
    } catch (error) {
      const failure = job.kind === 'granola' || job.kind === 'granola-page' || job.kind === 'granola-suggest'
        ? 'granola.job.failed'
        : job.kind === 'github-repo' ? 'github.job.failed'
          : job.kind === 'slack-channel' ? 'slack.job.failed'
            : job.kind === 'backup-object' ? 'backup.job.failed' : 'artifact.failed';
      log('error', failure, {
        ...(job.kind === 'granola' || job.kind === 'granola-suggest' ? { noteId: job.noteId } : {}),
        ...(job.kind === 'github-repo' ? { repo: `${job.owner}/${job.repo}`, page: job.page ?? 1 } : {}),
        ...(job.kind === 'slack-channel' ? { channel: job.channelId, page: job.page ?? null } : {}),
        ...(job.kind === 'backup-object' ? { day: job.day, object: job.object, id: job.id } : {}),
        ...(job.kind === 'granola' || job.kind === 'granola-page' || job.kind === 'granola-suggest' || job.kind === 'github-repo' || job.kind === 'slack-channel' || job.kind === 'backup-object'
          ? {}
          : { roomSlug: job.roomSlug, meetingId: job.meetingId }),
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // A backup job that fails is counted under the `backup` kind the
      // daily pass and the alert mail already use (docs/OPERATIONS.md §Alerts).
      await recordFailure(env, job.kind === 'backup-object' ? 'backup' : failure, job.kind === 'granola' || job.kind === 'granola-suggest'
        ? job.noteId
        : job.kind === 'github-repo' ? `${job.owner}/${job.repo}`
          : job.kind === 'slack-channel' ? job.channelId
            : job.kind === 'backup-object' ? `${job.object}:${job.id}`
              : job.kind === 'granola-page' ? 'granola-page' : job.meetingId);
      // 30 s, then 60 s, then 120 s: a rate-limited upstream is given room
      // to recover, and a retry that would fail the same way is not read
      // (and billed) a second later.
      message.retry({ delaySeconds: Math.min(3600, 30 * 2 ** Math.max(0, message.attempts - 1)) });
    }
  }
}

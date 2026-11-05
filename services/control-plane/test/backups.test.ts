// The daily text backup and the restore (meet#317, meet#603): a room, a thread
// and an owner's Quick Notes go to JSON and come back with the same rows, the
// day is planned once after 03:00 UTC as one job per object, a missing object
// is sent again, and only an org admin restores.
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AmbientMeetingResponse, BackupObjectJob } from '@starlings/contracts';
import { backupKey, processBackupJob, restoreObject, runDailyBackup } from '../src/backups';
import type { QuickNotesCoordinator } from '../src/quick-notes';
import type { RoomCoordinator } from '../src/room-coordinator';
import { threadStub } from '../src/threads';

async function session(email: string, name = 'Ada') {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json', origin: env.WEB_ORIGIN };
}

function withoutTime<T extends { exported_at: number }>(snapshot: T): Omit<T, 'exported_at'> {
  const { exported_at: _exportedAt, ...rest } = snapshot;
  return rest;
}

async function meetingWithLines(): Promise<string> {
  const headers = await session('rosa@example.com', 'Rosa');
  const created = await exports.default.fetch(new Request('http://local/api/rooms/rosa/meetings/ambient', {
    method: 'POST',
    headers,
    body: JSON.stringify({ started_at: '2026-09-16T09:00:00.000Z', ended_at: '2026-09-16T09:40:00.000Z', title: 'Backup test' }),
  }));
  const { meeting_id } = await created.json<AmbientMeetingResponse>();
  const line = (n: number, text: string) => ({
    id: crypto.randomUUID(), meeting_id, speaker_id: 'ambient:ana', speaker_name: 'Ana', language: 'en',
    starts_at_ms: n * 1000, ends_at_ms: n * 1000 + 900, text, is_final: true,
  });
  await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/transcript`, {
    method: 'POST', headers, body: JSON.stringify({ segments: [line(1, 'First line.'), line(2, 'Second line.')] }),
  }));
  return meeting_id;
}

async function threadWithMessages(id: string) {
  const thread = threadStub(env, id);
  const ana = { sub: 'sub-ana', email: 'ana@example.com', name: 'Ana' };
  await thread.ensureThread({ id, kind: 'dm', parentId: null, audience: 'members', members: [ana, { sub: 'sub-bo', email: 'bo@example.com' }] } as never);
  await thread.append(ana, 'Hello', crypto.randomUUID(), Date.parse('2026-09-20T10:00:00Z'));
  const second = crypto.randomUUID();
  await thread.append(ana, 'Second', second, Date.parse('2026-09-20T10:01:00Z'));
  await thread.react(ana, second, '👍', Date.parse('2026-09-20T10:02:00Z'));
  return thread;
}

describe('export and import', () => {
  it('gives back a room with its meetings and transcript lines', async () => {
    await meetingWithLines();
    const room = env.ROOMS.getByName('rosa') as DurableObjectStub<RoomCoordinator>;
    const before = await room.exportState();
    expect(before.version).toBe(1);
    expect(before.tables.meetings!.length).toBeGreaterThan(0);
    expect(before.tables.transcript_segments!.length).toBeGreaterThanOrEqual(2);

    // Writes after the snapshot are what a restore loses.
    await meetingWithLines();
    expect((await room.exportState()).tables.meetings!.length).toBeGreaterThan(before.tables.meetings!.length);

    await room.importState(JSON.parse(JSON.stringify(before)));
    expect(withoutTime(await room.exportState())).toEqual(withoutTime(before));
  });

  it('gives back a thread with its messages and reactions', async () => {
    const thread = await threadWithMessages(`dm:backup-${crypto.randomUUID()}`);
    const before = await thread.exportState();
    expect(before.tables.messages).toHaveLength(2);
    expect(before.tables.reactions).toHaveLength(1);

    await thread.append({ sub: 'sub-ana', email: 'ana@example.com', name: 'Ana' }, 'After the snapshot', crypto.randomUUID(), Date.parse('2026-09-20T11:00:00Z'));
    await thread.importState(JSON.parse(JSON.stringify(before)));
    expect(withoutTime(await thread.exportState())).toEqual(withoutTime(before));
  });

  it('refuses a snapshot of the other kind before it writes anything', async () => {
    const thread = await threadWithMessages(`dm:backup-${crypto.randomUUID()}`);
    const room = env.ROOMS.getByName('rosa') as DurableObjectStub<RoomCoordinator>;
    const roomBefore = await room.exportState();
    const refused = await room.importState(await thread.exportState()).then(() => null, (error: unknown) => error);
    expect(String(refused)).toMatch(/tables this object does not/u);
    expect(withoutTime(await room.exportState())).toEqual(withoutTime(roomBefore));
  });
});

/** Run every job a spy caught, as the queue consumer would. */
async function runJobs(sent: BackupObjectJob[], only?: (job: BackupObjectJob) => boolean): Promise<void> {
  for (const job of sent.splice(0)) {
    if (!only || only(job)) await processBackupJob(env, job);
  }
}

function captureSends(): BackupObjectJob[] {
  const sent: BackupObjectJob[] = [];
  vi.spyOn(env.ARTIFACT_JOBS, 'sendBatch').mockImplementation(async (messages) => {
    for (const message of messages) sent.push(message.body as BackupObjectJob);
    return {} as never;
  });
  return sent;
}

async function quickNoteFor(sub: string, body: string): Promise<void> {
  await env.USAGE.prepare(
    `INSERT OR IGNORE INTO people (sub, email, name, first_seen_at, last_seen_at) VALUES (?1, ?2, 'Ana', 1, 1)`,
  ).bind(sub, `${sub}@example.com`).run();
  const response = await env.QUICK_NOTES.getByName(`owner:${sub}`).fetch('https://quick-notes/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body, source: 'home' }),
  });
  expect(response.status).toBe(201);
}

describe('the daily backup', () => {
  afterEach(() => vi.restoreAllMocks());

  it('plans the day once, after 03:00 UTC, as one job per room, thread and person', async () => {
    const threadId = `dm:backup-${crypto.randomUUID()}`;
    const sub = `qn-${crypto.randomUUID()}`;
    await threadWithMessages(threadId);
    await env.USAGE.prepare(
      `INSERT OR IGNORE INTO threads (id, kind, parent_id, created_at) VALUES (?1, 'dm', NULL, ?2)`,
    ).bind(threadId, Date.now()).run();
    await quickNoteFor(sub, 'Remember the backup');
    const sent = captureSends();

    expect((await runDailyBackup(env, Date.parse('2038-04-05T02:59:00Z'))).ran).toBe(false);
    const first = await runDailyBackup(env, Date.parse('2038-04-05T03:00:00Z'));
    expect(first).toMatchObject({ ran: true, done: false });
    expect(first.queued).toBe(sent.length);
    expect(sent.filter((job) => job.object === 'room').map((job) => job.id)).toContain('rosa');
    expect(sent).toContainEqual({ kind: 'backup-object', day: '2038-04-05', object: 'thread', id: threadId });
    expect(sent).toContainEqual({ kind: 'backup-object', day: '2038-04-05', object: 'quick-notes', id: sub });

    // Nothing written yet: the next tick does not plan again and does not send
    // until the jobs have had half an hour.
    sent.length = 0;
    expect(await runDailyBackup(env, Date.parse('2038-04-05T03:05:00Z'))).toMatchObject({ ran: false, done: false });
    expect(sent).toHaveLength(0);
  });

  it('retries what is missing, and marks the day done only when every object is stored', async () => {
    const sub = `qn-${crypto.randomUUID()}`;
    await quickNoteFor(sub, 'Kept');
    const sent = captureSends();
    const day = '2038-05-10';
    await runDailyBackup(env, Date.parse(`${day}T03:00:00Z`));
    const planned = [...sent];

    // One job fails (the queue would retry it, then give up); the others run.
    const failing = planned.find((job) => job.object === 'quick-notes' && job.id === sub)!;
    sent.length = 0;
    await runJobs([...planned], (job) => job !== failing);
    await expect(env.BACKUPS.get(backupKey(day, 'quick-notes', sub))).resolves.toBeNull();

    // Five minutes later: not sent again yet, not done.
    expect(await runDailyBackup(env, Date.parse(`${day}T03:05:00Z`))).toMatchObject({ done: false, queued: 0, missing: 1 });
    // Half an hour after the first send: only the missing one is sent again.
    const again = await runDailyBackup(env, Date.parse(`${day}T03:31:00Z`));
    expect(again).toMatchObject({ done: false, queued: 1, missing: 1 });
    expect(sent).toEqual([failing]);
    await runJobs(sent);
    expect(await env.BACKUPS.get(backupKey(day, 'quick-notes', sub))).not.toBeNull();

    expect(await runDailyBackup(env, Date.parse(`${day}T03:40:00Z`))).toMatchObject({ done: true, missing: 0 });
    // Done is remembered: later ticks do not look again.
    const list = vi.spyOn(env.BACKUPS, 'list');
    expect(await runDailyBackup(env, Date.parse(`${day}T04:00:00Z`))).toMatchObject({ done: true });
    expect(list).not.toHaveBeenCalled();
    // The next day plans again.
    expect((await runDailyBackup(env, Date.parse('2038-05-11T03:05:00Z'))).ran).toBe(true);
  });

  it('does not ask for a thread or a person that began after the plan', async () => {
    const sent = captureSends();
    const day = '2038-05-20';
    await runDailyBackup(env, Date.parse(`${day}T03:00:00Z`));
    await runJobs(sent);
    const late = `dm:late-${crypto.randomUUID()}`;
    await env.USAGE.prepare(`INSERT INTO threads (id, kind, parent_id, created_at) VALUES (?1, 'dm', NULL, ?2)`)
      .bind(late, Date.parse(`${day}T11:00:00Z`)).run();
    await env.USAGE.prepare(`INSERT INTO people (sub, email, name, first_seen_at, last_seen_at) VALUES (?1, ?2, 'Bo', ?3, ?3)`)
      .bind(`late-${crypto.randomUUID()}`, `late-${crypto.randomUUID()}@example.com`, Date.parse(`${day}T11:00:00Z`)).run();
    // Nothing missing against the plan, so the day is done, and no failure at 10:00.
    expect(await runDailyBackup(env, Date.parse(`${day}T10:00:00Z`))).toMatchObject({ done: true, missing: 0 });
    const row = await env.USAGE.prepare(`SELECT count FROM ops_failures WHERE kind = 'backup' AND day = ?1`).bind(day).first();
    expect(row).toBeNull();
  });

  it('counts one backup failure when objects are still missing six hours in', async () => {
    const sent = captureSends();
    const day = '2038-06-02';
    await runDailyBackup(env, Date.parse(`${day}T03:00:00Z`));
    sent.length = 0;
    await runDailyBackup(env, Date.parse(`${day}T09:01:00Z`));
    await runDailyBackup(env, Date.parse(`${day}T09:30:00Z`));
    const row = await env.USAGE.prepare(`SELECT count, last_detail FROM ops_failures WHERE kind = 'backup' AND day = ?1`)
      .bind(day).first<{ count: number; last_detail: string }>();
    expect(row?.count).toBe(1);
    expect(row?.last_detail).toMatch(/^incomplete 2038-06-02: \d+ missing/u);
    expect(sent).toHaveLength(0);
  });

  it('restores one room and one Quick Notes inbox from a backup', async () => {
    await meetingWithLines();
    const sub = `qn-${crypto.randomUUID()}`;
    await quickNoteFor(sub, 'Before the snapshot');
    const sent = captureSends();
    const day = '2038-07-01';
    await runDailyBackup(env, Date.parse(`${day}T03:00:00Z`));
    await runJobs(sent, (job) => (job.object === 'room' && job.id === 'rosa') || (job.object === 'quick-notes' && job.id === sub));

    const room = env.ROOMS.getByName('rosa') as DurableObjectStub<RoomCoordinator>;
    const roomBefore = await room.exportState();
    const notes = env.QUICK_NOTES.getByName(`owner:${sub}`) as DurableObjectStub<QuickNotesCoordinator>;
    expect((await notes.exportState()).tables.quick_notes).toHaveLength(1);

    // Writes after the backup are what a restore loses.
    await meetingWithLines();
    await quickNoteFor(sub, 'After the snapshot');
    expect((await notes.exportState()).tables.quick_notes).toHaveLength(2);

    expect(await restoreObject(env, 'room', 'rosa', day)).toMatchObject({ meetings: roomBefore.tables.meetings!.length });
    expect(withoutTime(await room.exportState())).toEqual(withoutTime(roomBefore));
    expect(await restoreObject(env, 'quick-notes', sub, day)).toEqual({ quick_notes: 1 });
    const restored = (await notes.exportState()).tables.quick_notes!;
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ body: 'Before the snapshot' });
  });

  it('does not restore the Quick Notes of someone Meet does not know', async () => {
    await expect(restoreObject(env, 'quick-notes', 'nobody-here', '2038-07-01')).rejects.toMatchObject({ status: 404 });
  });
});

describe('POST /api/admin/restore-object', () => {
  it('restores a thread for an org admin and writes the audit row', async () => {
    const threadId = `dm:restore-${crypto.randomUUID()}`;
    const thread = await threadWithMessages(threadId);
    await env.USAGE.prepare(
      `INSERT OR IGNORE INTO threads (id, kind, parent_id, created_at) VALUES (?1, 'dm', NULL, ?2)`,
    ).bind(threadId, Date.now()).run();
    await env.BACKUPS.put(backupKey('2038-05-01', 'thread', threadId), JSON.stringify(await thread.exportState()));
    await thread.append({ sub: 'sub-ana', email: 'ana@example.com', name: 'Ana' }, 'Lost on restore', crypto.randomUUID(), Date.now());

    const response = await exports.default.fetch(new Request('http://local/api/admin/restore-object', {
      method: 'POST',
      headers: await session('rosa@example.com', 'Rosa'),
      body: JSON.stringify({ kind: 'thread', id: threadId, date: '2038-05-01' }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'thread', id: threadId, tables: { messages: 2, reactions: 1 } });
    expect((await thread.exportState()).tables.messages).toHaveLength(2);
    const audit = await env.USAGE.prepare(`SELECT detail FROM admin_audit WHERE action = 'object.restore' AND subject = ?1`)
      .bind(`thread:${threadId}`).first<{ detail: string }>();
    expect(audit?.detail).toMatch(/^2038-05-01, \d+ rows$/u);
  });

  it('answers 404 for a day with no snapshot', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/admin/restore-object', {
      method: 'POST',
      headers: await session('rosa@example.com', 'Rosa'),
      body: JSON.stringify({ kind: 'room', id: 'rosa', date: '2001-01-01' }),
    }));
    expect(response.status).toBe(404);
  });

  it('refuses a member', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/admin/restore-object', {
      method: 'POST',
      headers: await session('restore-member@example.com'),
      body: JSON.stringify({ kind: 'room', id: 'rosa', date: '2038-04-05' }),
    }));
    expect(response.status).toBe(403);
  });
});

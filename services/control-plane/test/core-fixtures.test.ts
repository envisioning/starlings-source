import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreFoldExportPageSchema, internalChannelEventSchema } from '@starlings/contracts';
import { coreWriteRequestSchema } from '@starlings/contracts/core-writes';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import { hmacSHA256Hex } from '../src/crypto';
import {
  buildMeetingLogPayload,
  createCrmDecision,
  createCrmGoal,
  createCrmProjectRepo,
  createCrmSubject,
  createCrmTask,
  exchangeCoreToken,
  fetchAllCrmGoals,
  fetchCrmCalendarContacts,
  fetchCrmDecisions,
  fetchCrmGithubRepos,
  fetchCrmInteractions,
  fetchCrmIssue,
  fetchCrmIssueFacets,
  fetchCrmIssues,
  fetchCrmMyWork,
  fetchCrmProjectRepos,
  fetchCrmSubject,
  fetchCrmSubjectCounts,
  fetchCrmSubjectDetail,
  fetchCrmSubjects,
  fetchCrmTasks,
  fetchCrmTeam,
  fetchCrmWorkItems,
  fetchGranolaLedger,
  postMeetingLog,
  setCrmGithubLogin,
  updateCrmGoal,
  updateCrmSubject,
  updateCrmTask,
  writeCrmIssue,
} from '../src/crm';
import { purgeAllCoreCache } from '../src/core-cache';
import { repointCoreMerge } from '../src/core-merge-repoint';
import { routePublicEventsProxy } from '../src/schedule-proxy';
import {
  cancelSessionRegistration,
  registerForSession,
  registrationsNeedingMail,
  resolveSessionToken,
  sessionEventBySlug,
  sessionTokenHashes,
  sha256Hex,
  stampSessionMail,
} from '../src/event-signups';
import type { SessionEventRecord } from '@starlings/contracts/event-signups';

/*
 * Core's recorded projections (meet#606).
 *
 * `fixtures/core/*.json` is a copy of what Core's route tests record for each
 * `/api/public/meet-*` response and for each channel event it posts to Meet
 * (`node scripts/sync-core-fixtures.mjs`; procedure in docs/agents/areas/worker.md).
 * Each file is answered, through the Worker's real reader for that route, as
 * Core would answer it. A field Meet's schema needs and Core stopped sending
 * is a 502 `upstream_shape` and fails here, naming the path.
 *
 * Every file must be claimed by a case below, and every case must name a file,
 * so a response Core adds cannot go unread and a case cannot outlive its file.
 */

const fixtures = import.meta.glob('../../../fixtures/core/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

function fixture(name: string): any {
  const hit = fixtures[`../../../fixtures/core/${name}.json`];
  if (hit === undefined) throw new Error(`fixtures/core/${name}.json is missing. Run: node scripts/sync-core-fixtures.mjs`);
  return hit;
}

const secretEnv = { ...env, INTERNAL_REQUEST_SECRET: 'meet-core-shared-secret-at-least-32-chars' } as Env;

/** Core answers every call with this body. */
function coreAnswers(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

beforeEach(async () => {
  await purgeAllCoreCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PROJECT = 'aaaaaaaa-0000-4000-8000-000000000001';
const LEAD = 'aaaaaaaa-0000-4000-8000-000000000002';
const ORGANIZATION = 'aaaaaaaa-0000-4000-8000-000000000003';
const TASK = 'aaaaaaaa-0000-4000-8000-000000000004';
const GOAL = 'aaaaaaaa-0000-4000-8000-000000000005';
const CONTACT = 'aaaaaaaa-0000-4000-8000-000000000008';
const ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000009';
const EVENT = 'aaaaaaaa-0000-4000-8000-0000000000e1';
const ACTOR = 'owner@example.com';
const SESSION_EVENT = 'abcdef12-0000-4000-8000-000000000001';

/**
 * Core's own CRM write, sent to the Worker's door with Core's inbound key and
 * forwarded to `meet-crm-writes` (meet#275). Answers the door's response.
 */
async function coreWrite(body: unknown): Promise<Response> {
  const raw = JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = await hmacSHA256Hex('inbound-test-secret-with-at-least-32-characters', `${timestamp}.${raw}`);
  const context = createExecutionContext();
  const response = await worker.fetch(new Request('http://local/api/internal/core-writes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key-id': 'core', 'x-internal-timestamp': timestamp, 'x-internal-signature': signature },
    body: raw,
  }), secretEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** One case: the Worker function that reads the route, and what it must make of the file. */
type Read = (name: string) => Promise<void>;

const reads: Record<string, Read> = {
  'meet-crm-writes-create.post': async (name) => {
    coreAnswers(fixture(name), 201);
    const response = await coreWrite(fixture(CORE_WRITE_REQUEST));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: ORGANIZATION } });
  },
  'meet-crm-writes-update.post': async (name) => {
    coreAnswers(fixture(name));
    const response = await coreWrite({ action: 'update', entity: 'leads', id: LEAD, values: { status: 'Closed Won' }, select: 'id, status' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: LEAD, status: 'Closed Won' } });
  },

  'meet-team.get': async (name) => {
    coreAnswers(fixture(name));
    expect((await fetchCrmTeam(secretEnv)).map((member) => member.email)).toEqual(['ada@example.test', 'ben@example.test']);
  },
  'meet-team.patch': async (name) => {
    coreAnswers(fixture(name));
    expect(await setCrmGithubLogin(secretEnv, 'ada@example.test', 'ada-example')).toBe('ada-example');
  },

  'meet-crm-tasks.get': async (name) => {
    coreAnswers(fixture(name));
    const tasks = await fetchCrmTasks(secretEnv, { projectId: PROJECT });
    expect(tasks.map((task) => task.status)).toEqual(['in_progress', 'pending']);
  },
  'meet-crm-tasks.post': async (name) => {
    coreAnswers(fixture(name));
    expect((await createCrmTask(secretEnv, { title: 'Send the pilot scope', project_id: PROJECT })).id).toBe(TASK);
  },
  'meet-crm-tasks-id.patch': async (name) => {
    coreAnswers(fixture(name));
    expect((await updateCrmTask(secretEnv, TASK, { status: 'review' })).id).toBe(TASK);
  },

  'meet-crm-goals.get': async (name) => {
    coreAnswers(fixture(name));
    expect((await fetchAllCrmGoals(secretEnv)).map((goal) => goal.id)).toEqual([GOAL]);
  },
  'meet-crm-goals.post': async (name) => {
    coreAnswers(fixture(name));
    expect((await createCrmGoal(secretEnv, { project_id: PROJECT, title: 'Ship the pilot', actor_email: ACTOR } as never)).id).toBe(GOAL);
  },
  'meet-crm-goals-id.patch': async (name) => {
    coreAnswers(fixture(name));
    expect((await updateCrmGoal(secretEnv, GOAL, { status: 'met', actor_email: ACTOR } as never)).id).toBe(GOAL);
  },

  'meet-crm-decisions.get': async (name) => {
    coreAnswers(fixture(name));
    expect(await fetchCrmDecisions(secretEnv, { kind: 'project', id: PROJECT })).toHaveLength(1);
  },
  'meet-crm-decisions.post': async (name) => {
    coreAnswers(fixture(name));
    const decision = await createCrmDecision(secretEnv, { subject_kind: 'project', subject_id: PROJECT, body: 'x', source: 'meeting', actor_email: ACTOR } as never);
    expect(decision.subject_id).toBe(PROJECT);
  },

  'meet-calendar-contacts.get': async (name) => {
    coreAnswers(fixture(name));
    expect(await fetchCrmCalendarContacts(secretEnv, ['cleo@client.test'])).toEqual([{ id: CONTACT, name: 'Cleo Example', email: 'cleo@client.test' }]);
  },

  'meet-github-repos.get': async (name) => {
    coreAnswers(fixture(name));
    expect((await fetchCrmGithubRepos(secretEnv, '')).map((repo) => repo.id)).toEqual(['example-org/pilot']);
  },
  'meet-project-repos.get': async (name) => {
    coreAnswers(fixture(name));
    expect(await fetchCrmProjectRepos(secretEnv, PROJECT)).toHaveLength(1);
  },
  'meet-project-repos.post': async (name) => {
    coreAnswers(fixture(name));
    const link = await createCrmProjectRepo(secretEnv, { project_id: PROJECT, owner: 'example-org', repo: 'pilot', label: 'scope' }, ACTOR);
    expect(link.repo).toBe('pilot');
  },

  'meet-github-issues.get': async (name) => {
    coreAnswers(fixture(name));
    const { issues, linked } = await fetchCrmIssues(secretEnv, { project_id: PROJECT } as never);
    expect(linked).toBe(true);
    expect(issues.map((issue) => issue.number)).toEqual([12]);
  },
  'meet-github-issues-unlinked.get': async (name) => {
    coreAnswers(fixture(name));
    expect(await fetchCrmIssues(secretEnv, { project_id: PROJECT } as never)).toMatchObject({ issues: [], linked: false });
  },
  'meet-github-issues-detail.get': async (name) => {
    coreAnswers(fixture(name));
    const issue = await fetchCrmIssue(secretEnv, 'example-org', 'pilot', 12);
    expect(issue?.comments_list).toHaveLength(1);
  },
  'meet-github-issues-facets.get': async (name) => {
    coreAnswers(fixture(name));
    expect((await fetchCrmIssueFacets(secretEnv, 'example-org', 'pilot')).labels.map((label) => label.name)).toEqual(['scope']);
  },
  'meet-github-issues.post': async (name) => {
    coreAnswers(fixture(name));
    expect((await writeCrmIssue(secretEnv, 'POST', { project_id: PROJECT, title: 'x' }, ACTOR))?.number).toBe(12);
  },
  'meet-github-issues.patch': async (name) => {
    coreAnswers(fixture(name));
    expect((await writeCrmIssue(secretEnv, 'PATCH', { owner: 'example-org', repo: 'pilot', number: 12 }, ACTOR))?.number).toBe(12);
  },

  'meet-my-work.get': async (name) => {
    coreAnswers(fixture(name));
    const work = await fetchCrmMyWork(secretEnv, 'ada@example.test');
    expect(work).toMatchObject({ matched: true, github_login: 'ada-example' });
    expect(work.tasks).toHaveLength(1);
    expect(work.issues).toHaveLength(1);
  },
  'meet-my-work-unmatched.get': async (name) => {
    coreAnswers(fixture(name));
    expect(await fetchCrmMyWork(secretEnv, 'nobody@example.test')).toMatchObject({ matched: false, tasks: [], issues: [] });
  },

  'meet-work-items.get': async (name) => {
    coreAnswers(fixture(name));
    const items = await fetchCrmWorkItems(secretEnv, { start: '2026-10-05', end: '2026-10-11' });
    expect(items.map((item) => item.kind)).toEqual(['task', 'milestone']);
  },

  'meet-fold-merge-repoint.post': async (name) => {
    coreAnswers(fixture(name));
    // A body this code cannot read is a counted failure, not a throw.
    const failed = vi.spyOn(console, 'error');
    await repointCoreMerge(secretEnv, { entity: 'organizations', into_id: ORGANIZATION, from_ids: [ACCOUNT] });
    expect(failed).not.toHaveBeenCalled();
  },
  'meet-fold-export.get': async (name) => {
    expect(coreFoldExportPageSchema.parse(fixture(name)).rows).toHaveLength(1);
  },
  'meet-meeting-logs.post': async (name) => {
    coreAnswers(fixture(name));
    await expect(postMeetingLog(secretEnv, buildMeetingLogPayload({
      roomSlug: 'example',
      ownerEmail: ACTOR,
      meetingId: '0f1a5a2c-1111-4c8f-9a13-8a9d0e2f0001',
      startedAt: 1_760_000_000_000,
      endedAt: 1_760_000_600_000,
      participants: [],
      transcript: [],
    } as never, 'ended', { publicOrigin: 'https://envisioning.starlings.example' }))).resolves.toBeUndefined();
  },

  'meet-owner-exchange.post': async (name) => {
    coreAnswers(fixture(name));
    const token = await exchangeCoreToken(secretEnv, ACTOR, 'Example Mac');
    expect(token.token.length).toBeGreaterThan(0);
    expect(token.scopes.length).toBeGreaterThan(0);
  },
  'meet-owner-exchange-no-account.post': async (name) => {
    coreAnswers(fixture(name), 404);
    await expect(exchangeCoreToken(secretEnv, ACTOR, 'Example Mac')).rejects.toMatchObject({ code: 'core_account_missing' });
  },

  'meet-crm-interactions.get': async (name) => {
    coreAnswers(fixture(name));
    const rows = await fetchCrmInteractions(secretEnv, { projectId: PROJECT });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contacts).toHaveLength(1);
  },
  'meet-crm-interactions-granola.get': async (name) => {
    coreAnswers(fixture(name));
    expect((await fetchGranolaLedger(secretEnv))[0]).toMatchObject({ granola_note_id: 'not_example', meeting_kind: 'project', subject_title: 'Pilot programme' });
  },

  'meet-crm-subjects-project.get': async (name) => {
    coreAnswers(fixture(name));
    const { subjects } = await fetchCrmSubjects(secretEnv, 'project', '');
    expect(subjects).toMatchObject([{ id: PROJECT, kind: 'project', open_tasks: 2, has_repo: true }]);
  },
  'meet-crm-subjects-lead.get': async (name) => {
    coreAnswers(fixture(name));
    expect((await fetchCrmSubjects(secretEnv, 'lead', '')).subjects.map((subject) => subject.id)).toEqual([LEAD]);
  },
  'meet-crm-subjects-partner.get': async (name) => {
    coreAnswers(fixture(name));
    expect((await fetchCrmSubjects(secretEnv, 'organization', '')).subjects.map((subject) => subject.id)).toEqual([ORGANIZATION]);
  },
  'meet-crm-subjects-event.get': async (name) => {
    coreAnswers(fixture(name));
    expect((await fetchCrmSubjects(secretEnv, 'event', '', undefined, 25, '2026-10-01')).subjects.map((subject) => subject.id)).toEqual([EVENT]);
  },
  'meet-crm-subjects-project-id.get': async (name) => {
    coreAnswers(fixture(name));
    expect((await fetchCrmSubject(secretEnv, 'project', PROJECT))?.id).toBe(PROJECT);
    expect((await fetchCrmSubjectDetail(secretEnv, 'project', PROJECT)).id).toBe(PROJECT);
  },
  'meet-crm-subjects-lead-id.get': async (name) => {
    coreAnswers(fixture(name));
    expect((await fetchCrmSubjectDetail(secretEnv, 'lead', LEAD)).id).toBe(LEAD);
  },
  'meet-crm-subjects-partner-id.get': async (name) => {
    coreAnswers(fixture(name));
    expect((await fetchCrmSubjectDetail(secretEnv, 'organization', ORGANIZATION)).id).toBe(ORGANIZATION);
  },
  'meet-crm-subjects-event-id.get': async (name) => {
    coreAnswers(fixture(name));
    expect((await fetchCrmSubjectDetail(secretEnv, 'event', EVENT)).id).toBe(EVENT);
  },
  'meet-crm-subjects-counts.get': async (name) => {
    coreAnswers(fixture(name));
    expect(await fetchCrmSubjectCounts(secretEnv, 'project', '')).toBeTruthy();
  },
  'meet-crm-subjects.post': async (name) => {
    coreAnswers(fixture(name));
    expect((await createCrmSubject(secretEnv, { kind: 'project', title: 'Pilot programme' }, ACTOR)).id).toBe(PROJECT);
  },
  'meet-crm-subjects.patch': async (name) => {
    coreAnswers(fixture(name));
    expect((await updateCrmSubject(secretEnv, 'project', PROJECT, { status: 'Paused' }, ACTOR)).id).toBe(PROJECT);
  },
  // Choosing who is responsible (core#155): the lead comes back with the choice.
  'meet-crm-subjects-responsible.patch': async (name) => {
    coreAnswers(fixture(name));
    const subject = await updateCrmSubject(secretEnv, 'lead', LEAD, { responsible_email: 'ada@example.com' }, ACTOR);
    expect(subject).toMatchObject({ id: LEAD, responsible_email: 'ada@example.com', responsible_set_by: 'owner@example.com' });
  },

  // Meet's Worker hands this projection to the Mac and the web as it is: the
  // proxy must not drop or rename a field on the way.
  'meet-events.get': async (name) => {
    coreAnswers(fixture(name));
    const response = await routePublicEventsProxy(
      new Request('https://meet.test/api/public/events?startDate=2026-10-05&endDate=2026-10-11'),
      secretEnv,
      '/api/public/events',
    );
    expect(await response?.json()).toEqual(fixture(name));
  },

  // Event sign-up (meet#965, meet#966): the store seam's Core client.
  'meet-session-events.get': async (name) => {
    coreAnswers(fixture(name));
    expect(await sessionEventBySlug(secretEnv, 'starlings-at-work-abcdef12')).toMatchObject({ id: SESSION_EVENT, room_slug: 'rosa', registration_count: 1, description: 'A live call where Starlings runs a real project. Bring a question.' });
  },
  'meet-session-events-registrations.post': async (name) => {
    coreAnswers(fixture(name));
    const event = { id: SESSION_EVENT } as SessionEventRecord;
    const result = await registerForSession(secretEnv, event, { name: 'Ada Example', email: 'ada@example.test', join_token: 'OTHERTOKEN000001', ics_uid: 'x' });
    expect(result).toMatchObject({ kind: 'registered', created: false, registration: { join_token: 'K7Q2M9X4C8V1B6N3' } });
  },
  'meet-session-events-token-hashes.get': async (name) => {
    coreAnswers(fixture(name));
    expect(await sessionTokenHashes(secretEnv, SESSION_EVENT)).toEqual([await sha256Hex('K7Q2M9X4C8V1B6N3')]);
  },
  'meet-session-events-mail-due.get': async (name) => {
    coreAnswers(fixture(name));
    expect((await registrationsNeedingMail(secretEnv, SESSION_EVENT, 'reminder')).map((row) => row.email)).toEqual(['ada@example.test']);
  },
  'meet-session-registrations-resolve.post': async (name) => {
    coreAnswers(fixture(name));
    expect(await resolveSessionToken(secretEnv, 'K7Q2M9X4C8V1B6N3')).toMatchObject({ event_id: SESSION_EVENT, status: 'registered' });
  },
  'meet-session-registrations-cancel.post': async (name) => {
    coreAnswers(fixture(name));
    expect(await cancelSessionRegistration(secretEnv, 'K7Q2M9X4C8V1B6N3')).toMatchObject({ status: 'cancelled' });
  },
  'meet-session-registrations-stamp.post': async (name) => {
    coreAnswers(fixture(name));
    expect(await stampSessionMail(secretEnv, 'abcdef12-0000-4000-8000-000000000002', 'reminder')).toBe(true);
  },
};

/** What Core posts to Meet: each body must parse with the schema Meet's door reads it with, and lose nothing in the parse. */
const CHANNEL_EVENTS = [
  'meet-channel-events-issue.post',
  'meet-channel-events-pull.post',
  'meet-channel-events-commit.post',
  'meet-channel-events-run.post',
  'meet-channel-events-release.post',
  'meet-channel-events-lead.post',
  'meet-channel-events-offer.post',
  'meet-channel-events-offer-extension.post',
  'meet-channel-events-offer-viewed.post',
  'meet-channel-events-project-viewed.post',
  'meet-channel-events-pricing-request.post',
  'meet-channel-events-readiness-assessment.post',
  // The one subject kind that is not a lead or a project: a partner (meet#608).
  'meet-channel-events-support-case.post',
];

const PING = 'meet-ping.post';

/** What Core sends the Worker's `/api/internal/core-writes` for one CRM write (meet#275). */
const CORE_WRITE_REQUEST = 'meet-crm-writes-request.post';

const claimed = new Set([...Object.keys(reads), ...CHANNEL_EVENTS, PING, CORE_WRITE_REQUEST]);
const present = Object.keys(fixtures).map((file) => file.replace('../../../fixtures/core/', '').replace(/\.json$/u, ''));

describe('Core fixtures', () => {
  it('has every file claimed by a case, and every case backed by a file', () => {
    expect(present.filter((name) => !claimed.has(name))).toEqual([]);
    expect([...claimed].filter((name) => !present.includes(name))).toEqual([]);
  });

  it('holds no real name or address: invented data only', () => {
    const text = JSON.stringify(fixtures);
    expect(text).not.toMatch(/@(gmail|outlook|hotmail)\./u);
  });
});

describe('what Core answers, through the reader Meet uses for each route', () => {
  it.each(Object.keys(reads))('%s', async (name) => {
    await reads[name]!(name);
  });

  it('names the path when Core drops a field the schema needs', async () => {
    const body = structuredClone(fixture('meet-crm-tasks.get'));
    delete body.tasks[1].title;
    coreAnswers(body);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(fetchCrmTasks(secretEnv, { projectId: PROJECT })).rejects.toMatchObject({
      status: 502,
      code: 'upstream_shape',
      message: expect.stringContaining('tasks.1.title'),
    });
  });
});

/** Core's `partner` kind as Meet reads it (ADR 0006): the inverse of `toCoreKinds`. */
function fromCoreKinds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromCoreKinds);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [
    key,
    (key === 'kind' || key === 'subject_kind') && inner === 'partner' ? 'organization' : fromCoreKinds(inner),
  ]));
}

describe('what Core sends Meet', () => {
  it.each(CHANNEL_EVENTS)('%s parses with internalChannelEventSchema, and the parse drops nothing', (name) => {
    const body = fixture(name);
    const parsed = internalChannelEventSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    // A field Core sends that the schema does not know is stripped silently by
    // zod; equal means Meet reads every field Core wrote. Core's subject kind
    // `partner` reads as `organization` (ADR 0006).
    expect(parsed.data).toEqual(fromCoreKinds(body));
  });

  it(`${CORE_WRITE_REQUEST} parses with coreWriteRequestSchema, and the parse drops nothing`, () => {
    const body = fixture(CORE_WRITE_REQUEST);
    const parsed = coreWriteRequestSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data).toEqual(body);
  });

  it('the ping is accepted by the route that answers it', async () => {
    const raw = JSON.stringify(fixture(PING));
    const timestamp = String(Date.now());
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('inbound-test-secret-with-at-least-32-characters'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${raw}`)))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const response = await exports.default.fetch(new Request('http://local/api/internal/ping', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key-id': 'core', 'x-internal-timestamp': timestamp, 'x-internal-signature': signature },
      body: raw,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, pong: true });
  });
});

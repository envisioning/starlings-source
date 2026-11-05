import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThreadMessagesResponse } from '@starlings/contracts';
import { githubIssueEventKey, openSubjectThread, postIssueEvent } from '../src/threads';
import { recordOwnerSignIn } from '../src/usage';

import { requireCapability } from '../src/capabilities';
// The person a route's gate has already read: what a thread function takes now.
const memberOf = (request: Request) => requireCapability(request, env as Env, 'conversations');

/**
 * A GitHub issue reporting itself into the project's channel.
 *
 * Two properties are worth pinning. The line names the project the client
 * claimed only when Core agrees the repository is linked to it — otherwise a
 * colleague could put a sentence about someone else's issue in any channel.
 * And the same change reported twice is one line, which is what will keep
 * Core's webhook from repeating what Meet already said.
 */

const rosa = { sub: 'issue-evt-rosa', email: 'issue-evt-rosa@example.com', name: 'Rosa' };

const withCore = {
  ...env,
  INTERNAL_REQUEST_SECRET: 'meet-core-shared-secret-at-least-32-chars',
} as Env;

// One project per test: D1 is wiped between tests, a Durable Object's storage
// is not, so two tests on one project would share a channel.
const linkedProject = 'b1c2d3e4-0000-4a00-8000-00000000a001';
const otherProject = 'b1c2d3e4-0000-4a00-8000-00000000a002';
const twiceProject = 'b1c2d3e4-0000-4a00-8000-00000000a003';

/**
 * Core, answering the two questions this path asks it: which subject is this,
 * and which repositories are linked to it. Routed on the path because the
 * order of the calls is an implementation detail no test should depend on.
 */
function coreReturns(options: { title: string; repos: Array<{ owner: string; repo: string }> }) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = url.pathname.includes('project-repos')
      ? {
          repos: options.repos.map((link, index) => ({
            id: `link-${index}`, ...link, label: null, milestone: null, is_primary: index === 0,
          })),
        }
      : {
          ok: true,
          subjects: [{ id: url.searchParams.get('id'), kind: 'project', title: options.title, subtitle: null }],
        };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
}

async function member() {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: rosa.name, email: rosa.email }),
  }));
  const body = await response.json<{ access_token: string }>();
  await recordOwnerSignIn(env as Env, { sub: `dev:${rosa.email}`, email: rosa.email, name: rosa.name }, 'mac');
  return { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json' };
}

async function channelMessages(headers: Record<string, string>, projectID: string) {
  const thread = await openSubjectThread(
    await memberOf(new Request('http://local/api/threads', { method: 'POST', headers })), withCore, 'project', projectID,
  );
  const response = await exports.default.fetch(
    new Request(`http://local/api/threads/${thread.id}/messages`, { headers }),
  );
  return (await response.json<ThreadMessagesResponse>()).messages;
}

afterEach(() => vi.unstubAllGlobals());

describe('the line an issue leaves in its project’s channel', () => {
  it('names what happened and carries a ref the client can open', async () => {
    const mine = await member();
    coreReturns({ title: 'Acme rollout', repos: [{ owner: 'envisioning', repo: 'starlings' }] });

    await postIssueEvent(withCore, {
      projectID: linkedProject,
      actor: 'Rosa',
      owner: 'envisioning',
      repo: 'starlings',
      number: 142,
      title: 'Raise hand, across web, Mac, and iOS',
      verb: 'filed',
    });

    const messages = await channelMessages(mine, linkedProject);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'event',
      text: 'Rosa filed #142 · Raise hand, across web, Mac, and iOS',
      sender_email: 'meet@org.example',
      refs: [{ kind: 'issue', id: 'envisioning/starlings#142' }],
    });
  });

  it('writes nothing when the repository is not on the project the client named', async () => {
    // The update body has no project, so the client supplies one — which means
    // an unchecked line could be dropped into any channel by naming it.
    const mine = await member();
    coreReturns({ title: 'Someone else’s project', repos: [{ owner: 'envisioning', repo: 'core' }] });

    await postIssueEvent(withCore, {
      projectID: otherProject,
      actor: 'Rosa',
      owner: 'envisioning',
      repo: 'starlings',
      number: 7,
      title: 'Not this project’s issue',
      verb: 'closed',
    });

    expect(await channelMessages(mine, otherProject)).toHaveLength(0);
  });

  it('says one change once, however many times it is reported', async () => {
    const mine = await member();
    coreReturns({ title: 'Acme rollout', repos: [{ owner: 'envisioning', repo: 'starlings' }] });
    const closing = {
      projectID: twiceProject,
      actor: 'Rosa',
      owner: 'envisioning',
      repo: 'starlings',
      number: 9,
      title: 'Mic mute kills the speaker',
      verb: 'closed',
    } as const;

    await postIssueEvent(withCore, closing);
    await postIssueEvent(withCore, closing);
    // And the reason Meet knew is not a second event either: `not_planned` is
    // the same close, rephrased.
    await postIssueEvent(withCore, { ...closing, verb: 'closed_not_planned' });

    expect(await channelMessages(mine, twiceProject)).toHaveLength(1);
  });
});

describe('the key both reporters of one change agree on', () => {
  it('speaks GitHub’s vocabulary, not ours', () => {
    // Core sees a webhook `action`; this Worker sees a request. The key is the
    // only thing they share, so it is built from what GitHub calls it.
    expect(githubIssueEventKey('envisioning/starlings#1', 'filed')).toBe('github:envisioning/starlings#1:opened');
    expect(githubIssueEventKey('envisioning/starlings#1', 'reopened')).toBe('github:envisioning/starlings#1:reopened');
  });

  it('collapses a close and a close-as-not-planned', () => {
    expect(githubIssueEventKey('envisioning/starlings#1', 'closed_not_planned'))
      .toBe(githubIssueEventKey('envisioning/starlings#1', 'closed'));
  });
});

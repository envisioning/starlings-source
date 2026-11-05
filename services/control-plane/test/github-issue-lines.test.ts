// What the GitHub connector's issues phase says in a subject's channel, and
// what it refuses to say. This is the half of the sync that exists because
// Core's webhook edge went down for a week and nothing noticed (meet#205);
// see docs/GITHUB_CONNECTOR.md §The issues phase.
import { describe, expect, it } from 'vitest';
import { issueChange, type GithubIssueRow } from '../src/github-connector';
import { githubIssueEventKey, githubIssueLine } from '../src/threads';

const CURSOR = '2026-09-13T06:00:00Z';

function issue(patch: Partial<GithubIssueRow>): GithubIssueRow {
  return {
    number: 12,
    title: 'The organization switcher',
    state: 'open',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-20T00:00:00Z',
    user: { login: 'rosaortiz' },
    ...patch,
  };
}

describe('issueChange', () => {
  it('reports an issue filed after the cursor, as its author', () => {
    const change = issueChange(issue({ created_at: '2026-09-20T00:00:00Z' }), CURSOR);
    expect(change).toEqual({ verb: 'filed', actor: 'rosaortiz' });
  });

  it('reports a close after the cursor, and says who closed it when GitHub does', () => {
    const change = issueChange(issue({
      state: 'closed',
      closed_at: '2026-09-20T00:00:00Z',
      closed_by: { login: 'ana' },
    }), CURSOR);
    expect(change).toEqual({ verb: 'closed', actor: 'ana' });
  });

  it('names nobody rather than the author when GitHub omits who closed it', () => {
    const change = issueChange(issue({ state: 'closed', closed_at: '2026-09-20T00:00:00Z' }), CURSOR);
    expect(change).toEqual({ verb: 'closed', actor: null });
  });

  it('separates a close that was not planned', () => {
    const change = issueChange(issue({
      state: 'closed',
      closed_at: '2026-09-20T00:00:00Z',
      state_reason: 'not_planned',
      closed_by: { login: 'ana' },
    }), CURSOR);
    expect(change?.verb).toBe('closed_not_planned');
  });

  it('says nothing about an old open issue that was merely edited', () => {
    // Open, created before the cursor, updated after it: a label, an
    // assignee, a comment, or a reopen. The list cannot tell which.
    expect(issueChange(issue({}), CURSOR)).toBeNull();
  });

  it('says nothing about a close that happened before the cursor', () => {
    expect(issueChange(issue({
      state: 'closed',
      closed_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-09-20T00:00:00Z',
    }), CURSOR)).toBeNull();
  });
});

describe('githubIssueLine', () => {
  it('puts the actor first when there is one', () => {
    expect(githubIssueLine({ actor: 'ana', number: 311, title: 'Organization switcher', verb: 'closed' }))
      .toBe('ana closed #311 · Organization switcher');
  });

  it('drops the name rather than guessing one', () => {
    expect(githubIssueLine({ actor: null, number: 311, title: 'Organization switcher', verb: 'closed' }))
      .toBe('#311 closed · Organization switcher');
  });
});

describe('githubIssueEventKey', () => {
  it('is the key both reporters agree on, so the second one writes nothing', () => {
    // Core's webhook and this sync report the same close. The key carries no
    // delivery id, which is what lets them meet.
    expect(githubIssueEventKey('envisioning/starlings#311', 'closed'))
      .toBe(githubIssueEventKey('envisioning/starlings#311', 'closed_not_planned'));
    expect(githubIssueEventKey('envisioning/starlings#311', 'filed')).toBe('github:envisioning/starlings#311:opened');
  });
});

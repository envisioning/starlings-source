import { describe, expect, it } from 'vitest';
import type { InboxItem } from '@starlings/contracts/inbox';
import { boardCards, type CrmBoardResponse } from './crm-work';
import { inboxItemHref, inboxItemMeta } from './inbox-rows';

const org = '11111111-1111-1111-1111-111111111111';

describe('partner tasks on the board', () => {
  const response = {
    subjects: [
      { id: org, kind: 'organization', title: 'Echos', subtitle: null },
      { id: 'p1', kind: 'project', title: 'Atlas', subtitle: null },
    ],
    tasks: [
      { id: 't1', title: 'Call Echos', organization_id: org, project_id: null, lead_id: null, status: 'open' },
      { id: 't2', title: 'Ship', organization_id: org, project_id: 'p1', lead_id: null, status: 'open' },
    ],
    issues: [],
    traces: [],
    issue_projects: {},
    partial: [],
    finished_since: '2026-09-01T00:00:00Z',
  } as unknown as CrmBoardResponse;

  it('titles a partner card by its organization and a project card by its project', () => {
    const cards = boardCards(response);
    expect(cards.find((card) => card.id === 't1')?.subject?.title).toBe('Echos');
    expect(cards.find((card) => card.id === 't2')?.subject?.title).toBe('Atlas');
  });
});

describe('partner proposals in the INBOX', () => {
  const item = {
    source: 'task', key: 'k', task: { id: 't1', title: 'Call Echos' },
    subject: { kind: 'organization', id: org, title: 'Echos' },
  } as unknown as InboxItem;

  it('says Partner and opens the partner subject', () => {
    expect(inboxItemMeta(item).detail).toBe('Proposed · Partner · Echos');
    expect(inboxItemHref(item)).toBe(`/work/organization/${org}?pane=tasks`);
  });

});

import { describe, expect, it } from 'vitest';
import { calendarWorkItemsQuerySchema } from '@starlings/contracts';
import { markOwnWorkItems, type CrmWorkItem } from '../src/crm';

function item(overrides: Partial<CrmWorkItem>): CrmWorkItem {
  return {
    id: 'a',
    kind: 'task',
    assignee_id: null,
    assignee_name: null,
    assignee_email: null,
    title: 'Task',
    notes: null,
    status: 'pending',
    due_at: '2026-08-17T09:00:00.000Z',
    priority: null,
    responsible_party: 'team',
    project_id: null,
    project_title: null,
    lead_id: null,
    milestone_id: null,
    updated_at: null,
    ...overrides,
  };
}

describe('marking your own work', () => {
  it('keeps the team’s items and flags only yours', () => {
    const marked = markOwnWorkItems(
      [
        item({ id: 'mine', assignee_email: 'ROSA@example.com' }),
        item({ id: 'theirs', assignee_email: 'someone@example.com' }),
        item({ id: 'nobody' }),
      ],
      'rosa@example.com',
    );
    expect(marked).toHaveLength(3);
    expect(marked.find((row) => row.id === 'mine')?.mine).toBe(true);
    expect(marked.find((row) => row.id === 'theirs')?.mine).toBe(false);
    expect(marked.find((row) => row.id === 'nobody')?.mine).toBe(false);
  });

  it('claims nothing when the owner has no email', () => {
    const marked = markOwnWorkItems([item({ assignee_email: 'rosa@example.com' })], undefined);
    expect(marked[0]?.mine).toBe(false);
  });
});

describe('calendar work item query', () => {
  it('accepts a plain date range', () => {
    const parsed = calendarWorkItemsQuerySchema.parse({
      start: '2026-08-01',
      end: '2026-08-31',
    });
    expect(parsed.start).toBe('2026-08-01');
    expect(parsed.include_done).toBe(false);
  });

  it('rejects timestamps, because these are dates not instants', () => {
    expect(() => calendarWorkItemsQuerySchema.parse({
      start: '2026-08-01T00:00:00.000Z',
      end: '2026-08-31',
    })).toThrow();
  });

  it('rejects a range that runs backwards', () => {
    expect(() => calendarWorkItemsQuerySchema.parse({
      start: '2026-08-31',
      end: '2026-08-01',
    })).toThrow();
  });

  it('allows an equal start and end, which is a single day', () => {
    expect(() => calendarWorkItemsQuerySchema.parse({
      start: '2026-08-17',
      end: '2026-08-17',
    })).not.toThrow();
  });

  it('caps how much can be asked for at once', () => {
    expect(() => calendarWorkItemsQuerySchema.parse({
      start: '2026-01-01',
      end: '2026-12-31',
    })).toThrow(/cannot exceed/u);
  });
});

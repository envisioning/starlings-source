import { describe, expect, it } from 'vitest';
import type { InboxItem, InboxResponse } from '@starlings/contracts/inbox';
import { attentionFromOpenQuestion } from '@starlings/contracts/attention';
import { inboxItemHref, inboxItemMeta, retainQuestionInbox } from './inbox-rows';

const request = attentionFromOpenQuestion({ id: 'message', thread_id: 'thread', sent_at: Date.now(), sender_email: 'agent-vocab@example.com', sender_name: 'Vocab', text: 'Which version?' },
  { mode: 'single', options: [{ id: 'short', label: 'Short' }, { id: 'long', label: 'Long' }] }, 'ada@example.com');
const item: InboxItem = { source: 'question', key: request.id, at: Date.now(), request: { ...request, context: 'Project Talk' } };
const response = (partial: InboxResponse['partial']): InboxResponse => ({ items: [], partial, recent: [], recent_partial: [] });
describe('question Inbox projections', () => {
  it('names the asker and source context and links by canonical identity', () => {
    const meta = inboxItemMeta(item);
    expect(meta.title).toBe('Which version?');
    expect(meta.detail).toBe('Question · Asked by Vocab · Project Talk');
    expect(inboxItemHref(item)).toBe(`/work?question=${encodeURIComponent(request.id)}`);
  });
  it('retains the last known question on partial reads but removes it on a successful empty read', () => {
    expect(retainQuestionInbox([item], response(['question'])).items).toEqual([item]);
    expect(retainQuestionInbox([item], response([])).items).toEqual([]);
  });
});

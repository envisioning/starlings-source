import { describe, expect, it } from 'vitest';
import type { InboxItem } from '@starlings/contracts/inbox';
import { inboxItemHref, inboxItemMeta } from './inbox-rows';
import { subjectHref, teamThreadHref } from './work-hrefs';

const appUser: InboxItem = {
  source: 'guest',
  key: 'guest:thread-app',
  at: Date.now(),
  thread_id: 'thread-app',
  subject: { kind: 'organization', id: 'intake', title: 'App user · Ada' },
  sender_email: null,
  preview: 'Can I export my notes?',
  origin: 'app',
};

describe('guest Inbox rows', () => {
  it('opens an app user\'s intake row in its conversation', () => {
    expect(inboxItemHref(appUser)).toBe(teamThreadHref('thread-app'));
    expect(inboxItemMeta(appUser).detail).toBe('App user · Can I export my notes?');
  });

  it('opens a guest line on a subject at that subject', () => {
    const onSubject: InboxItem = { ...appUser, subject: { kind: 'lead', id: 'lead-1', title: 'Acme' }, origin: 'guest' };
    expect(inboxItemHref(onSubject)).toBe(subjectHref(onSubject.subject));
  });
});

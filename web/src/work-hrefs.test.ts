import { describe, expect, it } from 'vitest';
import { parsePermalinkPath } from '@starlings/contracts/permalinks';
import { contactHref, documentHref, eventHref, issueHref, peerHref, subjectHref, taskHref, teamThreadHref } from './work-hrefs';

// meet#581: every record a member page opens has one address, and the
// parser the router and the Worker share reads back the record it names.
describe('record permalinks', () => {
  const path = (href: string) => href.split('?')[0]!;

  it('round-trips each kind through the shared parser', () => {
    expect(parsePermalinkPath(taskHref('rec1'))).toEqual({ surface: 'work', kind: 'task', id: 'rec1' });
    expect(parsePermalinkPath(path(subjectHref({ kind: 'project', id: 'p1' }, { pane: 'tasks' })))).toEqual({ surface: 'work', kind: 'project', id: 'p1' });
    expect(parsePermalinkPath(issueHref('envisioning/starlings#581'))).toEqual({ surface: 'work', kind: 'issue', id: 'envisioning/starlings#581' });
    expect(parsePermalinkPath(documentHref('d 1/x'))).toEqual({ surface: 'docs', kind: 'document', id: 'd 1/x' });
    expect(parsePermalinkPath(path(eventHref('primary:abc', '2026-09-30')))).toEqual({ surface: 'calendar', kind: 'event', id: 'primary:abc' });
    expect(parsePermalinkPath(teamThreadHref('t1'))).toEqual({ surface: 'team', kind: 'thread', id: 't1' });
    expect(parsePermalinkPath(peerHref({ email: 'vocab@example.com', kind: 'agent' }))).toEqual({ surface: 'team', kind: 'agent', id: 'vocab' });
    expect(parsePermalinkPath(contactHref('c1'))).toEqual({ surface: 'work', kind: 'contact', id: 'c1' });
  });

  it('names a person or an agent by the local part of the address', () => {
    expect(peerHref({ email: 'Ada@example.com', kind: 'human' })).toBe('/team/person/ada');
    expect(peerHref({ email: 'vocab@example.com', kind: 'agent' })).toBe('/team/agent/vocab');
  });

  it('keeps context and verbs in the query', () => {
    expect(subjectHref({ kind: 'lead', id: 'l1' }, { pane: 'issues', new: 'issue' })).toBe('/work/lead/l1?pane=issues&new=issue');
    expect(eventHref('primary:abc', '2026-09-30')).toBe('/calendar/event/primary%3Aabc?day=2026-09-30');
  });

  it('sends an issue id with no permalink to Work itself', () => {
    expect(issueHref('not-an-issue')).toBe('/work');
  });

  it('is not fooled by the view segments that share the prefix', () => {
    expect(parsePermalinkPath('/work/browse')).toBeNull();
    expect(parsePermalinkPath('/work/projects/p1')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { decisionLine } from '../src/crm-actions';
import { documentChannels } from '../src/mcp';

/**
 * The channel lines a member's Claude leaves (meet#713): a decision it
 * recorded names it, and a document it wrote on a subject reaches that
 * subject's channel.
 */

describe('decision line', () => {
  const owner = { email: 'rosa@example.com', name: 'Rosa' };

  it('names the Claude when an agent recorded it', () => {
    expect(decisionLine(owner, { source: 'agent', source_ref: 'claude.ai' }, 'Ship it'))
      .toBe('Rosa via claude.ai recorded a decision: Ship it');
  });

  it('names the member for any other source', () => {
    expect(decisionLine(owner, { source: 'manual', source_ref: null }, 'Ship it')).toBe('Rosa recorded a decision: Ship it');
    expect(decisionLine({ email: 'rosa@example.com' }, { source: 'agent' }, 'Ship it')).toBe('rosa@example.com recorded a decision: Ship it');
  });
});

describe('document channels', () => {
  it('maps Core projects, leads and organizations to channels, once each', () => {
    expect(documentChannels([
      { system: 'core', kind: 'project', subject_id: 'p1' },
      { system: 'core', kind: 'organization', subject_id: 'o1' },
      { system: 'core', kind: 'lead', subject_id: 'l1' },
      { system: 'core', kind: 'project', subject_id: 'p1' },
    ])).toEqual([
      { to: 'subject', subjectKind: 'project', id: 'p1' },
      { to: 'subject', subjectKind: 'organization', id: 'o1' },
      { to: 'subject', subjectKind: 'lead', id: 'l1' },
    ]);
  });

  it('skips subjects without a channel and caps at five', () => {
    expect(documentChannels([
      { system: 'core', kind: 'contact', subject_id: 'c1' },
      { system: 'core', kind: 'offer', subject_id: 'x1' },
      { system: 'other', kind: 'project', subject_id: 'p0' },
    ])).toEqual([]);
    const many = Array.from({ length: 8 }, (_, index) => ({ system: 'core', kind: 'project', subject_id: `p${index}` }));
    expect(documentChannels(many)).toHaveLength(5);
  });
});

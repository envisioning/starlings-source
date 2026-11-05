import { describe, expect, it } from 'vitest';
import type { GranolaFilingSuggestion } from '@starlings/contracts';
import { suggestedBody } from './MeetingFiling';

const suggestion = (patch: Partial<GranolaFilingSuggestion>): GranolaFilingSuggestion => ({
  meeting_kind: 'uncategorized',
  probability: 0.9,
  lead_id: null,
  project_id: null,
  event_id: null,
  partner_organization_id: null,
  subject_title: null,
  subject_probability: null,
  ...patch,
} as GranolaFilingSuggestion);

describe('suggestedBody', () => {
  it('files a partner suggestion on the organization', () => {
    expect(suggestedBody(suggestion({ meeting_kind: 'partner', partner_organization_id: 'org-1' })))
      .toEqual({ meeting_kind: 'partner', partner_organization_id: 'org-1' });
  });

  it('needs the picker when a partner suggestion names no organization', () => {
    expect(suggestedBody(suggestion({ meeting_kind: 'partner' }))).toBeNull();
  });

  it('files a kind with no subject as itself', () => {
    expect(suggestedBody(suggestion({ meeting_kind: 'internal' }))).toEqual({ meeting_kind: 'internal' });
  });
});

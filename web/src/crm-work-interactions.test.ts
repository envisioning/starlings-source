import { beforeEach, describe, expect, it, vi } from 'vitest';
import { crmInteractionCreateSchema, crmInteractionUpdateSchema } from '@starlings/contracts/crm';

const apiFetch = vi.fn();
vi.mock('./api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args), apiFetchConditional: vi.fn() }));
const invalidateFor = vi.fn();
vi.mock('./snapshot-store', async (original) => ({
  ...(await original<typeof import('./snapshot-store')>()),
  invalidateFor: (write: string) => invalidateFor(write),
}));

const {
  createInteraction,
  deleteInteraction,
  interactionCreateBody,
  interactionDraftFor,
  interactionLinksFor,
  interactionUpdateBody,
  updateInteraction,
} = await import('./crm-work');
type CrmInteraction = import('./crm-work').CrmInteraction;

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const LEAD = '33333333-3333-4333-8333-333333333333';
const CONTACT = '44444444-4444-4444-8444-444444444444';

const row: CrmInteraction = {
  id: 'i 1',
  title: 'Kickoff',
  type: 'email',
  occurred_at: '2026-10-20T09:30:15.000Z',
  created_at: null,
  summary_preview: null,
  summary_markdown: 'Talked scope.',
  transcript_preview: null,
  duration_minutes: null,
  project_id: PROJECT,
  lead_id: null,
  organization_id: ORG,
  source: null,
  channel: null,
  status: null,
  url: 'https://example.com/a',
  contacts: [{ id: CONTACT, name: 'Ada', email: null }],
};

beforeEach(() => {
  apiFetch.mockReset();
  invalidateFor.mockReset();
});

/* meet#1223: a call, meeting or note logged by hand on History. */
describe('interaction drafts', () => {
  it('files a new row on the subject: a project with its organization, a lead with its organization, an organization itself', () => {
    expect(interactionLinksFor({ kind: 'project', id: PROJECT, organization_id: ORG })).toEqual({ project_id: PROJECT, lead_id: null, organization_id: ORG });
    expect(interactionLinksFor({ kind: 'lead', id: LEAD, organization_id: ORG })).toEqual({ project_id: null, lead_id: LEAD, organization_id: ORG });
    expect(interactionLinksFor({ kind: 'organization', id: ORG })).toEqual({ project_id: null, lead_id: null, organization_id: ORG });
  });

  it('starts a new row as a call, now, in local minutes', () => {
    const now = new Date(2026, 9, 22, 14, 5, 40);
    const draft = interactionDraftFor(null, { project_id: PROJECT, lead_id: null, organization_id: ORG }, now);
    expect(draft).toEqual({
      type: 'call', title: '', occurred_at: '2026-10-22T14:05', summary: '', url: '',
      organization_id: ORG, lead_id: '', project_id: PROJECT, contact_ids: [],
    });
  });

  it('builds a create body the wire accepts, leaving empty fields out', () => {
    const draft = { ...interactionDraftFor(null, { project_id: PROJECT, lead_id: null, organization_id: ORG }), title: '  Call with Ada ', url: 'example.com/notes', contact_ids: [CONTACT] };
    const body = interactionCreateBody(draft);
    expect(body).toMatchObject({ type: 'call', title: 'Call with Ada', url: 'https://example.com/notes', project_id: PROJECT, organization_id: ORG, contact_ids: [CONTACT] });
    expect(body).not.toHaveProperty('lead_id');
    expect(body).not.toHaveProperty('summary_markdown');
    expect(crmInteractionCreateSchema.safeParse(body).success).toBe(true);
  });

  it('refuses a clock that is not 24-hour HH:MM', () => {
    const draft = { ...interactionDraftFor(null, { project_id: PROJECT, lead_id: null, organization_id: ORG }), title: 'x', occurred_at: '2026-10-22T9:5' };
    expect(() => interactionCreateBody(draft)).toThrow('Enter times as HH:MM in 24-hour time.');
  });

  it('sends only what an edit changed, nulls for a cleared field, and keeps an email row’s type', () => {
    const draft = interactionDraftFor(row, row);
    expect(interactionUpdateBody(row, draft)).toEqual({});
    const body = interactionUpdateBody(row, { ...draft, title: 'Kickoff call', url: '', project_id: '', lead_id: LEAD, contact_ids: [] });
    expect(body).toEqual({ title: 'Kickoff call', url: null, project_id: null, lead_id: LEAD, contact_ids: [] });
    expect(crmInteractionUpdateSchema.safeParse(body).success).toBe(true);
  });
});

describe('interaction writes', () => {
  it('posts a new row and clears History', async () => {
    const saved = { ...row, id: 'new', type: 'call' as const };
    apiFetch.mockResolvedValueOnce({ interaction: saved });
    const draft = { ...interactionDraftFor(null, { project_id: PROJECT, lead_id: null, organization_id: ORG }), title: 'Call' };
    await expect(createInteraction(draft)).resolves.toEqual(saved);
    expect(apiFetch).toHaveBeenCalledWith('/crm/interactions', expect.objectContaining({ method: 'POST', fallbackError: 'Couldn’t log that interaction.', body: interactionCreateBody(draft) }));
    expect(invalidateFor).toHaveBeenCalledWith('interaction.write');
  });

  it('patches the row and clears History', async () => {
    const moved = { ...row, project_id: null, lead_id: LEAD };
    apiFetch.mockResolvedValueOnce({ interaction: moved });
    await updateInteraction(row, { ...interactionDraftFor(row, row), project_id: '', lead_id: LEAD });
    expect(apiFetch).toHaveBeenCalledWith('/crm/interactions/i%201', { method: 'PATCH', fallbackError: 'Couldn’t update that interaction.', body: { project_id: null, lead_id: LEAD } });
    expect(invalidateFor).toHaveBeenCalledWith('interaction.write');
  });

  it('deletes the row and clears History; a refusal passes on and drops nothing', async () => {
    apiFetch.mockResolvedValueOnce({ id: 'i 1', deleted: true });
    await expect(deleteInteraction(row)).resolves.toEqual({ id: 'i 1', deleted: true });
    expect(apiFetch).toHaveBeenCalledWith('/crm/interactions/i%201', { method: 'DELETE', fallbackError: 'Couldn’t delete that interaction.' });
    expect(invalidateFor).toHaveBeenCalledWith('interaction.write');

    invalidateFor.mockReset();
    apiFetch.mockRejectedValueOnce(new Error('You can’t change this subject.'));
    await expect(deleteInteraction(row)).rejects.toThrow('You can’t change this subject.');
    expect(invalidateFor).not.toHaveBeenCalled();
  });
});

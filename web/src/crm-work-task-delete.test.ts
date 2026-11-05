import { describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('./api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args), apiFetchConditional: vi.fn() }));

const { cardPassesTaskFilter, deleteTask, fetchOrganizationProjectTasks, sideChoiceTitle, taskPassesTaskFilter } = await import('./crm-work');
const { workspaceBrand } = await import('./workspace-brand');

/* meet#1222: task delete and the Due and Side filters on the web. */
describe('deleteTask', () => {
  it('sends DELETE to the task, with the delete fallback', async () => {
    apiFetch.mockResolvedValueOnce({ id: 't 1', deleted: true });
    await expect(deleteTask('t 1')).resolves.toEqual({ id: 't 1', deleted: true });
    expect(apiFetch).toHaveBeenCalledWith('/crm/tasks/t%201', { method: 'DELETE', fallbackError: 'Couldn’t delete that task.' });
  });

  it('passes the Worker’s refusal on', async () => {
    apiFetch.mockRejectedValueOnce(new Error('You can’t change this subject.'));
    await expect(deleteTask('t2')).rejects.toThrow('You can’t change this subject.');
  });
});

describe('fetchOrganizationProjectTasks', () => {
  it('reads the organization’s tasks by project, never from the store', async () => {
    apiFetch.mockResolvedValueOnce({ projects: [], partial: false });
    await expect(fetchOrganizationProjectTasks('o 1')).resolves.toEqual({ projects: [], partial: false });
    expect(apiFetch).toHaveBeenLastCalledWith('/crm/subjects/organization/o%201/project-tasks', { noStore: true, fallbackError: 'Couldn’t load tasks.' });
  });
});

describe('task filters', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  const late = { status: 'open', due_date: '2026-10-01T00:00:00Z', responsible_party: 'client' as const };

  it('reads a subject task’s side and date', () => {
    expect(taskPassesTaskFilter(late, { due: 'overdue', side: 'any' }, now)).toBe(true);
    expect(taskPassesTaskFilter(late, { due: 'any', side: 'client' }, now)).toBe(true);
    expect(taskPassesTaskFilter(late, { due: 'any', side: 'team' }, now)).toBe(false);
    expect(taskPassesTaskFilter({ ...late, due_date: '2026-11-01T00:00:00Z' }, { due: 'overdue', side: 'any' }, now)).toBe(false);
  });

  it('reads a board card’s side off its task, and hides issues while a filter is set', () => {
    const task = { id: 't1', responsible_party: 'team' } as never;
    const card = { id: 't1', origin: 'task', task, done: false, filed: true, status: 'open', dueDate: null } as never;
    expect(cardPassesTaskFilter(card, { due: 'any', side: 'team' }, now)).toBe(true);
    expect(cardPassesTaskFilter(card, { due: 'any', side: 'client' }, now)).toBe(false);
    const issue = { id: 'o/r#1', origin: 'issue', done: false, filed: true, state: 'open' } as never;
    expect(cardPassesTaskFilter(issue, { due: 'any', side: 'any' }, now)).toBe(true);
    expect(cardPassesTaskFilter(issue, { due: 'any', side: 'team' }, now)).toBe(false);
  });

  it('names the team side after the workspace', () => {
    expect(sideChoiceTitle({ value: 'team', title: 'Team' })).toBe(workspaceBrand().name);
    expect(sideChoiceTitle({ value: 'client', title: 'Client' })).toBe('Client');
  });
});

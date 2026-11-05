/**
 * Who answers for a project or a lead (docs/OWNERSHIP.md). A name,
 * never a permission: nothing here decides what anybody may see or do. Core
 * (or a D1 workspace) stores the chosen person; this module guards the choice
 * and clears it when the person leaves (decision 9).
 */
import { ControlError } from './errors';
import { openSubjects } from './board';
import { updateCrmSubject, workModelEnabled } from './crm';

/** The choice must name a person on this workspace who still has access; an agent never answers (decision 7). */
export async function requireResponsiblePerson(env: Env, email: string): Promise<void> {
  const row = await env.USAGE.prepare('SELECT kind, revoked_at FROM people WHERE email = ?1')
    .bind(email.trim().toLowerCase())
    .first<{ kind: string | null; revoked_at: number | null }>();
  if (!row || row.kind === 'agent' || row.revoked_at !== null) {
    throw new ControlError('Choose a person on this workspace.', 400, 'invalid_request');
  }
}

/**
 * A departure clears the person's choices (decision 9): each open project and
 * lead they were chosen for reads as nobody chosen again, so the suggestion
 * shows and nobody inherits the work silently. `actor` is the admin who
 * revoked. Returns how many subjects were cleared. A subject that fails to
 * clear is logged and left; the departure itself never fails on it.
 */
export async function clearResponsibleFor(env: Env, email: string, actor: string): Promise<number> {
  if (!workModelEnabled(env)) return 0;
  const gone = email.trim().toLowerCase();
  const partial: string[] = [];
  const subjects = (await openSubjects(env, partial))
    .filter((subject) => (subject.kind === 'project' || subject.kind === 'lead') && subject.responsible_email?.toLowerCase() === gone);
  let cleared = 0;
  for (const subject of subjects) {
    try {
      await updateCrmSubject(env, subject.kind as 'lead' | 'project', subject.id, { responsible_email: null }, actor);
      cleared += 1;
    } catch (error) {
      console.warn(JSON.stringify({
        level: 'warn',
        message: 'responsible.clear.failed',
        subject: `${subject.kind}/${subject.id}`,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  }
  return cleared;
}

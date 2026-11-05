import { parsePermalinkPath, peerPermalinkName, permalinkPath } from '@starlings/contracts/permalinks';

/**
 * Addresses into the member surfaces, with no DOM and no React:
 * `owner-agenda.ts` builds them, and the Worker's tests typecheck that file
 * without a window. `search-doors.ts` routes the palette's doors through the
 * same builders. Each is a record's permalink (the grammar in
 * `@starlings/contracts/permalinks`), with any context or verb in the query.
 */

function withQuery(path: string, extra: Record<string, string>): string {
  const query = new URLSearchParams(extra).toString();
  return query ? `${path}?${query}` : path;
}

/** A task by id. Work reads it in Mine, which holds only your own. */
export function taskHref(taskID: string): string {
  return permalinkPath({ surface: 'work', kind: 'task', id: taskID });
}

/** A subject's page in Work, with any pane or verb the caller adds. */
export function subjectHref(subject: { kind: string; id: string }, extra: Record<string, string> = {}): string {
  const kind = subject.kind as 'project' | 'lead' | 'organization' | 'event';
  return withQuery(permalinkPath({ surface: 'work', kind, id: subject.id }), extra);
}

/**
 * Anyone's task, read where it is filed: the subject's Tasks pane with the
 * task's editor open.
 */
export function subjectTaskHref(taskID: string, subject: { kind: string; id: string }): string {
  return subjectHref(subject, { pane: 'tasks', task: taskID, edit: 'task' });
}

/** A contact's page in Work. */
export function contactHref(contactID: string): string {
  return permalinkPath({ surface: 'work', kind: 'contact', id: contactID });
}

/** An issue by `owner/repo#n`, read in Work's column. */
export function issueHref(issueID: string): string {
  const path = permalinkPath({ surface: 'work', kind: 'issue', id: issueID });
  // An id that is not `owner/repo#n` has no permalink: Work itself.
  return parsePermalinkPath(path) ? path : '/work';
}

/** A Docs document by id. */
export function documentHref(documentID: string): string {
  return permalinkPath({ surface: 'docs', kind: 'document', id: documentID });
}

/**
 * A calendar event by `calendarId:eventId`. `day` (YYYY-MM-DD) names the
 * week to load first, when the caller knows it.
 */
export function eventHref(eventID: string, day?: string): string {
  return withQuery(permalinkPath({ surface: 'calendar', kind: 'event', id: eventID }), day ? { day } : {});
}

/** A person or an agent on Team, by name: `/team/person/ada`, `/team/agent/vocab`. */
export function peerHref(peer: { email: string; kind: string }): string {
  return permalinkPath({ surface: 'team', kind: peer.kind === 'agent' ? 'agent' : 'person', id: peerPermalinkName(peer.email) });
}

/**
 * A conversation on Team by its thread id; with a message id, the link lands
 * on that line, flashed once. Without one it lands on the newest.
 */
export function teamThreadHref(threadID: string, messageID?: string): string {
  const path = permalinkPath({ surface: 'team', kind: 'thread', id: threadID });
  return messageID ? `${path}#thread-message-${encodeURIComponent(messageID)}` : path;
}

/**
 * A partner task: filed on an organization and nothing else. Core also echoes
 * `organization_id` on a task that hangs off a project, lead or event (the
 * denormalized context), so the id alone does not make a partner task.
 */
export function isPartnerTask(row: {
  organization_id?: string | null;
  project_id?: string | null;
  lead_id?: string | null;
  event_id?: string | null;
  meeting_id?: string | null;
  signals_account_id?: string | null;
}): boolean {
  return Boolean(row.organization_id) && !row.project_id && !row.lead_id && !row.event_id && !row.meeting_id && !row.signals_account_id;
}

/** The subject a Core task or milestone is filed on. Core sets at most one of the ids; a partner's is its organization. */
export function workSubjectOf(row: {
  project_id?: string | null;
  lead_id?: string | null;
  event_id?: string | null;
  organization_id?: string | null;
  meeting_id?: string | null;
  signals_account_id?: string | null;
}): { kind: 'project' | 'lead' | 'event' | 'organization'; id: string } | null {
  if (row.project_id) return { kind: 'project', id: row.project_id };
  if (row.lead_id) return { kind: 'lead', id: row.lead_id };
  if (row.event_id) return { kind: 'event', id: row.event_id };
  if (isPartnerTask(row) && row.organization_id) return { kind: 'organization', id: row.organization_id };
  return null;
}

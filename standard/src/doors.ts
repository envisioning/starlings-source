/**
 * Doors: the stable address of a thing, passed between tools and agents.
 * The wire spelling is `<to>:<id>`, and `subject:<kind>:<id>` for a subject.
 * `parseDoor` is the one reader and `doorString` the one writer. Zod-free.
 *
 * These are thing doors only. A product adds its own doors for places and
 * verbs in its interface, and reads thing doors with `parseDoor`.
 */
import { readSubjectKind, type SubjectKind } from '@starlings/subject-spec/kinds';

/** Every kind of thing a door can name, in the order the spec lists them. */
export const DOOR_KINDS = ['subject', 'person', 'agent', 'contact', 'thread', 'document', 'event', 'task', 'issue'] as const;
export type DoorKind = (typeof DOOR_KINDS)[number];

/** The doors whose id is one opaque string. A subject door also names its kind. */
export const ID_DOOR_KINDS = ['person', 'agent', 'contact', 'thread', 'document', 'event', 'task', 'issue'] as const satisfies readonly DoorKind[];
export type IdDoorKind = (typeof ID_DOOR_KINDS)[number];

export type Door =
  | { to: 'subject'; subjectKind: SubjectKind; id: string }
  | { to: IdDoorKind; id: string };

export function parseDoor(door: string): Door | null {
  const colon = door.indexOf(':');
  if (colon <= 0) return null;
  const to = door.slice(0, colon);
  const rest = door.slice(colon + 1);
  if (rest.length === 0) return null;
  if (to === 'subject') {
    const second = rest.indexOf(':');
    if (second <= 0) return null;
    const subjectKind = readSubjectKind(rest.slice(0, second));
    const id = rest.slice(second + 1);
    return subjectKind && id.length > 0 ? { to, subjectKind, id } : null;
  }
  return (ID_DOOR_KINDS as readonly string[]).includes(to) ? { to: to as IdDoorKind, id: rest } : null;
}

export function doorString(door: Door): string {
  return door.to === 'subject' ? `subject:${door.subjectKind}:${door.id}` : `${door.to}:${door.id}`;
}

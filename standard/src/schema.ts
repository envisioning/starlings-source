import { z } from 'zod';
import { DOOR_KINDS, ID_DOOR_KINDS } from '@starlings/subject-spec/doors';
import { SUBJECT_KIND_ALIASES, SUBJECT_KINDS } from '@starlings/subject-spec/kinds';

/**
 * The records of the Starlings Subject Spec as zod schemas. The published JSON
 * Schema (`/spec/schema.json`) is generated from `STANDARD_SCHEMAS` at build
 * time, so the spec cannot say something this file does not.
 *
 * A product's wire shape may carry more fields than a record here. It must
 * carry every field, with the same type: Starlings checks its decision with
 * a compile-time assertion against this schema.
 */

export const subjectKindSchema = z.enum(SUBJECT_KINDS).describe('One of the subject kinds.');

export const doorKindSchema = z.enum(DOOR_KINDS).describe('What a door names.');

/** The door grammar `parseDoor` reads, as a pattern a JSON Schema validator can check. */
export const DOOR_PATTERN = new RegExp(`^(?:subject:(?:${[...SUBJECT_KINDS, ...Object.keys(SUBJECT_KIND_ALIASES)].join('|')}):.+|(?:${ID_DOOR_KINDS.join('|')}):.+)$`, 'u');

export const doorSchema = z.string()
  .regex(DOOR_PATTERN, 'A door is `<kind>:<id>`, or `subject:<subject kind>:<id>`.')
  .describe('The stable address of a thing: `<kind>:<id>`, or `subject:<subject kind>:<id>` for a subject.');

export const DECISION_SOURCES = ['message', 'meeting', 'manual', 'agent'] as const;
export const decisionSourceSchema = z.enum(DECISION_SOURCES)
  .describe('Where the decision was made: a message, a meeting, by hand, or by an agent acting for a person.');

export const DECISION_BODY_MAX_CHARS = 2_000;

/** A settled choice on one subject. Written once; a later decision that names it replaces it. */
export const decisionSchema = z.object({
  id: z.string().describe('Stable id of the decision.'),
  subject_kind: subjectKindSchema,
  subject_id: z.string().describe('Id of the subject the decision belongs to.'),
  body: z.string().max(DECISION_BODY_MAX_CHARS).describe('What was chosen, in one to a few sentences.'),
  source: decisionSourceSchema,
  source_ref: z.string().nullable().describe('The message id, the meeting id, or the agent, by `source`. Null for `manual`.'),
  goal_id: z.string().nullable().describe('The goal the decision serves, if any.'),
  decided_by_name: z.string().nullable().describe('Display name of the person who decided.'),
  decided_by_email: z.string().nullable().describe('Address of the person who decided.'),
  decided_at: z.string().describe('When it was decided, as an ISO 8601 timestamp.'),
}).describe('A settled choice on one subject.');
export type Decision = z.infer<typeof decisionSchema>;

/** A subject: one thing a company works on, holding its own history. */
export const subjectSchema = z.object({
  id: z.string().describe('Stable id of the subject, unique within its kind.'),
  kind: subjectKindSchema,
  title: z.string().describe('The name people use for it.'),
  subtitle: z.string().nullable().describe('One line of context: a client, a stage, a date. Null when there is none.'),
  last_activity_at: z.string().nullable().optional().describe('When something last happened on the subject, as an ISO 8601 timestamp. Null or absent when unknown.'),
}).describe('One thing a company works on: a project, a lead, an organization or an event.');
export type Subject = z.infer<typeof subjectSchema>;

/**
 * Where a task stands. `proposed` is a task an agent suggested and a person
 * has not accepted yet; `declined` is one a person turned down. The rest is
 * the usual board: open (`pending`, `in_progress`, `review`, `blocked`) and
 * finished (`completed`, `cancelled`).
 */
export const TASK_STATUSES = ['pending', 'in_progress', 'review', 'blocked', 'completed', 'cancelled', 'proposed', 'declined'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const taskStatusSchema = z.enum(TASK_STATUSES)
  .describe('Where the task stands. `proposed`: suggested by an agent, not yet accepted by a person. `declined`: turned down by a person.');

/** A day without a time or a zone. */
const civilDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'YYYY-MM-DD');

/** Work someone must do, usually on one subject. */
export const taskSchema = z.object({
  id: z.string().describe('Stable id of the task.'),
  title: z.string().describe('What must be done, in a few words.'),
  notes: z.string().nullable().describe('Longer detail. Null when there is none.'),
  status: taskStatusSchema,
  subject_kind: subjectKindSchema.nullable().describe('The kind of subject the task belongs to. Null, with `subject_id`, for a task that belongs to no subject.'),
  subject_id: z.string().nullable().describe('Id of the subject the task belongs to. Null exactly when `subject_kind` is null.'),
  assignee_name: z.string().nullable().describe('Display name of the person who owns the task. Null when nobody does.'),
  assignee_email: z.string().nullable().describe('Address of the person who owns the task. Null when nobody does.'),
  due_date: civilDateSchema.nullable().describe('The day it is due, as YYYY-MM-DD. Null when it has no date.'),
  goal_id: z.string().nullable().describe('The goal the task serves, if any.'),
  updated_at: z.string().nullable().describe('When the task last changed, as an ISO 8601 timestamp. Null when unknown.'),
}).refine((task) => (task.subject_kind === null) === (task.subject_id === null), 'subject_kind and subject_id are both set or both null')
  .describe('Work someone must do, usually on one subject.');
export type Task = z.infer<typeof taskSchema>;

/** Every schema the spec publishes, by the name `$defs` gives it. */
export const STANDARD_SCHEMAS = {
  SubjectKind: subjectKindSchema,
  DoorKind: doorKindSchema,
  Door: doorSchema,
  DecisionSource: decisionSourceSchema,
  Decision: decisionSchema,
  Subject: subjectSchema,
  TaskStatus: taskStatusSchema,
  Task: taskSchema,
} as const;

/**
 * The published JSON Schema document: one `$defs` entry per name in
 * `STANDARD_SCHEMAS`, under the spec version. `/spec/schema.json` is this.
 */
export function standardJsonSchema(id: string, version: string): Record<string, unknown> {
  const registry = z.registry<{ id: string }>();
  for (const [name, schema] of Object.entries(STANDARD_SCHEMAS)) registry.add(schema, { id: name });
  const { schemas } = z.toJSONSchema(registry, { uri: (name) => `#/$defs/${name}` });
  const defs = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => {
    const { $schema: _schema, $id: _id, ...rest } = schema as Record<string, unknown>;
    return [name, rest];
  }));
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: id, title: 'Starlings Subject Spec', version, $defs: defs };
}

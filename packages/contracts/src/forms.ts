// A public form's answers, as the app reads them (docs/FORMS.md). One shape
// for every form: sections of questions, each answer already in the words
// the person saw. The Worker resolves ids to labels on read, so no client
// carries a form's option lists, and a renamed label never rewrites an old
// answer: the stored body keeps the ids.
import { z } from 'zod';
import { WORKSPACE_FORMS } from './deployment-forms';

export const formAnswerSchema = z.object({
  question: z.string(),
  /** The label they picked, a list of labels, or their own words. Free text keeps its line breaks. */
  answer: z.string(),
});
export type FormAnswer = z.infer<typeof formAnswerSchema>;

export const formAnswerSectionSchema = z.object({
  title: z.string(),
  answers: z.array(formAnswerSchema),
});
export type FormAnswerSection = z.infer<typeof formAnswerSectionSchema>;

export const formSubmissionSchema = z.object({
  id: z.string(),
  /** The form's registry id: `interest` is the only form today. */
  form: z.string(),
  /** What the form is called in the app: "Early-access request". */
  title: z.string(),
  /** ISO 8601. */
  submitted_at: z.string(),
  sections: z.array(formAnswerSectionSchema),
});
export type FormSubmission = z.infer<typeof formSubmissionSchema>;

/** `GET /api/crm/subjects/lead/{id}/submission`: the answers that filed the lead, or null. */
export const subjectSubmissionResponseSchema = z.object({
  submission: formSubmissionSchema.nullable(),
});
export type SubjectSubmissionResponse = z.infer<typeof subjectSubmissionResponseSchema>;

/*
 * The form registry (docs/FORMS.md §Step 2). One entry per form
 * that a workspace offers to people with no account. The entry drives the
 * Worker's validator, the labels on read, the lead it files and who may post
 * it from another site. `interest` keeps its own route and table
 * on hq until it moves into the registry.
 */

/** One pick: the id the body stores, and the words the person saw. */
export interface FormOption {
  readonly id: string;
  readonly label: string;
}

/** One question, in the order the answers read. `pick` is one option, `picks` a list. */
export interface FormQuestion {
  readonly id: string;
  readonly label: string;
  readonly kind: 'line' | 'text' | 'pick' | 'picks';
  readonly options?: readonly FormOption[];
}

export interface FormDefinition {
  /** Stable: part of the URL and of every submission row. */
  readonly id: string;
  /** What the app calls one submission: "Organisation request". */
  readonly title: string;
  /** The workspace slugs that offer the form. */
  readonly workspaces: readonly string[];
  /**
   * Exact `https://` origins that may post from their own page.
   * Empty: only the workspace's own origin.
   */
  readonly origins: readonly string[];
  /**
   * What a submission files: a lead with its organization and contact, a
   * contact alone, a private conversation on the intake subject (with a
   * mailed link that lets the sender continue it), or nothing.
   */
  readonly files: 'lead' | 'contact' | 'thread' | 'none';
  /** For `files: 'thread'`: the door in the thread title, and the mail per language. `{name}` and `{link}` are filled in. */
  readonly thread?: {
    readonly label: string;
    readonly sender: string;
    readonly mail: Readonly<Record<string, { readonly subject: string; readonly body: string }>>;
  };
  /** Who sees a new submission in INBOX. */
  readonly audience: 'admins' | 'members';
  /** Days a submission is kept; a daily prune deletes older rows. */
  readonly keepDays: number;
  /** Submissions the form takes in one hour, from everyone together. */
  readonly hourlyLimit: number;
  /** The body, ids not labels. A field named `website` is the honeypot. */
  readonly schema: z.ZodType<Record<string, unknown>>;
  readonly questions: readonly FormQuestion[];
  /** Which answers name the organization, the person and their address. */
  readonly who: { readonly organization?: string; readonly name: string; readonly email: string; readonly role?: string; readonly message?: string };
}

/** The largest body a form route reads. */
export const FORM_BODY_MAX_BYTES = 16 * 1024;

/** `POST /api/forms/{form}`: always 202 for a well-formed body, the honeypot included. */
export const formSubmitResponseSchema = z.object({ ok: z.literal(true) });
export type FormSubmitResponse = z.infer<typeof formSubmitResponseSchema>;

export const FORMS: readonly FormDefinition[] = WORKSPACE_FORMS;

/** The form with this id that this workspace offers, or null. */
export function formFor(slug: string | null, id: string): FormDefinition | null {
  if (!slug) return null;
  return FORMS.find((form) => form.id === id && form.workspaces.includes(slug)) ?? null;
}

/** Every form this workspace offers. */
export function formsFor(slug: string | null): readonly FormDefinition[] {
  return slug ? FORMS.filter((form) => form.workspaces.includes(slug)) : [];
}

/** Not given: a question they left blank. */
export const FORM_NOT_GIVEN = 'Not given';

/**
 * The answers as the words the person saw, in the form's order. A pick
 * resolves to its label here, on read, so a renamed label never rewrites a
 * stored answer. Blank optional answers are left out.
 */
export function formAnswers(form: FormDefinition, body: Record<string, unknown>): FormAnswer[] {
  const answers: FormAnswer[] = [];
  for (const question of form.questions) {
    const value = body[question.id];
    const label = (id: unknown) => question.options?.find((option) => option.id === id)?.label ?? String(id);
    let answer: string | null = null;
    if (question.kind === 'picks') answer = Array.isArray(value) && value.length ? value.map(label).join(', ') : null;
    else if (question.kind === 'pick') answer = typeof value === 'string' && value ? label(value) : null;
    else answer = typeof value === 'string' && value.trim() ? value : null;
    if (answer !== null) answers.push({ question: question.label, answer });
  }
  return answers;
}

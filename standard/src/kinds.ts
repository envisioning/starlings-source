/**
 * The subject kinds. A subject is one thing a company works on, holding its
 * own history across time. Zod-free, so a browser entry pays nothing for it.
 *
 * What each kind can receive in a given product (tasks, issues, documents,
 * meetings) is that product's decision, not the standard's.
 */

export const SUBJECT_KINDS = ['project', 'lead', 'organization', 'event'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/**
 * Names a reader still accepts for one version, mapped to the kind that
 * replaced them. 0.3.0 folds `partner` into `organization`: a partner is an
 * organization with a partnership, read from its records.
 */
export const SUBJECT_KIND_ALIASES: Readonly<Record<string, SubjectKind>> = { partner: 'organization' };

export function isSubjectKind(value: unknown): value is SubjectKind {
  return typeof value === 'string' && (SUBJECT_KINDS as readonly string[]).includes(value);
}

/** A kind, or a name it replaced (`SUBJECT_KIND_ALIASES`), as the kind. Null for anything else. */
export function readSubjectKind(value: unknown): SubjectKind | null {
  if (isSubjectKind(value)) return value;
  return typeof value === 'string' && Object.hasOwn(SUBJECT_KIND_ALIASES, value) ? SUBJECT_KIND_ALIASES[value]! : null;
}

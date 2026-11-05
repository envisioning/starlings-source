/**
 * The fields of Work's create and edit forms, decided once: New/Edit Lead,
 * New/Edit Project, Add/Edit Contact, New Organization.
 *
 * Each client drew these forms from its own copy, and the copies drifted from
 * the zod contract. A project's organization became optional, but
 * the Mac and the phone kept it a non-optional string and sent `""` when none
 * was picked; zod refuses `""` as a uuid, and New Project answered "Invalid
 * UUID". This table is the one list: per field, its wire key, its words,
 * whether the form requires it and why, and what a blank sends.
 *
 * It is rule input, not a wire shape: no zod, so a web entry may import it.
 * `services/control-plane/test/form-fields.test.ts` holds every row to the zod
 * schemas, so `required`, `blank` and `maxLength` cannot drift from the
 * contract. Swift reads `Sources/Generated/FormFieldsRegistry.swift` and
 * `fixtures/form-fields.json` pins it.
 */

export const FORM_IDS = ['lead', 'project', 'contact', 'organization'] as const;
export type FormID = (typeof FORM_IDS)[number];

/**
 * What a blank field sends. `omit` leaves the key out (the Worker keeps what it
 * has, or the schema's default), `null` clears the stored value, `send` sends
 * the empty value itself (an empty list: "nobody"). A blank is never sent as
 * `""`: zod refuses `""` for a uuid, a url, an address and a day.
 */
export const FORM_FIELD_BLANKS = ['omit', 'null', 'send'] as const;
export type FormFieldBlank = (typeof FORM_FIELD_BLANKS)[number];

/**
 * Why a field is required. `schema`: the zod create schema refuses the body
 * without it. `command`: the schema takes it, a Worker rule
 * (`crmSubjectCreateCommandSchema`) does not. `form`: the contract takes it,
 * the form asks for it anyway, a product choice. `none`: not required.
 */
export const FORM_FIELD_REQUIRED = ['schema', 'command', 'form', 'none'] as const;
export type FormFieldRequired = (typeof FORM_FIELD_REQUIRED)[number];

/** What the value is: what the test samples and what a client normalizes. */
export const FORM_FIELD_FORMATS = ['text', 'status', 'uuid', 'uuid-list', 'day', 'url', 'email-list', 'flags'] as const;
export type FormFieldFormat = (typeof FORM_FIELD_FORMATS)[number];

export interface FormFieldSpec {
  /** The client's name for the field; the Swift property. */
  id: string;
  /** The body key. */
  wire: string;
  /** The caption every client shows, English source. */
  label: string;
  required: FormFieldRequired;
  format: FormFieldFormat;
  /** A blank on create. */
  create: FormFieldBlank;
  /** A blank on edit. */
  update: FormFieldBlank;
  /** The schema's `.max()`, for a text field; null when it has none. */
  maxLength: number | null;
}

const field = (spec: Omit<FormFieldSpec, 'maxLength'> & { maxLength?: number }): FormFieldSpec => ({ ...spec, maxLength: spec.maxLength ?? null });

export const FORM_FIELDS: Readonly<Record<FormID, readonly FormFieldSpec[]>> = {
  lead: [
    // The contract takes a lead with no title (`crmNullableText(100)`); every
    // client asked for one, and the list draws a lead by it.
    field({ id: 'title', wire: 'title', label: 'Name', required: 'form', format: 'text', create: 'omit', update: 'omit', maxLength: 100 }),
    field({ id: 'status', wire: 'status', label: 'Status', required: 'none', format: 'status', create: 'omit', update: 'omit' }),
    field({ id: 'organization', wire: 'organization_id', label: 'Organization', required: 'command', format: 'uuid', create: 'omit', update: 'null' }),
    field({ id: 'contact', wire: 'contact_id', label: 'Contact', required: 'none', format: 'uuid', create: 'omit', update: 'null' }),
    // Required, and not nullable on an edit: a blank is left out, never null.
    field({ id: 'startDate', wire: 'start_date', label: 'Start date', required: 'schema', format: 'day', create: 'omit', update: 'omit', maxLength: 30 }),
    field({ id: 'characteristics', wire: 'characteristics', label: 'Qualification', required: 'none', format: 'flags', create: 'omit', update: 'omit' }),
    field({ id: 'notes', wire: 'notes', label: 'Notes', required: 'none', format: 'text', create: 'omit', update: 'null', maxLength: 10000 }),
  ],
  project: [
    field({ id: 'title', wire: 'title', label: 'Name', required: 'schema', format: 'text', create: 'omit', update: 'omit', maxLength: 200 }),
    field({ id: 'status', wire: 'status', label: 'Status', required: 'none', format: 'status', create: 'omit', update: 'omit' }),
    // Optional since. A blank is left out on create and clears on edit.
    field({ id: 'organization', wire: 'organization_id', label: 'Organization', required: 'none', format: 'uuid', create: 'omit', update: 'null' }),
    // Left out on create, so an untouched picker does not assert "no
    // contacts"; sent whole on edit, where the sheet showed the list.
    field({ id: 'contacts', wire: 'contact_ids', label: 'Contacts', required: 'none', format: 'uuid-list', create: 'omit', update: 'send' }),
    field({ id: 'startDate', wire: 'start_date', label: 'Start date', required: 'none', format: 'day', create: 'omit', update: 'null', maxLength: 30 }),
    field({ id: 'endDate', wire: 'end_date', label: 'End date', required: 'none', format: 'day', create: 'omit', update: 'null', maxLength: 30 }),
    field({ id: 'url', wire: 'url', label: 'URL', required: 'none', format: 'url', create: 'omit', update: 'null' }),
    field({ id: 'description', wire: 'description', label: 'Description', required: 'none', format: 'text', create: 'omit', update: 'null', maxLength: 2000 }),
  ],
  contact: [
    field({ id: 'name', wire: 'name', label: 'Name', required: 'schema', format: 'text', create: 'omit', update: 'omit', maxLength: 200 }),
    field({ id: 'title', wire: 'title', label: 'Title', required: 'none', format: 'text', create: 'omit', update: 'null', maxLength: 200 }),
    field({ id: 'organization', wire: 'organization_id', label: 'Organization', required: 'none', format: 'uuid', create: 'omit', update: 'null' }),
    field({ id: 'emails', wire: 'emails', label: 'Addresses, one per line', required: 'none', format: 'email-list', create: 'send', update: 'send' }),
  ],
  organization: [
    field({ id: 'name', wire: 'name', label: 'Name', required: 'schema', format: 'text', create: 'omit', update: 'omit', maxLength: 200 }),
  ],
};

/** What every client draws after a required field's caption. */
export const FORM_REQUIRED_MARK = ' *';

export function formField(form: FormID, id: string): FormFieldSpec {
  const spec = FORM_FIELDS[form].find((row) => row.id === id);
  if (!spec) throw new Error(`form-fields: ${form} has no field ${id}`);
  return spec;
}

export const isFormFieldRequired = (spec: FormFieldSpec): boolean => spec.required !== 'none';

/** The caption as drawn: the (already localized) label, and the mark when required. */
export const formFieldCaption = (spec: FormFieldSpec, label: string = spec.label): string =>
  isFormFieldRequired(spec) ? `${label}${FORM_REQUIRED_MARK}` : label;

/**
 * A URL as the person typed it, made one the schema takes: `example.com` gets
 * `https://`. zod's `.url()` refuses a bare host; the web's `type="url"`
 * refused it in the browser and the native clients sent it to be refused.
 */
export function normalizeFormURL(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Addresses one per line, or split by a comma or semicolon, lower case, blanks dropped. */
export function formEmails(text: string): string[] {
  return text.split(/[\n,;]+/u).map((line) => line.trim().toLowerCase()).filter(Boolean);
}

type FormValue = string | null | undefined | readonly string[] | Readonly<Record<string, boolean>>;

const isBlank = (value: FormValue): boolean =>
  value === null
  || value === undefined
  || (typeof value === 'string' && value.trim() === '')
  || (Array.isArray(value) && value.length === 0);

/**
 * The body a form sends, from its values by field id. A field the values do
 * not name is left out; a blank one goes as the row says; text is trimmed and
 * a URL normalized. Pass only the fields the form drew for that kind.
 */
export function formBody(form: FormID, write: 'create' | 'update', values: Readonly<Record<string, FormValue>>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const spec of FORM_FIELDS[form]) {
    if (!(spec.id in values)) continue;
    const raw = values[spec.id];
    const value = spec.format === 'url' && typeof raw === 'string' ? normalizeFormURL(raw) : raw;
    if (!isBlank(value)) {
      body[spec.wire] = typeof value === 'string' ? value.trim() : value;
      continue;
    }
    const blank = write === 'create' ? spec.create : spec.update;
    if (blank === 'null') body[spec.wire] = null;
    else if (blank === 'send') body[spec.wire] = [];
  }
  return body;
}

/**
 * The first required field the values leave blank, or null when none is.
 * `lacking` names the fields the stored record already has blank: an edit
 * does not ask for those (a lead from before the organization rule saves).
 */
export function missingFormField(
  form: FormID,
  values: Readonly<Record<string, FormValue>>,
  lacking: readonly string[] = [],
): FormFieldSpec | null {
  for (const spec of FORM_FIELDS[form]) {
    if (!isFormFieldRequired(spec) || !(spec.id in values) || lacking.includes(spec.id)) continue;
    if (isBlank(values[spec.id])) return spec;
  }
  return null;
}

/**
 * One issue the Worker's zod parse raised, in the shape it reads here. This
 * module takes no zod, so it names only the keys it needs.
 */
export interface FormIssue {
  code: string;
  path: readonly PropertyKey[];
  message: string;
}

/** A refused field: its wire key and the sentence a person reads beside it. */
export interface FormRefusal {
  field: string;
  message: string;
}

const article = (noun: string): string => (/^[aeiou]/iu.test(noun) ? `an ${noun}` : `a ${noun}`);

/**
 * The sentence for a value the schema refused, by what the field holds. The
 * Worker sends it instead of zod's own words ("Invalid UUID"), so every client
 * shows a sentence that names the field and the fix.
 */
function refusalSentence(spec: FormFieldSpec, issue: FormIssue): string {
  const noun = spec.label.toLowerCase();
  if (issue.code === 'too_big' && spec.maxLength !== null) return `${spec.label} is at most ${spec.maxLength} characters.`;
  if (issue.code === 'too_small' && spec.format === 'text') return `${spec.label} is required.`;
  if (issue.code === 'invalid_type' && isFormFieldRequired(spec)) return `${spec.label} is required.`;
  switch (spec.format) {
    case 'uuid': return isFormFieldRequired(spec)
      ? `Pick ${article(noun)} from the list.`
      : `Pick ${article(noun)} from the list, or leave it empty.`;
    case 'uuid-list': return `Pick ${noun} from the list, or leave it empty.`;
    case 'status': return `Pick ${article(noun)} from the list.`;
    case 'day': return `${spec.label} takes a day, like 2026-11-01.`;
    case 'url': return `${spec.label} must be a web address, like https://example.com.`;
    case 'email-list': return 'Each address must look like name@example.com.';
    case 'text':
    case 'flags': return `Check the ${noun} and save again.`;
  }
}

/**
 * The first issue of a refused form body, as a field and a sentence. A
 * custom issue already speaks to a person ("Choose an organization before
 * creating a lead."), so it keeps its words. Null when no issue names a field
 * of this form: the caller then answers as it always has.
 */
export function formRefusal(form: FormID, issues: readonly FormIssue[]): FormRefusal | null {
  for (const issue of issues) {
    const key = issue.path[0];
    if (typeof key !== 'string') continue;
    const spec = FORM_FIELDS[form].find((row) => row.wire === key);
    if (!spec) continue;
    return { field: spec.wire, message: issue.code === 'custom' ? issue.message : refusalSentence(spec, issue) };
  }
  return null;
}

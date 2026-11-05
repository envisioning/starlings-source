import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  crmContactCreateSchema,
  crmContactUpdateSchema,
  crmLeadCreateRequestSchema,
  crmLeadStatusSchema,
  crmLeadUpdateSchema,
  crmOrganizationCreateSchema,
  crmProjectCreateRequestSchema,
  crmProjectStatusSchema,
  crmProjectUpdateSchema,
  crmSubjectCreateCommandSchema,
} from '@starlings/contracts';
import {
  FORM_FIELDS,
  FORM_IDS,
  FORM_REQUIRED_MARK,
  formBody,
  formRefusal,
  missingFormField,
  type FormFieldSpec,
  type FormID,
} from '@starlings/contracts/form-fields';
import fixture from '../../../fixtures/form-fields.json';

/**
 * Each form against the zod it posts to. `create` is the wire shape, `command`
 * the Worker's rule over it, `update` the PATCH. `extra` is what the client
 * adds outside the form (the subject's `kind`).
 */
type Schema = z.ZodType;
const SCHEMAS: Record<FormID, { create: Schema; command: Schema; update: Schema | null; shape: Record<string, unknown>; updateShape: Record<string, unknown> | null; extra: Record<string, unknown> }> = {
  lead: {
    create: crmLeadCreateRequestSchema,
    command: crmSubjectCreateCommandSchema,
    update: crmLeadUpdateSchema,
    shape: crmLeadCreateRequestSchema.shape,
    updateShape: crmLeadUpdateSchema.shape,
    extra: { kind: 'lead' },
  },
  project: {
    create: crmProjectCreateRequestSchema,
    command: crmSubjectCreateCommandSchema,
    update: crmProjectUpdateSchema,
    shape: crmProjectCreateRequestSchema.shape,
    updateShape: crmProjectUpdateSchema.shape,
    extra: { kind: 'project' },
  },
  contact: {
    create: crmContactCreateSchema,
    command: crmContactCreateSchema,
    update: crmContactUpdateSchema,
    shape: crmContactCreateSchema.shape,
    updateShape: crmContactUpdateSchema.shape,
    extra: {},
  },
  organization: {
    create: crmOrganizationCreateSchema,
    command: crmOrganizationCreateSchema,
    update: null,
    shape: crmOrganizationCreateSchema.shape,
    updateShape: null,
    extra: {},
  },
};

const STATUS: Partial<Record<FormID, string>> = {
  lead: crmLeadStatusSchema.options[0]!,
  project: crmProjectStatusSchema.options[0]!,
};

const UUID = '7b0f5a52-3c3e-4d5f-9a5e-0d6c1f6b2a11';

function sample(form: FormID, spec: FormFieldSpec): unknown {
  switch (spec.format) {
    case 'text': return 'Acme';
    case 'status': return STATUS[form];
    case 'uuid': return UUID;
    case 'uuid-list': return [UUID];
    case 'day': return '2026-10-19';
    case 'url': return 'https://example.com';
    case 'email-list': return ['ana@example.net'];
    case 'flags': return { project_fit: true };
  }
}

/** The smallest body the Worker takes: the extra keys and every field the contract requires. */
function minimal(form: FormID): Record<string, unknown> {
  const body: Record<string, unknown> = { ...SCHEMAS[form].extra };
  for (const spec of FORM_FIELDS[form]) {
    if (spec.required === 'schema' || spec.required === 'command') body[spec.wire] = sample(form, spec);
  }
  return body;
}

const issuePaths = (result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) =>
  (result.error?.issues ?? []).map((issue) => issue.path.join('.'));

describe('form fields', () => {
  it('equals fixtures/form-fields.json, the table the Swift mirror pins', () => {
    expect(fixture.requiredMark).toBe(FORM_REQUIRED_MARK);
    expect(Object.keys(fixture.forms)).toEqual([...FORM_IDS]);
    expect(fixture.forms).toEqual(FORM_FIELDS);
  });

  for (const form of FORM_IDS) {
    const schemas = SCHEMAS[form];
    describe(form, () => {
      it('names each field once, by a key the contract has', () => {
        const ids = FORM_FIELDS[form].map((spec) => spec.id);
        const wires = FORM_FIELDS[form].map((spec) => spec.wire);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(wires).size).toBe(wires.length);
        for (const spec of FORM_FIELDS[form]) {
          expect(Object.keys(schemas.shape), `${form}.${spec.wire}`).toContain(spec.wire);
          if (schemas.updateShape) expect(Object.keys(schemas.updateShape), `${form}.${spec.wire} on edit`).toContain(spec.wire);
        }
      });

      it('takes the smallest body the table requires', () => {
        const result = schemas.command.safeParse(minimal(form));
        expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
      });

      it('requires exactly what the contract requires, for the reason the table gives', () => {
        for (const spec of FORM_FIELDS[form]) {
          const body = minimal(form);
          delete body[spec.wire];
          const wire = schemas.create.safeParse(body);
          const command = schemas.command.safeParse(body);
          const label = `${form}.${spec.id} is ${spec.required}`;
          switch (spec.required) {
            case 'schema':
              expect(wire.success, label).toBe(false);
              expect(issuePaths(wire), label).toContain(spec.wire);
              break;
            case 'command':
              expect(wire.success, label).toBe(true);
              expect(command.success, label).toBe(false);
              expect(issuePaths(command), label).toContain(spec.wire);
              break;
            case 'form':
            case 'none':
              expect(command.success, `${label}, but the Worker refuses the body without it`).toBe(true);
              break;
          }
        }
      });

      it('sends a blank the schema takes, on create and on edit', () => {
        for (const spec of FORM_FIELDS[form]) {
          if (spec.create === 'send' || spec.update === 'send') {
            expect(['uuid-list', 'email-list'], `${form}.${spec.id}: send is for a list`).toContain(spec.format);
          }
          const blank = spec.format === 'uuid-list' || spec.format === 'email-list' ? [] : '';
          if (spec.required === 'none' || spec.required === 'form') {
            const body = { ...minimal(form), ...formBody(form, 'create', { [spec.id]: blank }) };
            const result = schemas.command.safeParse(body);
            expect(result.success, `${form}.${spec.id} blank on create: ${JSON.stringify(result.error?.issues)}`).toBe(true);
          }
          if (schemas.update) {
            const result = schemas.update.safeParse(formBody(form, 'update', { [spec.id]: blank }));
            expect(result.success, `${form}.${spec.id} blank on edit: ${JSON.stringify(result.error?.issues)}`).toBe(true);
          }
        }
      });

      it('never sends "" where the schema refuses it', () => {
        for (const spec of FORM_FIELDS[form]) {
          const body = formBody(form, 'create', { [spec.id]: '  ' });
          expect(body[spec.wire], `${form}.${spec.id}`).not.toBe('');
          if (schemas.update) expect(formBody(form, 'update', { [spec.id]: '' })[spec.wire], `${form}.${spec.id} on edit`).not.toBe('');
          // The bug this table exists for: zod refuses "" for a uuid and a url.
          if (spec.format === 'uuid' || spec.format === 'url') {
            expect(schemas.command.safeParse({ ...minimal(form), [spec.wire]: '' }).success, `${form}.${spec.id}`).toBe(false);
          }
        }
      });

      it('caps text where the schema caps it', () => {
        for (const spec of FORM_FIELDS[form]) {
          if (spec.format !== 'text' && spec.format !== 'day') {
            expect(spec.maxLength, `${form}.${spec.id}`).toBeNull();
            continue;
          }
          expect(spec.maxLength, `${form}.${spec.id} has no maxLength`).not.toBeNull();
          const max = spec.maxLength!;
          const at = schemas.create.safeParse({ ...minimal(form), [spec.wire]: 'x'.repeat(max) });
          const over = schemas.create.safeParse({ ...minimal(form), [spec.wire]: 'x'.repeat(max + 1) });
          expect(at.success, `${form}.${spec.id} at ${max}`).toBe(true);
          expect(over.success, `${form}.${spec.id} over ${max}`).toBe(false);
        }
      });
    });
  }

  it('sends a bare host as a URL the schema takes', () => {
    const body = { ...minimal('project'), ...formBody('project', 'create', { url: 'example.com' }) };
    expect(body.url).toBe('https://example.com');
    expect(crmSubjectCreateCommandSchema.safeParse(body).success).toBe(true);
  });

  it('leaves out a project with no organization, which is how Acme failed', () => {
    const body = formBody('project', 'create', { title: 'Acme', organization: '', contacts: [] });
    expect(body).toEqual({ title: 'Acme' });
    expect(crmSubjectCreateCommandSchema.safeParse({ kind: 'project', ...body }).success).toBe(true);
    expect(formBody('project', 'update', { organization: null })).toEqual({ organization_id: null });
  });

  it('names the missing required field, and lets an edit keep a blank the record had', () => {
    expect(missingFormField('lead', { title: 'Acme', organization: '' })?.id).toBe('organization');
    expect(missingFormField('lead', { title: 'Acme', organization: '' }, ['organization'])).toBeNull();
    expect(missingFormField('project', { title: 'Acme', organization: '' })).toBeNull();
    expect(missingFormField('project', { title: ' ' })?.id).toBe('title');
  });

  it('turns a refused body into the field and a sentence, never zod\'s words', () => {
    const issues = (schema: z.ZodType, body: unknown) => {
      const parsed = schema.safeParse(body);
      if (parsed.success) throw new Error('expected a refusal');
      return parsed.error.issues;
    };
    // The body Acme's New Project sent before the form fields registry.
    expect(formRefusal('project', issues(crmSubjectCreateCommandSchema, { kind: 'project', title: 'Acme', organization_id: '' })))
      .toEqual({ field: 'organization_id', message: 'Pick an organization from the list, or leave it empty.' });
    expect(formRefusal('project', issues(crmSubjectCreateCommandSchema, { kind: 'project', title: '' })))
      .toEqual({ field: 'title', message: 'Name is required.' });
    expect(formRefusal('project', issues(crmSubjectCreateCommandSchema, { kind: 'project', title: 'x'.repeat(201) })))
      .toEqual({ field: 'title', message: 'Name is at most 200 characters.' });
    expect(formRefusal('project', issues(crmSubjectCreateCommandSchema, { kind: 'project', title: 'Acme', url: 'not a url' })))
      .toEqual({ field: 'url', message: 'URL must be a web address, like https://example.com.' });
    // A rule's own sentence already speaks to a person: it keeps its words.
    expect(formRefusal('lead', issues(crmSubjectCreateCommandSchema, { kind: 'lead', title: 'Acme', start_date: '2026-11-01' })))
      .toEqual({ field: 'organization_id', message: 'Choose an organization before creating a lead.' });
    expect(formRefusal('project', [{ code: 'invalid_type', path: ['kind'], message: 'Invalid input' }])).toBeNull();
  });
});

import {
  coreRecordResponseSchema,
  coreRegistryResponseSchema,
  coreSearchResponseSchema,
  type CoreEntity,
  type CoreField,
  type CoreFieldsEntity,
  type CoreFieldsWriteBody,
  type CoreRecord,
  type CoreSearchHit,
} from '@starlings/contracts/core-fields';
import type { CrmOrganizationUpdate } from '@starlings/contracts';
import { workspaceCoreOrigin, workspaceCoreURL } from './workspace-core';
import { updateCrmOrganization } from './crm-work';
import { apiFetch } from './api';
import { t } from './i18n';

/*
 * Core's CRM registry on the web, through the Worker's `/api/core/*`
 *: a subject's Fields pane and the palette's Core search. Mac and
 * iOS draw the same registry with core-kit and a device PAT; the browser
 * holds no Core token, so every read and write goes through the Worker as
 * the member. Core validates every write.
 */

let registry: Promise<CoreEntity[]> | null = null;

/** The registry, read once per page load; a failure is not remembered. */
export function fetchCoreRegistry(): Promise<CoreEntity[]> {
  if (!workspaceCoreOrigin()) return Promise.resolve([]);
  registry ??= apiFetch<unknown>('/core/registry', { fallbackError: t('Couldn’t load the fields.') })
    .then((body) => coreRegistryResponseSchema.parse(body).data.entities)
    .catch((cause: unknown) => {
      registry = null;
      throw cause;
    });
  return registry;
}

export async function fetchCoreFieldsRecord(entity: CoreFieldsEntity, id: string): Promise<CoreRecord> {
  const body = await apiFetch<unknown>(`/core/fields/${entity}/${encodeURIComponent(id)}`, {
    fallbackError: t('Couldn’t load the record'),
    noStore: true,
  });
  return coreRecordResponseSchema.parse(body).data;
}

/**
 * The organization columns Work's own route writes (`crmOrganizationUpdateSchema`),
 * in Core's names: Core's `website` is the route's `url`.
 */
const ORGANIZATION_ROUTE_FIELDS: ReadonlySet<string> = new Set([
  'name', 'website', 'industry', 'notes', 'legal_name', 'address', 'postcode', 'city', 'country', 'vat_id', 'tax_id', 'size',
  'owner_id', 'founded', 'hq_location', 'company_type', 'linkedin_url', 'logo_url', 'logo_image_url', 'profile_image_url',
  'entity', 'domain', 'is_agency', 'is_existing_client', 'is_partner',
] satisfies ReadonlyArray<Exclude<keyof CrmOrganizationUpdate, 'url'> | 'website'>);

export async function updateCoreFieldsRecord(entity: CoreFieldsEntity, id: string, patch: CoreFieldsWriteBody): Promise<CoreRecord> {
  // An organization's fields go through Work's organization route,
  // on the subjects group's store. A column that route does not name still
  // goes to Core's record route while the group is on Core.
  if (entity === 'organizations' && Object.keys(patch).every((key) => ORGANIZATION_ROUTE_FIELDS.has(key))) {
    const { website, ...rest } = patch;
    await updateCrmOrganization(id, { ...rest, ...(website === undefined ? {} : { url: website }) } as CrmOrganizationUpdate);
    return fetchCoreFieldsRecord(entity, id);
  }
  const body = await apiFetch<unknown>(`/core/fields/${entity}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
    fallbackError: t('Couldn’t save that record.'),
  });
  return coreRecordResponseSchema.parse(body).data;
}

export async function searchCore(query: string, signal?: AbortSignal): Promise<CoreSearchHit[]> {
  if (!workspaceCoreOrigin()) return [];
  const params = new URLSearchParams({ q: query });
  const body = await apiFetch<unknown>(`/core/search?${params}`, {
    fallbackError: t('Couldn’t search.'),
    noStore: true,
    ...(signal ? { signal } : {}),
  });
  return coreSearchResponseSchema.parse(body).data;
}

/** Whether this person may change the entity's rows: Core's grant AND the entity's own capability. */
export function coreEntityWritable(entity: CoreEntity): boolean {
  return entity.access.canWrite && entity.capabilities.update !== false;
}

// MARK: - Where a Core thing opens

/** Core's own page for one record, from the path Core's search answered with. */
export function coreRecordURL(hit: CoreSearchHit): string | null {
  return workspaceCoreURL(hit.href);
}

/** A hit that is a Work subject opens in Work, on its Fields; a partner is an organization Work may not list. */
export function coreHitSubjectKind(hit: CoreSearchHit): 'project' | 'lead' | null {
  if (hit.entity === 'projects') return 'project';
  if (hit.entity === 'leads') return 'lead';
  return null;
}

// MARK: - The form

/**
 * How a field is drawn. What the web cannot edit faithfully (relations,
 * lists, countries, characteristics, junction and computed fields, and any
 * kind Core adds later) shows its value read-only: edit it on the Mac, the
 * phone or in Core.
 */
export type CoreControl = 'section' | 'text' | 'textarea' | 'markdown' | 'url' | 'email' | 'number' | 'date' | 'toggle' | 'select' | 'readOnly';

export function coreControl(field: CoreField): CoreControl {
  if (field.kind === 'section') return 'section';
  if (field.storage === 'junction' || field.storage === 'computed') return 'readOnly';
  switch (field.kind) {
    case 'text':
    case 'textarea':
    case 'markdown':
    case 'url':
    case 'email':
    case 'number':
    case 'date':
    case 'toggle':
      return field.kind;
    case 'select':
      return field.options && field.options.length > 0 ? 'select' : 'readOnly';
    default:
      return 'readOnly';
  }
}

/** A field's value as the form holds it: text, or a boolean for a toggle. */
export type CoreDraftValue = string | boolean;

export function coreDraftValue(control: CoreControl, value: unknown): CoreDraftValue {
  if (control === 'toggle') return value === true;
  if (value === null || value === undefined) return '';
  if (control === 'date' && typeof value === 'string') return value.slice(0, 10);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * A read-only field's words: a related row by its name when Core embedded
 * it, a list joined, an option by its label. Never a raw object.
 */
export function coreDisplayValue(field: CoreField, record: CoreRecord): string {
  const value = record[field.name];
  const embeddedKey = typeof field.relationKey === 'string' ? field.relationKey : null;
  const embedded = embeddedKey ? record[embeddedKey] : undefined;
  const named = (entry: unknown): string => {
    if (entry === null || entry === undefined) return '';
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      const option = field.options?.find((candidate) => candidate.value === String(entry));
      return option ? option.label : String(entry);
    }
    if (Array.isArray(entry)) return entry.map(named).filter(Boolean).join(', ');
    if (typeof entry === 'object') {
      const row = entry as Record<string, unknown>;
      for (const key of ['name', 'title', 'label', 'full_name', 'email']) {
        if (typeof row[key] === 'string' && row[key]) return row[key] as string;
      }
      return '';
    }
    return '';
  };
  return named(embedded) || named(value);
}

/**
 * The write body: only the fields whose value changed, cleared text as
 * null. Returns null when nothing changed. A number that does not parse
 * throws, so the form says which field instead of Core refusing the body.
 */
export function corePatch(
  fields: CoreField[],
  original: CoreRecord,
  draft: Record<string, CoreDraftValue>,
): CoreFieldsWriteBody | null {
  const patch: CoreFieldsWriteBody = {};
  for (const field of fields) {
    const control = coreControl(field);
    if (control === 'readOnly' || control === 'section') continue;
    if (!(field.name in draft)) continue;
    const before = coreDraftValue(control, original[field.name]);
    const after = draft[field.name]!;
    if (after === before) continue;
    if (typeof after === 'boolean') {
      patch[field.name] = after;
      continue;
    }
    const trimmed = control === 'markdown' || control === 'textarea' ? after : after.trim();
    if (!trimmed.trim()) {
      patch[field.name] = null;
      continue;
    }
    if (control === 'number') {
      const number = Number(trimmed);
      if (!Number.isFinite(number)) throw new Error(t('{field} needs a number.', { field: field.label }));
      patch[field.name] = number;
      continue;
    }
    patch[field.name] = trimmed;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * The fields in the registry's order, grouped by the section each names,
 * under that section field's label (`kind: 'section'` rows are headings).
 */
export function coreSections(fields: CoreField[]): Array<{ id: string; label: string | null; fields: CoreField[] }> {
  const labels = new Map(fields.filter((field) => coreControl(field) === 'section').map((field) => [field.name, field.label]));
  const groups: Array<{ id: string; label: string | null; fields: CoreField[] }> = [];
  for (const field of fields) {
    if (coreControl(field) === 'section') continue;
    const id = field.section ?? '';
    const group = groups.find((entry) => entry.id === id);
    if (group) group.fields.push(field);
    else groups.push({ id, label: labels.get(id) ?? null, fields: [field] });
  }
  return groups;
}

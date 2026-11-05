import {
  CMS_COLUMN_FORMATS,
  cmsListResponseSchema,
  cmsRecordResponseSchema,
  cmsRegistryResponseSchema,
  isCmsFieldKind,
  type CmsEntity,
  type CmsField,
  type CmsRecord,
} from '@starlings/contracts/cms';
import type { CmsWriteBody } from '@starlings/contracts';
import { apiFetch } from './api';
import { t } from './i18n';

/*
 * Core's CMS through the Worker's `/api/cms/*`: the registry that
 * says which fields an entity has and whether this person may write it, and
 * one record read and saved as the person. Core validates every write.
 */

let registry: Promise<CmsEntity[]> | null = null;

/** The registry, read once per page load; a failure is not remembered. */
export function fetchCmsRegistry(): Promise<CmsEntity[]> {
  registry ??= apiFetch<unknown>('/cms/registry', { fallbackError: t('Couldn’t load the website fields.') })
    .then((body) => cmsRegistryResponseSchema.parse(body).data.entities)
    .catch((cause: unknown) => {
      registry = null;
      throw cause;
    });
  return registry;
}

/**
 * The entity when this person may change its rows, or null. Someone without
 * the CMS grant gets a refusal from the Worker or `canWrite: false` from
 * Core; either way there is nothing to edit.
 */
export async function writableCmsEntity(entityID: string): Promise<CmsEntity | null> {
  const entities = await fetchCmsRegistry().catch(() => [] as CmsEntity[]);
  const entity = entities.find((row) => row.id === entityID);
  return entity && entity.access.canWrite && entity.capabilities.update ? entity : null;
}

export async function fetchCmsRecord(entityID: string, id: string): Promise<CmsRecord> {
  const body = await apiFetch<unknown>(`/cms/${entityID}/${encodeURIComponent(id)}`, {
    fallbackError: t('Couldn’t load that record.'),
    noStore: true,
  });
  return cmsRecordResponseSchema.parse(body).data;
}

export async function updateCmsRecord(entityID: string, id: string, patch: CmsWriteBody): Promise<CmsRecord> {
  const body = await apiFetch<unknown>(`/cms/${entityID}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
    fallbackError: t('Couldn’t save that record.'),
  });
  return cmsRecordResponseSchema.parse(body).data;
}

/** A relation's choices: up to 200 rows of the target entity, by its primary field. */
export async function fetchCmsChoices(entity: CmsEntity): Promise<Array<{ id: string; label: string }>> {
  const body = await apiFetch<unknown>(`/cms/${entity.id}?limit=200`, {
    fallbackError: t('Couldn’t load the choices.'),
  });
  return cmsListResponseSchema.parse(body).data.flatMap((row) => {
    const id = typeof row.id === 'string' ? row.id : '';
    if (!id) return [];
    const label = row[entity.primaryField];
    return [{ id, label: typeof label === 'string' && label.trim() ? label.trim() : id }];
  });
}

/** How a field is drawn. Unknown and read-only kinds show their value and are never sent. */
export type CmsControl = 'text' | 'textarea' | 'markdown' | 'url' | 'email' | 'emails' | 'toggle' | 'number' | 'date' | 'time' | 'timezone' | 'datetime' | 'relation' | 'readOnly';

export function cmsControl(entityID: string, field: CmsField): CmsControl {
  if (field.readOnly || !isCmsFieldKind(field.kind)) return 'readOnly';
  const format = CMS_COLUMN_FORMATS[entityID]?.[field.name];
  if (format) return format;
  switch (field.kind) {
    case 'text':
    case 'select':
      return 'text';
    case 'image':
      return 'url';
    case 'svg':
      return 'markdown';
    default:
      return field.kind;
  }
}

/** A field's value as the form holds it: text, or a boolean for a toggle. */
export type CmsDraftValue = string | boolean;

export function cmsDraftValue(control: CmsControl, value: unknown): CmsDraftValue {
  if (control === 'toggle') return value === true;
  if (value === null || value === undefined) return '';
  if (control === 'time' && typeof value === 'string') return value.slice(0, 5);
  if (control === 'emails' && Array.isArray(value)) return value.filter((item) => typeof item === 'string').join(', ');
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * The write body: only the fields whose value changed, cleared text as
 * null. Returns null when nothing changed. A number that does not parse
 * throws, so the form says which field instead of Core refusing the body.
 */
export function cmsPatch(
  entityID: string,
  fields: CmsField[],
  original: CmsRecord,
  draft: Record<string, CmsDraftValue>,
): CmsWriteBody | null {
  const patch: CmsWriteBody = {};
  for (const field of fields) {
    const control = cmsControl(entityID, field);
    if (control === 'readOnly') continue;
    const before = cmsDraftValue(control, original[field.name]);
    const after = draft[field.name] ?? before;
    if (after === before) continue;
    if (typeof after === 'boolean') {
      patch[field.name] = after;
      continue;
    }
    if (control === 'emails') {
      // The column is NOT NULL: an empty list clears it, never null.
      patch[field.name] = [...new Set(after.split(/[\s,;]+/u).map((email) => email.toLowerCase()).filter(Boolean))];
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

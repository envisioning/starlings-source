import type { CoreMergeBody, CoreMergeResponse } from '@starlings/contracts/core-fields';
import type {
  CrmContact, CrmContactDeleteResponse, CrmContactDetail, CrmContactFacets, CrmContactOptionsResponse,
  CrmContactResponse, CrmContactsResponse, CrmContactUpdate, SignalsOutreachStatus,
} from '@starlings/contracts';
import { SIGNALS_OUTREACH_STATUSES } from '@starlings/contracts';
import { formBody, formEmails } from '@starlings/contracts/form-fields';
import { apiFetch } from './api';
import { t } from './i18n';
import { readStored, removeStored, writeStored } from './storage';

/** A person's outreach state, in words. */
export function outreachLabel(status: string): string {
  switch (status) {
    case 'to_notify': return t('To notify');
    case 'notified': return t('Notified');
    case 'replied': return t('Replied');
    case 'interested': return t('Interested');
    case 'not_interested': return t('Not interested');
    default: return status;
  }
}

/**
 * Contacts, the people outside the team: the Worker's
 * `/api/crm/contacts`, on Core and on a D1 workspace alike.
 */

/** A contact by name, title, address or organization name; or the contacts of one organization. */
export async function searchContacts(input: { q?: string; organizationId?: string; limit?: number }): Promise<CrmContact[]> {
  const search = new URLSearchParams();
  if (input.q?.trim()) search.set('q', input.q.trim());
  if (input.organizationId) search.set('organization_id', input.organizationId);
  if (input.limit) search.set('limit', String(input.limit));
  const body = await apiFetch<CrmContactsResponse>(`/crm/contacts?${search}`, {
    fallbackError: t('Couldn’t search contacts.'),
    noStore: true,
  });
  return body.contacts;
}

/**
 * The Contacts group's filters, as Core's contact table has them.
 * Wire names, so the fixture reads the same on every client. The
 * organization's name is kept only to draw the choice.
 */
export interface ContactListFilter {
  organization_id?: string;
  organization_name?: string;
  /** ISO 3166 alpha-2. */
  country?: string;
  partner: boolean;
  existing_client: boolean;
  signals_outreach_status?: SignalsOutreachStatus;
  preferred_language?: string;
}

export const DEFAULT_CONTACT_FILTER: ContactListFilter = { partner: false, existing_client: false };

/** True when the filter lists every contact. */
export function isDefaultContactFilter(filter: ContactListFilter): boolean {
  return !filter.organization_id && !filter.country?.trim() && !filter.partner && !filter.existing_client
    && !filter.signals_outreach_status && !filter.preferred_language?.trim();
}

/**
 * The query string the Contacts group sends, in the contract's order. The Mac
 * and iOS build the same one in `CrmContactsQuery.list`;
 * `fixtures/contact-query.json` pins both. Only a filter that is set goes.
 */
export function contactListSearchParams(query: string, filter: ContactListFilter): URLSearchParams {
  const search = new URLSearchParams();
  if (query.trim()) search.set('q', query.trim());
  if (filter.organization_id) search.set('organization_id', filter.organization_id);
  if (filter.country?.trim()) search.set('country', filter.country.trim().toUpperCase());
  if (filter.partner) search.set('partner', 'true');
  if (filter.existing_client) search.set('existing_client', 'true');
  if (filter.signals_outreach_status) search.set('signals_outreach_status', filter.signals_outreach_status);
  if (filter.preferred_language?.trim()) search.set('preferred_language', filter.preferred_language.trim());
  search.set('facets', 'true');
  return search;
}

export interface ContactListPage {
  contacts: CrmContact[];
  /** More match than came back: the answer is a narrower search. */
  hasMore: boolean;
  facets?: CrmContactFacets;
}

/** The Contacts group's page: a search and its filters, with the facets for the menu. */
export async function listContacts(query: string, filter: ContactListFilter): Promise<ContactListPage> {
  const body = await apiFetch<CrmContactsResponse>(`/crm/contacts?${contactListSearchParams(query, filter)}`, {
    fallbackError: t('Couldn’t load contacts.'),
    noStore: true,
  });
  return { contacts: body.contacts, hasMore: body.has_more, ...(body.facets ? { facets: body.facets } : {}) };
}

/** The Contacts group's filter, per device, under the Mac's key. */
const CONTACT_FILTER_KEY = 'meet.workSidebar.filter.contacts';

export function readContactFilter(): ContactListFilter {
  try {
    const stored = JSON.parse(readStored(CONTACT_FILTER_KEY) || 'null') as Partial<ContactListFilter> | null;
    if (!stored || typeof stored !== 'object') return DEFAULT_CONTACT_FILTER;
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
    const status = SIGNALS_OUTREACH_STATUSES.find((value) => value === stored.signals_outreach_status);
    return {
      partner: stored.partner === true,
      existing_client: stored.existing_client === true,
      ...(text(stored.organization_id) ? { organization_id: text(stored.organization_id), organization_name: text(stored.organization_name) } : {}),
      ...(text(stored.country) ? { country: text(stored.country) } : {}),
      ...(status ? { signals_outreach_status: status } : {}),
      ...(text(stored.preferred_language) ? { preferred_language: text(stored.preferred_language) } : {}),
    };
  } catch {
    return DEFAULT_CONTACT_FILTER;
  }
}

export function writeContactFilter(filter: ContactListFilter): void {
  if (isDefaultContactFilter(filter)) removeStored(CONTACT_FILTER_KEY);
  else writeStored(CONTACT_FILTER_KEY, JSON.stringify(filter));
}

/** The contacts a subject already carries, by id, to name them. */
export async function contactsByID(ids: readonly string[]): Promise<CrmContact[]> {
  if (ids.length === 0) return [];
  const search = new URLSearchParams({ ids: ids.join(',') });
  const body = await apiFetch<CrmContactsResponse>(`/crm/contacts?${search}`, {
    fallbackError: t('Couldn’t load contacts.'),
    noStore: true,
  });
  return body.contacts;
}

/**
 * The most addresses one `emails` read names. The Worker reads the first 25
 * and drops the rest (`crm.ts`, `work-d1.ts`); the contracts hold no constant yet.
 */
export const CONTACT_EMAILS_LIMIT = 25;

/** The addresses an `emails` read sends: trimmed, lower-cased, once each, at most 25. */
export function contactLookupEmails(addresses: readonly string[]): string[] {
  const emails = new Set<string>();
  for (const address of addresses) {
    const email = address.trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+$/u.test(email)) emails.add(email);
  }
  return [...emails].slice(0, CONTACT_EMAILS_LIMIT);
}

/**
 * The contacts any of `emails` belongs to, matched against every address a
 * contact holds. Calendar's event editor names the attendees with it.
 */
export async function contactsByEmail(emails: readonly string[]): Promise<CrmContact[]> {
  const lookup = contactLookupEmails(emails);
  if (lookup.length === 0) return [];
  const search = new URLSearchParams({ emails: lookup.join(',') });
  const body = await apiFetch<CrmContactsResponse>(`/crm/contacts?${search}`, {
    fallbackError: t('Couldn’t load contacts.'),
    noStore: true,
  });
  return body.contacts;
}

/** Each address a contact holds, lower-cased, to its contact. The first contact to hold an address keeps it. */
export function contactsByAddress(contacts: readonly CrmContact[]): Map<string, CrmContact> {
  const byAddress = new Map<string, CrmContact>();
  for (const contact of contacts) {
    for (const address of [contact.email, ...contact.emails]) {
      const email = address?.trim().toLowerCase();
      if (email && !byAddress.has(email)) byAddress.set(email, contact);
    }
  }
  return byAddress;
}

export async function fetchContact(id: string): Promise<CrmContactDetail> {
  const body = await apiFetch<CrmContactResponse>(`/crm/contacts/${encodeURIComponent(id)}`, {
    fallbackError: t('Couldn’t load that contact.'),
    noStore: true,
  });
  return body.contact;
}

export interface ContactDraft {
  name: string;
  title: string;
  organization_id: string;
  /** One address per line, the primary first. */
  emails: string;
  /** The fields added; absent, the write leaves them alone. */
  profile?: ContactProfile;
  /** The profile the contact had when the editor opened; null for a new contact. */
  baseProfile?: ContactProfile | null;
}

/**
 * The contact fields the editor adds beyond name, title, organization and
 * addresses. The Mac and the iPhone hold the same in
 * `ContactProfileDraft`.
 */
export interface ContactProfile {
  birthday_month: number | null;
  birthday_day: number | null;
  birthday_year: number | null;
  /** Every name the contact carries, true or false. */
  characteristics: Record<string, boolean>;
  preferred_language: string;
  signals_outreach_status: string | null;
}

export function contactProfile(contact: CrmContactDetail | null): ContactProfile {
  return {
    birthday_month: contact?.birthday_month ?? null,
    birthday_day: contact?.birthday_day ?? null,
    birthday_year: contact?.birthday_year ?? null,
    characteristics: { ...(contact?.characteristics ?? {}) },
    preferred_language: contact?.preferred_language?.trim() || 'en',
    signals_outreach_status: contact?.signals_outreach_status?.trim() || null,
  };
}

/** A birthday needs a month and a day; the year is optional. Null when the profile can be sent. */
export function contactProfileProblem(profile: ContactProfile): string | null {
  const { birthday_month: month, birthday_day: day, birthday_year: year } = profile;
  if (month === null && day === null) return year === null ? null : t('Choose a month and a day for the birthday.');
  if (month === null || day === null) return t('Choose a month and a day for the birthday.');
  if (month < 1 || month > 12 || day < 1 || day > 31) return t('That birthday is not a date.');
  if (year !== null && (year < 1900 || year > 2100)) return t('Use a year from 1900 to 2100.');
  return null;
}

/** The profile fields that differ from `base` (every set field for a new contact), as the write names them. */
export function contactProfileBody(profile: ContactProfile, base: ContactProfile | null): Partial<CrmContactUpdate> {
  const from = base ?? contactProfile(null);
  const body: Partial<CrmContactUpdate> = {};
  if (profile.birthday_month !== from.birthday_month) body.birthday_month = profile.birthday_month;
  if (profile.birthday_day !== from.birthday_day) body.birthday_day = profile.birthday_day;
  if (profile.birthday_year !== from.birthday_year) body.birthday_year = profile.birthday_year;
  const names = new Set([...Object.keys(profile.characteristics), ...Object.keys(from.characteristics)]);
  if ([...names].some((name) => profile.characteristics[name] !== from.characteristics[name])) {
    body.characteristics = Object.keys(profile.characteristics).length > 0 ? profile.characteristics : null;
  }
  if (profile.preferred_language !== from.preferred_language) body.preferred_language = profile.preferred_language;
  if (profile.signals_outreach_status !== from.signals_outreach_status) body.signals_outreach_status = profile.signals_outreach_status;
  return body;
}

/** The characteristic names the editor offers: the vocabulary and any other the contact carries, sorted. */
export function characteristicNames(options: readonly string[], carried: Record<string, boolean>): string[] {
  return [...new Set([...options, ...Object.keys(carried)])].sort();
}

/** A characteristic's stored name as a label: `board_member` reads "Board member". */
export function characteristicLabel(name: string): string {
  const words = name.replaceAll('_', ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/** `GET /api/crm/contact-options`: what the contact editor offers. */
export async function fetchContactOptions(): Promise<CrmContactOptionsResponse> {
  return apiFetch<CrmContactOptionsResponse>('/crm/contact-options', {
    fallbackError: t('Couldn’t load contact options.'),
  });
}

/**
 * Merge contacts. The oldest stays; every link and address moves
 * onto it and the others are deleted. The answer is the same from Core and D1.
 */
export async function mergeContacts(ids: string[]): Promise<CoreMergeResponse> {
  return apiFetch<CoreMergeResponse>('/core/merge/contacts', {
    method: 'POST',
    body: { ids } satisfies CoreMergeBody,
    fallbackError: t('Couldn’t merge those contacts.'),
  });
}

/** Delete a contact. Refused while a call or a task references it; the message names them. */
export async function deleteContact(id: string): Promise<CrmContactDeleteResponse> {
  return apiFetch<CrmContactDeleteResponse>(`/crm/contacts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    fallbackError: t('Couldn’t delete that contact.'),
  });
}

/** The addresses a draft names: one per line or comma, empty ones left out. */
export const draftEmails = formEmails;

/** The body, as `FORM_FIELDS.contact` says each field and each blank goes. */
const contactBody = (draft: ContactDraft, write: 'create' | 'update') => ({
  ...formBody('contact', write, {
    name: draft.name,
    title: draft.title,
    organization: draft.organization_id,
    emails: draftEmails(draft.emails),
  }),
  ...(draft.profile ? contactProfileBody(draft.profile, write === 'create' ? null : draft.baseProfile ?? null) : {}),
});

export async function createContact(draft: ContactDraft): Promise<CrmContactDetail> {
  const body = await apiFetch<CrmContactResponse>('/crm/contacts', {
    method: 'POST',
    fallbackError: t('Couldn’t add that contact.'),
    body: contactBody(draft, 'create'),
  });
  return body.contact;
}

export async function updateContact(id: string, draft: ContactDraft): Promise<CrmContactDetail> {
  const body = await apiFetch<CrmContactResponse>(`/crm/contacts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    fallbackError: t('Couldn’t save that contact.'),
    body: contactBody(draft, 'update'),
  });
  return body.contact;
}

/** A contact's name as a row draws it: the name, else the address. */
export function contactDisplayName(contact: Pick<CrmContact, 'name' | 'email'>): string {
  return contact.name?.trim() || contact.email || t('Unnamed');
}

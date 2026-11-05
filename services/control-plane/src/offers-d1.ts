// The member's offers and catalog on D1 ( to
// #223, #226; decided by MZ, 2026-11-04). Web, Mac and agents edit through
// these. Every write goes through `core-commercial-d1.ts`, the path Core's own
// flows use, so one list of columns, one trail and one freeze check hold.
//
// The rules live here, so an editor and an agent get the same ones: the server
// recomputes every total, EUR is binding and any other currency is indicative,
// Send freezes the offer and returns the link with no email, an edit after Send
// stays unsent until Send update on the same link, an accepted offer is locked,
// a catalog line keeps the catalog's name, and a service is never renamed.

import {
  computeOfferTotals,
  DEFAULT_DISCOUNT_REASON,
  derivedOfferStatus,
  displayPrice,
  offerTotalAmountEur,
} from '@starlings/contracts/offer-values';
import type {
  CatalogResponse,
  CatalogService,
  OfferCreate,
  OfferDecision,
  OfferDecisionResponse,
  OfferDuplicate,
  OfferHeader,
  OfferLine,
  OfferLineCreate,
  OfferLinePatch,
  OfferOptionsResponse,
  OfferPatch,
  OfferResponse,
  OfferSendResponse,
  OfferTotalsWire,
  OfferVersionResponse,
  OfferVersionSummary,
  OrganizationDiscount,
  OrganizationDiscountResponse,
  ServiceCreate,
  ServicePatch,
} from '@starlings/contracts/offers';
import {
  acceptOfferRecord,
  commercialInsertStatement,
  liveOfferSnapshot,
  memberCommercialRow,
  servedCommercialRows,
  writeCoreCommercial,
  type CommercialRawRow,
  type CoreCommercialRow,
  type OfferSnapshot,
} from './core-commercial-d1';
import { ControlError } from './errors';
import { recordWorkActivity, workActivityStatement } from './work-activity';
import { assertGroupWritable } from './work-freeze';
import { workModuleOn } from './work-modules';
import { usesCoreFor } from './work-store';
import { workspacePublicOrigin } from './workspace-origins';

/** What the routes need of the caller's access (`subject-access.ts`). */
export interface OfferAccess {
  requireSee(kind: string, id: string): void;
  requireWrite(kind: string, id: string): void;
}

const refuse = (message: string, status = 409) => new ControlError(message, status, 'invalid_request');

/**
 * Before any read or write: the group's store, then the work module. A Core
 * workspace answers 409 until the group moves, because D1's tables are empty
 * then. Clients hide the editor while the descriptor's `core_groups` names it.
 */
export async function assertOffersHere(env: Env): Promise<void> {
  if (usesCoreFor(env, 'commercial')) throw refuse('Offers on this workspace can’t change here yet.');
  if (!(await workModuleOn(env, 'offers'))) throw refuse('Offers are off for this workspace.');
}

/** The first thing a write does: the store, the module, then the group's freeze. */
async function assertWritable(env: Env): Promise<void> {
  await assertOffersHere(env);
  await assertGroupWritable(env, 'commercial');
}

async function offerRow(env: Env, id: string): Promise<CommercialRawRow> {
  const row = await env.USAGE.prepare('SELECT * FROM offers WHERE id = ?1').bind(id).first<CommercialRawRow>();
  if (!row) throw refuse('No such offer.', 404);
  return row;
}

/** The subject an offer's access follows. An offer on neither is any member's. */
function subjectOf(row: { lead_id?: unknown; organization_id?: unknown }): { kind: string; id: string } | null {
  if (typeof row.lead_id === 'string') return { kind: 'lead', id: row.lead_id };
  if (typeof row.organization_id === 'string') return { kind: 'organization', id: row.organization_id };
  return null;
}

function requireSee(access: OfferAccess, row: CommercialRawRow): void {
  const subject = subjectOf(row);
  if (subject) access.requireSee(subject.kind, subject.id);
}

function requireWrite(access: OfferAccess, row: CommercialRawRow): void {
  const subject = subjectOf(row);
  if (subject) access.requireWrite(subject.kind, subject.id);
}

/** The buyer's link. Core's offer page is the only buyer page until the Worker has one. */
export function offerLink(env: Env, id: string): string {
  const origin = env.CORE_WEB_ORIGIN?.trim() ? new URL(env.CORE_WEB_ORIGIN.trim()).origin : workspacePublicOrigin(env);
  return `${origin}/private/offer/${id}`;
}

// ── Rate and totals ─────────────────────────────────────────────────────────

/** The live rate with the house surcharge, or null when the cache has none. EUR is 1. */
async function liveRate(env: Env, currency: string): Promise<number | null> {
  if (currency === 'EUR') return 1;
  const [cache, settings] = await Promise.all([
    env.USAGE.prepare(`SELECT rate FROM exchange_rates_cache WHERE base_currency = 'EUR' AND target_currency = ?1`).bind(currency).first<number>('rate'),
    env.USAGE.prepare('SELECT surcharge_percentage FROM currency_settings WHERE currency_code = ?1').bind(currency).first<number>('surcharge_percentage'),
  ]);
  if (typeof cache !== 'number' || !(cache > 0)) return null;
  return cache * (1 + (Number(settings) || 0) / 100);
}

/** Core's `chooseOfferRate`: a stored rate other than 1 is frozen, otherwise the live one. With neither, the figures stay EUR. */
async function offerRate(env: Env, row: CommercialRawRow): Promise<{ currency: string; rate: number; frozen: boolean; missing: boolean }> {
  const currency = String(row.currency || 'EUR').toUpperCase();
  if (currency === 'EUR') return { currency, rate: 1, frozen: true, missing: false };
  const stored = Number(row.exchange_rate);
  if (Number.isFinite(stored) && stored > 0 && stored !== 1) return { currency, rate: stored, frozen: true, missing: false };
  const live = await liveRate(env, currency);
  return live !== null ? { currency, rate: live, frozen: false, missing: false } : { currency: 'EUR', rate: 1, frozen: false, missing: true };
}

const lineCounts = (row: Record<string, unknown>) => ({
  price: row.price as number,
  quantity: row.quantity as number,
  is_optional: row.is_optional === true || row.is_optional === 1,
  is_recurring: row.snapshot_is_recurring === true || row.snapshot_is_recurring === 1,
});

async function liveLines(env: Env, offerId: string): Promise<CommercialRawRow[]> {
  const { results } = await env.USAGE.prepare('SELECT * FROM offer_services WHERE offer_id = ?1 ORDER BY id').bind(offerId).all<CommercialRawRow>();
  return results;
}

function totalsOf(row: { global_discount_percentage?: unknown; tax_percentage?: unknown }, lines: ReadonlyArray<Record<string, unknown>>, rate: Awaited<ReturnType<typeof offerRate>>): OfferTotalsWire {
  return {
    ...computeOfferTotals(lines.map(lineCounts), {
      globalDiscountPct: row.global_discount_percentage as number | null,
      taxPct: row.tax_percentage as number | null,
      currency: rate.currency,
      rate: rate.rate,
      rateFrozen: rate.frozen,
    }),
    rate_missing: rate.missing,
  };
}

function wireLine(row: Record<string, unknown>, rate: number): OfferLine {
  const flag = (value: unknown) => value === true || value === 1;
  const isCustom = flag(row.is_custom);
  return {
    id: String(row.id),
    service_id: (row.service_id as string | null) ?? null,
    is_custom: isCustom,
    name: ((row.snapshot_name ?? row.custom_title) as string | null) ?? null,
    description: (row.snapshot_description as string | null) ?? null,
    custom_title: (row.custom_title as string | null) ?? null,
    custom_description: (row.custom_description as string | null) ?? null,
    group_type: (row.snapshot_group_type as string | null) ?? null,
    is_recurring: flag(row.snapshot_is_recurring),
    price: Number(row.price) || 0,
    quantity: Number(row.quantity) || 0,
    is_optional: flag(row.is_optional),
    hide_description: flag(row.hide_description),
    display_price: displayPrice(row.price, rate),
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function versionSummaries(env: Env, offerId: string): Promise<OfferVersionSummary[]> {
  const { results } = await env.USAGE.prepare(
    `SELECT version, sent_at, sent_by, currency, rate, json_extract(totals, '$.total_eur') AS total_eur FROM offer_versions WHERE offer_id = ?1 ORDER BY version DESC`,
  ).bind(offerId).all<{ version: number; sent_at: number; sent_by: string | null; currency: string; rate: number; total_eur: number | null }>();
  return results.map((row) => ({ ...row, sent_at: new Date(row.sent_at).toISOString() }));
}

const text = (row: CoreCommercialRow, column: string) => (row[column] as string | null | undefined) ?? null;
const numberOrNull = (row: CoreCommercialRow, column: string) => (row[column] as number | null | undefined) ?? null;

async function offerResponse(env: Env, id: string): Promise<OfferResponse> {
  const raw = await offerRow(env, id);
  const row = memberCommercialRow('offers', raw);
  const [lines, rate, versions, links] = await Promise.all([
    liveLines(env, id),
    offerRate(env, raw),
    versionSummaries(env, id),
    env.USAGE.prepare('SELECT link_id FROM offer_selected_links WHERE offer_id = ?1 AND is_enabled = 1').bind(id).all<{ link_id: string }>(),
  ]);
  const accepted = row.is_accepted === true;
  const unsent = row.has_unsent_changes === true;
  const never = row.unsent_draft === true;
  const offer: OfferHeader = {
    id,
    title: text(row, 'title'),
    status: String(row.status),
    shown_status: derivedOfferStatus({ status: text(row, 'status'), is_accepted: accepted, valid_until: text(row, 'valid_until') }),
    has_unsent_changes: unsent,
    locked: accepted,
    next_send: accepted ? null : never ? 'send' : unsent || versions.length === 0 ? 'send_update' : null,
    link: never ? null : offerLink(env, id),
    lead_id: text(row, 'lead_id'),
    organization_id: text(row, 'organization_id'),
    recipient_email: text(row, 'recipient_email'),
    currency: text(row, 'currency') ?? 'EUR',
    valid_until: text(row, 'valid_until'),
    global_discount_percentage: numberOrNull(row, 'global_discount_percentage'),
    discount_reason: text(row, 'discount_reason'),
    tax_percentage: numberOrNull(row, 'tax_percentage'),
    tax_reason: text(row, 'tax_reason'),
    payment_term_id: text(row, 'payment_term_id'),
    payment_terms_text: text(row, 'payment_terms_text'),
    delivery_condition_id: text(row, 'delivery_condition_id'),
    delivery_conditions_text: text(row, 'delivery_conditions_text'),
    corporate_entity_id: text(row, 'corporate_entity_id'),
    notes: text(row, 'notes'),
    link_ids: links.results.map((link) => link.link_id),
    total_amount: Number(row.total_amount) || 0,
    is_accepted: accepted,
    accepted_at: text(row, 'accepted_at'),
    accepted_by_name: text(row, 'accepted_by_name'),
    accepted_by_email: text(row, 'accepted_by_email'),
    accepted_version: numberOrNull(row, 'accepted_version'),
    created_at: text(row, 'created_at'),
    updated_at: text(row, 'updated_at'),
  };
  return { offer, lines: lines.map((line) => wireLine(line, rate.rate)), totals: totalsOf(raw, lines, rate), versions };
}

export async function readOffer(env: Env, access: OfferAccess, id: string): Promise<OfferResponse> {
  await assertOffersHere(env);
  requireSee(access, await offerRow(env, id));
  const [answer, views] = await Promise.all([
    offerResponse(env, id),
    env.USAGE.prepare('SELECT accessed_at, accessed_email FROM offer_access_logs WHERE offer_id = ?1 ORDER BY accessed_at DESC LIMIT 50')
      .bind(id).all<{ accessed_at: number; accessed_email: string | null }>(),
  ]);
  return { ...answer, views: views.results.map((row) => ({ at: new Date(row.accessed_at).toISOString(), email: row.accessed_email })) };
}

export async function readOfferVersion(env: Env, access: OfferAccess, id: string, version: number): Promise<OfferVersionResponse> {
  await assertOffersHere(env);
  requireSee(access, await offerRow(env, id));
  const row = await env.USAGE.prepare('SELECT version, sent_at, sent_by, currency, rate, snapshot, totals FROM offer_versions WHERE offer_id = ?1 AND version = ?2')
    .bind(id, version).first<{ version: number; sent_at: number; sent_by: string | null; currency: string; rate: number; snapshot: string; totals: string }>();
  if (!row) throw refuse('No such version.', 404);
  const snapshot = JSON.parse(row.snapshot) as OfferSnapshot;
  const totals = JSON.parse(row.totals) as OfferVersionResponse['totals'];
  return {
    version: { version: row.version, sent_at: new Date(row.sent_at).toISOString(), sent_by: row.sent_by, currency: row.currency, rate: row.rate, total_eur: totals.total_eur ?? null },
    offer: { ...snapshot.offer, notes: snapshot.notes } as OfferVersionResponse['offer'],
    lines: snapshot.lines.map((line) => wireLine(line, row.rate)),
    totals,
  };
}

// ── Offer writes ────────────────────────────────────────────────────────────

/**
 * What every edit does first. An accepted offer refuses. A row a buyer can read
 * gets a version if it has none yet, an offer copied from Core and sent there,
 * so the buyer keeps what they saw; then it is marked as unsent changes.
 */
async function beforeEdit(env: Env, actor: string, row: CommercialRawRow): Promise<void> {
  if (row.is_accepted === 1) throw refuse('This offer was accepted. Duplicate it to change it.');
  if (row.unsent_draft === 1) return;
  const id = String(row.id);
  const known = await env.USAGE.prepare('SELECT 1 AS one FROM offer_versions WHERE offer_id = ?1 LIMIT 1').bind(id).first<number>('one');
  if (!known) {
    const snapshot = await liveOfferSnapshot(env, id);
    const rate = await offerRate(env, row);
    await env.USAGE.prepare(
      'INSERT OR IGNORE INTO offer_versions (id, offer_id, version, sent_at, sent_by, snapshot, totals, rate, currency) VALUES (?1, ?2, 1, ?3, NULL, ?4, ?5, ?6, ?7)',
    ).bind(
      crypto.randomUUID(), id, Number(row.updated_at ?? row.created_at ?? Date.now()), JSON.stringify(snapshot),
      JSON.stringify(totalsOf(row, await liveLines(env, id), rate)), rate.rate, rate.currency,
    ).run();
    await recordWorkActivity(env, { actor, table: 'offer_versions', id, action: 'insert', label: 'Baseline', fields: ['version'] });
  }
  if (row.has_unsent_changes !== 1) await env.USAGE.prepare('UPDATE offers SET has_unsent_changes = 1 WHERE id = ?1').bind(id).run();
}

/** The stored total after a change: never a value a client sent. */
async function storeTotal(env: Env, id: string): Promise<void> {
  const row = await offerRow(env, id);
  const lines = await liveLines(env, id);
  await env.USAGE.prepare('UPDATE offers SET total_amount = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(id, offerTotalAmountEur(lines.map(lineCounts), row.global_discount_percentage as number | null), Date.now()).run();
}

async function resolveSubject(env: Env, body: { lead_id?: string | undefined; organization_id?: string | undefined }): Promise<{ lead_id: string | null; organization_id: string | null; contact_id: string | null }> {
  if (body.lead_id) {
    const lead = await env.USAGE.prepare('SELECT organization_id, contact_id FROM leads WHERE id = ?1').bind(body.lead_id).first<{ organization_id: string | null; contact_id: string | null }>();
    if (!lead) throw refuse('No such lead.', 404);
    if (body.organization_id && lead.organization_id && body.organization_id !== lead.organization_id) throw refuse('That lead is on another organization.');
    return { lead_id: body.lead_id, organization_id: lead.organization_id ?? body.organization_id ?? null, contact_id: lead.contact_id };
  }
  const known = await env.USAGE.prepare('SELECT 1 AS one FROM organizations WHERE id = ?1').bind(body.organization_id ?? '').first<number>('one');
  if (!known) throw refuse('No such organization.', 404);
  return { lead_id: null, organization_id: body.organization_id ?? null, contact_id: null };
}

async function contactEmail(env: Env, contactId: string | null | undefined): Promise<string | null> {
  if (!contactId) return null;
  const email = await env.USAGE.prepare('SELECT email FROM contacts WHERE id = ?1').bind(contactId).first<string>('email');
  return email?.trim() || null;
}

const defaultRow = <T>(env: Env, table: 'settings_delivery_conditions') =>
  env.USAGE.prepare(`SELECT id, description FROM ${table} WHERE is_active = 1 AND is_default = 1 ORDER BY title LIMIT 1`).first<T>();

export async function createOffer(env: Env, access: OfferAccess, actor: string, body: OfferCreate): Promise<OfferResponse> {
  await assertWritable(env);
  const subject = await resolveSubject(env, body);
  if (subject.lead_id) access.requireWrite('lead', subject.lead_id);
  else access.requireWrite('organization', subject.organization_id!);
  if (body.currency) await assertCurrency(env, body.currency);
  const organization = subject.organization_id
    ? await env.USAGE.prepare('SELECT default_discount_percentage, default_discount_reason FROM organizations WHERE id = ?1').bind(subject.organization_id)
      .first<{ default_discount_percentage: number | null; default_discount_reason: string | null }>()
    : null;
  const discount = organization?.default_discount_percentage ?? null;
  const delivery = await defaultRow<{ id: string; description: string }>(env, 'settings_delivery_conditions');
  const created = await writeCoreCommercial(env, actor, {
    action: 'create',
    entity: 'commercial',
    table: 'offers',
    values: {
      status: 'draft',
      unsent_draft: true,
      total_amount: 0,
      exchange_rate: 1,
      currency: body.currency ?? 'EUR',
      lead_id: subject.lead_id,
      organization_id: subject.organization_id,
      title: body.title ?? null,
      valid_until: body.valid_until ?? null,
      recipient_email: await contactEmail(env, body.contact_id ?? subject.contact_id),
      global_discount_percentage: discount,
      discount_reason: discount !== null ? organization?.default_discount_reason ?? DEFAULT_DISCOUNT_REASON : null,
      delivery_condition_id: delivery?.id ?? null,
      delivery_conditions_text: delivery?.description ?? null,
    },
  }, 'member');
  const id = String(created!.id);
  const { results: links } = await env.USAGE.prepare('SELECT id FROM settings_offer_links WHERE is_active = 1 AND is_default = 1').all<{ id: string }>();
  if (links.length > 0) await env.USAGE.batch(links.map((link) => linkStatement(env, id, link.id)));
  return offerResponse(env, id);
}

const linkStatement = (env: Env, offerId: string, linkId: string) => commercialInsertStatement(env, 'offer_selected_links', {
  id: crypto.randomUUID(), offer_id: offerId, link_id: linkId, is_enabled: true, created_at: new Date().toISOString(),
});

async function assertCurrency(env: Env, currency: string): Promise<void> {
  if (currency === 'EUR') return;
  const enabled = await env.USAGE.prepare('SELECT is_enabled FROM currency_settings WHERE currency_code = ?1').bind(currency).first<number>('is_enabled');
  if (enabled !== 1) throw refuse(`${currency} is not an offer currency here.`, 422);
}

export async function patchOffer(env: Env, access: OfferAccess, actor: string, id: string, body: OfferPatch): Promise<OfferResponse> {
  await assertWritable(env);
  const row = await offerRow(env, id);
  requireWrite(access, row);
  await beforeEdit(env, actor, row);
  const { link_ids: linkIds, ...values } = body;
  const set: Record<string, unknown> = { ...values };
  if (body.currency !== undefined) {
    await assertCurrency(env, body.currency);
    // A rate of 1 is an unfrozen rate; Send freezes the new one.
    if (body.currency !== String(row.currency ?? 'EUR').toUpperCase()) set.exchange_rate = 1;
  }
  if (body.payment_term_id && body.payment_terms_text === undefined) {
    set.payment_terms_text = await settingText(env, 'settings_payment_terms', body.payment_term_id);
  }
  if (body.delivery_condition_id && body.delivery_conditions_text === undefined) {
    set.delivery_conditions_text = await settingText(env, 'settings_delivery_conditions', body.delivery_condition_id);
  }
  if (Object.keys(set).length > 0) {
    await writeCoreCommercial(env, actor, { action: 'update', entity: 'commercial', table: 'offers', id, values: set as never, unless: { is_accepted: true } }, 'member');
  }
  if (linkIds) {
    await env.USAGE.batch([
      env.USAGE.prepare('DELETE FROM offer_selected_links WHERE offer_id = ?1').bind(id),
      ...[...new Set(linkIds)].map((linkId) => linkStatement(env, id, linkId)),
      workActivityStatement(env, { actor, table: 'offer_selected_links', id, action: 'update', fields: ['link_ids'] }),
    ]);
  }
  await storeTotal(env, id);
  return offerResponse(env, id);
}

async function settingText(env: Env, table: 'settings_payment_terms' | 'settings_delivery_conditions', id: string): Promise<string> {
  const description = await env.USAGE.prepare(`SELECT description FROM ${table} WHERE id = ?1`).bind(id).first<string>('description');
  if (description === null) throw refuse('No such term.', 404);
  return description;
}

interface ServiceRow {
  id: string;
  name: string;
  description: string;
  price: number;
  group_type: string | null;
  is_recurring: number | null;
  allow_multiple: number;
  allow_description_override: number;
}

export async function addOfferLine(env: Env, access: OfferAccess, actor: string, id: string, body: OfferLineCreate): Promise<OfferResponse> {
  await assertWritable(env);
  const row = await offerRow(env, id);
  requireWrite(access, row);
  let values: Record<string, unknown>;
  if (body.custom_title !== undefined) {
    // Core's `check_service_or_custom`: a custom line names no service.
    values = {
      is_custom: true,
      custom_title: body.custom_title,
      custom_description: body.custom_description ?? null,
      price: body.price!,
      snapshot_name: body.custom_title,
      snapshot_description: body.custom_description ?? null,
      snapshot_group_type: 'Custom',
      snapshot_is_recurring: false,
    };
  } else {
    const service = body.service_id
      ? await env.USAGE.prepare('SELECT * FROM services WHERE id = ?1').bind(body.service_id).first<ServiceRow>()
      : await env.USAGE.prepare('SELECT * FROM services WHERE slug = ?1').bind(body.service_slug!).first<ServiceRow>();
    if (!service) throw refuse('No such service.', 404);
    if (body.custom_description !== undefined && service.allow_description_override !== 1) throw refuse('This service keeps its own description.');
    if (service.allow_multiple !== 1) {
      const already = await env.USAGE.prepare('SELECT 1 AS one FROM offer_services WHERE offer_id = ?1 AND service_id = ?2 LIMIT 1').bind(id, service.id).first<number>('one');
      if (already) throw refuse('This service can be on an offer once.');
    }
    values = {
      is_custom: false,
      service_id: service.id,
      custom_description: body.custom_description ?? null,
      price: body.price ?? service.price,
      snapshot_name: service.name,
      snapshot_description: body.custom_description ?? service.description,
      snapshot_group_type: service.group_type,
      snapshot_is_recurring: service.is_recurring === 1,
    };
  }
  await beforeEdit(env, actor, row);
  await writeCoreCommercial(env, actor, {
    action: 'create',
    entity: 'commercial',
    table: 'offer_services',
    values: { ...values, offer_id: id, quantity: body.quantity, is_optional: body.is_optional, hide_description: body.hide_description } as never,
  }, 'member');
  await storeTotal(env, id);
  return offerResponse(env, id);
}

async function lineRow(env: Env, offerId: string, lineId: string): Promise<CommercialRawRow> {
  const line = await env.USAGE.prepare('SELECT * FROM offer_services WHERE id = ?1 AND offer_id = ?2').bind(lineId, offerId).first<CommercialRawRow>();
  if (!line) throw refuse('No such line.', 404);
  return line;
}

export async function patchOfferLine(env: Env, access: OfferAccess, actor: string, id: string, lineId: string, body: OfferLinePatch): Promise<OfferResponse> {
  await assertWritable(env);
  const row = await offerRow(env, id);
  requireWrite(access, row);
  const line = await lineRow(env, id, lineId);
  const custom = line.is_custom === 1;
  if (!custom && body.custom_title !== undefined) throw refuse('A catalog line keeps the catalog’s name.');
  const values: Record<string, unknown> = { ...body };
  if (custom && body.custom_title !== undefined) values.snapshot_name = body.custom_title;
  if (body.custom_description !== undefined) {
    if (custom) {
      values.snapshot_description = body.custom_description;
    } else {
      const service = await env.USAGE.prepare('SELECT * FROM services WHERE id = ?1').bind(line.service_id).first<ServiceRow>();
      if (service?.allow_description_override !== 1) throw refuse('This service keeps its own description.');
      values.snapshot_description = body.custom_description ?? service.description;
    }
  }
  await beforeEdit(env, actor, row);
  await writeCoreCommercial(env, actor, { action: 'update', entity: 'commercial', table: 'offer_services', id: lineId, values: values as never }, 'member');
  await storeTotal(env, id);
  return offerResponse(env, id);
}

export async function removeOfferLine(env: Env, access: OfferAccess, actor: string, id: string, lineId: string): Promise<OfferResponse> {
  await assertWritable(env);
  const row = await offerRow(env, id);
  requireWrite(access, row);
  await lineRow(env, id, lineId);
  await beforeEdit(env, actor, row);
  await writeCoreCommercial(env, actor, { action: 'delete', entity: 'commercial', table: 'offer_services', id: lineId }, 'member');
  await storeTotal(env, id);
  return offerResponse(env, id);
}

/**
 * Send, and Send update: check, freeze the rate and the totals, write the next
 * version, return the link. No email: the member shares the link.
 */
async function freezeOffer(env: Env, actor: string, row: CommercialRawRow): Promise<OfferSendResponse> {
  const id = String(row.id);
  const lines = await liveLines(env, id);
  if (lines.filter((line) => line.is_optional !== 1).length === 0) throw refuse('Add a line that is not optional before you send.', 422);
  const recipient = (row.recipient_email as string | null)?.trim()
    || (typeof row.lead_id === 'string'
      ? await contactEmail(env, await env.USAGE.prepare('SELECT contact_id FROM leads WHERE id = ?1').bind(row.lead_id).first<string>('contact_id'))
      : null);
  if (!recipient) throw refuse('Name who the offer is for before you send.', 422);
  const validUntil = Number(row.valid_until);
  if (!Number.isFinite(validUntil) || row.valid_until === null || validUntil <= Date.now()) throw refuse('Set a valid-until date in the future before you send.', 422);
  const currency = String(row.currency || 'EUR').toUpperCase();
  const rate = await liveRate(env, currency);
  if (rate === null) throw refuse(`There is no rate for ${currency}. Refresh the rates or use EUR.`, 422);

  const now = Date.now();
  const previous = await env.USAGE.prepare('SELECT MAX(version) AS version FROM offer_versions WHERE offer_id = ?1').bind(id).first<number>('version');
  const version = (previous ?? 0) + 1;
  const totalAmount = offerTotalAmountEur(lines.map(lineCounts), row.global_discount_percentage as number | null);
  const totals = totalsOf(row, lines, { currency, rate, frozen: true, missing: false });
  const snapshot = (await liveOfferSnapshot(env, id))!;
  snapshot.offer = { ...snapshot.offer, exchange_rate: rate, total_amount: totalAmount, recipient_email: recipient };
  try {
    await env.USAGE.batch([
      env.USAGE.prepare('INSERT INTO offer_versions (id, offer_id, version, sent_at, sent_by, snapshot, totals, rate, currency) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
        .bind(crypto.randomUUID(), id, version, now, actor, JSON.stringify(snapshot), JSON.stringify(totals), rate, currency),
      env.USAGE.prepare(
        `UPDATE offers SET status = 'sent', unsent_draft = 0, has_unsent_changes = 0, exchange_rate = ?2, total_amount = ?3, recipient_email = ?4, updated_at = ?5
          WHERE id = ?1 AND is_accepted IS NOT 1`,
      ).bind(id, rate, totalAmount, recipient, now),
      workActivityStatement(env, { actor, table: 'offer_versions', id, action: 'insert', label: `Version ${version}`, fields: ['version', 'status'] }),
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/u.test(error.message)) throw refuse('Someone else sent this offer. Read it again.');
    throw error;
  }
  const link = offerLink(env, id);
  return { ...(await offerResponse(env, id)), version, link };
}

export async function sendOffer(env: Env, access: OfferAccess, actor: string, id: string): Promise<OfferSendResponse> {
  await assertWritable(env);
  const row = await offerRow(env, id);
  requireWrite(access, row);
  if (row.is_accepted === 1) throw refuse('This offer was accepted.');
  if (row.unsent_draft !== 1) throw refuse('This offer was sent. Use Send update.');
  return freezeOffer(env, actor, row);
}

export async function sendOfferUpdate(env: Env, access: OfferAccess, actor: string, id: string): Promise<OfferSendResponse> {
  await assertWritable(env);
  const row = await offerRow(env, id);
  requireWrite(access, row);
  if (row.is_accepted === 1) throw refuse('This offer was accepted.');
  if (row.unsent_draft === 1) throw refuse('This offer has not been sent. Use Send.');
  if (row.has_unsent_changes !== 1) {
    const known = await env.USAGE.prepare('SELECT 1 AS one FROM offer_versions WHERE offer_id = ?1 LIMIT 1').bind(id).first<number>('one');
    if (known) throw refuse('There are no changes to send.');
  }
  return freezeOffer(env, actor, row);
}

export async function duplicateOffer(env: Env, access: OfferAccess, actor: string, id: string, body: OfferDuplicate): Promise<OfferResponse> {
  await assertWritable(env);
  const row = await offerRow(env, id);
  requireSee(access, row);
  const named = body.lead_id || body.organization_id;
  const subject = await resolveSubject(env, named ? body : {
    ...(typeof row.lead_id === 'string' ? { lead_id: row.lead_id } : {}),
    ...(typeof row.organization_id === 'string' ? { organization_id: row.organization_id } : {}),
  });
  if (subject.lead_id) access.requireWrite('lead', subject.lead_id);
  else access.requireWrite('organization', subject.organization_id!);

  const newId = crypto.randomUUID();
  const now = new Date().toISOString();
  const lines = await liveLines(env, id);
  const { results: links } = await env.USAGE.prepare('SELECT link_id FROM offer_selected_links WHERE offer_id = ?1 AND is_enabled = 1').bind(id).all<{ link_id: string }>();
  const sameSubject = subject.lead_id === (row.lead_id ?? null) && subject.organization_id === (row.organization_id ?? null);
  const recipient = sameSubject ? (row.recipient_email as string | null) : await contactEmail(env, subject.contact_id);
  const wire = memberCommercialRow('offers', row);
  await env.USAGE.batch([
    commercialInsertStatement(env, 'offers', {
      id: newId,
      created_at: now,
      updated_at: now,
      status: 'draft',
      unsent_draft: true,
      title: null,
      lead_id: subject.lead_id,
      organization_id: subject.organization_id,
      recipient_email: recipient,
      currency: wire.currency,
      exchange_rate: 1,
      total_amount: offerTotalAmountEur(lines.map(lineCounts), row.global_discount_percentage as number | null),
      global_discount_percentage: wire.global_discount_percentage,
      discount_reason: wire.discount_reason,
      tax_percentage: wire.tax_percentage,
      tax_reason: wire.tax_reason,
      payment_term_id: wire.payment_term_id,
      payment_terms_text: wire.payment_terms_text,
      delivery_condition_id: wire.delivery_condition_id,
      delivery_conditions_text: wire.delivery_conditions_text,
      corporate_entity_id: wire.corporate_entity_id,
      notes: wire.notes,
    }),
    ...lines.map((line) => {
      const copy = memberCommercialRow('offer_services', line);
      return commercialInsertStatement(env, 'offer_services', { ...copy, id: crypto.randomUUID(), offer_id: newId });
    }),
    ...links.map((link) => linkStatement(env, newId, link.link_id)),
    workActivityStatement(env, { actor, table: 'offers', id: newId, action: 'insert', label: 'Duplicate', fields: ['duplicate_of'] }),
  ]);
  return offerResponse(env, newId);
}

/**
 * What the buyer told a member. An accept is the one Core's public accept lands
 * on (`acceptOfferRecord`): it locks the offer on the version the buyer read and
 * makes the license and the project, in one batch.
 */
export async function recordOfferDecision(env: Env, access: OfferAccess, actor: string, id: string, body: OfferDecision): Promise<OfferDecisionResponse> {
  await assertWritable(env);
  const row = await offerRow(env, id);
  requireWrite(access, row);
  if (row.is_accepted === 1) throw refuse('This offer was accepted.');
  if (row.unsent_draft === 1) throw refuse('This offer has not been sent.');
  if (body.decision === 'reject') {
    await writeCoreCommercial(env, actor, { action: 'update', entity: 'commercial', table: 'offers', id, values: { status: 'declined' }, unless: { is_accepted: true } }, 'member');
    return { ...(await offerResponse(env, id)), license_id: null, license_created: false, project_id: null, project_created: false };
  }
  // The buyer accepted what they read, not unsent edits.
  const read = { op: 'commercial_rows', limit: 1000, offset: 0 } as const;
  const [served] = await servedCommercialRows(env, { ...read, table: 'offers', eq: { id } });
  const servedLines = await servedCommercialRows(env, { ...read, table: 'offer_services', eq: { offer_id: id } });
  const optional = new Set(servedLines.filter((line) => line.is_optional === true).map((line) => String(line.id)));
  const chosen = [...new Set(body.selected_optional_ids ?? [])].filter((lineId) => optional.has(lineId));
  const taken = servedLines.map((line) => (chosen.includes(String(line.id)) ? { ...line, is_optional: false } : line));
  const rate = await offerRate(env, { ...row, currency: served!.currency, exchange_rate: served!.exchange_rate } as CommercialRawRow);
  const totals = totalsOf(served!, taken, rate);
  const accepted = await acceptOfferRecord(env, actor, id, {
    is_accepted: true,
    status: 'accepted',
    accepted_at: new Date().toISOString(),
    accepted_metadata: { accepted_source: 'member', recorded_by: actor, selected_optional_ids: chosen, rate: totals.rate, rate_currency: totals.currency, rate_error: rate.missing, totals },
    total_amount: Math.max(0, Math.round(totals.total_eur)),
    ...(rate.missing ? {} : { exchange_rate: rate.rate }),
    ...(body.accepted_by_name ? { accepted_by_name: body.accepted_by_name } : {}),
    ...(body.accepted_by_email ? { accepted_by_email: body.accepted_by_email } : {}),
  }, { unless: { is_accepted: true } });
  if (!accepted) throw refuse('This offer was accepted.');
  const { row: _row, ...made } = accepted;
  return { ...(await offerResponse(env, id)), ...made };
}

// ── The picker lists ────────────────────────────────────────────────────────

export async function readOfferOptions(env: Env): Promise<OfferOptionsResponse> {
  await assertOffersHere(env);
  const [currencies, terms, conditions, entities, links] = await env.USAGE.batch([
    env.USAGE.prepare('SELECT currency_code, symbol, surcharge_percentage FROM currency_settings WHERE is_enabled = 1 ORDER BY currency_code'),
    env.USAGE.prepare('SELECT id, title, description, is_default FROM settings_payment_terms WHERE is_active = 1 ORDER BY is_default DESC, title'),
    env.USAGE.prepare('SELECT id, title, description, is_default FROM settings_delivery_conditions WHERE is_active = 1 ORDER BY is_default DESC, title'),
    env.USAGE.prepare('SELECT id, name, is_default FROM corporate_entities ORDER BY is_default = 1 DESC, name'),
    env.USAGE.prepare('SELECT id, title, url, is_default FROM settings_offer_links WHERE is_active = 1 ORDER BY is_default DESC, title'),
  ]);
  type Row = Record<string, string | number | null>;
  const flagged = (row: Row) => ({ ...row, is_default: row.is_default === 1 });
  return {
    currencies: (currencies!.results as Row[]).map((row) => ({ code: String(row.currency_code), symbol: (row.symbol as string | null) ?? null, surcharge_percentage: Number(row.surcharge_percentage) || 0 })),
    payment_terms: (terms!.results as Row[]).map(flagged) as OfferOptionsResponse['payment_terms'],
    delivery_conditions: (conditions!.results as Row[]).map(flagged) as OfferOptionsResponse['delivery_conditions'],
    corporate_entities: (entities!.results as Row[]).map(flagged) as OfferOptionsResponse['corporate_entities'],
    links: (links!.results as Row[]).map(flagged) as OfferOptionsResponse['links'],
  };
}

// ── The partner's standing discount ─────────────────────────────────────────

/** The organization's standing discount, which a new offer on it starts with. */
export async function readOrganizationDiscount(env: Env, access: OfferAccess, organizationId: string): Promise<OrganizationDiscountResponse> {
  await assertOffersHere(env);
  access.requireSee('organization', organizationId);
  const row = await env.USAGE.prepare('SELECT default_discount_percentage, default_discount_reason FROM organizations WHERE id = ?1').bind(organizationId)
    .first<{ default_discount_percentage: number | null; default_discount_reason: string | null }>();
  if (!row) throw refuse('No such organization.', 404);
  return { organization_id: organizationId, default_discount_percentage: row.default_discount_percentage, default_discount_reason: row.default_discount_reason };
}

export async function setOrganizationDiscount(env: Env, access: OfferAccess, actor: string, organizationId: string, body: OrganizationDiscount): Promise<OrganizationDiscountResponse> {
  await assertWritable(env);
  await assertGroupWritable(env, 'subjects');
  access.requireWrite('organization', organizationId);
  const reason = body.default_discount_percentage === null ? null : body.default_discount_reason ?? DEFAULT_DISCOUNT_REASON;
  const result = await env.USAGE.prepare('UPDATE organizations SET default_discount_percentage = ?2, default_discount_reason = ?3, updated_at = ?4 WHERE id = ?1')
    .bind(organizationId, body.default_discount_percentage, reason, Date.now()).run();
  if (!result.meta.changes) throw refuse('No such organization.', 404);
  await recordWorkActivity(env, { actor, table: 'organizations', id: organizationId, action: 'update', fields: ['default_discount_percentage', 'default_discount_reason'] });
  return { organization_id: organizationId, default_discount_percentage: body.default_discount_percentage, default_discount_reason: reason };
}

// ── The catalog ─────────────────────────────────────────────────────────────

const wireService = (row: CoreCommercialRow): CatalogService => ({
  id: String(row.id),
  name: String(row.name),
  slug: text(row, 'slug'),
  description: String(row.description),
  summary: String(row.summary),
  price: Number(row.price) || 0,
  is_recurring: row.is_recurring === true,
  recurring_interval: text(row, 'recurring_interval'),
  url: text(row, 'url'),
  icon: text(row, 'icon'),
  group_type: text(row, 'group_type'),
  category: text(row, 'category'),
  is_public: row.is_public === true,
  is_listed: row.is_listed === true,
  allow_multiple: row.allow_multiple === true,
  is_default: row.is_default === true,
  allow_description_override: row.allow_description_override === true,
  name_pt: text(row, 'name_pt'),
  summary_pt: text(row, 'summary_pt'),
  description_pt: text(row, 'description_pt'),
});

export async function listCatalog(env: Env): Promise<CatalogResponse> {
  await assertOffersHere(env);
  const { results } = await env.USAGE.prepare('SELECT * FROM services ORDER BY group_type, name COLLATE NOCASE').all<CommercialRawRow>();
  return { services: results.map((row) => wireService(memberCommercialRow('services', row))) };
}

async function serviceRow(env: Env, id: string): Promise<CommercialRawRow> {
  const row = await env.USAGE.prepare('SELECT * FROM services WHERE id = ?1').bind(id).first<CommercialRawRow>();
  if (!row) throw refuse('No such service.', 404);
  return row;
}

const slugTaken = (error: unknown) => error instanceof Error && /UNIQUE constraint failed: services\.slug/u.test(error.message);

export async function createService(env: Env, actor: string, body: ServiceCreate): Promise<CatalogService> {
  await assertWritable(env);
  try {
    const created = await writeCoreCommercial(env, actor, { action: 'create', entity: 'commercial', table: 'services', values: body as never }, 'member');
    return wireService(memberCommercialRow('services', await serviceRow(env, String(created!.id))));
  } catch (error) {
    if (slugTaken(error)) throw refuse('That slug is taken.');
    throw error;
  }
}

export async function patchService(env: Env, actor: string, id: string, body: ServicePatch): Promise<CatalogService> {
  await assertWritable(env);
  const current = await serviceRow(env, id);
  if (body.slug !== undefined && current.slug !== null && current.slug !== body.slug) throw refuse('A slug never changes. Create a new service.');
  try {
    await writeCoreCommercial(env, actor, { action: 'update', entity: 'commercial', table: 'services', id, values: body as never }, 'member');
  } catch (error) {
    if (slugTaken(error)) throw refuse('That slug is taken.');
    throw error;
  }
  return wireService(memberCommercialRow('services', await serviceRow(env, id)));
}

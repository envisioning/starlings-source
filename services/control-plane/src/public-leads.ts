// The public lead form (MZ, 2026-11-05; docs/SECURITY.md, "The public lead
// route"). What Core's `POST /api/public/leads` does, on D1: find or make the
// organization and the contact, make the lead and its interaction, record the
// source fact, and post the channel line. Core also mails the sender and the
// team; this route does not.
//
// The route is shut unless the workspace set `PUBLIC_LEAD_SECRET` and keeps
// these records in D1. It answers as a path with no route, so no other firm
// has an open door, and Envisioning has none before its switch.
import { crmContactCreateSchema, crmOrganizationUpdateSchema } from '@starlings/contracts';
import {
  PUBLIC_LEAD_BODY_MAX_BYTES,
  publicLeadSubmissionSchema,
  type PublicLeadResponse,
  type PublicLeadSubmission,
} from '@starlings/contracts/public-leads';
import { writeD1Interaction } from './core-interactions-d1';
import { createCrmContact, createCrmOrganization, createCrmSubject, purgeRecordCaches, updateCrmOrganization } from './crm';
import { constantTimeEqualSync, hmacSHA256Hex, sha256, SIGNATURE_WINDOW_MS } from './crypto';
import { AuthError, ControlError } from './errors';
import { FORM_ACTOR } from './forms';
import { assertUnderRateLimit, json, readBoundedText } from './http';
import { recordInboundRefusal } from './ops';
import { contactSourceStatement } from './subject-settings';
import { postSubjectEvent } from './threads';
import { assertHumanFailClosed } from './turnstile';
import { contactIdForEmail, d1ContactOrganization } from './work-d1';
import { assertGroupWritable } from './work-freeze';
import { usesCoreFor } from './work-store';

/** The name refused calls are counted under in `ops_inbound`, so a secret that drifted shows up. */
const CALLER = 'public-leads';
const MIN_SECRET_CHARS = 32;
const SOURCE_KEY = 'website_contact';
const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
/** Every submission in an hour, from every address. Core saw 16 in 90 days, so this is a flood's whole budget. */
const HOURLY_LIMIT = 60;

/** The key the sites sign with, or null when this workspace has not enabled the route. */
function routeSecret(env: Env): string | null {
  if (usesCoreFor(env, 'subjects') || usesCoreFor(env, 'interactions')) return null;
  const secret = env.PUBLIC_LEAD_SECRET?.trim();
  return secret && secret.length >= MIN_SECRET_CHARS ? secret : null;
}

/**
 * A signature that is present must be right, and a token does not rescue a
 * wrong one. A call with neither is refused. The Turnstile check here fails
 * closed: this route writes records, and nobody is waiting to join a meeting.
 */
async function assertSignedOrHuman(request: Request, env: Env, secret: string, rawBody: string, token: string | undefined): Promise<void> {
  const timestamp = request.headers.get('x-internal-timestamp') ?? '';
  const signature = request.headers.get('x-internal-signature') ?? '';
  if (!timestamp && !signature) {
    await assertUnderRateLimit(env.FEEDBACK_LIMIT, request, 'public-lead-unsigned');
    await assertHumanFailClosed(request, env, token);
    return;
  }
  const sentAt = Number(timestamp);
  if (!timestamp || !signature || !Number.isFinite(sentAt)) throw new AuthError('Request is not signed.', 403, 'owner_auth_required');
  if (Math.abs(Date.now() - sentAt) > SIGNATURE_WINDOW_MS) {
    await recordInboundRefusal(env, CALLER, 'expired');
    throw new AuthError('Signature has expired.', 403, 'owner_auth_required');
  }
  if (!constantTimeEqualSync(await hmacSHA256Hex(secret, `${timestamp}.${rawBody}`), signature.trim().toLowerCase())) {
    await recordInboundRefusal(env, CALLER, 'mismatch');
    throw new AuthError('Signature does not match.', 403, 'owner_auth_required');
  }
}

/** A submission's identity for one day: the same words from the same person, today or yesterday, are a repeat. */
async function dedupeKeys(body: PublicLeadSubmission, now: number): Promise<{ today: string; yesterday: string }> {
  const hash = await sha256(JSON.stringify([
    body.email, body.organization.toLowerCase(), body.message ?? '', body.sourcePage ?? '', body.createLead,
  ]));
  const day = Math.floor(now / DAY_MS);
  return { today: `public_lead:${hash}:${day}`, yesterday: `public_lead:${hash}:${day - 1}` };
}

interface FactRow {
  source_record_type: string | null;
  source_record_id: string | null;
  metadata: string | null;
}

function organizationOf(fact: FactRow): string | null {
  try {
    const value = (JSON.parse(fact.metadata ?? '{}') as { organization_id?: unknown }).organization_id;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function answer(body: PublicLeadSubmission, contactId: string, leadId: string | null, organizationId: string | null, duplicate: boolean): Response {
  return json({
    message: leadId ? 'Contact and lead created successfully' : 'Contact created successfully',
    lead_id: leadId,
    organization_id: organizationId,
    contact_id: contactId,
    requestOffer: body.requestOffer,
    duplicate,
  } satisfies PublicLeadResponse);
}

async function repeatedAnswer(env: Env, body: PublicLeadSubmission, contactId: string, keys: { today: string; yesterday: string }): Promise<Response | null> {
  const fact = await env.USAGE.prepare(
    `SELECT source_record_type, source_record_id, metadata FROM contact_source_events
     WHERE contact_id = ?1 AND dedupe_key IN (?2, ?3) LIMIT 1`,
  ).bind(contactId, keys.today, keys.yesterday).first<FactRow>();
  if (!fact) return null;
  return answer(body, contactId, fact.source_record_type === 'leads' ? fact.source_record_id : null, organizationOf(fact), true);
}

/** The two-letter code in capitals. A name from an old caller stays as it came. */
function countryStored(country: string | undefined): string | null {
  if (!country) return null;
  return /^[A-Za-z]{2}$/u.test(country) ? country.toUpperCase() : country;
}

function countryLabel(stored: string | null): string {
  if (!stored) return 'Not provided';
  if (!/^[A-Z]{2}$/u.test(stored)) return stored;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(stored) ?? stored;
  } catch {
    return stored;
  }
}

/** The organization with this name, or a new one. A public form fills in a new row and never changes a row that exists. */
async function findOrMakeOrganization(env: Env, name: string, country: string | null): Promise<string> {
  const existing = await env.USAGE.prepare('SELECT id FROM organizations WHERE name = ?1 COLLATE NOCASE').bind(name).first<{ id: string }>();
  if (existing) return existing.id;
  const created = await createCrmOrganization(env, FORM_ACTOR, name);
  await updateCrmOrganization(env, FORM_ACTOR, created.id, crmOrganizationUpdateSchema.parse({ legal_name: name, ...(country ? { country } : {}) }));
  return created.id;
}

async function makeContact(env: Env, body: PublicLeadSubmission, title: string | null, country: string | null, organizationId: string | null): Promise<string> {
  try {
    const contact = await createCrmContact(env, FORM_ACTOR, crmContactCreateSchema.parse({
      name: body.name,
      title,
      organization_id: organizationId,
      emails: [body.email],
      source_key: SOURCE_KEY,
      ...(country ? { country } : {}),
      notes: `Created from public form submission. Organization: ${body.organization}`,
    }), { anySource: true });
    return contact.id;
  } catch (error) {
    // Two submissions from a new address at once: the other one made the contact.
    const winner = await contactIdForEmail(env, body.email);
    if (winner) return winner;
    throw error;
  }
}

/** The lead's notes and the interaction's description, in Core's order and labels. */
function details(body: PublicLeadSubmission, title: string | null, country: string | null): string {
  const message = body.message ? `\nContact Reason:\n${body.message}` : '';
  const partner = body.partner ? `\nReferred by partner: ${body.partner}` : '';
  const budget = body.budgetRange ? `\nBudget Range: ${body.budgetRange}` : '';
  const funds = body.fundsAllocated ? `\nFunds Allocated: ${body.fundsAllocated === 'yes' ? 'Yes' : 'No'}` : '';
  return `Contact: ${body.name} (${body.email})\nJob Title: ${title ?? 'Not provided'}\nCountry: ${countryLabel(country)}${message}${partner}\n\nRequest Offer: ${body.requestOffer ? 'Yes' : 'No'}${budget}${funds}`;
}

/** The interaction is the lead's history, not the lead: a failure logs one line, as on Core. */
async function fileInteraction(env: Env, body: PublicLeadSubmission, description: string, organizationId: string | null, leadId: string | null, contactId: string): Promise<void> {
  try {
    const written = await writeD1Interaction(env, FORM_ACTOR, {
      action: 'create',
      entity: 'interactions',
      values: {
        title: body.requestOffer ? 'Site - Offer requested' : 'Site - Information only',
        type: 'web',
        source: 'website',
        channel: 'web',
        description,
        organization_id: organizationId,
        ...(leadId ? { lead_id: leadId } : {}),
        tags: ['public-form', 'initial-contact'],
      },
      contact_ids: [contactId],
    });
    await purgeRecordCaches('interactions', null, written?.after ?? undefined);
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'public-lead.interaction.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

export async function handlePublicLead(request: Request, env: Env): Promise<Response> {
  const secret = routeSecret(env);
  if (!secret) return json({ error: 'Not found.' }, 404);
  await assertUnderRateLimit(env.AGENT_LIMIT, request, CALLER);

  const rawBody = await readBoundedText(request, PUBLIC_LEAD_BODY_MAX_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new ControlError('Request body must be valid JSON.', 400, 'invalid_request');
  }
  const token = (parsed as { turnstileToken?: unknown } | null)?.turnstileToken;
  await assertSignedOrHuman(request, env, secret, rawBody, typeof token === 'string' ? token : undefined);
  const body = publicLeadSubmissionSchema.parse(parsed);

  await assertGroupWritable(env, 'subjects');
  await assertGroupWritable(env, 'interactions');
  const now = Date.now();
  const recent = await env.USAGE.prepare(
    'SELECT COUNT(*) AS n FROM contact_source_events WHERE source_key = ?1 AND occurred_at > ?2',
  ).bind(SOURCE_KEY, now - HOUR_MS).first<{ n: number }>();
  if ((recent?.n ?? 0) >= HOURLY_LIMIT) throw new ControlError('This form takes no more answers right now. Try again in an hour.', 429, 'rate_limited');

  const keys = await dedupeKeys(body, now);
  const known = await contactIdForEmail(env, body.email);
  if (known) {
    const repeated = await repeatedAnswer(env, body, known, keys);
    if (repeated) return repeated;
  }

  const title = body.title && body.title !== 'Not provided' ? body.title : null;
  const country = countryStored(body.country);
  // A contact-only submission from a person this workspace knows names no new record.
  const organizationId = body.createLead || !known
    ? await findOrMakeOrganization(env, body.organization, country)
    : await d1ContactOrganization(env, known);
  const contactId = known ?? await makeContact(env, body, title, country, organizationId);

  // The fact goes first: its (contact, dedupe key) pair lets one of two
  // identical submissions at once through, and the other reads its answer.
  const sourcePage = body.sourcePage ? body.sourcePage.slice(0, 200) : null;
  const reserved = await contactSourceStatement(env, contactId, {
    eventType: 'form_submitted',
    sourceKey: SOURCE_KEY,
    sourceRecordType: 'contacts',
    sourceRecordId: contactId,
    dedupeKey: keys.today,
    metadata: {
      createLead: body.createLead,
      message: body.message ? body.message.slice(0, 1000) : null,
      organization_id: organizationId,
      requestOffer: body.requestOffer,
      sourcePage,
    },
  }, now).run();
  if ((reserved.meta?.changes ?? 0) === 0) {
    const repeated = await repeatedAnswer(env, body, contactId, keys);
    if (repeated) return repeated;
  }

  const description = details(body, title, country);
  let leadId: string | null = null;
  if (body.createLead) {
    try {
      const lead = await createCrmSubject(env, {
        kind: 'lead',
        title: `Lead for ${body.organization}`,
        organization_id: organizationId,
        contact_id: contactId,
        status: 'Conversations',
        start_date: new Date(now).toISOString().slice(0, 10),
        notes: description,
      }, FORM_ACTOR);
      leadId = lead.id;
    } catch (error) {
      // A retry must be able to file the lead: the fact goes with the failure.
      await env.USAGE.prepare('DELETE FROM contact_source_events WHERE contact_id = ?1 AND dedupe_key = ?2').bind(contactId, keys.today).run();
      throw error;
    }
    await env.USAGE.batch([
      env.USAGE.prepare('UPDATE leads SET source = ?2 WHERE id = ?1').bind(leadId, sourcePage),
      env.USAGE.prepare(
        "UPDATE contact_source_events SET source_record_type = 'leads', source_record_id = ?3 WHERE contact_id = ?1 AND dedupe_key = ?2",
      ).bind(contactId, keys.today, leadId),
    ]);
  }

  await fileInteraction(env, body, description, organizationId, leadId, contactId);
  // A contact-only submission has no channel: a line would put something there that is not in the pipeline.
  if (leadId) {
    const text = `New Lead: ${body.organization.replace(/\s+/gu, ' ')} - ${body.name.replace(/\s+/gu, ' ')}`;
    await postSubjectEvent(env, { kind: 'lead', id: leadId }, text, [], { dedupeKey: `crm:lead:${leadId}:created` });
  }

  return answer(body, contactId, leadId, organizationId, false);
}

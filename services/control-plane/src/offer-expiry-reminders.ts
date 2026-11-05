// The offer expiry reminder (decided by MZ, 2026-11-05): Core's daily job,
// moved word for word, on D1 once the commercial group moved. While Core holds
// the group, Core's job sends and this does nothing; once it moved, Core's job
// answers without sending (`/api/offers/expiration-reminders`). So exactly one
// sends, and the interaction each mail files stops a second.
//
// A failure logs the offer id and nothing about the mail.

import { servedCommercialRows } from './core-commercial-d1';
import { writeD1Interaction } from './core-interactions-d1';
import { sendMail } from './mail';
import { offerLink } from './offers-d1';
import { usesCore, usesCoreFor } from './work-store';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const REMINDER_WRITER = 'offer-reminders@starlings.invalid';
const PAGE = 1000;

/** Core's schedule: 08:00 UTC, the first tick of the hour. */
export function isReminderTick(scheduledTime: number): boolean {
  const at = new Date(scheduledTime);
  return at.getUTCHours() === 8 && at.getUTCMinutes() < 5;
}

const escapeHtml = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

/** Core's `formatDateForEmail`, in UTC. */
function reminderDay(value: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(value));
}

function reminderAmount(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.round(amount));
}

/** Core's `sendOfferExpirationReminder`: the same subject and words. `total_amount` is EUR on every offer. */
export function offerReminderMail(input: { to: string; name: string; title: string; link: string; validUntil: string; amount: number }) {
  const expires = reminderDay(input.validUntil);
  const amount = reminderAmount(input.amount);
  return {
    to: input.to,
    subject: `Your offer expires on ${expires}`,
    text: `Offer Expiration Reminder

Hi ${input.name},

This is a friendly reminder that your offer is expiring soon.

Offer: ${input.title}
Amount: ${amount}
Expires on: ${expires}

Please review the offer before it expires.

View Offer: ${input.link}

If you have any questions, please reply directly to this email.
`,
    html: `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a1a; margin-bottom: 24px;">Offer Expiration Reminder</h2>

      <p>Hi ${escapeHtml(input.name)},</p>
      <p>This is a friendly reminder that your offer is expiring soon.</p>

      <div style="background: #fff3cd; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ffc107;">
        <p style="margin: 0;"><strong>Offer:</strong> ${escapeHtml(input.title)}</p>
        <p style="margin: 5px 0;"><strong>Amount:</strong> ${amount}</p>
        <p style="margin: 5px 0 0;"><strong>Expires on:</strong> ${expires}</p>
      </div>

      <p>Please review the offer before it expires.</p>

      <div style="margin: 20px 0;">
        <a href="${escapeHtml(input.link)}" style="display: inline-block; background: #1a1a1a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">View Offer</a>
      </div>

      <p style="color: #6c757d; font-size: 0.9em;">If you have any questions, please reply directly to this email.</p>
    </div>
  `,
  };
}

/** Core's `getOfferDisplayLabel`. */
function offerLabel(offer: Record<string, unknown>, organization: string | null): string {
  const title = typeof offer.title === 'string' ? offer.title.trim() : '';
  if (title) return title;
  const raw = (offer.valid_until ?? offer.created_at) as string | null;
  const day = raw ? new Date(raw).toISOString().slice(0, 10) : '';
  return day ? `${organization ?? 'Offer'} – ${day}` : organization ?? 'Offer';
}

export interface OfferReminderResult { sent: number; skipped: number; errors: number }

/**
 * Each sent offer that expires within a week and is not accepted, with a lead
 * whose contact has an address: one mail, then one interaction. Mail off (dev,
 * tests) sends nothing and files nothing, so a later tick still sends. Only a
 * Core workspace has this job: a D1 workspace has no reminder to move.
 */
export async function sendOfferExpiryReminders(env: Env, now: number): Promise<OfferReminderResult | null> {
  if (!usesCore(env) || usesCoreFor(env, 'commercial')) return null;
  const offers = await servedCommercialRows(env, {
    op: 'commercial_rows',
    table: 'offers',
    eq: { is_accepted: false },
    gte: { valid_until: new Date(now).toISOString() },
    lte: { valid_until: new Date(now + WEEK_MS).toISOString() },
    limit: PAGE,
    offset: 0,
  });
  const results: OfferReminderResult = { sent: 0, skipped: 0, errors: 0 };
  for (const offer of offers) {
    const id = String(offer.id);
    try {
      const contact = typeof offer.lead_id === 'string'
        ? await env.USAGE.prepare(
          'SELECT c.id, c.name, c.email, c.corporate_email FROM leads l JOIN contacts c ON c.id = l.contact_id WHERE l.id = ?1',
        ).bind(offer.lead_id).first<{ id: string; name: string | null; email: string | null; corporate_email: string | null }>()
        : null;
      const to = contact?.corporate_email || contact?.email;
      if (!contact || !to) { results.skipped += 1; continue; }

      const reminded = await env.USAGE.prepare(
        `SELECT 1 AS one FROM interactions WHERE type = 'email' AND json_extract(metadata, '$.offer_id') = ?1 AND json_extract(metadata, '$.email_type') = 'expiration_reminder' LIMIT 1`,
      ).bind(id).first('one');
      if (reminded) { results.skipped += 1; continue; }

      const organization = typeof offer.organization_id === 'string'
        ? await env.USAGE.prepare('SELECT coalesce(name, legal_name) AS name FROM organizations WHERE id = ?1').bind(offer.organization_id).first<string>('name')
        : null;
      const title = offerLabel(offer, organization);
      const validUntil = String(offer.valid_until);
      const sent = await sendMail(env, offerReminderMail({
        to, name: contact.name || 'there', title, link: offerLink(env, id), validUntil, amount: Number(offer.total_amount || 0),
      }));
      if (!sent) { results.skipped += 1; continue; }
      await writeD1Interaction(env, REMINDER_WRITER, {
        action: 'create',
        entity: 'interactions',
        values: {
          title: `Offer expiration reminder: ${title}`,
          type: 'email',
          description: `Automated expiration reminder sent to ${to} for offer expiring on ${validUntil}`,
          organization_id: (offer.organization_id as string | null) ?? null,
          lead_id: offer.lead_id as string,
          metadata: { offer_id: id, email_type: 'expiration_reminder' },
          source: 'manual',
          created_by: null,
        },
        contact_ids: [contact.id],
      });
      results.sent += 1;
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'offer.reminder.failed', offer_id: id, error: error instanceof Error ? error.message : 'Unknown error' }));
      results.errors += 1;
    }
  }
  return results;
}

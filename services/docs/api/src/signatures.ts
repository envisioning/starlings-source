// Electronic signatures with an audit trail.
//
// What makes this defensible is not cryptography theatre — it is that four
// things are pinned together and never editable afterwards:
//
//   1. the exact bytes signed        (`content_hash`, SHA-256, hex)
//   2. who signed                    (verified email, not merely stated)
//   3. what they agreed to           (`consent_text`, stored verbatim)
//   4. when, and from where          (`sealed_at`, IP, user agent, timezone)
//
// Those four are HMAC-sealed with a server-side secret. The seal proves the
// row has not been edited since it was written; the certificate renders all of
// it for a human, including the hash they can recompute themselves with
// `shasum -a 256` against the downloaded file.
//
// This is a "simple" electronic signature under ESIGN / eIDAS — the same class
// as DocuSign's default. It is not a qualified signature, and nothing here
// pretends otherwise.

import {
  CONSENT_TEXT,
  declineSchema,
  signSchema,
  signatureRequestSchema,
  type Principal,
  type SignatureRecord,
  type SignatureRequestDetail,
} from '@docs/contracts';
import { hmacSHA256Hex, randomToken, uuid } from './crypto';
import { AuthError, ConflictError, DocsError, NotFoundError } from './errors';
import { sendMailQuietly } from './email';
import { shareURL } from './grants';
import { assertStaysInternal, type DocumentRow } from './documents';
import { recordAccess } from './audit';

interface RequestRow {
  id: string;
  document_id: string;
  document_version: number;
  content_hash: string;
  requested_by: string;
  subject: string | null;
  message: string | null;
  ordered: number;
  status: 'pending' | 'completed' | 'declined' | 'cancelled' | 'expired';
  created_at: string;
  expires_at: string | null;
  completed_at: string | null;
}

interface PartyRow {
  id: string;
  request_id: string;
  email: string;
  name: string | null;
  role: 'signer' | 'approver' | 'cc';
  sequence: number;
  status: 'pending' | 'viewed' | 'signed' | 'declined';
  grant_id: string | null;
  viewed_at: string | null;
  signed_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
}

interface SignatureRow extends SignatureRecord {
  party_id: string;
  consent_text: string;
  ip: string | null;
  user_agent: string | null;
  timezone: string | null;
  typed_text: string | null;
  signature_r2_key: string | null;
}

// ---------------------------------------------------------------------------
// Creating a request
// ---------------------------------------------------------------------------

export async function createSignatureRequest(
  env: Env,
  document: DocumentRow,
  input: unknown,
  requestedBy: string,
): Promise<SignatureRequestDetail> {
  const parsed = signatureRequestSchema.parse(input);
  // A request hands each signer a link to the text: sharing by another name.
  assertStaysInternal(document.category, 'link');

  if (!document.content_hash) {
    throw new DocsError('This document has no content to sign.', 409, 'invalid_request');
  }

  const requestId = uuid();
  const expiresAt = new Date(Date.now() + parsed.expires_in_days * 86_400_000).toISOString();

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO signature_requests
         (id, document_id, document_version, content_hash, requested_by, subject, message, ordered, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      requestId,
      document.id,
      document.version,
      document.content_hash,
      requestedBy,
      parsed.subject ?? null,
      parsed.message ?? null,
      parsed.ordered ? 1 : 0,
      expiresAt,
    ),
  ];

  // Each party gets their own signer grant: one link, one address, always
  // verification-gated. Nobody shares a signing URL.
  const parties = parsed.parties.map((party) => ({
    ...party,
    id: uuid(),
    grantId: uuid(),
    token: randomToken(24),
  }));

  for (const party of parties) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO grants
           (id, document_id, token, email, role, require_verification, label, created_by, expires_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).bind(
        party.grantId,
        document.id,
        party.token,
        party.email.toLowerCase(),
        party.role === 'cc' ? 'viewer' : 'signer',
        `Signature: ${party.email}`,
        requestedBy,
        expiresAt,
      ),
      env.DB.prepare(
        `INSERT INTO signature_parties (id, request_id, email, name, role, sequence, grant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(party.id, requestId, party.email.toLowerCase(), party.name ?? null, party.role, party.sequence, party.grantId),
    );
  }

  await env.DB.batch(statements);

  // Only whoever is up first is invited when the request is ordered.
  const firstSequence = Math.min(...parties.map((party) => party.sequence));
  for (const party of parties) {
    if (parsed.ordered && party.sequence !== firstSequence) continue;
    await inviteParty(env, {
      email: party.email,
      name: party.name ?? null,
      url: shareURL(env, party.token),
      documentTitle: document.title,
      subject: parsed.subject,
      message: parsed.message,
      requestedBy,
    });
  }

  return getSignatureRequest(env, requestId, { includeURLs: true });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getSignatureRequest(
  env: Env,
  id: string,
  options: { includeURLs?: boolean } = {},
): Promise<SignatureRequestDetail> {
  const request = await env.DB.prepare(`SELECT * FROM signature_requests WHERE id = ?`)
    .bind(id)
    .first<RequestRow>();
  if (!request) throw new NotFoundError('No such signature request.');

  const document = await env.DB.prepare(`SELECT path, title FROM documents WHERE id = ?`)
    .bind(request.document_id)
    .first<{ path: string; title: string }>();

  const [{ results: parties }, { results: signatures }] = await Promise.all([
    env.DB.prepare(
      `SELECT p.*, g.token AS token
         FROM signature_parties p
         LEFT JOIN grants g ON g.id = p.grant_id
        WHERE p.request_id = ?
        ORDER BY p.sequence, p.email`,
    )
      .bind(id)
      .all<PartyRow & { token: string | null }>(),
    env.DB.prepare(`SELECT * FROM signatures WHERE request_id = ? ORDER BY sealed_at`)
      .bind(id)
      .all<SignatureRow>(),
  ]);

  return {
    id: request.id,
    document_id: request.document_id,
    document_path: document?.path ?? '',
    document_title: document?.title ?? '',
    document_version: request.document_version,
    content_hash: request.content_hash,
    requested_by: request.requested_by,
    subject: request.subject,
    message: request.message,
    ordered: request.ordered === 1,
    status: request.status,
    created_at: request.created_at,
    expires_at: request.expires_at,
    completed_at: request.completed_at,
    parties: parties.map((party) => ({
      id: party.id,
      email: party.email,
      name: party.name,
      role: party.role,
      sequence: party.sequence,
      status: party.status,
      signed_at: party.signed_at,
      // Signing URLs are only ever handed to staff, never echoed to a guest.
      ...(options.includeURLs && party.token ? { url: shareURL(env, party.token) } : {}),
    })),
    signatures: signatures.map(toRecord),
  };
}

/**
 * What a signer is allowed to see: their most recent request on this document,
 * minus everyone else's links.
 *
 * Deliberately not filtered to `pending`. A signer who has just signed — or
 * who comes back to the link a week later — needs to see that it happened;
 * hiding completed requests would make the confirmation vanish the moment it
 * mattered.
 */
export async function getSignerView(env: Env, documentId: string, email: string): Promise<SignatureRequestDetail | null> {
  const row = await env.DB.prepare(
    `SELECT r.id
       FROM signature_requests r
       JOIN signature_parties p ON p.request_id = r.id
      WHERE r.document_id = ? AND p.email = ?
      ORDER BY r.created_at DESC LIMIT 1`,
  )
    .bind(documentId, email.toLowerCase())
    .first<{ id: string }>();
  if (!row) return null;
  return getSignatureRequest(env, row.id);
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export async function sign(
  env: Env,
  request: Request,
  requestId: string,
  input: unknown,
  principal: Principal,
): Promise<SignatureRecord> {
  const parsed = signSchema.parse(input);

  if (principal.kind !== 'guest') {
    throw new AuthError('Sign from the link you were sent.', 403, 'forbidden');
  }
  const guest = principal.guest;
  if (guest.role !== 'signer') throw new AuthError('This link cannot sign.', 403, 'forbidden');
  // The whole point of the mailed code: without it, a signature names someone
  // who never proved they hold the address.
  if (!guest.verified) throw new AuthError('Verify your email address before signing.', 403, 'forbidden');

  const sigRequest = await env.DB.prepare(`SELECT * FROM signature_requests WHERE id = ?`)
    .bind(requestId)
    .first<RequestRow>();
  if (!sigRequest) throw new NotFoundError('No such signature request.');
  if (sigRequest.status !== 'pending') throw new ConflictError(`This request is ${sigRequest.status}.`);
  if (sigRequest.expires_at && Date.parse(sigRequest.expires_at) < Date.now()) {
    await setStatus(env, requestId, 'expired');
    throw new DocsError('This signature request has expired.', 410, 'gone');
  }

  // Refuse to record a signature against bytes the signer did not see.
  if (parsed.content_hash !== sigRequest.content_hash) {
    throw new ConflictError('The document changed — reload before signing.', 'hash_mismatch');
  }

  const party = await env.DB.prepare(
    `SELECT * FROM signature_parties WHERE request_id = ? AND email = ?`,
  )
    .bind(requestId, guest.email)
    .first<PartyRow>();
  if (!party) throw new AuthError('You are not a party to this request.', 403, 'forbidden');
  if (party.status === 'signed') throw new ConflictError('You have already signed this document.');
  if (party.status === 'declined') throw new ConflictError('You declined this document.');
  if (party.role === 'cc') throw new AuthError('You were copied on this document, not asked to sign it.', 403, 'forbidden');

  if (sigRequest.ordered) {
    const ahead = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM signature_parties
        WHERE request_id = ? AND sequence < ? AND role <> 'cc' AND status <> 'signed'`,
    )
      .bind(requestId, party.sequence)
      .first<{ n: number }>();
    if ((ahead?.n ?? 0) > 0) throw new ConflictError('It is not your turn yet — earlier signers have not finished.');
  }

  // A drawn signature is an image; store it in R2 rather than inline in D1.
  let imageKey: string | null = null;
  if (parsed.method === 'drawn' && parsed.signature_image) {
    imageKey = `signatures/${requestId}/${party.id}.png`;
    const bytes = decodeDataURL(parsed.signature_image);
    if (!bytes) throw new DocsError('The signature image is not a valid PNG data URL.', 400, 'invalid_request');
    await env.DOCS_FILES.put(imageKey, bytes, { httpMetadata: { contentType: 'image/png' } });
  }

  const context = {
    ip: request.headers.get('cf-connecting-ip'),
    userAgent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
  };
  const sealedAt = new Date().toISOString();
  const id = uuid();

  const canonical = canonicalRecord({
    id,
    request_id: requestId,
    document_id: sigRequest.document_id,
    document_version: sigRequest.document_version,
    content_hash: sigRequest.content_hash,
    signer_email: guest.email,
    signer_name: parsed.name,
    method: parsed.method,
    consent_text: CONSENT_TEXT,
    // Sealed as 1/0, never true/false: `verifySeal` reads the column back out
    // of SQLite as an integer, and the two must stringify identically or every
    // certificate reports tampering.
    email_verified: 1,
    ip: context.ip,
    user_agent: context.userAgent,
    timezone: parsed.timezone ?? null,
    sealed_at: sealedAt,
  });
  const seal = await hmacSHA256Hex(env.SIGNATURE_SEAL_SECRET || env.SESSION_SIGNING_SECRET, canonical);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO signatures
         (id, request_id, party_id, document_id, document_version, content_hash,
          signer_email, signer_name, method, typed_text, signature_r2_key,
          consent_text, email_verified, ip, user_agent, timezone, sealed_at, seal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      requestId,
      party.id,
      sigRequest.document_id,
      sigRequest.document_version,
      sigRequest.content_hash,
      guest.email,
      parsed.name,
      parsed.method,
      parsed.method === 'typed' ? (parsed.typed_text ?? parsed.name) : null,
      imageKey,
      CONSENT_TEXT,
      context.ip,
      context.userAgent,
      parsed.timezone ?? null,
      sealedAt,
      seal,
    ),
    env.DB.prepare(`UPDATE signature_parties SET status = 'signed', signed_at = ? WHERE id = ?`).bind(sealedAt, party.id),
  ]);

  await recordAccess(env, {
    documentId: sigRequest.document_id,
    grantId: guest.grantId,
    actor: guest.email,
    actorKind: 'guest',
    kind: 'sign',
    request,
    detail: { request_id: requestId, signature_id: id },
  });

  await advance(env, sigRequest);

  const row = await env.DB.prepare(`SELECT * FROM signatures WHERE id = ?`).bind(id).first<SignatureRow>();
  if (!row) throw new DocsError('Signature was not recorded.', 500, 'internal');
  return toRecord(row);
}

export async function decline(
  env: Env,
  request: Request,
  requestId: string,
  input: unknown,
  principal: Principal,
): Promise<void> {
  const parsed = declineSchema.parse(input);
  if (principal.kind !== 'guest') throw new AuthError('Decline from the link you were sent.', 403, 'forbidden');

  const party = await env.DB.prepare(`SELECT * FROM signature_parties WHERE request_id = ? AND email = ?`)
    .bind(requestId, principal.guest.email)
    .first<PartyRow>();
  if (!party) throw new AuthError('You are not a party to this request.', 403, 'forbidden');

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE signature_parties SET status = 'declined', declined_at = ?, decline_reason = ? WHERE id = ?`,
    ).bind(now, parsed.reason ?? null, party.id),
    // One decline ends the request. Partial execution is worse than none.
    env.DB.prepare(`UPDATE signature_requests SET status = 'declined' WHERE id = ? AND status = 'pending'`).bind(requestId),
  ]);

  const sigRequest = await env.DB.prepare(`SELECT * FROM signature_requests WHERE id = ?`)
    .bind(requestId)
    .first<RequestRow>();

  if (sigRequest) {
    await recordAccess(env, {
      documentId: sigRequest.document_id,
      grantId: principal.guest.grantId,
      actor: principal.guest.email,
      actorKind: 'guest',
      kind: 'decline',
      request,
      detail: { request_id: requestId, reason: parsed.reason ?? null },
    });
    await sendMailQuietly(env, {
      to: sigRequest.requested_by,
      subject: `Declined: ${sigRequest.subject ?? 'signature request'}`,
      text: `${principal.guest.email} declined to sign.\n\n${parsed.reason ?? 'No reason given.'}`,
    });
  }
}

export async function cancel(env: Env, requestId: string): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE signature_requests SET status = 'cancelled' WHERE id = ? AND status = 'pending'`,
  )
    .bind(requestId)
    .run();
  if (!result.meta.changes) throw new ConflictError('Only a pending request can be cancelled.');
  await env.DB.prepare(`UPDATE grants SET revoked_at = ? WHERE id IN (SELECT grant_id FROM signature_parties WHERE request_id = ?)`)
    .bind(new Date().toISOString(), requestId)
    .run();
}

/** Move an ordered request along, or complete it when everyone has signed. */
async function advance(env: Env, sigRequest: RequestRow): Promise<void> {
  const outstanding = await env.DB.prepare(
    `SELECT * FROM signature_parties
      WHERE request_id = ? AND role <> 'cc' AND status <> 'signed'
      ORDER BY sequence LIMIT 1`,
  )
    .bind(sigRequest.id)
    .first<PartyRow>();

  if (!outstanding) {
    await setStatus(env, sigRequest.id, 'completed');
    const detail = await getSignatureRequest(env, sigRequest.id);
    const recipients = new Set([sigRequest.requested_by, ...detail.parties.map((party) => party.email)]);
    for (const to of recipients) {
      await sendMailQuietly(env, {
        to,
        subject: `Fully signed: ${detail.document_title}`,
        text:
          `Every party has signed "${detail.document_title}".\n\n` +
          `Document hash (SHA-256): ${detail.content_hash}\n` +
          `Audit certificate: ${env.WEB_ORIGIN}/certificate/${sigRequest.id}\n`,
      });
    }
    return;
  }

  if (!sigRequest.ordered) return;

  // Ordered: invite the next sequence now that the previous one is done.
  const grant = await env.DB.prepare(`SELECT token FROM grants WHERE id = ?`)
    .bind(outstanding.grant_id)
    .first<{ token: string }>();
  if (!grant) return;

  const document = await env.DB.prepare(`SELECT title FROM documents WHERE id = ?`)
    .bind(sigRequest.document_id)
    .first<{ title: string }>();

  await inviteParty(env, {
    email: outstanding.email,
    name: outstanding.name,
    url: shareURL(env, grant.token),
    documentTitle: document?.title ?? 'a document',
    subject: sigRequest.subject,
    message: sigRequest.message,
    requestedBy: sigRequest.requested_by,
  });
}

async function setStatus(env: Env, id: string, status: RequestRow['status']): Promise<void> {
  await env.DB.prepare(
    `UPDATE signature_requests
        SET status = ?, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
      WHERE id = ?`,
  )
    .bind(status, status, new Date().toISOString(), id)
    .run();
}

async function inviteParty(
  env: Env,
  input: {
    email: string;
    name: string | null;
    url: string;
    documentTitle: string;
    subject?: string | null | undefined;
    message?: string | null | undefined;
    requestedBy: string;
  },
): Promise<void> {
  await sendMailQuietly(env, {
    to: input.email,
    subject: input.subject ?? `Signature requested: ${input.documentTitle}`,
    replyTo: input.requestedBy,
    text:
      `${input.name ? `${input.name},\n\n` : ''}` +
      `${input.requestedBy} has asked you to sign "${input.documentTitle}".\n\n` +
      `${input.message ? `${input.message}\n\n` : ''}` +
      `Open it here: ${input.url}\n\n` +
      `You will be asked to confirm your email address with a short code before signing.`,
  });
}

// ---------------------------------------------------------------------------
// The seal
// ---------------------------------------------------------------------------

/**
 * The exact string the HMAC covers. Field order is fixed and must never
 * change — a reordering would invalidate every seal ever written.
 */
function canonicalRecord(input: Record<string, unknown>): string {
  const order = [
    'id',
    'request_id',
    'document_id',
    'document_version',
    'content_hash',
    'signer_email',
    'signer_name',
    'method',
    'consent_text',
    'email_verified',
    'ip',
    'user_agent',
    'timezone',
    'sealed_at',
  ];
  return order.map((key) => `${key}=${String(input[key] ?? '')}`).join('\n');
}

/** Recompute a stored signature's seal. Used by the certificate route. */
export async function verifySeal(env: Env, row: SignatureRow): Promise<boolean> {
  const expected = await hmacSHA256Hex(
    env.SIGNATURE_SEAL_SECRET || env.SESSION_SIGNING_SECRET,
    canonicalRecord({
      id: row.id,
      request_id: row.request_id,
      document_id: row.document_id,
      document_version: row.document_version,
      content_hash: row.content_hash,
      signer_email: row.signer_email,
      signer_name: row.signer_name,
      method: row.method,
      consent_text: row.consent_text,
      email_verified: row.email_verified ? 1 : 0,
      ip: row.ip,
      user_agent: row.user_agent,
      timezone: row.timezone,
      sealed_at: row.sealed_at,
    }),
  );
  return expected === row.seal;
}

// ---------------------------------------------------------------------------
// Certificate
// ---------------------------------------------------------------------------

/**
 * A human-readable audit certificate in markdown. Rendered to PDF client-side
 * and appended to the signed document when it is downloaded.
 */
export async function certificate(env: Env, requestId: string): Promise<string> {
  const detail = await getSignatureRequest(env, requestId);
  const { results } = await env.DB.prepare(`SELECT * FROM signatures WHERE request_id = ? ORDER BY sealed_at`)
    .bind(requestId)
    .all<SignatureRow>();

  // A list, not consecutive bold lines: markdown would render those as one
  // run-together paragraph, and this document exists to be read.
  const lines: string[] = [
    '# Certificate of completion',
    '',
    `- **Document** — ${detail.document_title}`,
    `- **Path** — \`${detail.document_path}\``,
    `- **Version** — ${detail.document_version}`,
    `- **Content hash (SHA-256)** — \`${detail.content_hash}\``,
    `- **Request** — \`${detail.id}\``,
    `- **Requested by** — ${detail.requested_by}`,
    `- **Status** — ${detail.status}`,
    ...(detail.completed_at ? [`- **Completed** — ${detail.completed_at}`] : []),
    '',
    '## Signatures',
    '',
  ];

  for (const row of results) {
    const valid = await verifySeal(env, row);
    lines.push(
      `### ${row.signer_name} — ${row.signer_email}`,
      '',
      `- Signed at: ${row.sealed_at}`,
      `- Method: ${row.method}`,
      `- Email verified: ${row.email_verified ? 'yes' : 'no'}`,
      `- IP address: ${row.ip ?? 'unknown'}`,
      `- Timezone: ${row.timezone ?? 'unknown'}`,
      `- User agent: ${row.user_agent ?? 'unknown'}`,
      `- Seal: \`${row.seal}\``,
      `- Seal verified: **${valid ? 'yes' : 'NO — this record has been altered'}**`,
      '',
      `> ${row.consent_text}`,
      '',
    );
  }

  const outstanding = detail.parties.filter((party) => party.status !== 'signed' && party.role !== 'cc');
  if (outstanding.length) {
    lines.push('## Outstanding', '');
    for (const party of outstanding) lines.push(`- ${party.email} — ${party.status}`);
    lines.push('');
  }

  lines.push(
    '---',
    '',
    'Verify independently by downloading the document and running:',
    '',
    '```',
    `shasum -a 256 <file>   # expect ${detail.content_hash}`,
    '```',
    '',
    'This is a simple electronic signature under ESIGN and eIDAS. It is not a qualified',
    'electronic signature and carries no certificate from a trust service provider.',
  );

  return lines.join('\n');
}

function toRecord(row: SignatureRow): SignatureRecord {
  return {
    id: row.id,
    request_id: row.request_id,
    document_id: row.document_id,
    document_version: row.document_version,
    content_hash: row.content_hash,
    signer_email: row.signer_email,
    signer_name: row.signer_name,
    method: row.method,
    email_verified: Boolean(row.email_verified),
    sealed_at: row.sealed_at,
    seal: row.seal,
  };
}

function decodeDataURL(value: string): Uint8Array | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u.exec(value.trim());
  if (!match?.[1]) return null;
  try {
    const binary = atob(match[1]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

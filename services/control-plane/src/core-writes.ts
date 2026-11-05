// Core's own writers, through the one write path (CORE_FOLD_PLAN
// Phase 2).
//
// Core's public forms, webhooks and flows used to write organizations,
// contacts, leads and projects straight to Postgres. Now each write comes
// here, signed with Core's own inbound key (`x-internal-key-id: core`,
//), and the Worker sends it to the store that holds the group. While
// the group is on Core, that is Core's `POST /api/public/meet-crm-writes`,
// signed with `INTERNAL_REQUEST_SECRET`. When the group flips to D1,
// this file changes and Core does not.
//
// Fold groups 2 and 4 are different: Core sends a task
// or an interaction write only once its group moved, and the Worker writes
// it to D1 (`core-tasks-d1.ts`, `core-interactions-d1.ts`). Partner agreement
// signatures move with the interactions group. Fold group 5, the
// commercial tables, follows the same rule (`core-commercial-d1.ts`),
//
// The same locks as `/api/internal/channel-events`, in the same order: no key
// id is a 404; a session token is refused; the burst guard; the signature
// inside its clock window; then the key must be Core's. An agent key is
// refused: an agent writes the CRM as a person, through `/mcp`.

import { z } from 'zod';
import type { CoreFieldsWriteBody } from '@starlings/contracts/core-fields';
import {
  coreWriteRefusalSchema,
  coreWriteRequestSchema,
  coreWriteResponseSchema,
  type CoreCommercialWriteRequest,
  type CoreInteractionWriteRequest,
  type CorePartnerSignatureWriteRequest,
  type CoreSubjectWriteRequest,
  type CoreTaskWriteRequest,
  type CoreWriteEntity,
} from '@starlings/contracts/core-writes';
import { writeCoreCommercial } from './core-commercial-d1';
import { upsertD1PartnerSignature, writeD1Interaction } from './core-interactions-d1';
import { writeCoreTask } from './core-tasks-d1';
import { createD1CoreRecord, fetchD1CoreRecord, updateD1CoreRecord } from './core-records-d1';
import { CrmSyncError, parseCoreBody, purgeRecordCaches, signedCoreFetch } from './crm';
import { AuthError, ControlError } from './errors';
import { assertUnderRateLimit, json, readBoundedText } from './http';
import { bindInboundIdentity, resolveInboundKey } from './inbound-keys';
import { assertSignature } from './internal';
import { CORE_CALLER, recordInboundAccepted } from './ops';
import { assertGroupWritable } from './work-freeze';
import { usesCore, usesCoreFor } from './work-store';

const CORE_ROUTE = '/api/public/meet-crm-writes';

/**
 * Who a Core writer writes as on D1. No person has this address, so
 * `created_by` stays null, as the group copy leaves it for Core's rows.
 */
const CORE_WRITER = 'core-writes@starlings.invalid';

/**
 * Columns only Core's own flows set (migration 0131). No member edits them,
 * so they are not on the Work write schemas: this door writes them to D1
 * itself, after the record write.
 */
const WRITER_COLUMNS: Partial<Record<CoreWriteEntity, Record<string, 'text' | 'time'>>> = {
  leads: { source: 'text' },
  projects: { last_viewed_at: 'time' },
};

/**
 * The body of one call from Core's own key, after every lock: the key id, no
 * session, the burst guard, the signature in its clock window, and Core's
 * identity. Shared by the write door and the read door (`core-reads.ts`).
 */
export async function readCoreCall(request: Request, env: Env, door: 'core-writes' | 'core-reads'): Promise<unknown> {
  const caller = await resolveInboundKey(request, env);
  if (request.headers.get('authorization')) {
    throw new AuthError('This route does not take a session.', 403, 'owner_auth_required');
  }
  await assertUnderRateLimit(env.AGENT_LIMIT, request, door === 'core-writes' ? 'internal-core-write' : 'internal-core-read');
  const rawBody = await readBoundedText(request);
  await assertSignature(request, caller, rawBody, env);
  await bindInboundIdentity(env, caller, door, null);
  await recordInboundAccepted(env, CORE_CALLER);
  try {
    return JSON.parse(rawBody === '' ? '{}' : rawBody) as unknown;
  } catch {
    throw new ControlError('Request body must be valid JSON.', 400, 'invalid_request');
  }
}

export async function handleInternalCoreWrite(request: Request, env: Env): Promise<Response> {
  const write = coreWriteRequestSchema.parse(await readCoreCall(request, env, 'core-writes'));

  if (!usesCore(env)) {
    // Core's writers exist only beside Envisioning's Core. A workspace whose
    // CRM is in D1 has no Core to send them, and this door writes nothing.
    throw new ControlError('This workspace keeps its CRM in D1.', 404, 'not_configured');
  }
  if (write.entity === 'tasks') return writeTask(env, write);
  if (write.entity === 'interactions' || write.entity === 'partner_agreement_signatures') return writeInteraction(env, write);
  if (write.entity === 'commercial') return writeCommercial(env, write);
  // Fold group 1 (organizations, contacts, leads, projects): Core until the
  // `subjects` group moves, D1 after. Core does not change.
  return usesCoreFor(env, 'subjects') ? forwardToCore(env, write) : writeToD1(env, write);
}

/**
 * Fold group 2. Core sends a task write only once the `tasks`
 * group moved; while it is on Core, Core writes its own table, and this door
 * refuses, as the read door does.
 */
async function writeTask(env: Env, write: CoreTaskWriteRequest): Promise<Response> {
  if (usesCoreFor(env, 'tasks')) {
    throw new ControlError('These records are still in Core. Write them there.', 409, 'not_configured');
  }
  try {
    return json({ data: await writeCoreTask(env, CORE_WRITER, write) });
  } catch (error) {
    if (error instanceof ControlError && (error.status < 500 || error.code === 'records_moving')) {
      return json({ error: error.message, code: error.code ?? null }, error.status);
    }
    if (error instanceof Error && /FOREIGN KEY constraint failed/u.test(error.message)) {
      // Core's callers branch on Postgres' foreign-key code.
      return json({ error: 'A record the task names does not exist.', code: '23503' }, 409);
    }
    throw error;
  }
}

/**
 * Fold group 4. Core sends an interaction or a partner agreement
 * signature only once the `interactions` group moved; while it is on Core,
 * Core writes its own tables, and this door refuses.
 */
async function writeInteraction(env: Env, write: CoreInteractionWriteRequest | CorePartnerSignatureWriteRequest): Promise<Response> {
  if (usesCoreFor(env, 'interactions')) {
    throw new ControlError('These records are still in Core. Write them there.', 409, 'not_configured');
  }
  try {
    if (write.entity === 'partner_agreement_signatures') {
      return json({ data: selected(await upsertD1PartnerSignature(env, write), write.select) });
    }
    const written = await writeD1Interaction(env, CORE_WRITER, write);
    for (const row of [written?.before, written?.after]) if (row) await purgeRecordCaches('interactions', null, row);
    if (!written) return json({ data: null });
    return json({ data: write.action === 'delete' ? { id: written.id } : selected(written.after ?? { id: written.id }, write.select) });
  } catch (error) {
    if (error instanceof ControlError && (error.status < 500 || error.code === 'records_moving')) {
      return json({ error: error.message, code: error.code ?? null }, error.status);
    }
    throw error;
  }
}

/**
 * Fold group 5. Core sends a commercial write only once the group
 * moved; while it is on Core, Core writes its own tables, and this door refuses.
 * Core's callers branch on Postgres' codes, so D1's refusals carry them.
 */
async function writeCommercial(env: Env, write: CoreCommercialWriteRequest): Promise<Response> {
  if (usesCoreFor(env, 'commercial')) {
    throw new ControlError('These records are still in Core. Write them there.', 409, 'not_configured');
  }
  return answeringPostgresCodes(() => writeCoreCommercial(env, CORE_WRITER, write));
}

/** One write's answer. D1's and the repository's refusals carry Postgres' codes. */
async function answeringPostgresCodes(write: () => Promise<unknown>): Promise<Response> {
  try {
    return json({ data: await write() });
  } catch (error) {
    if (error instanceof ControlError && (error.status < 500 || error.code === 'records_moving')) {
      return json({ error: error.message, code: error.code ?? null }, error.status);
    }
    if (error instanceof Error && /FOREIGN KEY constraint failed/u.test(error.message)) {
      return json({ error: 'A record the row names does not exist.', code: '23503' }, 409);
    }
    if (error instanceof Error && /UNIQUE constraint failed/u.test(error.message)) {
      return json({ error: 'duplicate key value violates unique constraint', code: '23505' }, 409);
    }
    if (error instanceof Error && /NOT NULL constraint failed/u.test(error.message)) {
      return json({ error: 'A required column has no value.', code: '23502' }, 400);
    }
    if (error instanceof Error && /CHECK constraint failed/u.test(error.message)) {
      return json({ error: 'A value breaks a rule of the record.', code: '23514' }, 409);
    }
    throw error;
  }
}

/**
 * One write into D1, through the record path MCP and the Fields pane use
 * (`core-records-d1.ts`), so Core's columns map to D1 in one place. The answer
 * is Core's: the row with the `select` columns, null for an update that
 * matched no row, and a refusal as `{ error, code }`.
 */
async function writeToD1(env: Env, write: CoreSubjectWriteRequest): Promise<Response> {
  const own = WRITER_COLUMNS[write.entity] ?? {};
  const values = Object.fromEntries(Object.entries(write.values).filter(([column]) => !(column in own))) as CoreFieldsWriteBody;
  const writerValues = Object.entries(write.values).filter(([column]) => column in own);
  try {
    await assertGroupWritable(env, 'subjects');
    let id: string;
    if (write.action === 'create') {
      // Core's flows name their own source; one that names none came in through Core's API, as Core records it.
      const body = write.entity === 'contacts' && values.source_key === undefined ? { ...values, source_key: 'agent_api' } : values;
      const created = await createD1CoreRecord(env, CORE_WRITER, write.entity, body, { anySource: true });
      id = z.object({ data: z.object({ id: z.string() }) }).parse(created).data.id;
    } else {
      id = write.id;
      if (Object.keys(values).length > 0) await updateD1CoreRecord(env, CORE_WRITER, write.entity, id, values);
      else await fetchD1CoreRecord(env, write.entity, id);
    }
    if (writerValues.length > 0) {
      const cells = writerValues.map(([column, value]) => (own[column] === 'time' ? timeCell(value) : textCell(value)));
      await env.USAGE.prepare(
        `UPDATE ${write.entity} SET ${writerValues.map(([column], index) => `${column} = ?${index + 2}`).join(', ')} WHERE id = ?1`,
      ).bind(id, ...cells).run();
    }
    const row = z.object({ data: z.record(z.string(), z.json()) }).parse(await fetchD1CoreRecord(env, write.entity, id)).data;
    await purgeRecordCaches(write.entity, values, row);
    return json({ data: selected(row, write.select) });
  } catch (error) {
    if (error instanceof ControlError && error.status === 404 && write.action === 'update') return json({ data: null });
    if (error instanceof ControlError && error.status < 500) return json({ error: error.message, code: error.code ?? null }, error.status);
    if (error instanceof ControlError && error.code === 'records_moving') return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof z.ZodError) return json({ error: error.issues[0]?.message ?? 'Invalid values.', code: 'invalid_request' }, 400);
    // Core's callers branch on Postgres' unique-violation code.
    if (error instanceof Error && /UNIQUE constraint failed/u.test(error.message)) {
      return json({ error: 'duplicate key value violates unique constraint', code: '23505' }, 409);
    }
    throw error;
  }
}

const textCell = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function timeCell(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new ControlError(`Not a time: ${String(value).slice(0, 40)}.`, 400, 'invalid_request');
  return parsed;
}

/** The row cut to `select`, as PostgREST answers it. `id` when not named. */
function selected(row: Record<string, unknown>, select: string | undefined): Record<string, unknown> {
  const columns = (select ?? 'id').split(',').map((column) => column.trim());
  return Object.fromEntries(columns.map((column) => [column, row[column] ?? null]));
}

/**
 * One write, sent on to Core. Core's answer travels back as it came: the row
 * on success, and on a refusal its status with its `error` and `code`, so a
 * caller that branched on a Postgres code (`23505`) still can.
 */
async function forwardToCore(env: Env, write: CoreSubjectWriteRequest): Promise<Response> {
  const response = await signedCoreFetch(env, CORE_ROUTE, { method: 'POST', body: JSON.stringify(write) });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const refusal = coreWriteRefusalSchema.safeParse(body);
    if (refusal.success && response.status >= 400 && response.status < 500) {
      return json({ error: refusal.data.error, code: refusal.data.code ?? null }, response.status);
    }
    throw new CrmSyncError(`Core ${write.entity} ${write.action} failed (${response.status}).`, 502);
  }
  const answer = parseCoreBody(coreWriteResponseSchema, body, `POST ${CORE_ROUTE}`);
  // The board and the subject lists cache these rows for a minute; a write
  // that changes one drops them, as a write from a member does.
  await purgeRecordCaches(write.entity, write.values as CoreFieldsWriteBody, answer.data ?? undefined);
  return json({ data: answer.data });
}

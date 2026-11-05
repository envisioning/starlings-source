import { DurableObject } from 'cloudflare:workers';
import { ZodError } from 'zod';
import {
  QUICK_NOTE_CAPTURE_MAX_AGE_MS,
  quickNoteCreateSchema,
  quickNotePromoteSchema,
  quickNoteUpdateSchema,
  type QuickNote,
  type QuickNoteContext,
  type QuickNotePromotion,
  type QuickNoteSource,
  type QuickNoteState,
} from './contracts';
import { exportSqlState, freezeSql, importSqlState, isObjectMovingError, migrateFrozen, unfreezeSql, type ObjectSnapshot } from './object-snapshot';

interface QuickNoteRow extends Record<string, SqlStorageValue> {
  id: string;
  body: string;
  source: string;
  context_json: string | null;
  state: string;
  promotion_kind: string | null;
  promotion_id: string | null;
  promoted_at: number | null;
  created_at: number;
  updated_at: number;
}

const QUICK_NOTE_COLUMNS = `id, body, source, context_json, state,
  promotion_kind, promotion_id, promoted_at, created_at, updated_at`;

/** One owner-scoped inbox. The Worker is the only public caller. */
export class QuickNotesCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => migrateFrozen(ctx.storage.sql, () => this.migrate()));
  }

  /** Every table this inbox owns, as JSON, for the daily backup. */
  async exportState(): Promise<ObjectSnapshot> {
    return exportSqlState(this.ctx.storage.sql);
  }

  /** Replace every table with a snapshot's rows, in one transaction. Writes after the snapshot are lost. */
  async importState(snapshot: unknown): Promise<Record<string, number>> {
    return importSqlState(this.ctx.storage, snapshot);
  }

  /** An inbox has no live state, so nothing blocks a move. */
  async moveBlocker(): Promise<string | null> {
    return null;
  }

  /** Refuse every write until `unfreeze` (object-snapshot.ts). */
  async freeze(): Promise<void> {
    freezeSql(this.ctx.storage.sql);
  }

  async unfreeze(): Promise<void> {
    unfreezeSql(this.ctx.storage.sql);
  }

  async closeSockets(_reason: string): Promise<void> {
    // An inbox holds no sockets.
  }

  /** Delete every row and table. Only for the old copy of an inbox that moved. */
  async purge(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/notes') {
        const rows = this.ctx.storage.sql.exec<QuickNoteRow>(
          `SELECT ${QUICK_NOTE_COLUMNS} FROM quick_notes
           ORDER BY CASE state WHEN 'open' THEN 0 ELSE 1 END, updated_at DESC, id DESC`,
        ).toArray();
        return Response.json({ notes: rows.map(toQuickNote) }, noStore());
      }

      if (request.method === 'POST' && url.pathname === '/notes') {
        const input = quickNoteCreateSchema.parse(await request.json());
        const now = Date.now();
        const id = input.id?.toLowerCase() ?? crypto.randomUUID();
        // A retry of a note this inbox already holds: the first send made it
        // and its response was lost. Answer with that note, make no second.
        const existing = this.ctx.storage.sql.exec<QuickNoteRow>(
          `SELECT ${QUICK_NOTE_COLUMNS} FROM quick_notes WHERE id = ?`,
          id,
        ).toArray()[0];
        if (existing) return Response.json({ note: toQuickNote(existing) }, { ...noStore(), status: 200 });
        // When it was written, never in the future and never older than the
        // window: a device clock can be wrong.
        const written = Math.min(now, Math.max(now - QUICK_NOTE_CAPTURE_MAX_AGE_MS, input.captured_at ?? now));
        this.ctx.storage.sql.exec(
          `INSERT INTO quick_notes (
             id, body, source, context_json, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'open', ?, ?)`,
          id,
          input.body,
          input.source,
          input.context ? JSON.stringify(input.context) : null,
          written,
          written,
        );
        const row = this.ctx.storage.sql.exec<QuickNoteRow>(
          `SELECT ${QUICK_NOTE_COLUMNS} FROM quick_notes WHERE id = ?`,
          id,
        ).one();
        return Response.json({ note: toQuickNote(row) }, { ...noStore(), status: 201 });
      }

      const noteID = url.pathname.match(/^\/notes\/([0-9a-f-]{36})$/i)?.[1];
      if (noteID && request.method === 'DELETE') {
        const existing = this.ctx.storage.sql.exec<QuickNoteRow>(
          `SELECT ${QUICK_NOTE_COLUMNS} FROM quick_notes WHERE id = ?`,
          noteID,
        ).toArray()[0];
        if (!existing) return Response.json({ error: 'Quick Note not found.' }, { ...noStore(), status: 404 });
        this.ctx.storage.sql.exec(`DELETE FROM quick_notes WHERE id = ?`, noteID);
        return Response.json({ ok: true }, noStore());
      }

      // A rewrite keeps the note where it is: state, promotion and creation
      // time stay, so an edited filed note still says where it went.
      if (noteID && request.method === 'PATCH') {
        const input = quickNoteUpdateSchema.parse(await request.json());
        const existing = this.ctx.storage.sql.exec<QuickNoteRow>(
          `SELECT ${QUICK_NOTE_COLUMNS} FROM quick_notes WHERE id = ?`,
          noteID,
        ).toArray()[0];
        if (!existing) return Response.json({ error: 'Quick Note not found.' }, { ...noStore(), status: 404 });
        this.ctx.storage.sql.exec(
          `UPDATE quick_notes SET body = ?, updated_at = ? WHERE id = ?`,
          input.body,
          Date.now(),
          noteID,
        );
        const row = this.ctx.storage.sql.exec<QuickNoteRow>(
          `SELECT ${QUICK_NOTE_COLUMNS} FROM quick_notes WHERE id = ?`,
          noteID,
        ).one();
        return Response.json({ note: toQuickNote(row) }, noStore());
      }

      const promotionPath = url.pathname.match(/^\/notes\/([0-9a-f-]{36})\/promote$/i);
      if (promotionPath && request.method === 'POST') {
        const input = quickNotePromoteSchema.parse(await request.json());
        const noteID = promotionPath[1];
        const existing = this.ctx.storage.sql.exec<QuickNoteRow>(
          `SELECT ${QUICK_NOTE_COLUMNS} FROM quick_notes WHERE id = ?`,
          noteID,
        ).toArray()[0];
        if (!existing) return Response.json({ error: 'Quick Note not found.' }, { ...noStore(), status: 404 });

        // Retrying the same promotion is safe: the Core task already exists,
        // and the note only needs to point at it once.
        if (existing.state !== 'promoted') {
          const now = Date.now();
          this.ctx.storage.sql.exec(
            `UPDATE quick_notes
             SET state = 'promoted', promotion_kind = ?, promotion_id = ?, promoted_at = ?, updated_at = ?
             WHERE id = ?`,
            input.kind,
            input.id,
            now,
            now,
            noteID,
          );
        }
        const row = this.ctx.storage.sql.exec<QuickNoteRow>(
          `SELECT ${QUICK_NOTE_COLUMNS} FROM quick_notes WHERE id = ?`,
          noteID,
        ).one();
        return Response.json({ note: toQuickNote(row) }, noStore());
      }

      return Response.json({ error: 'Not found.' }, { ...noStore(), status: 404 });
    } catch (error) {
      if (error instanceof ZodError) {
        return Response.json({ error: error.issues[0]?.message ?? 'Invalid request.' }, { ...noStore(), status: 400 });
      }
      if (isObjectMovingError(error)) {
        return Response.json({ error: 'Quick Notes are moving. Try again in a minute.' }, { ...noStore(), status: 503 });
      }
      return Response.json({ error: 'Could not store the Quick Note.' }, { ...noStore(), status: 500 });
    }
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS quick_notes (
        id              TEXT PRIMARY KEY,
        body            TEXT NOT NULL,
        source          TEXT NOT NULL,
        context_json    TEXT,
        state           TEXT NOT NULL DEFAULT 'open',
        promotion_kind  TEXT,
        promotion_id    TEXT,
        promoted_at    INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS quick_notes_inbox_order
       ON quick_notes (state, updated_at DESC, id DESC)`,
    );
  }
}

function toQuickNote(row: QuickNoteRow): QuickNote {
  return {
    id: row.id,
    body: row.body,
    source: row.source as QuickNoteSource,
    context: parseContext(row.context_json),
    state: row.state as QuickNoteState,
    promotion: parsePromotion(row),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

function parseContext(raw: string | null): QuickNoteContext | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const meetingID = (value as { meeting_id?: unknown }).meeting_id;
    return typeof meetingID === 'string' ? { meeting_id: meetingID } : null;
  } catch {
    return null;
  }
}

function parsePromotion(row: QuickNoteRow): QuickNotePromotion | null {
  if (!row.promotion_kind || !row.promotion_id || row.promoted_at === null) return null;
  return {
    kind: row.promotion_kind as QuickNotePromotion['kind'],
    id: row.promotion_id,
    promoted_at: new Date(row.promoted_at).toISOString(),
  };
}

function noStore(): ResponseInit {
  return { headers: { 'cache-control': 'no-store' } };
}

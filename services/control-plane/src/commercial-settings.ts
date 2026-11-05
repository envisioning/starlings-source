// The commercial group's settings in Admin › Records: payment terms,
// currencies, corporate entities, delivery conditions, offer links, policies.
// While Core holds the group the read answers `editable: false` and every write
// is refused, as `subject-settings.ts` does for the subjects group. A write goes
// through `core-commercial-d1.ts`, so it has the freeze check and the trail.

import {
  COMMERCIAL_SETTINGS_TABLES,
  type CommercialSettingsResponse,
  type CommercialSettingsWrite,
} from '@starlings/contracts/commercial-settings';
import { coreCommercialRows, writeCoreCommercial } from './core-commercial-d1';
import { ControlError } from './errors';
import { usesCoreFor } from './work-store';

const ORDER: Readonly<Record<(typeof COMMERCIAL_SETTINGS_TABLES)[number], string>> = {
  settings_payment_terms: 'title',
  currency_settings: 'currency_code',
  corporate_entities: 'name',
  settings_delivery_conditions: 'title',
  settings_offer_links: 'title',
  policies: 'title',
};

const EMPTY: Omit<CommercialSettingsResponse, 'editable'> = {
  settings_payment_terms: [],
  currency_settings: [],
  corporate_entities: [],
  settings_delivery_conditions: [],
  settings_offer_links: [],
  policies: [],
};

/** `GET /api/admin/records/commercial`. */
export async function readCommercialSettings(env: Env): Promise<CommercialSettingsResponse> {
  if (usesCoreFor(env, 'commercial')) return { editable: false, ...EMPTY };
  const lists = await Promise.all(COMMERCIAL_SETTINGS_TABLES.map((table) => coreCommercialRows(env, {
    op: 'commercial_rows', table, order: [{ column: ORDER[table], descending: false }], limit: 1000, offset: 0,
  })));
  return {
    editable: true,
    ...Object.fromEntries(COMMERCIAL_SETTINGS_TABLES.map((table, index) => [table, lists[index]])),
  } as CommercialSettingsResponse;
}

/** One default per table: a row saved as the default takes it from the others. */
async function clearOtherDefaults(env: Env, table: string, id: string | null): Promise<void> {
  await env.USAGE.prepare(`UPDATE "${table}" SET is_default = 0 WHERE is_default = 1 AND id IS NOT ?1`).bind(id).run();
}

/** `POST /api/admin/records/commercial`: one change, then the whole page again. */
export async function writeCommercialSettings(env: Env, actor: string, write: CommercialSettingsWrite): Promise<CommercialSettingsResponse> {
  if (usesCoreFor(env, 'commercial')) throw new ControlError('These settings can’t change here yet.', 409, 'invalid_request');
  try {
    if (write.op === 'delete') {
      const removed = await writeCoreCommercial(env, actor, { action: 'delete', entity: 'commercial', table: write.table, id: write.id }, 'member');
      if (!removed) throw new ControlError('That row is gone.', 404, 'invalid_request');
    } else {
      const values = write.values as Record<string, unknown>;
      if (write.table === 'currency_settings') {
        const code = await env.USAGE.prepare('SELECT 1 AS one FROM currency_settings WHERE currency_code = ?1 AND id IS NOT ?2').bind(values.currency_code, write.id ?? null).first<number>('one');
        if (code) throw new ControlError('That one is in the list already.', 409, 'invalid_request');
      }
      const saved = write.id
        ? await writeCoreCommercial(env, actor, { action: 'update', entity: 'commercial', table: write.table, id: write.id, values: values as never }, 'member')
        : await writeCoreCommercial(env, actor, { action: 'create', entity: 'commercial', table: write.table, values: values as never }, 'member');
      if (!saved) throw new ControlError('That row is gone.', 404, 'invalid_request');
      if (values.is_default === true) await clearOtherDefaults(env, write.table, String(saved.id));
    }
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/u.test(error.message)) {
      throw new ControlError('That one is in the list already.', 409, 'invalid_request');
    }
    throw error;
  }
  return readCommercialSettings(env);
}

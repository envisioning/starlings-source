/**
 * The Beeper card (`docs/AGENTS_SURFACE.md` neighbours).
 *
 * Beeper is the one connector Meet cannot read for itself: Beeper Desktop's
 * API is loopback-only, so the Mac is the reader and the Worker only ever
 * receives what it has already matched. None of that is built yet — this is
 * the card, so `/admin/connectors` is the whole inventory rather than the
 * subset that happens to have shipped, and so the surface exists before the
 * reader rather than after it.
 *
 * It is deliberately pulse-driven. `connector_pulse` is keyed by connector
 * id, so the moment the import route starts calling `touchConnector(env,
 * 'beeper', …)` this card reports real times with no change here. Until then
 * it reads "Not configured", which is the truth.
 *
 * Counts stay zero until the `beeper_chats` index exists (#274 step 2). A
 * zero is the contract's own answer for a field a connector has no notion of
 * yet, and is honest in a way an invented number would not be.
 */
import type { ConnectorStatus } from '@starlings/contracts';
import { connectorPulse } from './import-ledger';

export async function beeperConnectorStatus(env: Env): Promise<ConnectorStatus> {
  const pulse = await connectorPulse(env, 'beeper');
  // No env flag to read: the bridge is configured by the owner turning it on
  // in the Mac app's Settings, not by a Worker secret. So "configured" is
  // whether this Meet has ever heard from that reader.
  const heard = pulse.import ?? pulse.sync ?? null;
  return {
    id: 'beeper',
    configured: heard !== null,
    imported: 0,
    unfiled: 0,
    suggested: 0,
    accepted: 0,
    corrected: 0,
    // Beeper files onto every subject its contact is linked to; it never
    // proposes a filing for a person to accept (#274 decision 2).
    suggesting: false,
    // Nothing pushes to Meet — the Mac polls Beeper and posts. A webhook time
    // would always be null, so it says so.
    last_webhook_at: null,
    last_import_at: pulse.import ?? null,
    last_sync_at: pulse.sync ?? null,
    enabled: heard !== null,
  };
}

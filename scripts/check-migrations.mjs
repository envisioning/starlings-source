#!/usr/bin/env node
// Migration lint for Meet's D1 migrations (docs/agents/areas/worker.md
// §D1 migrations are additive).
//
// Workers Builds applies `services/control-plane/migrations/*.sql` to
// production on every push with nobody watching, so two things are checked
// before a migration reaches `main`:
//
// 1. Order. A new migration's number is higher than every grandfathered
//    migration's and unique among the new ones. Seven numbers were used twice
//    before this check existed; wrangler applies in filename order, so a
//    duplicate prefix is an order nobody chose.
// 2. Destructive steps. A migration with `DROP TABLE`, `DROP COLUMN` or a
//    table rebuild (`ALTER TABLE ... RENAME TO`) needs its first line to be a
//    comment `-- destructive: <reason>`. The reason says why the running
//    Worker no longer reads what is dropped.
//
// Files in GRANDFATHERED are the ones that existed on 2026-10-01; they are
// not checked. Never add a file to the list to get past the check.

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GRANDFATHERED = new Set([
  '0001_people.sql',
  '0002_threads.sql',
  '0003_presence.sql',
  '0004_channels.sql',
  '0005_revocation.sql',
  '0006_intent.sql',
  '0007_agent_activity.sql',
  '0008_call_kind.sql',
  '0009_avatars.sql',
  '0010_person_profile.sql',
  '0011_thread_delivery.sql',
  '0012_card_trace.sql',
  '0013_agent_manifest.sql',
  '0014_owner_devices.sql',
  '0015_office_scene.sql',
  '0016_office_screenshot_scene.sql',
  '0017_office_boundaries_and_style.sql',
  '0018_office_remove_draft_types.sql',
  '0019_office_far_wall_description.sql',
  '0020_office_remove_exact_palette.sql',
  '0021_office_walled_zones.sql',
  '0022_office_chairs.sql',
  '0023_office_sparse_points.sql',
  '0024_person_hidden.sql',
  '0025_person_role.sql',
  '0025_thread_archive.sql',
  '0026_admin_audit.sql',
  '0027_meetings_ledger.sql',
  '0028_drop_transcription_vocabulary.sql',
  '0029_agent_handoffs.sql',
  '0030_appear_offline.sql',
  '0031_people_role_community.sql',
  '0032_intent_focused.sql',
  '0032_subject_state.sql',
  '0033_home_preferences.sql',
  '0034_owner_devices_previous_jti.sql',
  '0035_subject_state_drop_followed.sql',
  '0036_mcp.sql',
  '0036_work_list_preferences.sql',
  '0037_core_favorites_sync.sql',
  '0037_inbound_addresses.sql',
  '0038_owner_devices_label.sql',
  '0039_inbox_dismissed.sql',
  '0040_inbox_sources.sql',
  '0040_pending_calendar_events.sql',
  '0041_meeting_deliveries.sql',
  '0041_people_language.sql',
  '0042_interest_submissions.sql',
  '0043_agent_addressers.sql',
  '0044_granola_suggestions.sql',
  '0045_github_connector.sql',
  '0046_granola_notes.sql',
  '0047_granola_suggestions_organization.sql',
  '0047_slack_users.sql',
  '0048_granola_ingested_at.sql',
  '0049_mcp_calls_redact_words.sql',
  '0050_diagnostics.sql',
  '0051_ops_alerts.sql',
  '0052_notes_owed.sql',
  '0053_model_usage.sql',
  '0054_ops_runs.sql',
  '0055_granola_personal.sql',
  '0056_granola_names_not_addresses.sql',
  '0057_import_ledger.sql',
  '0058_google_grants.sql',
  '0059_mcp_idempotency.sql',
  '0060_meetings_ledger_changes.sql',
  '0061_owner_device_versions.sql',
  '0062_operational_error_daily.sql',
  '0063_decision_asks.sql',
  '0064_agent_activity.sql',
  '0065_downstream_usage.sql',
  '0066_ops_signals.sql',
]);

const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/u;
const DESTRUCTIVE = [
  [/\bDROP\s+TABLE\b/iu, 'DROP TABLE'],
  [/\bDROP\s+COLUMN\b/iu, 'DROP COLUMN'],
  [/\bALTER\s+TABLE\s+\S+\s+RENAME\s+TO\b/iu, 'a table rebuild (ALTER TABLE ... RENAME TO)'],
];
const DESTRUCTIVE_HEADER = /^--\s*destructive:\s*\S/u;

/** The SQL with comments and string literals blanked, so words in them do not count. */
export function stripSql(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/--[^\n]*/gu, ' ')
    .replace(/'(?:[^']|'')*'/gu, "''");
}

/**
 * @param {Array<{ name: string, text: string }>} files every file in the migrations folder
 * @param {Set<string>} grandfathered
 * @returns {string[]} one message per problem
 */
export function lintMigrations(files, grandfathered = GRANDFATHERED) {
  const problems = [];
  const prefixOf = (name) => FILE_PATTERN.exec(name)?.[1];
  const highest = Math.max(0, ...[...grandfathered].map((name) => Number(prefixOf(name) ?? 0)));
  const seen = new Map();
  for (const { name, text } of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    if (grandfathered.has(name)) continue;
    const prefix = prefixOf(name);
    if (!prefix) {
      problems.push(`${name}: a migration is named NNNN_snake_case.sql.`);
      continue;
    }
    if (Number(prefix) <= highest) {
      problems.push(`${name}: the number ${prefix} is not higher than the last grandfathered migration (${String(highest).padStart(4, '0')}); renumber it to the next free number.`);
    }
    if (seen.has(prefix)) {
      problems.push(`${name}: the number ${prefix} is also used by ${seen.get(prefix)}; the later one takes the next free number.`);
    } else {
      seen.set(prefix, name);
    }
    const found = DESTRUCTIVE.filter(([pattern]) => pattern.test(stripSql(text))).map(([, label]) => label);
    if (found.length > 0 && !DESTRUCTIVE_HEADER.test(text.split('\n', 1)[0] ?? '')) {
      problems.push(`${name}: contains ${found.join(', ')}; its first line must be a comment "-- destructive: <reason>" (the reason is why the running Worker no longer reads it).`);
    }
  }
  return problems;
}

async function readFolder(path) {
  const folder = resolve(fileURLToPath(new URL('..', import.meta.url)), path);
  const names = (await readdir(folder)).filter((name) => name.endsWith('.sql'));
  return Promise.all(names.map(async (name) => ({ name, text: await readFile(resolve(folder, name), 'utf8') })));
}

async function main() {
  const files = await readFolder('services/control-plane/migrations');
  const names = files.map((file) => file.name);
  const missing = [...GRANDFATHERED].filter((name) => !names.includes(name));
  const problems = lintMigrations(files);
  if (missing.length > 0) problems.push(`check-migrations: grandfathered files are gone: ${missing.join(', ')}. A migration that was applied is never renamed or deleted.`);
  // The starlings-auth Worker's own D1 (wrangler.auth.jsonc): the same rules, numbered from 0001.
  const authFiles = await readFolder('services/control-plane/auth-migrations');
  problems.push(...lintMigrations(authFiles, new Set()).map((problem) => `auth-migrations/${problem}`));
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`check-migrations: ${names.length} migrations, ${names.length - GRANDFATHERED.size} new, all in order; ${authFiles.length} auth migrations.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

#!/usr/bin/env node
// The plan for Core's `signals_accounts` rows (decided by MZ, 2026-11-05): a
// Signals customer is a licence, a prospect is a lead. Run once the commercial
// group is on D1, through the admin action.
//
//   node --import ./scripts/node-ts-resolve.mjs scripts/signals-accounts-map.mjs
//     The dry run. It reads Core and prints counts and the ambiguous ids. It
//     writes nothing, and it prints no row contents.
//   ... scripts/signals-accounts-map.mjs --payload > accounts.json
//     The body for `POST /api/admin/signals-accounts/map`. The file holds row
//     contents: keep it out of the repository. On D1 the same rule runs against
//     D1's licences and leads, a dry run first, then with `"apply": true`, which
//     refuses while any row is ambiguous.
//
// Only a read of Core. Applying is the admin action's job: it writes the trail
// and takes the freeze check. Core has no `leads.source`, so this dry run sees no
// Signals lead; D1's answer can only turn a `lead_create` into a `lead_found`.

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { planSignalsAccounts, signalsAccountSourceSchema } from '../packages/contracts/src/licenses.ts';

const PROJECT_REF = 'qogwcwqkztsgkqfewtgq';

/** One read-only query through the Supabase CLI, from home so no project config interferes. */
function query(sql) {
  const output = execFileSync('supabase', ['db', 'query', '--linked', '--project-ref', PROJECT_REF, sql], {
    cwd: homedir(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1)).rows;
}

const accounts = query(`select id, organization_id, primary_contact_id, stage, notes, seats, started_on::text, payment_type, signals_org_id,
  usage_schema_version, usage_snapshot_at, usage_window_starts_at, usage_window_ends_at, usage_projects_count, usage_sessions_created_30d,
  usage_last_session_created_at, usage_workflow_runs_succeeded_30d, usage_last_successful_workflow_run_at, usage_results_first_viewed_at,
  usage_credit_buckets from signals_accounts order by created_at`).map((row) => signalsAccountSourceSchema.parse(row));

if (process.argv.includes('--payload')) {
  process.stdout.write(`${JSON.stringify({ accounts })}\n`);
  process.exit(0);
}

const licenses = query(`select id, organization_id, product, is_active from licenses`);
const { steps, counts } = planSignalsAccounts(accounts, licenses, []);
const stages = accounts.reduce((all, account) => ({ ...all, [account.stage]: (all[account.stage] ?? 0) + 1 }), {});

console.log(JSON.stringify({ counts, stages, signals_licenses: licenses.filter((license) => license.product === 'signals').length }, null, 2));
for (const step of steps) {
  if (step.action === 'ambiguous') console.log(`ambiguous ${step.account_id} ${step.reason}`);
}

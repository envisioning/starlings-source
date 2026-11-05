-- destructive: work_group_moves is rebuilt to widen its CHECK, and its rows are copied; only an admin's move reads that table, and no move runs during a deploy.
-- The Signals group's tables (meet#1224, docs/CORE_FOLD_PLAN.md §The group move).
-- Decided by MZ, 2026-11-04: the simplest version. Core's CRM `signals_*` tables
-- move with the same group move: same ids, same columns, same table names, and
-- the foreign keys inside D1. Nothing reads or writes these until
-- WORK_STORE_SIGNALS is d1; the group copy fills them.
--
-- Times are epoch ms, booleans 0/1, `numeric` is REAL, `jsonb` and `text[]` are
-- JSON text (`packages/contracts/src/core-signals.ts`). A `date` stays YYYY-MM-DD
-- text. A column is NOT NULL only where Core's is.
--
-- Foreign keys follow Core's actions. No foreign key names auth.users (owner_id,
-- created_by, approved_by, decided_by, requested_by, verified_by): those are
-- Core's person ids, as `tasks.assignee_id` holds them. `tasks.signals_account_id`
-- and `interactions.signals_account_id` keep no foreign key: their groups move
-- first, and a parent must come before its child (the order test).
--
-- Each CHECK says what Core's says, with the same values. Every Core CHECK was
-- validated on 2026-11-04 (`pg_constraint.convalidated`), so each accepts every
-- value Core holds. One Core CHECK has no SQLite form:
-- `effective_to = effective_from + '1 year'` on entitlements. Core's route and
-- `queue_entitlement_event` check that rule.

CREATE TABLE signals_accounts (
  id                                     TEXT PRIMARY KEY,
  organization_id                        TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  primary_contact_id                     TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  motion                                 TEXT NOT NULL DEFAULT 'direct' CHECK (motion IN ('direct', 'partner')),
  stage                                  TEXT NOT NULL DEFAULT 'target' CHECK (stage IN ('target', 'contacted', 'demoed', 'testing', 'active', 'not_now', 'closed_lost')),
  source                                 TEXT CHECK (source IN ('existing_client', 'network', 'referral', 'event', 'public_scan', 'other', 'outreach', 'signals_product')),
  source_detail                          TEXT,
  issue_codes                            TEXT NOT NULL DEFAULT '[]',
  notes                                  TEXT,
  created_at                             INTEGER NOT NULL,
  updated_at                             INTEGER NOT NULL,
  account_type                           TEXT CHECK (account_type IN ('starter', 'pro', 'partner')),
  seats                                  INTEGER CHECK (seats >= 0),
  started_on                             TEXT,
  payment_type                           TEXT CHECK (payment_type IN ('invoice', 'stripe')),
  signals_org_id                         TEXT CHECK (length(trim(signals_org_id)) BETWEEN 1 AND 255),
  owner_id                               TEXT,
  usage_schema_version                   INTEGER,
  usage_snapshot_at                      INTEGER,
  usage_window_starts_at                 INTEGER,
  usage_window_ends_at                   INTEGER,
  usage_projects_count                   INTEGER,
  usage_sessions_created_30d             INTEGER,
  usage_last_session_created_at          INTEGER,
  usage_workflow_runs_succeeded_30d      INTEGER,
  usage_last_successful_workflow_run_at  INTEGER,
  usage_results_first_viewed_at          INTEGER,
  usage_credit_buckets                   TEXT CHECK (json_type(usage_credit_buckets) = 'array'),
  UNIQUE (organization_id)
);
CREATE UNIQUE INDEX signals_accounts_signals_org_id ON signals_accounts (signals_org_id) WHERE signals_org_id IS NOT NULL;
CREATE INDEX signals_accounts_primary_contact ON signals_accounts (primary_contact_id);
CREATE INDEX signals_accounts_stage ON signals_accounts (stage);
CREATE INDEX signals_accounts_updated_at ON signals_accounts (updated_at DESC);

CREATE TABLE signals_members (
  id                    TEXT PRIMARY KEY,
  signals_account_id    TEXT NOT NULL REFERENCES signals_accounts (id) ON DELETE CASCADE,
  contact_id            TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  signals_user_id       TEXT NOT NULL,
  email                 TEXT NOT NULL,
  role                  TEXT CHECK (role IN ('admin', 'member')),
  joined_at             INTEGER,
  last_active_at        INTEGER,
  sessions_created_30d  INTEGER,
  runs_completed_30d    INTEGER,
  removed_at            INTEGER,
  match_state           TEXT NOT NULL DEFAULT 'matched' CHECK (match_state IN ('matched', 'created', 'ambiguous')),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE (signals_account_id, signals_user_id)
);
CREATE INDEX signals_members_contact ON signals_members (contact_id);

CREATE TABLE signals_worksessions (
  id                     TEXT PRIMARY KEY,
  organization_id        TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  signals_account_id     TEXT REFERENCES signals_accounts (id) ON DELETE SET NULL,
  title                  TEXT NOT NULL,
  briefing               TEXT,
  session_date           TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  delivery_mode          TEXT CHECK (delivery_mode IN ('online', 'in_person', 'hybrid')),
  outcomes               TEXT,
  primary_contact_id     TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  facilitator            TEXT,
  offer_id               TEXT REFERENCES offers (id) ON DELETE SET NULL,
  project_id             TEXT REFERENCES projects (id) ON DELETE SET NULL,
  included_starter_plan  INTEGER NOT NULL DEFAULT 0,
  notes                  TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX signals_worksessions_organization ON signals_worksessions (organization_id, session_date DESC);
CREATE INDEX signals_worksessions_account ON signals_worksessions (signals_account_id);
CREATE INDEX signals_worksessions_contact ON signals_worksessions (primary_contact_id);

CREATE TABLE signals_worksession_contacts (
  id              TEXT PRIMARY KEY,
  worksession_id  TEXT NOT NULL REFERENCES signals_worksessions (id) ON DELETE CASCADE,
  contact_id      TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  UNIQUE (worksession_id, contact_id)
);
CREATE INDEX signals_worksession_contacts_contact ON signals_worksession_contacts (contact_id);

CREATE TABLE signals_evaluations (
  id                       TEXT PRIMARY KEY,
  organization_id          TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  signals_account_id       TEXT REFERENCES signals_accounts (id) ON DELETE SET NULL,
  request_id               TEXT,
  status                   TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'active', 'review_due', 'completed', 'declined', 'canceled')),
  owner_id                 TEXT,
  sponsor_contact_id       TEXT REFERENCES contacts (id) ON DELETE SET NULL,
  use_case                 TEXT NOT NULL,
  success_measure          TEXT NOT NULL,
  requested_at             INTEGER NOT NULL,
  approved_by              TEXT,
  approved_at              INTEGER,
  starts_at                INTEGER,
  ends_at                  INTEGER,
  review_due_at            INTEGER,
  credit_cap               REAL CHECK (credit_cap >= 0),
  onboarding_included      INTEGER NOT NULL DEFAULT 1 CHECK (onboarding_included = 1),
  onboarding_completed_at  INTEGER,
  outcome                  TEXT CHECK (outcome IN ('successful', 'unsuccessful', 'inconclusive', 'not_reviewed')),
  outcome_summary          TEXT,
  converted_license_id     TEXT REFERENCES licenses (id) ON DELETE SET NULL,
  internal_subsidy_eur     REAL CHECK (internal_subsidy_eur >= 0),
  internal_notes           TEXT,
  created_by               TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  CHECK (status NOT IN ('approved', 'active', 'review_due', 'completed')
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND starts_at IS NOT NULL AND ends_at IS NOT NULL)),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
CREATE UNIQUE INDEX signals_evaluations_request_id ON signals_evaluations (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX signals_evaluations_organization ON signals_evaluations (organization_id, status, updated_at DESC);

CREATE TABLE signals_partnerships (
  id                       TEXT PRIMARY KEY,
  organization_id          TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  status                   TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'under_review', 'needs_information', 'declined', 'approved_pending_agreement', 'active', 'closed')),
  owner_id                 TEXT,
  proposed_mutual_outcome  TEXT,
  contribution_sought      TEXT,
  relevant_audience        TEXT,
  likely_first_initiative  TEXT,
  internal_rationale       TEXT,
  decided_by               TEXT,
  decided_at               INTEGER,
  agreement_reference      TEXT,
  agreement_version        TEXT,
  signed_at                INTEGER,
  term_starts_at           INTEGER,
  term_ends_at             INTEGER,
  renewal_state            TEXT CHECK (renewal_state IN ('not_due', 'review_due', 'renewed', 'not_renewing', 'canceled')),
  public_name_allowed      INTEGER NOT NULL DEFAULT 0,
  logo_allowed             INTEGER NOT NULL DEFAULT 0,
  review_due_at            INTEGER,
  next_action              TEXT,
  closed_at                INTEGER,
  created_by               TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  next_task_id             TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  agreement_on_file        INTEGER NOT NULL DEFAULT 0,
  CHECK (status <> 'active' OR (agreement_on_file = 1 AND signed_at IS NOT NULL AND term_starts_at IS NOT NULL AND term_ends_at IS NOT NULL)),
  CHECK (term_starts_at IS NULL OR term_ends_at IS NULL OR term_ends_at > term_starts_at)
);
CREATE INDEX signals_partnerships_organization ON signals_partnerships (organization_id, status, updated_at DESC);
CREATE INDEX signals_partnerships_next_task ON signals_partnerships (next_task_id) WHERE next_task_id IS NOT NULL;

CREATE TABLE signals_partner_entitlements (
  id                  TEXT PRIMARY KEY,
  partnership_id      TEXT NOT NULL REFERENCES signals_partnerships (id) ON DELETE RESTRICT,
  agreement_year      INTEGER NOT NULL CHECK (agreement_year >= 1),
  organization_id     TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  signals_account_id  TEXT REFERENCES signals_accounts (id) ON DELETE SET NULL,
  signals_org_id      TEXT,
  status              TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'provisioned', 'expired', 'revoked')),
  effective_from      INTEGER NOT NULL,
  effective_to        INTEGER NOT NULL,
  provisioned_at      INTEGER,
  expired_at          INTEGER,
  revoked_at          INTEGER,
  created_by          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (partnership_id, agreement_year),
  CHECK (effective_to > effective_from),
  CHECK (status <> 'provisioned' OR (signals_account_id IS NOT NULL AND signals_org_id IS NOT NULL))
);
CREATE INDEX signals_partner_entitlements_organization ON signals_partner_entitlements (organization_id, status, effective_to DESC);

CREATE TABLE signals_partner_entitlement_outbox (
  id               TEXT PRIMARY KEY,
  event_id         TEXT NOT NULL UNIQUE,
  entitlement_id   TEXT NOT NULL REFERENCES signals_partner_entitlements (id) ON DELETE RESTRICT,
  action           TEXT NOT NULL CHECK (action IN ('grant', 'renew', 'revoke', 'expire')),
  payload          TEXT NOT NULL CHECK (json_type(payload) = 'object'),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead_letter')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  INTEGER NOT NULL,
  last_error_code  TEXT,
  delivered_at     INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX signals_partner_entitlement_outbox_pending ON signals_partner_entitlement_outbox (next_attempt_at, created_at) WHERE status = 'pending';

CREATE TABLE signals_promotions (
  id                     TEXT PRIMARY KEY,
  promotion_id           TEXT,
  organization_id        TEXT NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  signals_account_id     TEXT REFERENCES signals_accounts (id) ON DELETE SET NULL,
  license_id             TEXT REFERENCES licenses (id) ON DELETE SET NULL,
  campaign               TEXT,
  source                 TEXT,
  plan_key               TEXT,
  charge_scope           TEXT CHECK (charge_scope IN ('initial', 'renewal', 'any')),
  benefit_type           TEXT CHECK (benefit_type IN ('amount', 'percent', 'credits')),
  benefit_value          REAL CHECK (benefit_value >= 0),
  currency               TEXT CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  valid_from             INTEGER,
  valid_to               INTEGER,
  usage_limit            INTEGER CHECK (usage_limit >= 1),
  status                 TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'issued', 'applied', 'redeemed', 'expired', 'reversed')),
  requested_by           TEXT,
  approved_by            TEXT,
  requested_at           INTEGER NOT NULL,
  issued_at              INTEGER,
  applied_at             INTEGER,
  redeemed_at            INTEGER,
  expired_at             INTEGER,
  reversed_at            INTEGER,
  last_billing_event_at  INTEGER,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  UNIQUE (signals_account_id, promotion_id),
  CHECK (promotion_id IS NULL OR signals_account_id IS NOT NULL),
  CHECK (benefit_type <> 'amount' OR currency IS NOT NULL),
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX signals_promotions_account ON signals_promotions (signals_account_id, updated_at DESC);
CREATE INDEX signals_promotions_organization ON signals_promotions (organization_id, status, updated_at DESC);

CREATE TABLE signals_billing_events (
  id                        TEXT PRIMARY KEY,
  event_id                  TEXT NOT NULL UNIQUE,
  event_hash                TEXT NOT NULL CHECK (length(event_hash) = 64 AND event_hash NOT GLOB '*[^a-f0-9]*'),
  schema_version            INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  event_type                TEXT NOT NULL CHECK (event_type IN (
    'subscription.created', 'subscription.updated', 'subscription.canceled', 'invoice.paid', 'invoice.payment_failed', 'invoice.refunded',
    'promotion.issued', 'promotion.applied', 'promotion.redeemed', 'promotion.expired', 'promotion.reversed')),
  signals_org_id            TEXT NOT NULL,
  signals_account_id        TEXT REFERENCES signals_accounts (id) ON DELETE SET NULL,
  organization_id           TEXT REFERENCES organizations (id) ON DELETE SET NULL,
  signals_license_id        TEXT,
  stripe_subscription_id    TEXT,
  subscription_status       TEXT CHECK (subscription_status IN ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'unpaid', 'paused')),
  plan_key                  TEXT,
  billing_interval          TEXT CHECK (billing_interval IN ('month', 'year', 'one_time')),
  billing_period_starts_at  INTEGER,
  billing_period_ends_at    INTEGER,
  stripe_invoice_id         TEXT,
  currency                  TEXT CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  amount_due_minor          INTEGER CHECK (amount_due_minor >= 0),
  amount_paid_minor         INTEGER CHECK (amount_paid_minor >= 0),
  amount_refunded_minor     INTEGER CHECK (amount_refunded_minor >= 0),
  discount_minor            INTEGER CHECK (discount_minor >= 0),
  promotion_id              TEXT,
  promotion_campaign        TEXT,
  promotion_status          TEXT CHECK (promotion_status IN ('requested', 'issued', 'applied', 'redeemed', 'expired', 'reversed')),
  occurred_at               INTEGER NOT NULL,
  received_at               INTEGER NOT NULL,
  CHECK ((amount_due_minor IS NULL AND amount_paid_minor IS NULL AND amount_refunded_minor IS NULL AND discount_minor IS NULL) OR currency IS NOT NULL),
  CHECK (billing_period_starts_at IS NULL OR billing_period_ends_at IS NULL OR billing_period_ends_at > billing_period_starts_at)
);
CREATE INDEX signals_billing_events_account ON signals_billing_events (signals_account_id, occurred_at DESC);
CREATE INDEX signals_billing_events_organization ON signals_billing_events (organization_id, occurred_at DESC);

CREATE TABLE signals_lifecycle_snapshots (
  signals_account_id           TEXT PRIMARY KEY REFERENCES signals_accounts (id) ON DELETE CASCADE,
  signals_org_id               TEXT NOT NULL,
  definition_version           INTEGER NOT NULL DEFAULT 1 CHECK (definition_version = 1),
  first_user_activated_at      INTEGER,
  first_project_created_at     INTEGER,
  first_workflow_succeeded_at  INTEGER,
  first_results_viewed_at      INTEGER,
  first_value_at               INTEGER,
  time_to_first_value_seconds  INTEGER CHECK (time_to_first_value_seconds >= 0),
  workflow_successes_7d        INTEGER CHECK (workflow_successes_7d >= 0),
  workflow_successes_30d       INTEGER CHECK (workflow_successes_30d >= 0),
  active_users_7d              INTEGER CHECK (active_users_7d >= 0),
  active_users_30d             INTEGER CHECK (active_users_30d >= 0),
  window_starts_at             INTEGER,
  window_ends_at               INTEGER,
  retained_from                TEXT,
  refreshed_at                 INTEGER NOT NULL,
  history_complete             INTEGER NOT NULL DEFAULT 0,
  created_at                   INTEGER NOT NULL,
  updated_at                   INTEGER NOT NULL,
  CHECK (window_starts_at IS NULL OR window_ends_at IS NULL OR window_ends_at > window_starts_at)
);

CREATE TABLE signals_posthog_identity_mappings (
  id                  TEXT PRIMARY KEY,
  posthog_user_id     TEXT NOT NULL,
  signals_org_id      TEXT NOT NULL,
  signals_account_id  TEXT REFERENCES signals_accounts (id) ON DELETE SET NULL,
  verification_state  TEXT NOT NULL DEFAULT 'review_needed' CHECK (verification_state IN ('review_needed', 'verified', 'revoked')),
  verified_by         TEXT,
  verified_at         INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (posthog_user_id, signals_org_id),
  CHECK (verification_state <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX signals_posthog_identity_account ON signals_posthog_identity_mappings (signals_account_id, verification_state);

-- A move's record takes the new group. SQLite cannot change a CHECK in place.
CREATE TABLE work_group_moves_new (
  work_group   TEXT PRIMARY KEY CHECK (work_group IN ('subjects', 'tasks', 'goals', 'interactions', 'commercial', 'signals')),
  frozen       INTEGER NOT NULL DEFAULT 0,
  frozen_at    INTEGER,
  copied_at    INTEGER,
  verified_at  INTEGER,
  verified_ok  INTEGER,
  report       TEXT,
  updated_at   INTEGER NOT NULL
);
INSERT INTO work_group_moves_new SELECT work_group, frozen, frozen_at, copied_at, verified_at, verified_ok, report, updated_at FROM work_group_moves;
DROP TABLE work_group_moves;
ALTER TABLE work_group_moves_new RENAME TO work_group_moves;

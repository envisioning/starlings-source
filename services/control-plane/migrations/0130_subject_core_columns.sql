-- D1 organizations and contacts keep every column Core holds for them
-- (meet#1209, docs/CORE_FOLD_PLAN.md §Before each group moves). Without
-- these columns the `subjects` copy drops Core's data and the verify still
-- passes, because it digests only the copied columns.
--
-- Read from core-web DATABASE.md (synced 2026-10-07) and its migrations to
-- 2026-10-17. Booleans are INTEGER 0/1, `jsonb` is JSON TEXT, times are epoch
-- milliseconds (§Postgres to D1).
--
-- Kept columns that already exist: organizations.name, is_partner, industry,
-- logo_url, url (Core's `website`); contacts.organization_id, name, email,
-- title (Core's `company_role`). Not copied: `search_vector` on both, a
-- generated tsvector that search rebuilds in D1. Core's contact source
-- (`source_key`) is a row in `contact_source_events`, a table in no group.

-- Organizations: the address and tax block, the company profile, links.
ALTER TABLE organizations ADD COLUMN legal_name TEXT;
ALTER TABLE organizations ADD COLUMN address TEXT;
ALTER TABLE organizations ADD COLUMN postcode TEXT;
ALTER TABLE organizations ADD COLUMN city TEXT;
ALTER TABLE organizations ADD COLUMN country TEXT;
ALTER TABLE organizations ADD COLUMN vat_id TEXT;
ALTER TABLE organizations ADD COLUMN tax_id TEXT;
ALTER TABLE organizations ADD COLUMN size TEXT;
ALTER TABLE organizations ADD COLUMN notes TEXT;
-- A person id (migration 0072): Core's auth.users uuid, which meet#720 makes Meet's.
ALTER TABLE organizations ADD COLUMN owner_id TEXT;
ALTER TABLE organizations ADD COLUMN founded TEXT;
ALTER TABLE organizations ADD COLUMN hq_location TEXT;
ALTER TABLE organizations ADD COLUMN company_type TEXT;
ALTER TABLE organizations ADD COLUMN linkedin_url TEXT;
ALTER TABLE organizations ADD COLUMN logo_image_url TEXT;
-- The curated logo. A reader shows it before `logo_url`.
ALTER TABLE organizations ADD COLUMN profile_image_url TEXT;
-- The billing entity Core's offers name.
ALTER TABLE organizations ADD COLUMN entity TEXT;
ALTER TABLE organizations ADD COLUMN domain TEXT;
ALTER TABLE organizations ADD COLUMN is_agency INTEGER NOT NULL DEFAULT 0;
ALTER TABLE organizations ADD COLUMN is_existing_client INTEGER NOT NULL DEFAULT 0;

-- Contacts: the profile, the Signals outreach state, the birthday.
ALTER TABLE contacts ADD COLUMN notes TEXT;
ALTER TABLE contacts ADD COLUMN linkedin_url TEXT;
ALTER TABLE contacts ADD COLUMN phone TEXT;
ALTER TABLE contacts ADD COLUMN headline TEXT;
ALTER TABLE contacts ADD COLUMN location TEXT;
ALTER TABLE contacts ADD COLUMN connection_count TEXT;
-- ISO 3166 alpha-2, as Core's varchar(2).
ALTER TABLE contacts ADD COLUMN country TEXT;
ALTER TABLE contacts ADD COLUMN corporate_email TEXT;
ALTER TABLE contacts ADD COLUMN profile_image_url TEXT;
-- A JSON object of named flags, as Core's jsonb.
ALTER TABLE contacts ADD COLUMN characteristics TEXT;
ALTER TABLE contacts ADD COLUMN preferred_language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE contacts ADD COLUMN signals_outreach_status TEXT;
ALTER TABLE contacts ADD COLUMN signals_notified_at INTEGER;
ALTER TABLE contacts ADD COLUMN birthday_month INTEGER;
ALTER TABLE contacts ADD COLUMN birthday_day INTEGER;
ALTER TABLE contacts ADD COLUMN birthday_year INTEGER;
-- The profile kinds, one flag each, as Core keeps them.
ALTER TABLE contacts ADD COLUMN futurist INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN corporate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN academic INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN independent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN government INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN ngo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN media INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN intelligence INTEGER NOT NULL DEFAULT 0;

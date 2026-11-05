#!/usr/bin/env node

import { PUBLIC_WEB_ORIGIN } from '../packages/contracts/src/deployment-values.ts';
import { customRoutesMatchAliases, originHasCustomDomainRoute } from './production-domain-policy.mjs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { accentPalette } from '../packages/contracts/src/workspace-accent.ts';
import { WORKSPACE_SUITES } from '../packages/contracts/src/workspace-suite.ts';
import { parseIdentityDomains } from '../packages/contracts/src/deployment.ts';
import { PLATFORM_WORKSPACE_SLUGS, WORKSPACE_HOST_SUFFIX, checkWorkspaceSlug, isWorkspaceHostOrigin, parseWorkspaceAddress, serviceOrigin, workspaceOrigin } from '../packages/contracts/src/workspace-slug.ts';
import { OPS_ENTRYPOINT, OPS_SERVICE_KINDS, opsBindingName, opsServiceBindingName } from '../packages/contracts/src/ops.ts';
import { LIVEKIT_SECRET_NAMES, OWN_STORE_SECRET_NAMES, SHARED_SECRETS_STORE_ID, WORKSPACE_SHARED_SECRET_NAMES, sharedSecretBindings } from '../packages/contracts/src/shared-secrets.ts';
import { WORK_GROUPS, WORK_GROUP_VARS } from '../packages/contracts/src/work-groups.ts';
import { DEFAULT_WORKSPACE_REGION, WORKSPACE_REGIONS, isWorkspaceRegion, regionPlacement } from '../packages/contracts/src/workspace-region.ts';

/**
 * wrangler.jsonc is JSONC (wrangler's own format) — strip `//` and `/* *\/`
 * comments before JSON.parse. String-aware so it never eats a `//` inside a
 * URL value; nothing here needs to handle escaped slashes since JSON strings
 * escape `\`, not `/`.
 */
export function stripJSONComments(text) {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === '\n') { inLineComment = false; out += ch; }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next; i++; }
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    out += ch;
  }
  return out;
}

const REQUIRED = ['GOOGLE_WEB_CLIENT_ID', 'GOOGLE_NATIVE_CLIENT_ID', 'LIVEKIT_URL', 'OWNER_ROOM_MAP', 'ROOT_ADMIN_EMAILS', 'WORKSPACE_NAME', 'PUBLIC_WEB_ORIGIN', 'NATIVE_APPLE_TEAM_ID'];

/** `services/control-plane/wrangler.jsonc`, the Worker config for every workspace. */
export const WRANGLER_CONFIG_URL = new URL('../services/control-plane/wrangler.jsonc', import.meta.url);

export async function readWranglerConfig(url = WRANGLER_CONFIG_URL) {
  return JSON.parse(stripJSONComments(await readFile(url, 'utf8')));
}

/**
 * The resources one workspace binds, by kind. Two workspaces never share
 * one: isolation is the platform's (STARLINGS (HQ Docs) phase 3).
 */
function workspaceResources(workspace) {
  return {
    'Worker name': workspace.name ? [workspace.name] : [],
    'KV namespace': (workspace.kv_namespaces ?? []).map((kv) => kv.id),
    'D1 database': (workspace.d1_databases ?? []).flatMap((db) => [db.database_id, db.database_name]),
    'R2 bucket': (workspace.r2_buckets ?? []).map((bucket) => bucket.bucket_name),
    queue: [
      ...(workspace.queues?.producers ?? []).map((queue) => queue.queue),
      ...(workspace.queues?.consumers ?? []).flatMap((queue) => [queue.queue, queue.dead_letter_queue]),
    ],
    'rate limit namespace': (workspace.ratelimits ?? []).map((limit) => limit.namespace_id),
  };
}

/** `services/control-plane/wrangler.auth.jsonc`, the starlings-auth Worker config (docs/CENTRAL_AUTH.md). */
export const AUTH_CONFIG_URL = new URL('../services/control-plane/wrangler.auth.jsonc', import.meta.url);

/** The auth Worker config, or null when the file does not exist. */
export function readAuthConfigSync(url = AUTH_CONFIG_URL) {
  return existsSync(url) ? JSON.parse(stripJSONComments(readFileSync(url, 'utf8'))) : null;
}

/**
 * The one service binding a workspace may hold (docs/CENTRAL_AUTH.md,
 *): AUTH to starlings-auth's AuthService, with
 * `props: { origin }` and nothing else. The props name the calling workspace
 * to the auth Worker; `checkCentralAuth` holds the origin to the
 * workspace's WEB_ORIGIN.
 */
const AUTH_BINDING = { binding: 'AUTH', service: 'starlings-auth', entrypoint: 'AuthService' };
/**
 * The GitHub token broker (docs/GITHUB_CONNECTOR.md "One App, one broker"):
 * GITHUB to starlings-auth's GithubService, with `props: { origin }` and
 * nothing else. The broker mints tokens for the installation recorded for
 * the props origin, so `checkGithubBroker` holds it to WEB_ORIGIN.
 */
const GITHUB_BINDING = { binding: 'GITHUB', service: 'starlings-auth', entrypoint: 'GithubService' };
function isOriginPinnedBinding(service, shape) {
  if (!service || typeof service !== 'object') return false;
  const keys = Object.keys(service).sort().join(',');
  if (keys !== 'binding,entrypoint,props,service') return false;
  if (!Object.entries(shape).every(([key, value]) => service[key] === value)) return false;
  const props = service.props;
  return Boolean(props) && typeof props === 'object' && !Array.isArray(props)
    && Object.keys(props).join(',') === 'origin' && typeof props.origin === 'string';
}
/**
 * The LiveKit token broker: LIVEKIT to starlings-auth's
 * LiveKitService, with `props: { origin }` and nothing else. The broker signs
 * only for the props origin's rooms, so `liveKitBrokerProblems` holds it to
 * WEB_ORIGIN.
 */
const LIVEKIT_BINDING = { binding: 'LIVEKIT', service: 'starlings-auth', entrypoint: 'LiveKitService' };
function isLiveKitBinding(service) {
  return isOriginPinnedBinding(service, LIVEKIT_BINDING);
}
function isAuthBinding(service) {
  return isOriginPinnedBinding(service, AUTH_BINDING);
}
function isGithubBinding(service) {
  return isOriginPinnedBinding(service, GITHUB_BINDING);
}

/**
 * The App's key, client secret and webhook secret are the auth Worker's
 * `GITHUB_APP` secret and nobody else's: one key mints a token for every
 * firm's installation. A workspace that names one as a var or binds one
 * from the Secrets Store is refused.
 */
const GITHUB_APP_SECRET_NAME = /^(SHARED_)?GITHUB_APP(_|$)/u;

/** Every problem with a workspace's GITHUB binding: exactly one, to the broker, pinned to WEB_ORIGIN. */
export function githubBrokerProblems(workspace) {
  const problems = [];
  const bound = (workspace.services ?? []).filter((service) => service?.binding === 'GITHUB');
  if (bound.length !== 1) problems.push('needs exactly one GITHUB binding to starlings-auth, entrypoint GithubService (docs/GITHUB_CONNECTOR.md)');
  else if (!isGithubBinding(bound[0])) problems.push('GITHUB must bind service starlings-auth, entrypoint GithubService, props { origin }, and nothing else');
  else if (bound[0].props.origin !== workspace.vars?.WEB_ORIGIN) problems.push(`GITHUB props.origin must be the workspace's WEB_ORIGIN (${workspace.vars?.WEB_ORIGIN})`);
  for (const name of Object.keys(workspace.vars ?? {})) {
    if (GITHUB_APP_SECRET_NAME.test(name)) problems.push(`${name}: the GitHub App's secrets live in starlings-auth only`);
  }
  for (const entry of workspace.secrets_store_secrets ?? []) {
    if (GITHUB_APP_SECRET_NAME.test(String(entry?.binding ?? '')) || GITHUB_APP_SECRET_NAME.test(String(entry?.secret_name ?? ''))) {
      problems.push(`${entry.binding}: the GitHub App's secrets live in starlings-auth only`);
    }
  }
  return problems;
}
/**
 * Every problem with a workspace's LiveKit: exactly one LIVEKIT binding to
 * the broker, pinned to WEB_ORIGIN, on Envisioning's project, and no
 * LiveKit key of its own. A key in a workspace could sign a token for any
 * room on the project, Envisioning's included.
 */
export function liveKitBrokerProblems(workspace, top) {
  const problems = [];
  const bound = (workspace.services ?? []).filter((service) => service?.binding === 'LIVEKIT');
  if (bound.length !== 1) problems.push('needs exactly one LIVEKIT binding to starlings-auth, entrypoint LiveKitService (meet#823)');
  else if (!isLiveKitBinding(bound[0])) problems.push('LIVEKIT must bind service starlings-auth, entrypoint LiveKitService, props { origin }, and nothing else');
  else if (bound[0].props.origin !== workspace.vars?.WEB_ORIGIN) problems.push(`LIVEKIT props.origin must be the workspace's WEB_ORIGIN (${workspace.vars?.WEB_ORIGIN})`);
  if (workspace.vars?.LIVEKIT_URL !== top.vars?.LIVEKIT_URL) problems.push(`LIVEKIT_URL must be ${JSON.stringify(top.vars?.LIVEKIT_URL ?? '')}, the project the broker signs for`);
  for (const entry of workspace.secrets_store_secrets ?? []) {
    if (LIVEKIT_SECRET_NAMES.includes(entry?.secret_name)) problems.push(`${entry.binding}: the LiveKit key lives in starlings-auth only`);
  }
  for (const name of Object.keys(workspace.vars ?? {})) {
    if (LIVEKIT_SECRET_NAMES.includes(name)) problems.push(`${name}: the LiveKit key lives in starlings-auth only`);
  }
  return problems;
}

/**
 * A workspace's own Docs and Keep: `starlings-<slug>-docs` at
 * `docs-<slug>.<suffix>`, `starlings-<slug>-keep` at
 * `keep-<slug>.<suffix>`. Each is a plain fetch binding, as
 * Envisioning's are.
 */
const OWN_SERVICES = [
  { binding: 'DOCS', part: 'docs', originVar: 'DOCS_ORIGIN' },
  { binding: 'KEEP', part: 'keep', originVar: 'KEEP_ORIGIN' },
];
function isOwnServiceBinding(service, slug) {
  if (!service || typeof service !== 'object') return false;
  if (Object.keys(service).sort().join(',') !== 'binding,service') return false;
  return OWN_SERVICES.some(({ binding, part }) => service.binding === binding && service.service === `starlings-${slug}-${part}`);
}

/**
 * A workspace binds DOCS and KEEP only to its own pair, and its origin var
 * names the pair's host. An origin without its binding is refused too: the
 * Worker would then fetch that origin over the internet with the shared
 * secret's signature.
 */
function checkOwnServices(slug, vars, services, label, problems) {
  for (const { binding, part, originVar } of OWN_SERVICES) {
    const bound = (services ?? []).some((service) => service?.binding === binding);
    const origin = vars?.[originVar];
    const expected = serviceOrigin(part, slug);
    if (bound && origin !== expected) problems.push(`${label}${originVar} must be ${expected} with the ${binding} binding`);
    if (!bound && origin !== undefined) problems.push(`${label}${originVar} needs the ${binding} binding to starlings-${slug}-${part}`);
  }
}

function exactHTTPSOrigin(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; }
}
function listedOrigins(value) {
  return String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

/** The app update floor (client-version.ts, the workspace descriptor): one value for the fleet. */
const UPDATE_FLOOR_VARS = ['MIN_RECOMMENDED_VERSION_MACOS', 'MIN_RECOMMENDED_VERSION_IOS', 'MIN_RECOMMENDED_VERSION_ANDROID'];

/** `fleet.jsonc`, the fleet deploy's switch (docs/DEPLOY_STRATEGY.md). */
export const FLEET_CONFIG_URL = new URL('../fleet.jsonc', import.meta.url);
/** `services/control-plane/workspaces/`, one provisioning record per workspace (docs/PROVISIONING.md "The record"). */
export const RECORDS_URL = new URL('../services/control-plane/workspaces/', import.meta.url);
/** The script that writes a workspace's record. */
export const PROVISION_SCRIPT = 'scripts/provision-workspace.mjs';

/** The workspace's declared region (WORKSPACE_REGION); the default when it is missing or wrong, which the region part reports. */
function regionOf(workspace) {
  const region = workspace.vars?.WORKSPACE_REGION;
  return isWorkspaceRegion(region) ? region : DEFAULT_WORKSPACE_REGION;
}

/** A JSONC file, or null when it does not exist. */
function readJSONCSync(url) {
  return existsSync(url) ? JSON.parse(stripJSONComments(readFileSync(url, 'utf8'))) : null;
}

/** Every provisioning record, by slug. */
export function readRecordsSync(url = RECORDS_URL) {
  if (!existsSync(url)) return {};
  return Object.fromEntries(readdirSync(url).filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(new URL(file, url), 'utf8')))
    .map((record) => [record.slug, record]));
}

/**
 * What every workspace (`env.<slug>`) must have: the one list
 * (docs/PROVISIONING.md "What a workspace needs"). `step` is the
 * provisioning step that writes the part (`steps()` in
 * scripts/provision-workspace.mjs; a test holds every part to a real step).
 * `check(slug, workspace, fleet)` returns what is missing, as sentences.
 * `fleet` is `{ config, opsConfig, fleetConfig, records }`; an absent
 * opsConfig or fleetConfig (a self-hosted workspace has neither) skips the
 * part that reads it.
 *
 * A workspace that misses a part fails the check, so `pnpm deploy` and
 * `cf:build` stop on it. Add a part here, give provisioning a step that
 * writes it, and the test a way to remove it.
 */
export const WORKSPACE_PARTS = [
  {
    id: 'record',
    part: 'A provisioning record, services/control-plane/workspaces/<slug>.json, that names the Worker. hq, made by hand (meet#770), has none.',
    step: 'config',
    check(slug, workspace, { records }) {
      if (PLATFORM_WORKSPACE_SLUGS.has(slug)) return [];
      const record = records?.[slug];
      if (!record) return [`no record services/control-plane/workspaces/${slug}.json`];
      if (record.createdBy !== PROVISION_SCRIPT) return [`the record is not written by ${PROVISION_SCRIPT}`];
      if (record.worker?.name !== workspace.name) return [`the record names the Worker ${record.worker?.name}, not ${workspace.name}`];
      return [];
    },
  },
  {
    id: 'central-sign-in',
    part: 'Sign-in through starlings-auth: the AUTH binding and AUTH_ORIGIN (docs/CENTRAL_AUTH.md).',
    step: 'config',
    check(slug, workspace) {
      const bound = (workspace.services ?? []).some((service) => service?.binding === 'AUTH');
      return bound && workspace.vars?.AUTH_ORIGIN ? [] : ['no AUTH binding to starlings-auth with AUTH_ORIGIN'];
    },
  },
  {
    id: 'github-broker',
    part: 'The GitHub token broker: one GITHUB binding to starlings-auth\'s GithubService, props.origin its WEB_ORIGIN, and no App secret of its own (docs/GITHUB_CONNECTOR.md).',
    step: 'config',
    check(slug, workspace) {
      return githubBrokerProblems(workspace);
    },
  },
  {
    id: 'livekit-broker',
    part: 'The LiveKit token broker: one LIVEKIT binding to starlings-auth\'s LiveKitService, props.origin its WEB_ORIGIN, Envisioning\'s LIVEKIT_URL, and no LiveKit key of its own (meet#823).',
    step: 'config',
    check(slug, workspace, { config }) {
      return liveKitBrokerProblems(workspace, config);
    },
  },
  {
    id: 'region',
    part: 'One data region, WORKSPACE_REGION, from packages/contracts/src/workspace-region.ts; the record names the same region. Every store below follows it.',
    step: 'config',
    check(slug, workspace, { records }) {
      const region = workspace.vars?.WORKSPACE_REGION;
      if (!isWorkspaceRegion(region)) return [`WORKSPACE_REGION must be one of ${WORKSPACE_REGIONS.join(', ')}`];
      const record = records?.[slug];
      if (record && record.region !== region) return [`the record's region ${record.region} is not WORKSPACE_REGION ${region}`];
      return [];
    },
  },
  {
    id: 'rooms-region',
    part: 'Rooms and Quick Notes in the workspace\'s region: DO_JURISDICTION equal to it (meet#312). The Worker pins an eu workspace\'s objects to the EU jurisdiction and places a us workspace\'s with a location hint (workspace-region.ts).',
    step: 'config',
    check(slug, workspace) {
      const want = regionOf(workspace);
      return workspace.vars?.DO_JURISDICTION === want ? [] : [`DO_JURISDICTION must be ${want}, the workspace's region`];
    },
  },
  {
    id: 'buckets-region',
    part: 'Every R2 bucket in the workspace\'s region: downloads, avatars, attachments and backups (meet#1147, meet#1160). An eu bucket has the jurisdiction eu; a us bucket has none, as Cloudflare has no US jurisdiction.',
    step: 'r2',
    check(slug, workspace) {
      const want = regionPlacement(regionOf(workspace)).jurisdiction;
      return (workspace.r2_buckets ?? [])
        .filter((bucket) => (bucket.jurisdiction ?? null) !== want)
        .map((bucket) => want
          ? `R2 bucket ${bucket.bucket_name} must have jurisdiction ${want}, the workspace's region`
          : `R2 bucket ${bucket.bucket_name} must have no jurisdiction: Cloudflare has none for the workspace's region`);
    },
  },
  {
    id: 'd1-region',
    part: 'Each D1 database the record lists with a jurisdiction is in the workspace\'s region. A database made before the region field has only the location hint weur and stays so. A us database has no jurisdiction and the location hint enam.',
    step: 'd1',
    check(slug, workspace, { records }) {
      const want = regionPlacement(regionOf(workspace)).jurisdiction;
      return (records?.[slug]?.resources ?? [])
        .filter((entry) => entry.kind === 'd1' && entry.jurisdiction !== undefined && entry.jurisdiction !== want)
        .map((entry) => `D1 ${entry.name} has jurisdiction ${entry.jurisdiction}, not the workspace's region's ${want ?? 'none'}`);
    },
  },
  {
    id: 'update-floor',
    part: 'The fleet\'s app update floor: MIN_RECOMMENDED_VERSION_MACOS, _IOS and _ANDROID equal to the top level\'s (meet#1150).',
    step: 'config',
    check(slug, workspace, { config }) {
      return UPDATE_FLOOR_VARS.filter((name) => workspace.vars?.[name] !== config.vars?.[name])
        .map((name) => `${name} must be ${JSON.stringify(config.vars?.[name] ?? '')}, the top level's; the update floor is the same for every workspace`);
    },
  },
  {
    id: 'shared-secrets',
    part: 'Every shared key but LiveKit\'s bound from the Secrets Store starlings-shared as SHARED_<NAME> (WORKSPACE_SHARED_SECRET_NAMES, packages/contracts/src/shared-secrets.ts).',
    step: 'config',
    check(slug, workspace) {
      const key = (entry) => `${entry.binding}|${entry.store_id}|${entry.secret_name}`;
      // A workspace's own key (OWN_STORE_SECRET_NAMES) may sit beside the shared ones, bound under its own name.
      const entries = workspace.secrets_store_secrets ?? [];
      const own = entries.filter((entry) => OWN_STORE_SECRET_NAMES.includes(entry?.secret_name));
      const problems = own.filter((entry) => entry.binding !== entry.secret_name || entry.store_id !== SHARED_SECRETS_STORE_ID)
        .map((entry) => `${entry.binding}: a workspace's own key binds as its own name (${entry.secret_name}) from starlings-shared`);
      const want = JSON.stringify(sharedSecretBindings(WORKSPACE_SHARED_SECRET_NAMES).map(key).sort());
      const have = JSON.stringify(entries.filter((entry) => !own.includes(entry)).map(key).sort());
      if (want !== have) problems.push('secrets_store_secrets must bind every shared secret from starlings-shared but LiveKit\'s (WORKSPACE_SHARED_SECRET_NAMES, packages/contracts/src/shared-secrets.ts)');
      return problems;
    },
  },
  {
    id: 'fleet-deploy',
    part: 'The Worker in fleet.jsonc automatic, so every push to main deploys it, or in holds with a reason (meet#1149).',
    step: 'config',
    check(slug, workspace, { fleetConfig }) {
      if (!fleetConfig) return [];
      const listed = (fleetConfig.automatic ?? []).includes(workspace.name) || Object.hasOwn(fleetConfig.holds ?? {}, workspace.name);
      return listed ? [] : [`${workspace.name} is in neither automatic nor holds in fleet.jsonc, so no release reaches it`];
    },
  },
  {
    id: 'ops-console',
    part: 'Its starlings-ops bindings in wrangler.ops.jsonc: WORKSPACE_<SLUG>, and DOCS_<SLUG> and KEEP_<SLUG> with its own Docs and Keep (meet#860).',
    step: 'config',
    check(slug, workspace, { opsConfig }) {
      if (!opsConfig) return [];
      const want = [[opsBindingName(slug), workspace.name]];
      for (const { kind, binding } of OPS_SERVICE_KINDS) {
        const own = (workspace.services ?? []).find((service) => service?.binding === binding);
        if (own?.service) want.push([opsServiceBindingName(kind, slug), own.service]);
      }
      return want.filter(([binding, worker]) => !(opsConfig.services ?? []).some((service) => service?.binding === binding && service.service === worker))
        .map(([binding, worker]) => `no ${binding} binding to ${worker} in wrangler.ops.jsonc, so the ops host does not list it`);
    },
  },
];

/** Every part a workspace misses, as `env.<slug>: <sentence>`. */
export function checkWorkspaceParts(slug, workspace, fleet) {
  return WORKSPACE_PARTS.flatMap((part) => part.check(slug, workspace, fleet).map((problem) => `env.${slug}: ${problem}`));
}

/**
 * Every problem in one parsed wrangler config, as sentences. An empty list
 * means the public configuration is ready. `scripts/provision-workspace.mjs`
 * runs this on the config it will write, before it creates anything.
 * `authConfig` is wrangler.auth.jsonc, `opsConfig` wrangler.ops.jsonc,
 * `fleetConfig` fleet.jsonc and `records` the provisioning records by slug;
 * by default each is read from disk. Each workspace env is held to
 * WORKSPACE_PARTS with them.
 */
export function checkProductionConfig(config, {
  authConfig = readAuthConfigSync(),
  opsConfig = readJSONCSync(OPS_CONFIG_URL),
  fleetConfig = readJSONCSync(FLEET_CONFIG_URL),
  records = readRecordsSync(),
} = {}) {
  const problems = [];

  for (const name of REQUIRED) {
    const value = config.vars?.[name];
    if (typeof value !== 'string' || !value || value.startsWith('replace-with-')) {
      problems.push(`${name} is not configured`);
    }
  }
  if (config.vars?.ENVIRONMENT !== 'production') problems.push('ENVIRONMENT must be production');
  if (!String(config.vars?.LIVEKIT_URL ?? '').startsWith('wss://')) problems.push('LIVEKIT_URL must use wss://');
  const webOrigin = String(config.vars?.WEB_ORIGIN ?? '');
  const apiOrigin = String(config.vars?.PUBLIC_API_ORIGIN ?? '');
  // Envisioning is workspace 1 at the built-in workspace's host (ADR 0004 step 5).
  // A fork on its own domain names it as WEB_ORIGIN and routes the same host
  // as a custom domain: a stray origin still fails, because no
  // route agrees with it.
  const allowedOrigin = /^https:\/\/[a-z0-9.-]+\.workers\.dev$/;
  if (webOrigin !== PUBLIC_WEB_ORIGIN && !allowedOrigin.test(webOrigin) && !originHasCustomDomainRoute(webOrigin, config.routes)) {
    problems.push('WEB_ORIGIN must be the built-in origin, a *.workers.dev origin, or an https origin this config routes as a custom domain');
  }
  if (apiOrigin !== webOrigin) problems.push('PUBLIC_API_ORIGIN must match WEB_ORIGIN (same-origin SPA+API)');
  if (Array.isArray(config.routes) && config.routes.length > 0 && webOrigin.includes('workers.dev')
      && !customRoutesMatchAliases(config.routes, config.vars?.WORKSPACE_ORIGIN_ALIASES)) {
    problems.push('Custom routes alongside workers.dev must be exact custom domains in WORKSPACE_ORIGIN_ALIASES');
  }

  // Where a workspace keeps its records (docs/WORKSPACE_STORE.md). Stated,
  // never implied: unset reads as `core` at runtime. A D1 workspace carries no
  // Core origin and no sync, so nothing in its configuration points at
  // Envisioning's Core.
  function checkWorkStore(vars, label) {
    const workStore = vars?.WORK_STORE;
    if (workStore !== 'core' && workStore !== 'd1') problems.push(`${label}WORK_STORE must be core or d1`);
    if (workStore === 'd1') {
      for (const name of ['CORE_API_ORIGIN', 'CORE_WEB_ORIGIN']) {
        if (vars?.[name]) problems.push(`${label}${name} must be unset when WORK_STORE is d1`);
      }
      if (vars?.CRM_SYNC_MODE === 'on') problems.push(`${label}CRM_SYNC_MODE must not be on when WORK_STORE is d1`);
    }
    // The Worker has no compiled Core origin: a Core workspace names its own.
    if (workStore === 'core' && !vars?.CORE_API_ORIGIN) problems.push(`${label}CORE_API_ORIGIN must be set when WORK_STORE is core`);
    // Booking's own switch (docs/CORE_FOLD_PLAN.md §Phase 3d). The Worker
    // reads anything but the exact `d1` as Core, so a typo would leave a
    // workspace booking through Core with nobody told.
    const bookingStore = vars?.BOOKING_STORE;
    if (bookingStore !== undefined && bookingStore !== 'core' && bookingStore !== 'd1') {
      problems.push(`${label}BOOKING_STORE must be core or d1 when set`);
    }
    // The table-group switches (docs/CORE_FOLD_PLAN.md §The group
    // move). The Worker reads anything but `d1` as Core, so a typo would keep
    // a group on Core with nobody told. A group on D1 needs every group
    // before it on D1: D1's foreign keys point at the earlier groups' tables.
    let coreBefore = null;
    for (const group of WORK_GROUPS) {
      const name = WORK_GROUP_VARS[group];
      const value = vars?.[name];
      if (value === undefined) {
        coreBefore ??= name;
        continue;
      }
      if (value !== 'core' && value !== 'd1') problems.push(`${label}${name} must be core or d1 when set`);
      if (workStore === 'd1') problems.push(`${label}${name} must be unset when WORK_STORE is d1`);
      if (value === 'd1' && coreBefore) problems.push(`${label}${name} is d1 while ${coreBefore} is not: the groups move in order`);
      if (value !== 'd1') coreBefore ??= name;
    }
  }
  checkWorkStore(config.vars, '');
  // Rooms and Quick Notes: `legacy` until Envisioning's objects move, or `eu`.
  if (!['legacy', 'eu'].includes(config.vars?.DO_JURISDICTION)) problems.push('DO_JURISDICTION must be legacy or eu');

  // A workspace accent must carry readable text on its own fill;
  // the Worker would otherwise drop it silently and draw the default.
  function checkAccent(vars, label) {
    const accent = vars?.WORKSPACE_ACCENT;
    if (accent && !accentPalette(accent)) {
      problems.push(`${label}WORKSPACE_ACCENT must be #rrggbb with readable text on it (contrast 4.5)`);
    }
  }
  checkAccent(config.vars, '');

  // Where the workspace's mail and calendar live. Absent is google.
  function checkSuite(vars, label) {
    const suite = vars?.WORKSPACE_SUITE;
    if (suite !== undefined && !WORKSPACE_SUITES.includes(suite)) {
      problems.push(`${label}WORKSPACE_SUITE must be one of ${WORKSPACE_SUITES.join(', ')}`);
    }
  }
  checkSuite(config.vars, '');

  // Who can join, as signup chose it (docs/ONBOARDING.md). Absent is no recorded choice.
  function checkMembership(vars, label) {
    const membership = vars?.WORKSPACE_MEMBERSHIP;
    if (membership !== undefined && membership !== 'domains' && membership !== 'invite') {
      problems.push(`${label}WORKSPACE_MEMBERSHIP must be domains or invite`);
    }
  }
  checkMembership(config.vars, '');

  // Who signs in by address (docs/ACCESS.md slice 3). Each entry must be a
  // domain, or the Worker drops it and admits nobody on it; SIGN_IN_DOMAIN,
  // the account chooser's filter, must be one of them.
  function checkIdentityDomains(vars, label) {
    const raw = String(vars?.IDENTITY_DOMAINS ?? '');
    const entries = raw.split(',').map((part) => part.trim()).filter(Boolean);
    const domains = parseIdentityDomains(raw);
    if (domains.length === 0) problems.push(`${label}IDENTITY_DOMAINS must name at least one domain`);
    else if (domains.length !== entries.length) problems.push(`${label}IDENTITY_DOMAINS has an entry that is not a domain`);
    const signIn = String(vars?.SIGN_IN_DOMAIN ?? '').trim().toLowerCase();
    if (!domains.includes(signIn)) problems.push(`${label}SIGN_IN_DOMAIN must be one of IDENTITY_DOMAINS`);
  }
  checkIdentityDomains(config.vars, '');

  // Rooms come from the workspace's D1 first; OWNER_ROOM_MAP is a
  // read fallback. A D1 workspace may leave it `{}`: its members get their
  // rooms at sign-in or when they accept an invitation. A Core workspace
  // (Envisioning) still names its rooms here.
  function checkRoomMap(vars, label) {
    try {
      const rooms = JSON.parse(vars?.OWNER_ROOM_MAP ?? 'null');
      if (!rooms || typeof rooms !== 'object' || Array.isArray(rooms)) problems.push(`${label}OWNER_ROOM_MAP must be a JSON object`);
      else if (Object.keys(rooms).length === 0 && vars?.WORK_STORE !== 'd1') problems.push(`${label}OWNER_ROOM_MAP is empty`);
    } catch {
      problems.push(`${label}OWNER_ROOM_MAP is invalid JSON`);
    }
  }
  checkRoomMap(config.vars, '');

  // Central sign-in (docs/CENTRAL_AUTH.md). The auth
  // Worker is starlings-auth on its own D1. A workspace reaches it only
  // through one service binding, AUTH, to its AuthService entrypoint.
  const authOrigin = String(authConfig?.vars?.AUTH_ORIGIN ?? '');
  function checkCentralAuth(vars, services, routes, label) {
    const bound = (services ?? []).filter((service) => service?.binding === 'AUTH');
    if (bound.some((service) => !isAuthBinding(service))) {
      problems.push(`${label}AUTH must bind service starlings-auth, entrypoint AuthService, props { origin }, and nothing else`);
    }
    // The fixed origin: starlings-auth trusts these props, not the caller.
    for (const service of bound) {
      const fixed = service?.props?.origin;
      if (fixed !== vars?.WEB_ORIGIN) problems.push(`${label}AUTH props.origin must be the workspace's WEB_ORIGIN (${vars?.WEB_ORIGIN})`);
      else if (authConfig && !isWorkspaceHostOrigin(fixed) && !listedOrigins(authConfig.vars?.RETURN_ORIGIN_ALIASES).includes(fixed)) {
        problems.push(`${label}AUTH props.origin ${fixed} is not <slug>.${WORKSPACE_HOST_SUFFIX} and not in the auth Worker's RETURN_ORIGIN_ALIASES`);
      }
    }
    if (authOrigin && (routes ?? []).some((route) => `https://${route?.pattern}` === authOrigin)) problems.push(`${label}a workspace must not route ${authOrigin}; starlings-auth serves it`);
    const origin = vars?.AUTH_ORIGIN;
    if (!origin) {
      if (bound.length > 0) problems.push(`${label}an AUTH binding needs AUTH_ORIGIN`);
      return;
    }
    if (!authConfig) {
      problems.push(`${label}AUTH_ORIGIN needs services/control-plane/wrangler.auth.jsonc`);
      return;
    }
    if (bound.length !== 1) problems.push(`${label}AUTH_ORIGIN needs exactly one AUTH service binding to starlings-auth`);
    if (origin !== authOrigin) problems.push(`${label}AUTH_ORIGIN must be the auth Worker's AUTH_ORIGIN (${authOrigin})`);
    if ([vars?.WEB_ORIGIN, vars?.PUBLIC_API_ORIGIN, ...listedOrigins(vars?.WORKSPACE_ORIGIN_ALIASES)].includes(origin)) {
      problems.push(`${label}AUTH_ORIGIN must be separate from the workspace's own origins`);
    }
    // A workspace exchanges a consent code with its own client, so the clients match.
    if (vars?.GOOGLE_WEB_CLIENT_ID !== authConfig.vars?.GOOGLE_WEB_CLIENT_ID) problems.push(`${label}GOOGLE_WEB_CLIENT_ID must match the auth Worker's`);
    // The auth Worker asks for calendar consent with its calendar client; the
    // workspace exchanges and refreshes the code with its own, so they match.
    if ((vars?.GOOGLE_CALENDAR_CLIENT_ID ?? '') !== (authConfig.vars?.GOOGLE_CALENDAR_CLIENT_ID ?? '')) {
      problems.push(`${label}GOOGLE_CALENDAR_CLIENT_ID must match the auth Worker's`);
    }
    if (vars?.GOOGLE_CONNECTOR_CLIENT_ID && vars.GOOGLE_CONNECTOR_CLIENT_ID !== authConfig.vars?.GOOGLE_CONNECTOR_CLIENT_ID) {
      problems.push(`${label}GOOGLE_CONNECTOR_CLIENT_ID must match the auth Worker's`);
    }
  }
  checkCentralAuth(config.vars, config.services, config.routes, '');
  problems.push(...githubBrokerProblems(config));
  // A shared D1 between the auth Worker and a workspace is a problem below.
  const authDatabaseId = authConfig?.d1_databases?.[0]?.database_id;

  // The first workspace that binds each resource. A second workspace that
  // binds the same resource is a problem that names both.
  const owners = new Map();
  function claimResources(workspace, label) {
    for (const [kind, values] of Object.entries(workspaceResources(workspace))) {
      for (const value of new Set(values.filter(Boolean))) {
        const key = `${kind}\u0000${value}`;
        if (!owners.has(key)) {
          owners.set(key, label);
          continue;
        }
        const first = owners.get(key) ? owners.get(key).slice(0, -2) : 'the top-level workspace';
        problems.push(`${label}shares the ${kind} ${value} with ${first}`);
      }
    }
  }
  claimResources(config, '');

  // A workspace environment (`--env <slug>`) is a D1 workspace at
  // <slug>.<suffix> with its own resources and the same required values.
  // Its resources exist before its config lands, so no id is a placeholder.
  for (const [slug, workspace] of Object.entries(config.env ?? {})) {
    const label = `env.${slug}: `;
    const checked = checkWorkspaceSlug(slug);
    if (!checked.ok || checked.slug !== slug) problems.push(`${label}the name is not a workspace slug (${checked.ok ? 'not lowercase' : checked.reason})`);
    for (const name of REQUIRED) {
      const value = workspace.vars?.[name];
      if (typeof value !== 'string' || !value) problems.push(`${label}${name} is not configured`);
    }
    if (workspace.vars?.WORK_STORE !== 'd1') problems.push(`${label}WORK_STORE must be d1`);
    // An unnamed workspace would call itself Envisioning, the fixed profile.
    if (!String(workspace.vars?.WORKSPACE_NAME ?? '').trim()) problems.push(`${label}WORKSPACE_NAME is not configured`);
    // Every part a workspace needs (WORKSPACE_PARTS, docs/PROVISIONING.md).
    problems.push(...checkWorkspaceParts(slug, workspace, { config, opsConfig, fleetConfig, records }));
    checkWorkStore(workspace.vars, label);
    checkAccent(workspace.vars, label);
    checkSuite(workspace.vars, label);
    checkMembership(workspace.vars, label);
    checkIdentityDomains(workspace.vars, label);
    checkRoomMap(workspace.vars, label);
    const origin = workspaceOrigin(slug);
    if (workspace.vars?.WEB_ORIGIN !== origin) problems.push(`${label}WEB_ORIGIN must be ${origin}`);
    if (workspace.vars?.PUBLIC_API_ORIGIN !== origin) problems.push(`${label}PUBLIC_API_ORIGIN must be ${origin}`);
    // A workspace holds AUTH and GITHUB (starlings-auth keeps no workspace
    // data) and its own Docs and Keep. Any other binding could
    // reach Envisioning's Docs and Keep or another workspace's.
    if ((workspace.services ?? []).some((service) => !isAuthBinding(service) && !isGithubBinding(service) && !isLiveKitBinding(service) && !isOwnServiceBinding(service, slug))) {
      problems.push(`${label}service bindings other than AUTH, GITHUB, LIVEKIT and its own Docs and Keep (starlings-${slug}-docs, starlings-${slug}-keep) are refused`);
    }
    checkOwnServices(slug, workspace.vars, workspace.services, label, problems);
    checkCentralAuth(workspace.vars, workspace.services, workspace.routes, label);
    const ids = [...(workspace.kv_namespaces ?? []).map((kv) => kv.id), ...(workspace.d1_databases ?? []).map((db) => db.database_id)];
    if (ids.some((id) => !id || String(id).startsWith('replace-with-'))) problems.push(`${label}a KV or D1 id is not filled in`);
    claimResources(workspace, label);
  }
  if (authDatabaseId) {
    const workspaceIds = [config, ...Object.values(config.env ?? {})].flatMap((workspace) => (workspace.d1_databases ?? []).map((db) => db.database_id));
    if (workspaceIds.includes(authDatabaseId)) problems.push('wrangler.auth.jsonc: shares a D1 database with a workspace');
  }

  return problems;
}

/**
 * The auth Worker itself (wrangler.auth.jsonc): one host, one D1, no other
 * binding. `pending` holds a placeholder D1 id when `allowPending` is set
 * (verify:fast); a deploy runs without it and refuses the placeholder.
 */
export function checkAuthConfig(authConfig, { allowPending = false } = {}) {
  const problems = [];
  const pending = [];
  const label = 'wrangler.auth.jsonc: ';
  const vars = authConfig.vars ?? {};
  const authOrigin = String(vars.AUTH_ORIGIN ?? '');
  if (authConfig.name !== 'starlings-auth') problems.push(`${label}name must be starlings-auth`);
  if (authConfig.main !== 'src/auth-worker/index.ts') problems.push(`${label}main must be src/auth-worker/index.ts`);
  if (authConfig.workers_dev !== false) problems.push(`${label}workers_dev must be false; the Worker serves its custom domain only`);
  if (vars.ENVIRONMENT !== 'production') problems.push(`${label}ENVIRONMENT must be production`);
  if (!exactHTTPSOrigin(authOrigin) || !authOrigin.endsWith(`.${WORKSPACE_HOST_SUFFIX}`)) problems.push(`${label}AUTH_ORIGIN must be an exact HTTPS origin on ${WORKSPACE_HOST_SUFFIX}`);
  const routes = authConfig.routes ?? [];
  if (routes.length !== 1 || routes[0]?.custom_domain !== true || `https://${routes[0]?.pattern}` !== authOrigin) {
    problems.push(`${label}routes must be exactly the custom domain of AUTH_ORIGIN`);
  }
  const clientID = vars.GOOGLE_WEB_CLIENT_ID;
  if (typeof clientID !== 'string' || !clientID || clientID.startsWith('replace-with-')) problems.push(`${label}GOOGLE_WEB_CLIENT_ID is not configured`);
  for (const alias of listedOrigins(vars.RETURN_ORIGIN_ALIASES)) {
    if (!exactHTTPSOrigin(alias) || alias === authOrigin) problems.push(`${label}RETURN_ORIGIN_ALIASES holds ${alias}, which is not a separate exact HTTPS origin`);
  }
  for (const key of ['services', 'kv_namespaces', 'r2_buckets', 'queues', 'durable_objects', 'assets', 'ai', 'vectorize',
    'hyperdrive', 'analytics_engine_datasets', 'send_email', 'browser', 'workflows', 'env']) {
    const value = authConfig[key];
    if (value && (!Array.isArray(value) || value.length > 0) && (typeof value !== 'object' || Object.keys(value).length > 0)) {
      problems.push(`${label}${key} is not allowed; the auth Worker holds sign-in attempts and signup and nothing else`);
    }
  }
  const databases = authConfig.d1_databases ?? [];
  const db = databases[0];
  if (databases.length !== 1 || db?.binding !== 'AUTH_DB' || db.database_name !== 'starlings-auth' || db.migrations_dir !== './auth-migrations') {
    problems.push(`${label}d1_databases must be exactly AUTH_DB on starlings-auth with ./auth-migrations`);
  }
  const id = String(db?.database_id ?? '');
  if (!id || id.startsWith('replace-with-')) {
    (allowPending ? pending : problems).push(`${label}the starlings-auth D1 id is not filled in (wrangler d1 create starlings-auth)`);
  }
  return { problems, pending };
}

/** `services/control-plane/wrangler.ops.jsonc`, the operator console's Worker config. */
export const OPS_CONFIG_URL = new URL('../services/control-plane/wrangler.ops.jsonc', import.meta.url);

/** The slug of a workspace's first `https://<slug>.<suffix>` origin, or null. */
function workspaceSlugOf(vars) {
  const origins = [vars?.WEB_ORIGIN, ...String(vars?.WORKSPACE_ORIGIN_ALIASES ?? '').split(',')];
  for (const origin of origins) {
    const value = String(origin ?? '').trim();
    if (!value.startsWith('https://')) continue;
    const parsed = parseWorkspaceAddress(value);
    if (parsed.ok) return parsed.slug;
  }
  return null;
}

/**
 * The operator console (docs/OPS_CONSOLE.md): starlings-ops on one
 * host, with no storage, and only OpsService bindings to workspaces in
 * wrangler.jsonc. `pending` lists what is allowed before the first deploy:
 * an empty Access team domain or AUD tag, and a workspace with no binding
 * yet (a workspace provisioned after the console). `requireOps` (deploy:ops)
 * moves `pending` into `problems`.
 */
export function checkOpsConfig(config, opsConfig, { requireOps = false } = {}) {
  const problems = [];
  const pending = [];
  const later = requireOps ? problems : pending;
  const label = 'wrangler.ops.jsonc: ';
  const vars = opsConfig.vars ?? {};
  const opsHost = `ops.${WORKSPACE_HOST_SUFFIX}`;
  if (opsConfig.name !== 'starlings-ops') problems.push(`${label}name must be starlings-ops`);
  if (opsConfig.main !== 'src/ops-worker/index.ts') problems.push(`${label}main must be src/ops-worker/index.ts`);
  if (opsConfig.account_id !== config.account_id) problems.push(`${label}account_id must be the workspaces' account`);
  if (opsConfig.workers_dev !== false) problems.push(`${label}workers_dev must be false; the Worker serves its custom domain only`);
  if (vars.ENVIRONMENT !== 'production') problems.push(`${label}ENVIRONMENT must be production`);
  const routes = opsConfig.routes ?? [];
  if (routes.length !== 1 || routes[0]?.custom_domain !== true || routes[0]?.pattern !== opsHost) {
    problems.push(`${label}routes must be exactly the custom domain ${opsHost}`);
  }
  // The dashboard's files: one directory, served only after the Worker's Access check.
  const assets = opsConfig.assets;
  if (!assets || assets.directory !== '../../web/ops/dist' || assets.binding !== 'ASSETS' || assets.run_worker_first !== true
    || Object.keys(assets).length !== 3) {
    problems.push(`${label}assets must be exactly { directory: ../../web/ops/dist, binding: ASSETS, run_worker_first: true }`);
  }
  for (const key of ['d1_databases', 'kv_namespaces', 'r2_buckets', 'queues', 'durable_objects', 'ai', 'vectorize',
    'hyperdrive', 'analytics_engine_datasets', 'send_email', 'browser', 'workflows', 'triggers', 'migrations', 'env']) {
    const value = opsConfig[key];
    if (value && (!Array.isArray(value) || value.length > 0) && (typeof value !== 'object' || Object.keys(value).length > 0)) {
      problems.push(`${label}${key} is not allowed; the console keeps no data`);
    }
  }
  const allowedVars = new Set(['ENVIRONMENT', 'OPS_ACCESS_TEAM_DOMAIN', 'OPS_ACCESS_AUD', 'OPS_OPERATORS']);
  for (const name of Object.keys(vars)) {
    if (!allowedVars.has(name)) problems.push(`${label}var ${name} is not allowed`);
  }

  // Access: filled by hand. Empty is pending; malformed is wrong.
  const team = String(vars.OPS_ACCESS_TEAM_DOMAIN ?? '').trim();
  const aud = String(vars.OPS_ACCESS_AUD ?? '').trim();
  if (!team) later.push(`${label}OPS_ACCESS_TEAM_DOMAIN is empty (the Access team, <team>.cloudflareaccess.com)`);
  else if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u.test(team)) problems.push(`${label}OPS_ACCESS_TEAM_DOMAIN must be <team>.cloudflareaccess.com`);
  if (!aud) later.push(`${label}OPS_ACCESS_AUD is empty (the AUD tag of the Access application for ${opsHost})`);
  else if (!/^[a-f0-9]{64}$/u.test(aud)) problems.push(`${label}OPS_ACCESS_AUD must be the 64-character AUD tag`);
  const operators = String(vars.OPS_OPERATORS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (operators.length === 0) problems.push(`${label}OPS_OPERATORS must name at least one operator`);
  for (const operator of operators) {
    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/u.test(operator)) problems.push(`${label}OPS_OPERATORS holds ${operator}, which is not an address`);
  }

  // One OpsService binding per workspace: the top level is named by its
  // the workspace domain origin, each env.<slug> by its key.
  const workspaces = [{ label: 'the top level', worker: config.name, slug: workspaceSlugOf(config.vars), routes: config.routes, services: config.services }];
  for (const [slug, workspace] of Object.entries(config.env ?? {})) {
    workspaces.push({ label: `env.${slug}`, worker: workspace.name, slug, routes: workspace.routes, services: workspace.services });
  }
  const expected = new Map();
  for (const workspace of workspaces) {
    if ((workspace.routes ?? []).some((route) => route?.pattern === opsHost)) problems.push(`${label}${workspace.label} must not route ${opsHost}`);
    if (!workspace.slug) { problems.push(`${label}${workspace.label} has no <slug>.${WORKSPACE_HOST_SUFFIX} origin, so the console cannot name it`); continue; }
    if (!workspace.worker) { problems.push(`${label}${workspace.label} has no Worker name`); continue; }
    expected.set(opsBindingName(workspace.slug), workspace.worker);
    // Its own Docs and Keep: the Worker its DOCS or KEEP binding names.
    for (const { kind, binding } of OPS_SERVICE_KINDS) {
      const own = (workspace.services ?? []).find((service) => service?.binding === binding);
      if (own?.service) expected.set(opsServiceBindingName(kind, workspace.slug), own.service);
    }
  }
  const seen = new Set();
  for (const service of opsConfig.services ?? []) {
    const binding = service?.binding;
    // The Requests page (docs/ONBOARDING.md): one binding to starlings-auth's
    // SignupAdminService, and nothing else of that Worker.
    if (binding === 'SIGNUP_ADMIN') {
      const exact = Object.keys(service).length === 3 && service.service === 'starlings-auth' && service.entrypoint === 'SignupAdminService';
      if (!exact) problems.push(`${label}SIGNUP_ADMIN must bind service starlings-auth, entrypoint SignupAdminService, and nothing else`);
      if (seen.has(binding)) problems.push(`${label}${binding} is bound twice`);
      seen.add(binding);
      continue;
    }
    // hq's interest requests for the Requests page: one binding
    // to hq's InterestService, which returns names and addresses, so no
    // other workspace is bound to it.
    if (binding === 'HQ_INTERESTS') {
      const exact = Object.keys(service).length === 3 && service.service === 'starlings-hq' && service.entrypoint === 'InterestService';
      if (!exact) problems.push(`${label}HQ_INTERESTS must bind service starlings-hq, entrypoint InterestService, and nothing else`);
      if (seen.has(binding)) problems.push(`${label}${binding} is bound twice`);
      seen.add(binding);
      continue;
    }
    const worker = expected.get(binding);
    const exact = service && typeof service === 'object' && Object.keys(service).length === 3
      && service.service === worker && service.entrypoint === OPS_ENTRYPOINT;
    if (!worker) problems.push(`${label}service binding ${binding} reaches no workspace, Docs or Keep in wrangler.jsonc`);
    else if (!exact) problems.push(`${label}${binding} must bind service ${worker}, entrypoint ${OPS_ENTRYPOINT}, and nothing else`);
    if (seen.has(binding)) problems.push(`${label}${binding} is bound twice`);
    seen.add(binding);
  }
  // A workspace env's own bindings are a part it needs (WORKSPACE_PARTS
  // ops-console), refused in checkProductionConfig; the top level's stay pending.
  const envBindings = new Set(workspaces.slice(1).flatMap((workspace) => [opsBindingName(workspace.slug),
    ...OPS_SERVICE_KINDS.map(({ kind }) => opsServiceBindingName(kind, workspace.slug))]));
  for (const [binding, worker] of expected) {
    if (!seen.has(binding) && !envBindings.has(binding)) later.push(`${label}no ${binding} binding for the Worker ${worker}, so the console does not list it`);
  }
  return { problems, pending };
}

async function main() {
  const config = await readWranglerConfig();
  const authConfig = readAuthConfigSync();
  // The operator console runs a fleet; a single self-hosted workspace has no
  // wrangler.ops.jsonc. `--require-ops` (deploy:ops) still needs the file.
  const requireOps = process.argv.includes('--require-ops');
  const ops = existsSync(OPS_CONFIG_URL)
    ? checkOpsConfig(config, await readWranglerConfig(OPS_CONFIG_URL), { requireOps })
    : { problems: requireOps ? ['services/control-plane/wrangler.ops.jsonc does not exist'] : [], pending: [] };
  // `--allow-pending-auth` (verify:fast only): the auth Worker's D1 id may
  // still be a placeholder, reported as pending. A deploy refuses it.
  const auth = authConfig ? checkAuthConfig(authConfig, { allowPending: process.argv.includes('--allow-pending-auth') }) : { problems: [], pending: [] };
  const problems = [...checkProductionConfig(config, { authConfig }), ...ops.problems, ...auth.problems];
  if (ops.pending.length > 0) console.warn(`Pending before the first starlings-ops deploy:\n- ${ops.pending.join('\n- ')}`);
  if (auth.pending.length > 0) console.warn(`Pending before the first starlings-auth deploy:\n- ${auth.pending.join('\n- ')}`);
  if (problems.length > 0) {
    console.error(`Production configuration is incomplete:\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log('Production public configuration is ready. Wrangler secrets are checked separately.');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

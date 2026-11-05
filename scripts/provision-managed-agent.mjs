#!/usr/bin/env node
// Operator-side installer. Bootstrap/agent keys live in memory and the two
// managed services only. CLI responses and provider errors are never printed.
import './node-ts-resolve.mjs';
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const { MANAGED_AGENT_REPIN_STEPS, managedAgentBootstrapResponseSchema } = await import('../packages/contracts/src/managed-agent.ts');
const REPIN_STEPS = new Set(MANAGED_AGENT_REPIN_STEPS);
import { stripJSONComments } from './check-production-config.mjs';
import { freshHostFetch } from './fresh-host-fetch.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
/** The Vercel team every managed agent's project lives in. */
export const TEAM = 'ev-io';
const DOOR = '/api/internal/managed-agent/provision';
const WRANGLER = ['--filter', '@starlings/control-plane', 'exec', 'wrangler'];
function execute(command, args, input) {
  const res = spawnSync(command, args, { cwd: REPO, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 180_000 });
  if (res.status !== 0) throw new Error(`managed installer command failed: ${command} ${args[0]} (exit ${res.status})`);
  return res.stdout;
}
function provider(path, body, method = body ? 'POST' : 'GET') {
  const raw = execute('vercel', ['api', path, '--scope', TEAM, '--raw', '-X', method, ...(body ? ['--input', '-'] : []), ...(method === 'DELETE' ? ['--dangerously-skip-permissions'] : [])], body ? JSON.stringify(body) : undefined);
  return raw.trim() ? JSON.parse(raw) : null;
}
async function boundedJSON(response) {
  let text = '', length = 0; const decoder = new TextDecoder(); const reader = response.body?.getReader();
  if (!reader) throw new Error('empty managed response');
  try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength;
    if (length > 64_000) throw new Error('managed response too large'); text += decoder.decode(part.value, { stream: true }); } }
  finally { await reader.cancel(); }
  return JSON.parse(text + decoder.decode());
}
// macOS keeps the shared /private/tmp; other hosts (Linux) use their own temp dir.
export function installerLockPath(slug) {
  const dir = process.platform === 'darwin' ? '/private/tmp' : tmpdir();
  return `${dir}/starlings-managed-agent-${slug}.lock`;
}
function installerLock(slug) {
  const path = installerLockPath(slug);
  for (let attempt = 0; attempt < 2; attempt++) {
    try { mkdirSync(path, { mode: 0o700 }); writeFileSync(path + '/pid', String(process.pid), { mode: 0o600 }); return path; }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt !== 0) throw error;
      let pid;
      try { pid = Number(readFileSync(path + '/pid', 'utf8')); } catch { throw new Error('managed installer lock requires operator reconciliation'); }
      if (!Number.isInteger(pid) || pid <= 1) throw new Error('invalid managed installer lock');
      try { process.kill(pid, 0); throw new Error('another managed installer is running for this workspace'); }
      catch (live) { if (live.code !== 'ESRCH') throw live; }
      // A crashed process holds no bootstrap lease; resume its durable D1/project records.
      rmSync(path, { recursive: true });
    }
  }
  throw new Error('managed installer lock unavailable');
}
export function installationPlan(installationId) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(installationId)) throw new Error('invalid installation id');
  const name = `starlings-meeting-${installationId.replaceAll('-', '')}`;
  return { name, origin: `https://${name}.vercel.app`, rootDirectory: 'agents/steward', repository: 'envisioning/bots' };
}
/** Secret changes deploy asynchronously. Retry only the idempotent bootstrap begin during propagation. */
export function managedBootstrapTransport(origin, bootstrap, { request = freshHostFetch, pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  return async (body) => {
    for (let attempt = 0; attempt < 15; attempt++) {
      const raw = JSON.stringify(body), stamp = String(Date.now());
      const response = await request(origin + DOOR, { method: 'POST', redirect: 'error', body: raw,
        headers: { 'content-type': 'application/json', 'x-internal-timestamp': stamp,
          'x-internal-signature': createHmac('sha256', bootstrap).update(`${stamp}.managed-agent.POST.${DOOR}.${raw}`).digest('hex') },
        signal: AbortSignal.timeout(30_000) });
      if (response.ok) return managedAgentBootstrapResponseSchema.parse(await boundedJSON(response));
      await response.body?.cancel();
      if (body.action !== 'begin' || ![404, 503].includes(response.status) || attempt === 14) throw new Error(`managed bootstrap refused (${response.status})`);
      await pause(1000);
    }
  };
}
export async function provisionManagedAgent({ slug, owner, origin, apply = false, offboard = false, onProgress = () => {}, transport, cloud = provider, command = execute, log = console.log }) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(slug) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner)) throw new Error('workspace slug and first admin required');
  const config = JSON.parse(stripJSONComments(readFileSync(`${REPO}/services/control-plane/wrangler.jsonc`, 'utf8')));
  const workspace = slug === 'envisioning' ? config : config.env?.[slug];
  origin ??= workspace?.vars.PUBLIC_API_ORIGIN || workspace?.vars.WEB_ORIGIN;
  if (!origin || new URL(origin).protocol !== 'https:') throw new Error('workspace origin required');
  if (!apply) {
    console.log(offboard
      ? `Remove managed agent for ${slug}: revoke its keys, erase only its tracked isolated runtime, acknowledge erasure. Dry run changes nothing.`
      : `Install managed agent for ${slug}: reserve one Steward identity, create its isolated Eve project, configure sealed keys, deploy committed Bots main, prove signed synthetic callback and hosted payload expiry. Wait for the actual admin to sign in. Dry run allocates nothing.`);
    return null;
  }
  const bootstrap = randomBytes(32).toString('hex');
  const envArgs = slug === 'envisioning' ? [] : ['--env', slug];
  const call = transport ?? managedBootstrapTransport(origin, bootstrap);
  let failedStep = offboard ? 'runtime_erasure' : 'runtime_create', id;
  const lock = installerLock(slug); // Never rotate another live installer's bootstrap key.
  try {
    // An uncertain CLI acknowledgement still needs bootstrap cleanup.
    command('pnpm', [...WRANGLER, 'secret', 'put', 'MANAGED_AGENT_PROVISIONING_KEY', ...envArgs], bootstrap);
    const reserved = await call({ action: 'begin', accountable_email: owner });
    const state = reserved.readiness; id = state.installation.id;
    onProgress(state);
    if (offboard) await call({ action: 'offboard', installation_id: id });
    else if (['removed', 'frozen', 'paused'].includes(state.installation.state)) return state;
    const plan = installationPlan(id);
    let project;
    if (state.runtime_project_id && !offboard) project = cloud(`/v9/projects/${state.runtime_project_id}`);
    else {
      // Lookup by deterministic name recovers a crash after project creation.
      let cursor;
      for (let page = 0; page < 10; page++) {
        const listed = cloud(`/v9/projects?search=${encodeURIComponent(plan.name)}&limit=100${cursor ? `&until=${encodeURIComponent(cursor)}` : ''}`);
        project = listed.projects?.find((p) => p.name === plan.name);
        if (project || !listed.pagination?.next) break;
        if (page === 9 || cursor === listed.pagination.next) throw new Error('managed project lookup incomplete');
        cursor = listed.pagination.next;
      }
      if (!project && !offboard) project = cloud('/v11/projects', { name: plan.name, framework: 'eve', rootDirectory: plan.rootDirectory,
        outputDirectory: '.vercel/output', ssoProtection: null, gitRepository: { type: 'github', repo: plan.repository } });
    }
    if (offboard && !project) {
      await call({ action: 'erased', installation_id: id, ...(state.runtime_project_id ? { project_id: state.runtime_project_id } : {}) });
      return (await call({ action: 'status', installation_id: id })).readiness;
    }
    if ((state.runtime_project_id && state.runtime_project_id !== project.id) || !project.id || project.name !== plan.name || project.rootDirectory !== plan.rootDirectory
      || project.link?.type !== 'github' || project.link.org !== 'envisioning' || project.link.repo !== 'bots') throw new Error('managed runtime ownership differs');
    if (offboard) {
      // Revocation precedes resource erasure; provider failures leave the tracked erasure request pending.
      await call({ action: 'offboard', installation_id: id, project_id: project.id });
      cloud(`/v9/projects/${project.id}`, undefined, 'DELETE');
      await call({ action: 'erased', installation_id: id, project_id: project.id });
      return (await call({ action: 'status', installation_id: id })).readiness;
    }
    // Persist the project before configuring keys, so crashes always leave a resource to reconcile/erase.
    // A pinned commit stays pinned, except after a deploy that failed before
    // verification: then main is pinned again, or a cancelled first build
    // would be redeployed on every rerun.
    const repin = Boolean(state.runtime_version) && !state.verified_at && state.stage === 'failed' && REPIN_STEPS.has(state.failed_step);
    const pinned = repin ? null : state.runtime_version;
    const revision = JSON.parse(command('gh', ['api', `repos/envisioning/bots/commits/${pinned ?? 'main'}`])).sha;
    const version = pinned ?? revision.slice(0, 7);
    if (!state.verified_at) {
      log(repin ? `Deploying envisioning/bots ${version} (main): re-pinned from ${state.runtime_version}, because the last attempt failed at ${state.failed_step}.`
        : pinned ? `Deploying envisioning/bots ${version}: the pinned commit.` : `Deploying envisioning/bots ${version} (main), pinned from now on.`);
    }
    await call({ action: 'bind', installation_id: id, project_id: project.id, runtime_origin: plan.origin, runtime_version: version, ...(repin ? { repin: true } : {}) });
    failedStep = 'runtime_configure';
    if (!state.verified_at) {
      if (!reserved.webhook_key || !reserved.inbound_key) throw new Error('managed installation keys unavailable');
      const values = { AGENT_WEBHOOK_KEY: reserved.webhook_key, INTERNAL_INBOUND_KEY: reserved.inbound_key,
        MEET_API_ORIGIN: origin, MEET_WORKSPACE_ID: state.installation.workspace_id, MEET_INSTALLATION_ID: id,
        MEET_AGENT_SUB: state.installation.agent_sub, MEET_AGENT_EMAIL: state.installation.agent_email };
      // Vercel CLI 59 api serializes object input, but sends array input as [object Object].
      // One encrypted upsert per key keeps stdin-only secrets and resumes partial configuration.
      for (const [key, value] of Object.entries(values)) cloud(`/v10/projects/${project.id}/env?upsert=true`, { key, value, type: 'encrypted', target: ['production'] });
      failedStep = 'runtime_deploy';
      // A Git-backed committed deployment, never an upload of this checkout.
      const deploy = cloud('/v13/deployments', { name: plan.name, project: project.id, target: 'production',
        projectSettings: { framework: 'eve', rootDirectory: plan.rootDirectory, outputDirectory: '.vercel/output', nodeVersion: '24.x', sourceFilesOutsideRootDirectory: true },
        gitSource: { type: 'github', org: 'envisioning', repo: 'bots', ref: 'main', sha: revision } });
      if (!deploy.id) throw new Error('managed deployment id missing');
      for (let n = 0; n < 120; n++) {
        const deployed = cloud(`/v13/deployments/${deploy.id}`);
        if (deployed.readyState === 'READY') break;
        if (['ERROR', 'CANCELED'].includes(deployed.readyState) || n === 119) throw new Error('managed runtime deployment failed');
        await new Promise((r) => setTimeout(r, 1000));
      }
      // Vercel truncates the automatic project alias; bind the exact installation origin.
      const alias = cloud(`/v2/deployments/${deploy.id}/aliases`, { alias: new URL(plan.origin).hostname });
      if (alias?.alias !== new URL(plan.origin).hostname) throw new Error('managed runtime alias differs');
    }
    failedStep = 'runtime_verify';
    for (let n = 0; n < 120; n++) {
      const checked = await call({ action: 'verify', installation_id: id });
      onProgress(checked.readiness);
      if (checked.readiness.verified_at) return checked.readiness;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('managed runtime verification did not finish');
  } catch (error) {
    if (id) { try { await call({ action: 'failed', installation_id: id, failed_step: failedStep }); } catch {} }
    throw error;
  } finally {
    try { command('pnpm', [...WRANGLER, 'secret', 'delete', 'MANAGED_AGENT_PROVISIONING_KEY', ...envArgs]); }
    finally { rmSync(lock, { recursive: true }); }
  }
}
async function main() {
  const args = process.argv.slice(2); const slug = args[0];
  const owner = args[args.indexOf('--owner') + 1];
  if (!slug || !args.includes('--owner')) throw new Error('Usage: node scripts/provision-managed-agent.mjs <slug> --owner <workspace admin email> [--apply] [--offboard]');
  await provisionManagedAgent({ slug, owner, apply: args.includes('--apply'), offboard: args.includes('--offboard'), onProgress: (state) =>
    console.log(JSON.stringify({ installation_id: state.installation.id, stage: state.stage, runtime_project_id: state.runtime_project_id, failed_step: state.failed_step })) });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

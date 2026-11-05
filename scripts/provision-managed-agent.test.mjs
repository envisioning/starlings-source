import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { installationPlan, installerLockPath, provisionManagedAgent, managedBootstrapTransport } from './provision-managed-agent.mjs';
const id = 'f8a2fc94-1204-4a1b-bfe7-14f4c20d1a62';
function fixture() {
  let current = { installation: { id, workspace_id: 'workspace-fixture', agent_sub: 'agent:fixture', agent_email: 'fixture@agents.test', state: 'provisioning' },
    stage: 'reserved', verified_at: null, runtime_project_id: null, runtime_version: null };
  const calls = [], projects = [], keys = { webhook_key: 'w'.repeat(64), inbound_key: 'i'.repeat(64) };
  let fail = false, cancel = false;
  const transport = async (input) => {
    calls.push(input);
    if (input.action === 'bind') {
      // The server's rule (managed-agent-provisioning.ts): a pinned commit changes only by an allowed re-pin.
      const repinnable = current.verified_at === null && current.stage === 'failed' && ['runtime_configure', 'runtime_deploy'].includes(current.failed_step);
      if (current.runtime_version && current.runtime_version !== input.runtime_version && !(input.repin && repinnable)) throw new Error('managed bootstrap refused (409)');
      current = { ...current, stage: 'runtime', failed_step: null, runtime_project_id: input.project_id, runtime_version: input.runtime_version };
    }
    if (input.action === 'verify') current = { ...current, stage: 'awaiting_admin', verified_at: Date.now() };
    if (input.action === 'failed') current = { ...current, stage: 'failed', failed_step: input.failed_step };
    if (input.action === 'offboard') current = { ...current, stage: 'removed', installation: { ...current.installation, state: 'removed' } };
    return { readiness: current, ...keys };
  };
  // Bots main moves with `main`; a pinned ref answers its own commit.
  const bots = { main: '123abcd' + 'a'.repeat(33) };
  const command = (name, args, input) => {
    calls.push({ name, args, input: name === 'gh' ? undefined : Boolean(input) });
    if (name !== 'gh') return '';
    const ref = args[1].split('/').at(-1);
    return JSON.stringify({ sha: ref === 'main' ? bots.main : ref.padEnd(40, 'a') });
  };
  const cloud = (path, body, method) => {
    calls.push({ path, body, method });
    if (path.includes('search=')) return { projects };
    if (path === '/v11/projects') { const project = { id: 'prj_fixture', name: body.name, rootDirectory: body.rootDirectory, link: { type: 'github', org: 'envisioning', repo: 'bots' } }; projects.push(project); return project; }
    if (path === '/v9/projects/prj_fixture' && method === 'DELETE') { projects.length = 0; return null; }
    if (path === '/v9/projects/prj_fixture') return projects[0];
    if (path.includes('/env')) { if (fail) { fail = false; throw new Error('fixture provider unavailable'); } return {}; }
    if (path === '/v13/deployments') return { id: 'dpl_fixture' };
    if (path === '/v13/deployments/dpl_fixture') { if (cancel) { cancel = false; return { readyState: 'CANCELED' }; } return { readyState: 'READY' }; }
    if (path === '/v2/deployments/dpl_fixture/aliases') return { alias: body.alias };
    throw new Error('unexpected provider path');
  };
  return { calls, projects, transport, command, cloud, bots, log: () => {}, failNext: () => { fail = true; }, cancelNext: () => { cancel = true; }, state: () => current };
}
const options = { slug: 'synthetic-managed-test', owner: 'owner@example.test', origin: 'https://workspace.test', apply: true };
test('dry run validates input and allocates nothing', async () => {
  const f = fixture(); await provisionManagedAgent({ ...options, ...f, apply: false }); assert.deepEqual(f.calls, []);
  assert.throws(() => installationPlan('-'.repeat(36)));
});
test('rerun reuses project and keys and does not redeploy a verified runtime', async () => {
  const f = fixture(); await provisionManagedAgent({ ...options, ...f }); await provisionManagedAgent({ ...options, ...f });
  assert.equal(f.projects.length, 1); assert.equal(f.calls.filter(c => c.path === '/v11/projects').length, 1);
  assert.equal(f.calls.filter(c => c.path === '/v13/deployments').length, 1);
  const env = f.calls.filter(c => c.path?.includes('/env')).map(c => c.body);
  assert.ok(env.every(c => !Array.isArray(c)));
  assert.equal(env.length, 7);
  assert.equal(env.find(c => c.key === 'AGENT_WEBHOOK_KEY').value, 'w'.repeat(64));
  assert.equal(f.calls.filter(c => c.name === 'pnpm' && c.args.includes('delete')).length, 2);
  const deploy = f.calls.find(c => c.path === '/v13/deployments').body;
  assert.equal(deploy.gitSource.sha.length, 40); assert.equal(deploy.projectSettings.sourceFilesOutsideRootDirectory, true);
  const aliasIndex = f.calls.findIndex(c => c.path === '/v2/deployments/dpl_fixture/aliases');
  assert.equal(f.calls[aliasIndex].body.alias, new URL(installationPlan(id).origin).hostname);
  assert.ok(aliasIndex < f.calls.findIndex(c => c.action === 'verify'));
  assert.equal(f.calls.filter(c => c.path === '/v2/deployments/dpl_fixture/aliases').length, 1);
});
test('partial failure persists the resource, clears bootstrap and resumes the same installation', async () => {
  const f = fixture(); f.failNext();
  await assert.rejects(provisionManagedAgent({ ...options, ...f }), /unavailable/);
  assert.ok(f.calls.some(c => c.action === 'failed' && c.failed_step === 'runtime_configure'));
  assert.ok(f.calls.some(c => c.name === 'pnpm' && c.args.includes('delete')));
  await provisionManagedAgent({ ...options, ...f }); assert.equal(f.projects.length, 1);
});
test('explicit offboarding revokes before erasing only the tracked managed project', async () => {
  const f = fixture(); await provisionManagedAgent({ ...options, ...f }); f.calls.length = 0;
  await provisionManagedAgent({ ...options, ...f, offboard: true });
  const revoke = f.calls.findIndex(c => c.action === 'offboard'), erase = f.calls.findIndex(c => c.method === 'DELETE');
  assert.ok(revoke >= 0 && erase > revoke); assert.equal(f.projects.length, 0);
  assert.ok(f.calls.some(c => c.action === 'erased' && c.project_id === 'prj_fixture'));
  // Resume after provider deletion even if acknowledgement was lost. No new project or key pair.
  f.calls.length = 0; await provisionManagedAgent({ ...options, ...f, offboard: true });
  assert.ok(f.calls.some(c => c.action === 'erased' && c.project_id === 'prj_fixture'));
  assert.ok(!f.calls.some(c => c.method === 'DELETE'));
  f.calls.length = 0; await provisionManagedAgent({ ...options, ...f }); assert.equal(f.projects.length, 0);
  assert.ok(!f.calls.some(c => c.path));
});

test('a dead installer lock is reconciled, while a live installer is refused', async () => {
  const lock = installerLockPath(options.slug);
  mkdirSync(lock); writeFileSync(lock + '/pid', '2147483647');
  const f = fixture(); await provisionManagedAgent({ ...options, ...f });
  mkdirSync(lock); writeFileSync(lock + '/pid', String(process.pid));
  try { await assert.rejects(provisionManagedAgent({ ...options, ...f }), /another managed installer/); }
  finally { rmSync(lock, { recursive: true }); }
});

test('an uncertain secret-put acknowledgement still removes the bootstrap key', async () => {
  const f = fixture(); const command = (name, args, input) => {
    if (args.includes('put')) throw new Error('fixture acknowledgement lost');
    return f.command(name, args, input);
  };
  await assert.rejects(provisionManagedAgent({ ...options, ...f, command }), /acknowledgement lost/);
  assert.ok(f.calls.some(c => c.name === 'pnpm' && c.args.includes('delete')));
});


test('bootstrap retries idempotent begin while its secret deployment propagates', async () => {
  let calls = 0; const pauses = [];
  const response = { readiness: { installation: { id, workspace_id: 'workspace-fixture', agent_sub: 'agent:fixture',
    agent_email: 'fixture@agents.example.test', display_name: 'Steward', role: 'meeting_follow_through', kind: 'agent', source: 'starlings_managed', state: 'provisioning' },
    stage: 'reserved', accountable_sub: null, runtime_project_id: null, runtime_version: null, verified_at: null, failed_step: null, retryable: false }, webhook_key: null, inbound_key: null };
  const call = managedBootstrapTransport('https://workspace.test', 'synthetic-key', { pause: async ms => pauses.push(ms),
    request: async () => ++calls < 3 ? new Response('{}', { status: 404 }) : Response.json(response) });
  assert.deepEqual(await call({ action: 'begin' }), response); assert.equal(calls, 3); assert.deepEqual(pauses, [1000, 1000]);
  let refused = 0;
  const stop = managedBootstrapTransport('https://workspace.test', 'synthetic-key', { pause: async () => {}, request: async () => { refused++; return new Response('{}', { status: 403 }); } });
  await assert.rejects(stop({ action: 'begin' }), /403/); assert.equal(refused, 1);
  const exhausted = managedBootstrapTransport('https://workspace.test', 'synthetic-key', { pause: async () => {}, request: async () => new Response('{}', { status: 404 }) });
  await assert.rejects(exhausted({ action: 'begin' }), /404/);
  await assert.rejects(exhausted({ action: 'status' }), /404/);
});

test('a cancelled first build re-pins to Bots main on the rerun; a verified runtime keeps its commit (meet#1152)', async () => {
  const f = fixture(); f.cancelNext();
  await assert.rejects(provisionManagedAgent({ ...options, ...f }), /deployment failed/);
  assert.deepEqual([f.state().stage, f.state().failed_step, f.state().runtime_version], ['failed', 'runtime_deploy', '123abcd']);
  // Bots main moves on (the ignore-step fix); the rerun deploys it, not the pinned commit.
  f.bots.main = '456cdef' + 'b'.repeat(33);
  const lines = [];
  await provisionManagedAgent({ ...options, ...f, log: (line) => lines.push(line) });
  const deploys = f.calls.filter((c) => c.path === '/v13/deployments').map((c) => c.body.gitSource.sha);
  assert.deepEqual(deploys, ['123abcd' + 'a'.repeat(33), f.bots.main]);
  assert.ok(f.calls.some((c) => c.action === 'bind' && c.repin === true && c.runtime_version === '456cdef'));
  assert.match(lines.join('\n'), /re-pinned from 123abcd, because the last attempt failed at runtime_deploy/u);
  assert.equal(f.state().runtime_version, '456cdef');
  // Verified now: a later rerun binds the same commit, with no re-pin and no deploy.
  f.bots.main = '789abcd' + 'c'.repeat(33);
  await provisionManagedAgent({ ...options, ...f });
  assert.equal(f.calls.filter((c) => c.path === '/v13/deployments').length, 2);
  assert.equal(f.calls.filter((c) => c.repin).length, 1);
  assert.equal(f.state().runtime_version, '456cdef');
});

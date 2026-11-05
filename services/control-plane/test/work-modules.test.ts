import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WORK_MODULES,
  WORK_MODULE_SPECS,
  WORK_STORES,
  workModuleAvailable,
  workModuleForSubjectKind,
} from '@starlings/contracts/work-modules';
import { SUBJECT_KINDS } from '@starlings/contracts/subject-kinds';
import { workModulesAdminResponseSchema } from '@starlings/contracts/work-modules-setting';
import { workModulesOn } from '../src/work-modules';
import fixture from '../../../fixtures/work-modules.json';

// docs/WORK_MODEL.md, meet#941: the work modules a workspace admin turns on.

async function admin() {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}`, origin: env.WEB_ORIGIN };
}

async function put(on: string[]) {
  return exports.default.fetch(new Request('http://local/api/admin/work-modules', {
    method: 'PUT',
    headers: { ...(await admin()), 'content-type': 'application/json' },
    body: JSON.stringify({ on }),
  }));
}

afterEach(async () => {
  await env.USAGE.prepare("DELETE FROM workspace_settings WHERE key = 'work_modules'").run();
});

describe('work-module table', () => {
  it('equals fixtures/work-modules.json, the table the Swift mirror pins', () => {
    expect(fixture.modules).toEqual([...WORK_MODULES]);
    expect(fixture.specs).toEqual(WORK_MODULE_SPECS);
    for (const row of fixture.available) {
      expect(WORK_MODULES.filter((module) => workModuleAvailable(module, row.store as (typeof WORK_STORES)[number]))).toEqual(row.modules);
    }
    for (const row of fixture.gates) {
      expect(workModuleForSubjectKind(row.kind as (typeof SUBJECT_KINDS)[number])).toBe(row.module);
    }
  });
});

describe('work modules in force', () => {
  it('has every Core work module on Envisioning before anyone saves, and the base only on D1', async () => {
    expect(await workModulesOn(env)).toEqual(WORK_MODULES.filter((module) => workModuleAvailable(module, 'core')));
    expect(await workModulesOn({ ...env, WORK_STORE: 'd1' } as Env)).toEqual([]);
  });

  it('saves the choice, keeps the table order, and limits it to what the store serves', async () => {
    const saved = await put(['partners', 'sales']);
    expect(saved.status).toBe(200);
    expect(workModulesAdminResponseSchema.parse(await saved.json()).on).toEqual(['sales', 'partners']);
    expect(await workModulesOn({ ...env, WORK_STORE: 'd1' } as Env)).toEqual(['sales', 'partners']);
  });

  it('refuses a work module the store cannot serve', async () => {
    expect((await put(['support'])).status).toBe(409);
  });
});

describe('a kind whose work module is off', () => {
  async function call(path: string, init: RequestInit = {}) {
    return exports.default.fetch(new Request(`http://local${path}`, { ...init, headers: { ...(await admin()), 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) } }));
  }

  it('lists nothing, counts nothing and refuses a new one, before reaching the store', async () => {
    await put(['partners']);
    const list = await call('/api/crm/subjects?kind=lead');
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ subjects: [], has_more: false });
    const counts = await call('/api/crm/subject-counts?kind=lead');
    expect(await counts.json()).toEqual({ counts: {} });
    const created = await call('/api/crm/subjects', {
      method: 'POST',
      body: JSON.stringify({ kind: 'lead', title: 'A lead', organization_id: '00000000-0000-4000-8000-000000000001', start_date: '2026-10-05' }),
    });
    expect(created.status).toBe(404);
  });
});

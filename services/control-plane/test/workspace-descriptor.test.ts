import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ORG_NAME, PUBLIC_WEB_ORIGIN } from '@starlings/contracts/deployment';
import { workspaceDescriptorSchema } from '@starlings/contracts/workspace-descriptor';
import { workspaceDescriptor } from '../src/workspace-descriptor';

// meet#717: each workspace's Worker says who it is at /.well-known/meet.
describe('workspace descriptor', () => {
  it('serves the deployment\'s name, origin and member domains, public and cacheable', async () => {
    const response = await exports.default.fetch(new Request('http://local/.well-known/meet'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const body = workspaceDescriptorSchema.parse(await response.json());
    expect(body.name).toBe(ORG_NAME);
    expect(body.public_web_origin).toBe(PUBLIC_WEB_ORIGIN);
    expect(body.identity).toEqual({ provider: 'google', domains: ['example.com', 'example.org'], sign_in_hint: 'example.com' });
    expect(body.brand).toMatchObject({ mark_url: null, accent: null, backgrounds: { image_url: null, default: null } });
  });

  it('reflects a workspace that sets its own name, hosts, accent and floors', async () => {
    const body = workspaceDescriptorSchema.parse(await workspaceDescriptor({
      ...env,
      WORKSPACE_NAME: '  HQ  ',
      WORKSPACE_ACCENT: '#2563EB',
      WEB_ORIGIN: 'https://hq.starlings.example',
      PUBLIC_API_ORIGIN: 'https://hq.starlings.example',
      PUBLIC_WEB_ORIGIN: 'https://hq.starlings.example/',
      IDENTITY_DOMAINS: 'acme.com, Acme.io, not a domain',
      SIGN_IN_DOMAIN: 'acme.com',
      MIN_RECOMMENDED_VERSION_MACOS: '7.1.0',
      MIN_RECOMMENDED_VERSION_IOS: 'soon',
      WORKSPACE_ORIGIN_ALIASES: 'https://hq.example.com, http://insecure.example.com, not an origin',
    } as unknown as Env));
    expect(body).toMatchObject({
      name: 'HQ',
      web_origin: 'https://hq.starlings.example',
      api_origin: 'https://hq.starlings.example',
      public_web_origin: 'https://hq.starlings.example',
      aliases: ['https://hq.example.com'],
      identity: { domains: ['acme.com', 'acme.io'], sign_in_hint: 'acme.com' },
      brand: { accent: '#2563eb' },
      accent_palette: { dark: { accent: '#2563eb', on_accent: '#ffffff' }, light: { cta: '#2563eb' } },
      min_client: { macos: '7.1.0', ios: null },
    });
  });

  // meet#849: a client calls only the services the descriptor names.
  it('names each service only when its token route can broker a token', async () => {
    const configured = {
      ...env,
      WORK_STORE: 'core',
      CRM_SYNC_MODE: 'on',
      INTERNAL_REQUEST_SECRET: 'core-secret',
      CORE_API_ORIGIN: 'https://core.example.com/',
      DOCS_INTERNAL_SECRET: 'docs-secret',
      DOCS_ORIGIN: 'https://docs.example.com',
      KEEP_INTERNAL_SECRET: 'keep-secret',
      KEEP_ORIGIN: 'https://keep.example.com',
    } as unknown as Env;
    expect((await workspaceDescriptor(configured)).services).toEqual({
      core: 'https://core.example.com',
      core_groups: ['subjects', 'tasks', 'goals', 'interactions', 'commercial'],
      docs: 'https://docs.example.com',
      keep: 'https://keep.example.com',
    });
    // A group that has moved to D1 is no longer Core's to link (meet#1219).
    const moved = { ...configured, WORK_STORE_SUBJECTS: 'd1' } as unknown as Env;
    expect((await workspaceDescriptor(moved)).services?.core_groups).toEqual(['tasks', 'goals', 'interactions', 'commercial']);

    const d1 = { ...configured, WORK_STORE: 'd1', DOCS_INTERNAL_SECRET: '', KEEP_ORIGIN: '' } as unknown as Env;
    expect((await workspaceDescriptor(d1)).services).toEqual({ core: null, core_groups: [], docs: null, keep: null });
  });

  // meet#863: a workspace that names no public host links to its own, never Envisioning's.
  it('falls back to the workspace\'s own web origin for links', async () => {
    const body = await workspaceDescriptor({ ...env, WEB_ORIGIN: 'https://hq.starlings.example', PUBLIC_WEB_ORIGIN: '' } as unknown as Env);
    expect(body.public_web_origin).toBe('https://hq.starlings.example');
  });

  it('drops an accent that cannot carry readable text', async () => {
    const body = await workspaceDescriptor({ ...env, WORKSPACE_ACCENT: '#808080' } as unknown as Env);
    expect(body.brand.accent).toBeNull();
    expect(body.accent_palette).toBeNull();
  });
});

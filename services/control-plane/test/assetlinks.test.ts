// `/.well-known/assetlinks.json` (#1238): Android reads it before it verifies
// the app's room-link filters. The body is pinned here, fingerprint by
// fingerprint, so a changed key or package shows in review.
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ANDROID_APP_PACKAGE, ANDROID_DEBUG_CERT_SHA256, ANDROID_RELEASE_CERT_SHA256 } from '@starlings/contracts';
import { androidAssetLinks } from '../src/routes/public';

const RELEASE = '5C:33:4A:69:02:4D:F7:3E:1C:26:91:28:F6:87:1A:65:D1:B5:D1:33:1E:F7:7B:88:54:97:69:89:86:13:E5:9F';
const DEBUG = 'AC:F9:3D:7C:4F:3C:C5:C4:53:E8:E1:5C:20:17:E0:63:9E:26:9F:19:B9:3E:64:AE:D2:6A:9E:61:A3:A9:59:93';

const statement = (fingerprints: string[]) => [{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: { namespace: 'android_app', package_name: 'work.starlings.android', sha256_cert_fingerprints: fingerprints },
}];

describe('assetlinks.json (#1238)', () => {
  it('keeps the package and the fingerprints in the contracts', () => {
    expect(ANDROID_APP_PACKAGE).toBe('work.starlings.android');
    expect(ANDROID_RELEASE_CERT_SHA256).toBe(RELEASE);
    expect(ANDROID_DEBUG_CERT_SHA256).toBe(DEBUG);
    for (const value of [RELEASE, DEBUG]) expect(value).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/u);
  });

  it('names only the release certificate on a production Worker', () => {
    expect(androidAssetLinks({ ENVIRONMENT: 'production' })).toEqual(statement([RELEASE]));
  });

  it('adds the debug certificate only on a development Worker', () => {
    expect(androidAssetLinks({ ENVIRONMENT: 'development' } as never)).toEqual(statement([RELEASE, DEBUG]));
  });

  it('serves the file as JSON, public, with no redirect', async () => {
    const response = await exports.default.fetch(new Request('https://envisioning.starlings.example/.well-known/assetlinks.json'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    const body = await response.json();
    // The test Worker is a development one (wrangler.test.jsonc).
    expect(body).toEqual(statement([RELEASE, DEBUG]));
    const head = await exports.default.fetch(new Request('https://envisioning.starlings.example/.well-known/assetlinks.json', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
});

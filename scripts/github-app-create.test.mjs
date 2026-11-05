import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appSecret, manifestPage } from './github-app-create.mjs';

const { GITHUB_APP_PATHS, githubAppManifest } = await import('../packages/contracts/src/github-app.ts');

test('the manifest points GitHub at the broker on the auth host', () => {
  const manifest = githubAppManifest({ authOrigin: 'https://auth.starlings.example', redirectUrl: 'http://localhost:8790/callback' });
  assert.equal(manifest.setup_url, `https://auth.starlings.example${GITHUB_APP_PATHS.setup}`);
  assert.deepEqual(manifest.callback_urls, [`https://auth.starlings.example${GITHUB_APP_PATHS.callback}`]);
  assert.equal(manifest.hook_attributes.url, `https://auth.starlings.example${GITHUB_APP_PATHS.webhook}`);
  assert.equal(manifest.redirect_url, 'http://localhost:8790/callback');
  assert.equal(manifest.public, true);
  assert.equal(manifest.setup_on_update, true);
  assert.deepEqual(manifest.default_permissions, { contents: 'read', pull_requests: 'read', checks: 'read', metadata: 'read', issues: 'write' });
});

test('the loopback page posts the manifest, escaped, with the run state', () => {
  const page = manifestPage({ org: 'envisioning', state: 'abc', manifest: { name: '"><script>' } });
  assert.match(page, /action="https:\/\/github\.com\/organizations\/envisioning\/settings\/apps\/new\?state=abc"/u);
  assert.ok(!page.includes('"><script>'));
  assert.match(page, /&quot;&gt;&lt;script&gt;/u);
});

test('only the fields the broker reads are stored, and a conversion without a key is refused', () => {
  const conversion = {
    id: 1, slug: 'starlings', client_id: 'Iv1.x', client_secret: 'c', webhook_secret: 'w'.repeat(32),
    pem: '-----BEGIN RSA PRIVATE KEY-----\nAA\n-----END RSA PRIVATE KEY-----', owner: { login: 'envisioning' }, html_url: 'x',
  };
  assert.deepEqual(Object.keys(appSecret(conversion)).sort(), ['client_id', 'client_secret', 'id', 'pem', 'slug', 'webhook_secret']);
  assert.throws(() => appSecret({ ...conversion, pem: '' }));
});

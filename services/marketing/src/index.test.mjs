import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';

test('public enquiries preserve validation and discard workspace credentials', async () => {
  let forwarded;
  const response = await worker.fetch(new Request('https://site.example/api/interest', {
    method: 'POST', headers: { origin: 'https://site.example', 'content-type': 'application/json', cookie: 'meet_session=private', authorization: 'Bearer private', 'cf-connecting-ip': '192.0.2.1' }, body: '{}',
  }), { HQ: { async fetch(request) { forwarded = request; return new Response('validated', { status: 400 }); } } });
  assert.equal(response.status, 400);
  assert.equal(forwarded.url, 'https://hq.starlings.example/api/interest');
  assert.equal(forwarded.headers.get('authorization'), null);
  assert.equal(forwarded.headers.get('cookie'), null);
  assert.equal(forwarded.headers.get('origin'), 'https://hq.starlings.example');
  assert.equal(forwarded.headers.get('cf-connecting-ip'), '192.0.2.1');
  assert.equal(await forwarded.text(), '{}');
});

test('an agent request is carried from any origin; its confirm only from the site', async () => {
  let forwarded;
  const env = { HQ: { async fetch(request) { forwarded = request; return new Response('{}', { status: 202 }); } } };
  const agent = await worker.fetch(new Request('https://site.example/api/interest/agent', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: 'meet_session=private' }, body: '{}',
  }), env);
  assert.equal(agent.status, 202);
  assert.equal(forwarded.url, 'https://hq.starlings.example/api/interest/agent');
  assert.equal(forwarded.headers.get('cookie'), null);
  assert.equal((await worker.fetch(new Request('https://site.example/api/interest/confirm', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }), env)).status, 403);
  const confirmed = await worker.fetch(new Request('https://site.example/api/interest/confirm', { method: 'POST', headers: { origin: 'https://site.example' }, body: '{}' }), env);
  assert.equal(confirmed.status, 202);
  assert.equal(forwarded.url, 'https://hq.starlings.example/api/interest/confirm');
});

test('the product Worker exposes no workspace routes and rejects cross-site enquiries', async () => {
  for (const path of ['/api/auth/me', '/api/home/preferences', '/room/mz', '/mcp']) {
    assert.equal((await worker.fetch(new Request(`https://site.example${path}`), {})).status, 404);
  }
  assert.equal((await worker.fetch(new Request('https://site.example/api/interest', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }), {})).status, 403);
});

test('www redirects to the product apex and preview assets are not indexed', async () => {
  const redirected = await worker.fetch(new Request('https://www.site.example/workspace?x=1'), {});
  assert.equal(redirected.status, 301);
  assert.equal(redirected.headers.get('location'), 'https://site.example/workspace?x=1');
  for (const host of ['starlings.example', 'www.starlings.example']) {
    const fromApp = await worker.fetch(new Request(`https://${host}/pricing?x=1`), {});
    assert.equal(fromApp.status, 301);
    assert.equal(fromApp.headers.get('location'), 'https://site.example/pricing?x=1');
  }
  const env = { ASSETS: { fetch: async () => new Response('site') } };
  assert.equal((await worker.fetch(new Request('https://starlings-site.workers.org.example/'), env)).headers.get('x-robots-tag'), 'noindex');
  assert.equal((await worker.fetch(new Request('https://site.example/'), env)).headers.get('x-robots-tag'), null);
});

test('usage counts go to Plausible from the product domain only, after the response', async () => {
  const real = globalThis.fetch;
  const upstream = [];
  globalThis.fetch = async (request) => { upstream.push(request); return new Response(null, { status: 202 }); };
  try {
    const sent = [];
    const ctx = { waitUntil: (promise) => sent.push(promise) };
    const env = { PLAUSIBLE_DOMAIN: 'site.example' };
    const event = (host, body, origin = `https://${host}`) => new Request(`https://${host}/api/event`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json', 'user-agent': 'Test Browser', 'cf-connecting-ip': '192.0.2.9' }, body: JSON.stringify(body),
    });

    assert.equal((await worker.fetch(event('site.example', { name: 'pageview', path: '/pricing' }, 'https://evil.example'), env, ctx)).status, 403);
    assert.equal((await worker.fetch(event('site.example', { name: 'Anything', path: '/pricing' }), env, ctx)).status, 400);
    assert.equal((await worker.fetch(event('starlings-site.workers.org.example', { name: 'pageview', path: '/pricing' }), env, ctx)).status, 202);
    assert.equal(sent.length, 0, 'the workers.dev preview counts nothing');

    const response = await worker.fetch(event('site.example', { name: 'Download', path: '/download', props: { platform: 'mac' } }), env, ctx);
    assert.equal(response.status, 202);
    await Promise.all(sent);
    assert.equal(upstream.length, 1);
    assert.equal(upstream[0].url, 'https://plausible.io/api/event');
    assert.equal(upstream[0].headers.get('x-forwarded-for'), '192.0.2.9');
    assert.deepEqual(await upstream[0].json(), { domain: 'site.example', name: 'Download', url: 'https://site.example/download', props: { platform: 'mac' } });
  } finally {
    globalThis.fetch = real;
  }
});

test('a sent enquiry counts as a goal; a refused one does not', async () => {
  const real = globalThis.fetch;
  const upstream = [];
  globalThis.fetch = async (request) => { upstream.push(request); return new Response(null, { status: 202 }); };
  try {
    const sent = [];
    const ctx = { waitUntil: (promise) => sent.push(promise) };
    const enquiry = () => new Request('https://site.example/api/interest', { method: 'POST', headers: { origin: 'https://site.example', 'content-type': 'application/json' }, body: '{}' });
    const env = (status) => ({ PLAUSIBLE_DOMAIN: 'site.example', HQ: { fetch: async () => new Response('{}', { status }) } });
    await worker.fetch(enquiry(), env(400), ctx);
    await worker.fetch(enquiry(), env(202), ctx);
    await Promise.all(sent);
    assert.equal(upstream.length, 1);
    assert.equal((await upstream[0].json()).name, 'Interest sent');
  } finally {
    globalThis.fetch = real;
  }
});

function downloads(objects) {
  const asked = [];
  const find = (key) => {
    asked.push(key);
    const body = objects[key];
    return body === undefined ? null : { body, size: body.length, httpEtag: '"etag-1"' };
  };
  return { asked, bucket: { async get(key) { return find(key); }, async head(key) { return find(key); } } };
}

test('the Mac download streams the notarized zip from R2', async () => {
  const { asked, bucket } = downloads({ 'mac/latest/Starlings-macOS.zip': 'PK latest', 'mac/6.8.10/Starlings-macOS.zip': 'PK 6.8.10' });
  const env = { DOWNLOADS: bucket };

  const latest = await worker.fetch(new Request('https://site.example/download/mac'), env);
  assert.equal(latest.status, 200);
  assert.equal(latest.headers.get('content-type'), 'application/zip');
  assert.equal(latest.headers.get('content-length'), '9');
  assert.equal(latest.headers.get('content-disposition'), 'attachment; filename="Starlings-macOS.zip"');
  assert.equal(latest.headers.get('etag'), '"etag-1"');
  assert.equal(latest.headers.get('cache-control'), 'no-store');
  assert.equal(await latest.text(), 'PK latest');

  const version = await worker.fetch(new Request('https://site.example/download/mac/6.8.10/Starlings-macOS.zip'), env);
  assert.equal(version.status, 200);
  assert.equal(version.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await version.text(), 'PK 6.8.10');

  const named = await worker.fetch(new Request('https://site.example/download/mac/latest/Starlings-macOS.zip'), env);
  assert.equal(named.headers.get('cache-control'), 'no-store');

  const head = await worker.fetch(new Request('https://site.example/download/mac/6.8.10/Starlings-macOS.zip', { method: 'HEAD' }), env);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '9');
  assert.equal(await head.text(), '');

  assert.deepEqual(asked, ['mac/latest/Starlings-macOS.zip', 'mac/6.8.10/Starlings-macOS.zip', 'mac/latest/Starlings-macOS.zip', 'mac/6.8.10/Starlings-macOS.zip']);
});

test('only a release number or latest reaches the bucket; a missing zip is 404', async () => {
  const { asked, bucket } = downloads({});
  const env = { DOWNLOADS: bucket, ASSETS: { fetch: async () => new Response('asset', { status: 404 }) } };
  assert.equal((await worker.fetch(new Request('https://site.example/download/mac/6.8.9/Starlings-macOS.zip'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://site.example/download/mac'), env)).status, 404);
  for (const path of ['/download/mac/6.8/Starlings-macOS.zip', '/download/mac/v6.8.9/Starlings-macOS.zip', '/download/mac/6.8.9/Meet-macOS.zip', '/download/mac/latest/../secrets']) {
    assert.equal((await worker.fetch(new Request(`https://site.example${path}`), env)).status, 404, path);
  }
  assert.deepEqual(asked, ['mac/6.8.9/Starlings-macOS.zip', 'mac/latest/Starlings-macOS.zip']);
});

test('the Android download streams the signed APK from R2, versioned as the Mac zip', async () => {
  const { asked, bucket } = downloads({ 'android/latest/Starlings-android.apk': 'PK apk', 'android/7.2.3/Starlings-android.apk': 'PK 7.2.3' });
  const env = { DOWNLOADS: bucket, ASSETS: { fetch: async () => new Response('asset', { status: 404 }) } };

  const latest = await worker.fetch(new Request('https://site.example/download/android'), env);
  assert.equal(latest.status, 200);
  assert.equal(latest.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(latest.headers.get('content-disposition'), 'attachment; filename="Starlings-android.apk"');
  assert.equal(latest.headers.get('cache-control'), 'no-store');
  assert.equal(await latest.text(), 'PK apk');

  const named = await worker.fetch(new Request('https://site.example/download/android/latest/Starlings-android.apk'), env);
  assert.equal(named.status, 200);
  assert.equal(named.headers.get('cache-control'), 'no-store');

  const version = await worker.fetch(new Request('https://site.example/download/android/7.2.3/Starlings-android.apk'), env);
  assert.equal(version.status, 200);
  assert.equal(version.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(await version.text(), 'PK 7.2.3');

  assert.equal((await worker.fetch(new Request('https://site.example/download/android/7.2.2/Starlings-android.apk'), env)).status, 404);
  for (const path of ['/download/android/0.0.1-a0/Starlings-android.apk', '/download/android/latest/app-release.apk', '/download/android/latest/../secrets']) {
    assert.equal((await worker.fetch(new Request(`https://site.example${path}`), env)).status, 404, path);
  }
  assert.deepEqual(asked, ['android/latest/Starlings-android.apk', 'android/latest/Starlings-android.apk', 'android/7.2.3/Starlings-android.apk', 'android/7.2.2/Starlings-android.apk']);
});

test('/download/ios redirects to an https TestFlight invite and nothing else', async () => {
  const ios = await worker.fetch(new Request('https://site.example/download/ios'), { IOS_TESTFLIGHT_URL: 'https://testflight.apple.com/join/example' });
  assert.equal(ios.status, 302);
  assert.equal(ios.headers.get('location'), 'https://testflight.apple.com/join/example');
  for (const value of ['http://testflight.apple.com/join/example', '', undefined]) {
    assert.equal((await worker.fetch(new Request('https://site.example/download/ios'), { IOS_TESTFLIGHT_URL: value })).status, 404);
  }
});

test('the update feed is the gh-pages feed, served from the product domain', async () => {
  const real = globalThis.fetch;
  const asked = [];
  let upstream = new Response('{"schema":1,"version":"6.8.10"}', { status: 200 });
  globalThis.fetch = async (input) => { asked.push(new Request(input).url); return upstream; };
  try {
    const feed = await worker.fetch(new Request('https://site.example/updates/starlings.json'), {});
    assert.equal(feed.status, 200);
    assert.equal(feed.headers.get('content-type'), 'application/json');
    assert.equal(feed.headers.get('cache-control'), 'public, max-age=60');
    assert.deepEqual(await feed.json(), { schema: 1, version: '6.8.10' });
    assert.deepEqual(asked, ['https://envisioning.github.io/starlings/updates/starlings.json']);

    upstream = new Response('not found', { status: 404 });
    assert.equal((await worker.fetch(new Request('https://site.example/updates/starlings.json'), {})).status, 502);
  } finally {
    globalThis.fetch = real;
  }
});

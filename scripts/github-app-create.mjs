#!/usr/bin/env node
// Create the Starlings GitHub App from its manifest (docs/GITHUB_CONNECTOR.md
// "Creating the App"). One click on GitHub, nothing copied by hand.
//
//   pnpm github:app:create            serve the page on loopback and open it
//   pnpm github:app:create --print    print the manifest and stop
//
// The page posts the manifest (packages/contracts/src/github-app.ts) to
// GitHub's "new App" page for the org. After the click GitHub sends the
// browser back here with a one-time code. This script trades the code for
// the App (`POST /app-manifests/{code}/conversions`: id, slug, client id and
// secret, webhook secret, private key) and pipes it, as one line of JSON, into
// `wrangler secret put GITHUB_APP` on starlings-auth. The key is never
// written to disk, printed or logged. The script needs wrangler signed in to
// the Starlings account, as every deploy here does.
import { WORKSPACE_HOST_SUFFIX } from '../packages/contracts/src/deployment-values.ts';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { githubAppManifest, githubAppSecretSchema } = await import('../packages/contracts/src/github-app.ts');

const AUTH_ORIGIN = `https://auth.${WORKSPACE_HOST_SUFFIX}`;
const CONTROL_PLANE = fileURLToPath(new URL('../services/control-plane/', import.meta.url));

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

/** The loopback page: one form that posts the manifest to GitHub, submitted on load. */
export function manifestPage({ org, state, manifest }) {
  const action = `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${encodeURIComponent(state)}`;
  return `<!doctype html><meta charset="utf-8"><title>Create the Starlings GitHub App</title>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Continue to GitHub</button>
</form>
<script>document.forms[0].submit()</script>`;
}

/** The secret's value: only the fields the broker reads, checked before anything is stored. */
export function appSecret(conversion) {
  return githubAppSecretSchema.parse({
    id: conversion.id,
    slug: conversion.slug,
    client_id: conversion.client_id,
    client_secret: conversion.client_secret,
    webhook_secret: conversion.webhook_secret,
    pem: conversion.pem,
  });
}

function putSecret(value) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['exec', 'wrangler', 'secret', 'put', 'GITHUB_APP', '--config', 'wrangler.auth.jsonc'], {
      cwd: CONTROL_PLANE,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.stdin.end(value);
    child.on('close', (code) => resolve(code === 0));
  });
}

function reply(response, status, body) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`<!doctype html><meta charset="utf-8"><title>Starlings GitHub App</title><p>${escapeHtml(body)}</p>`);
}

async function main() {
  const org = option('org', 'envisioning');
  const port = Number(option('port', '8790'));
  const redirectUrl = `http://localhost:${port}/callback`;
  const manifest = githubAppManifest({ authOrigin: AUTH_ORIGIN, redirectUrl });
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  const state = randomBytes(24).toString('base64url');
  const timeout = Number(option('timeout-minutes', '120')) * 60_000;
  let done = false;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://localhost:${port}`);
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(manifestPage({ org, state, manifest }));
      return;
    }
    if (request.method !== 'GET' || url.pathname !== '/callback') {
      response.writeHead(404).end();
      return;
    }
    if (done || url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
      reply(response, 400, 'This link is not the one this run opened.');
      return;
    }
    done = true;
    const code = url.searchParams.get('code');
    const exchanged = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'starlings-github-app-create' },
    });
    if (!exchanged.ok) {
      reply(response, 502, `GitHub refused the code (${exchanged.status}). Run the script again.`);
      console.error(`github-app-create: GitHub answered ${exchanged.status} to the code exchange.`);
      process.exitCode = 1;
      server.close();
      return;
    }
    const secret = appSecret(await exchanged.json());
    const value = JSON.stringify(secret);
    let stored = await putSecret(value);
    if (!stored) stored = await putSecret(value);
    if (!stored) {
      // The code is single use: keep the App rather than lose it.
      const file = join(tmpdir(), `starlings-github-app-${secret.slug}.json`);
      writeFileSync(file, value, { mode: 0o600 });
      console.error(`github-app-create: wrangler did not store GITHUB_APP. The value is in ${file} (0600). Store it with:`);
      console.error(`  pnpm --filter @starlings/control-plane exec wrangler secret put GITHUB_APP --config wrangler.auth.jsonc < ${file}`);
      console.error('then delete the file.');
      reply(response, 500, 'The App exists, but storing its key failed. See the terminal.');
      process.exitCode = 1;
      server.close();
      return;
    }
    console.log(`github-app-create: created ${secret.slug} (App id ${secret.id}); GITHUB_APP is set on starlings-auth.`);
    console.log(`github-app-create: install page https://github.com/apps/${secret.slug}`);
    reply(response, 200, `The Starlings App (${secret.slug}) exists, and its key is in starlings-auth. You can close this tab.`);
    server.close();
  });

  server.listen(port, '127.0.0.1', () => {
    const page = `http://localhost:${port}/`;
    console.log(`github-app-create: open ${page} and press Create GitHub App on GitHub.`);
    if (!process.argv.includes('--no-open') && process.platform === 'darwin') spawn('open', [page], { stdio: 'ignore', detached: true }).unref();
  });
  setTimeout(() => {
    if (done) return;
    console.error('github-app-create: no answer from GitHub; stopped.');
    process.exitCode = 1;
    server.close();
  }, timeout).unref();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

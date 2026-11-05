#!/usr/bin/env node
import { createPrivateKey, sign } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TESTFLIGHT_ALERT_AGE_DAYS = 75;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const APP_STORE_CONNECT_BUILDS_URL = 'https://api.appstoreconnect.apple.com/v1/builds';

export function ageInDays(uploadedDate, now = Date.now()) {
  const uploadedAt = typeof uploadedDate === 'number' ? uploadedDate : Date.parse(uploadedDate);
  if (!Number.isFinite(uploadedAt)) throw new Error('The latest build has an invalid uploadedDate.');
  if (!Number.isFinite(now)) throw new Error('The current time is invalid.');
  return (now - uploadedAt) / MILLISECONDS_PER_DAY;
}

export function needsExpiryAlert(uploadedDate, now = Date.now()) {
  return ageInDays(uploadedDate, now) > TESTFLIGHT_ALERT_AGE_DAYS;
}

function encodeJwtPart(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createAppStoreConnectToken({ apiKey, keyId, issuerId }, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const header = encodeJwtPart({ alg: 'ES256', kid: keyId, typ: 'JWT' });
  const payload = encodeJwtPart({
    iss: issuerId,
    iat: issuedAt,
    exp: issuedAt + 10 * 60,
    aud: 'appstoreconnect-v1',
  });
  const signingInput = header + '.' + payload;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(apiKey),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return signingInput + '.' + signature;
}

function requiredSecret(env, name) {
  const value = env[name];
  if (!value) throw new Error('Required GitHub secret is missing: ' + name + '.');
  return value;
}

async function checkLatestBuild(env = process.env, fetchImpl = fetch, now = Date.now()) {
  const credentials = {
    apiKey: requiredSecret(env, 'APPLE_API_KEY'),
    keyId: requiredSecret(env, 'APPLE_API_KEY_ID'),
    issuerId: requiredSecret(env, 'APPLE_API_ISSUER_ID'),
  };
  const appId = requiredSecret(env, 'ASC_APP_ID');
  const url = new URL(APP_STORE_CONNECT_BUILDS_URL);
  url.searchParams.set('filter[app]', appId);
  url.searchParams.set('sort', '-uploadedDate');
  url.searchParams.set('limit', '1');

  const response = await fetchImpl(url, {
    headers: {
      Authorization: 'Bearer ' + createAppStoreConnectToken(credentials, now),
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error('App Store Connect returned HTTP ' + response.status + ' while reading the newest build.');
  }

  const payload = await response.json();
  const build = payload?.data?.[0];
  const buildNumber = build?.attributes?.version;
  const uploadedDate = build?.attributes?.uploadedDate;
  if (typeof buildNumber !== 'string' || !uploadedDate) {
    throw new Error('App Store Connect returned no newest build number or uploadedDate for this app.');
  }

  const age = ageInDays(uploadedDate, now);
  console.log('Newest TestFlight build ' + buildNumber + ' was uploaded ' + uploadedDate +
    ' (' + age.toFixed(1) + ' days old).');
  if (age > TESTFLIGHT_ALERT_AGE_DAYS) {
    throw new Error('TestFlight build ' + buildNumber + ' is more than ' +
      TESTFLIGHT_ALERT_AGE_DAYS + ' days old and is nearing its 90-day expiry.');
  }
}

async function main() {
  await checkLatestBuild();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('::error::' + message);
    process.exitCode = 1;
  });
}

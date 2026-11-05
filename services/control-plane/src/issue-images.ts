import { ISSUE_IMAGE_MAX_BYTES, type IssueImageResponse } from './contracts';
import { ControlError } from './errors';
import { sniffImageType } from './avatars';

/**
 * Pictures for GitHub issues, hosted here because GitHub will not host them.
 *
 * GitHub has no public API for attaching a file to an issue — the drag-and-drop
 * on github.com posts to an endpoint the REST API does not expose — so neither
 * this Worker nor Core's GitHub App can put an image *into* an issue. The only
 * shape left is to keep the bytes here and write a markdown image link into the
 * body, which is what every client does.
 *
 * **These objects are readable without a session, and that is the whole point.**
 * github.com renders an issue body for whoever is looking at it, with no Meet
 * cookie in hand; an authenticated URL would be a broken image on the page the
 * picture exists for. So the address is the secret: a 128-bit random id, which
 * is the same bargain GitHub's own attachment URLs make. Nothing enumerates,
 * nothing is listed, and knowing one address tells you nothing about any other
 * — but anyone who has an address can read that picture, so it is a decision
 * about company screenshots and it is written down in PRIVACY.md.
 *
 * Uploading is member-only. Reading is not.
 */

/** Namespaced inside the attachments bucket: same store, different lifetime. */
const KEY_PREFIX = 'issue-images/';

/** 128 bits, hex. Long enough that guessing is not a strategy. */
function freshImageID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function issueImageKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

/** Hex only, and exactly the length we mint. A key is never built from input. */
export function isIssueImageID(id: string): boolean {
  return /^[0-9a-f]{32}$/u.test(id);
}

/**
 * Keep one picture and answer where it lives.
 *
 * The type is sniffed from the bytes rather than believed from the header: the
 * serve route hands this back to a browser, so what it says a file is has to
 * come from what the file actually is. Anything that is not one of the three
 * image formats we can vouch for is refused outright rather than stored and
 * served as something a browser might guess at.
 */
export async function storeIssueImage(
  env: Env,
  bytes: Uint8Array,
  origin: string,
): Promise<IssueImageResponse> {
  const bucket = env.ATTACHMENTS;
  if (!bucket) throw new ControlError('Image storage is not configured.', 503, 'not_configured');
  if (bytes.byteLength === 0) throw new ControlError('That file is empty.', 400, 'invalid_request');

  const contentType = sniffImageType(bytes);
  if (!contentType) {
    throw new ControlError('Only PNG, JPEG and WebP images can be attached.', 415, 'invalid_request');
  }

  const id = freshImageID();
  await bucket.put(issueImageKey(id), bytes, {
    httpMetadata: { contentType },
  });
  return { id, url: `${origin.replace(/\/$/u, '')}/api/issue-images/${id}` };
}

/**
 * Hand one picture back to whoever asks, including github.com.
 *
 * The headers are the interesting part. `nosniff` plus a content type taken
 * from the bytes at upload means a browser cannot be talked into treating an
 * upload as a document, and the `default-src 'none'` policy means that even if
 * one somehow were, it could load nothing and run nothing. Both matter more
 * than usual here: this is user-supplied content served from the app's own
 * origin, which is the classic way an image host becomes an XSS.
 *
 * Immutable, because the id is minted per upload and never reused — that URL
 * cannot come to mean different bytes.
 */
export async function serveIssueImage(env: Env, id: string): Promise<Response> {
  const bucket = env.ATTACHMENTS;
  if (!bucket || !isIssueImageID(id)) return missing();

  const object = await bucket.get(issueImageKey(id));
  if (!object) return missing();

  const contentType = object.httpMetadata?.contentType ?? 'application/octet-stream';
  return new Response(object.body, {
    headers: {
      'content-type': contentType,
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      // Never rendered as a page, whatever a browser is asked to do with it.
      'content-disposition': 'inline',
      'cache-control': 'public, max-age=31536000, immutable',
      // The picture is public; the referring page is not something to leak.
      'referrer-policy': 'no-referrer',
    },
  });
}

function missing(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' },
  });
}

/** Cap, exported for the clients so they refuse a file before uploading it. */
export { ISSUE_IMAGE_MAX_BYTES };

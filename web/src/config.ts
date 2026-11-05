/// <reference types="vite/client" />

import type { ControlErrorBody, ControlErrorCode } from '@starlings/contracts';
import {
  bookPermalink as bookPermalinkOn,
  parsePublicBookPath,
  parsePublicRoomPath,
  roomPermalink as roomPermalinkOn,
  type RoomPathParts,
} from '@starlings/contracts/paths';
import { transcriptPermalink as transcriptPermalinkOn } from '@starlings/contracts/transcript-export';
import { t } from './i18n';
import { noteRequestId } from './help-bus';
import { noteClientUpdateRequired } from './client-update';

const runtimeOrigin = globalThis.location?.origin ?? 'http://localhost';

export const apiBase = new URL(import.meta.env.VITE_API_ENDPOINT ?? '/api', runtimeOrigin)
  .toString()
  .replace(/\/$/, '');

/** The one member-only room exposed from the signed-in Team workspace. */
export const internalRoomPath = '/room/team';

/** Vite skips Google — production Web clients reject loopback redirect URIs. */
export function envisioningSignInHref(returnTo: string): string {
  const target = encodeURIComponent(returnTo);
  if (import.meta.env.DEV) return `${apiBase}/dev/session?return_to=${target}`;
  return `${apiBase}/auth/google/start?return_to=${target}`;
}

// Room path grammar and permalinks are shared with the Worker so client and
// server can never disagree about which URLs are rooms.
export { canonicalRoomPath } from '@starlings/contracts/paths';

let publicOrigin: string | null = null;

/**
 * The origin this workspace's links name: `<meta name="public-web-origin">`,
 * which the Worker writes on every page from `PUBLIC_WEB_ORIGIN`. Without it
 * (the Vite dev server) the page's own origin, never another workspace's
 *.
 */
export function workspacePublicOrigin(): string {
  if (publicOrigin) return publicOrigin;
  // The Worker's typecheck reads this file too, without the DOM library.
  const page = (globalThis as { document?: { querySelector(selector: string): { content?: string } | null } }).document;
  const content = page?.querySelector('meta[name="public-web-origin"]')?.content;
  let origin = runtimeOrigin;
  try { if (content) origin = new URL(content).origin; } catch { /* the page's own */ }
  publicOrigin = origin;
  return origin;
}

/** A room's link on this workspace's public origin. */
export function roomPermalink(slug: string, bookingToken?: string): string {
  return roomPermalinkOn(workspacePublicOrigin(), slug, bookingToken);
}

/** A room's booking page on this workspace's public origin. */
export function bookPermalink(slug: string): string {
  return bookPermalinkOn(workspacePublicOrigin(), slug);
}

/** A meeting's page on this workspace's public origin, the link a transcript share carries. */
export function transcriptPermalink(roomSlug: string, meetingId: string): string {
  return transcriptPermalinkOn(workspacePublicOrigin(), roomSlug, meetingId);
}
export type { RoomPathParts };

/**
 * Permanent room from the canonical /room/<slug>[/<token>] route.
 * Worker 404s unknown slugs; the SPA also verifies via GET /api/rooms/:slug.
 */
export function roomPathFromLocation(pathname: string): RoomPathParts | null {
  return parsePublicRoomPath(pathname);
}

/**
 * `/book/<slug>` — the booking surface as its own address, so a website's
 * `/meet/<slug>` and an emailed "find a time" link can both land
 * straight on it instead of routing through the join card.
 */
export function bookPathFromLocation(pathname: string): { slug: string } | null {
  return parsePublicBookPath(pathname);
}

/**
 * A control-plane failure with its stable cause attached.
 *
 * Callers branch on `code`, never on `message` — the prose is free to be
 * reworded, and matching on it used to silently change which failures dropped
 * the guest's lobby credentials.
 */
export class ControlRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: ControlErrorCode,
    readonly requestId?: string,
    /** On a refused form body: the body key `message` is about (`formRefusal`). */
    readonly field?: string,
  ) {
    super(message);
    this.name = t('ControlRequestError');
  }

  /** True when the guest's seat is gone and re-knocking is the only way back. */
  get needsRejoin(): boolean {
    return this.code === 'lobby_credentials_invalid'
      || this.code === 'lobby_credentials_missing'
      || this.code === 'request_not_found';
  }

  /** True when the meeting is simply over — an ending, not a failure. */
  get meetingIsOver(): boolean {
    return this.code === 'meeting_ended' || this.code === 'meeting_inactive';
  }

  /**
   * True when sign-in succeeded and the role refused (docs/ERRORS.md,
   * `capability_denied`). Signing in again cannot fix it, so a gate must
   * not ask for that.
   */
  get isCapabilityDenied(): boolean {
    return this.status === 403 && this.code === 'capability_denied';
  }
}

export function errorCodeOf(error: unknown): ControlErrorCode | undefined {
  return error instanceof ControlRequestError ? error.code : undefined;
}

export async function responseError(response: Response, fallback: string): Promise<ControlRequestError> {
  const body = await response.json().catch(() => null) as ControlErrorBody | null;
  const message = typeof body?.error === 'string' ? body.error : fallback;
  noteRequestId(body?.request_id);
  if (body?.code === 'client_update_required') noteClientUpdateRequired(message);
  return new ControlRequestError(message, response.status, body?.code, body?.request_id, body?.field);
}

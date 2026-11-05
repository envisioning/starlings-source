/**
 * The bounded dimensions of the privacy-safe operational error stream
 *, without zod, so the web entry can read them. `index.ts` builds
 * the wire schemas from these lists; the Worker, the web reporter and the
 * generated Swift enums all read the same values.
 */
export const OPERATIONAL_ERROR_SOURCES = ['worker', 'mac', 'ios', 'web'] as const;
export const OPERATIONAL_ERROR_PLATFORMS = ['cloudflare', 'macos', 'ios', 'web'] as const;
export const OPERATIONAL_ERROR_OPERATIONS = [
  'auth', 'calendar', 'room', 'lobby', 'media', 'transcription', 'chat', 'team',
  'work', 'docs', 'notes', 'search', 'profile', 'other', 'guest_room', 'guest_join', 'guest_lobby',
] as const;
export const OPERATIONAL_ERROR_CLASSES = [
  'network', 'timeout', 'http', 'authorization', 'decode', 'upstream', 'internal', 'media', 'unknown',
] as const;
export const OPERATIONAL_ERROR_CODES = [
  'worker.internal_error', 'worker.calendar_failure', 'worker.upstream_shape',
  'calendar_expired', 'calendar_failed', 'oauth_failed', 'upstream_shape', 'internal_error',
  'service.offline', 'service.timeout', 'service.unavailable', 'service.invalid_response',
  'auth.session_expired', 'connect.timeout', 'connect.network', 'connect.webrtc',
  'connect.token_rejected', 'session.dropped', 'session.server_shutdown',
  'media.audio_engine', 'media.capture_format', 'transcription.engine_failed',
  'transcription.audio_recovery_failed', 'transcription.no_audio_frames', 'chat.not_connected',
  //: a render the web app's error boundary caught, and an error or
  // rejection nothing in the page handled.
  'web.render_failed', 'web.unhandled_error',
  'guest.room_load_failed', 'guest.join_failed', 'guest.request_failed', 'guest.page_failed',
] as const;
/**
 * Guest join-flow values: the only ones the anonymous route accepts. Each is
 * also a member value (`satisfies`), so a member's guest-door failure fits
 * the signed-in route. Literal lists, not spreads: a spread keeps every list
 * in the web entry bundle.
 */
export const GUEST_OPERATIONAL_ERROR_CODES = [
  'guest.room_load_failed', 'guest.join_failed', 'guest.request_failed', 'guest.page_failed',
] as const satisfies readonly (typeof OPERATIONAL_ERROR_CODES)[number][];
export const GUEST_OPERATIONAL_ERROR_OPERATIONS = [
  'guest_room', 'guest_join', 'guest_lobby',
] as const satisfies readonly (typeof OPERATIONAL_ERROR_OPERATIONS)[number][];
export const GUEST_OPERATIONAL_ERROR_CLASSES = [
  'network', 'timeout', 'http', 'decode', 'unknown',
] as const satisfies readonly (typeof OPERATIONAL_ERROR_CLASSES)[number][];
export const OPERATIONAL_SERVER_CODES = [
  'calendar_expired', 'calendar_failed', 'oauth_failed', 'upstream_shape', 'internal_error',
] as const;

export type OperationalErrorOperation = (typeof OPERATIONAL_ERROR_OPERATIONS)[number];

/**
 * Maps a request path (`/api/...`) to a fixed category; the path itself is
 * never stored. The Worker and the web reporter both name operations with it.
 */
export function operationForRequest(pathname: string): OperationalErrorOperation {
  const path = pathname.toLowerCase();
  if (path.includes('/calendar')) return 'calendar';
  if (path.includes('/auth/')) return 'auth';
  if (path.includes('/docs/')) return 'docs';
  if (path.includes('/quick-notes')) return 'notes';
  if (path.includes('/crm/') || path.includes('/work')) return 'work';
  if (path.includes('/threads') || path.includes('/messages') || path === '/mcp') return 'chat';
  if (path.includes('/peers') || path.includes('/presence')) return 'team';
  if (path.includes('/join-requests')) return 'lobby';
  if (path.includes('/api/owner/')) return 'room';
  if (path.includes('/rooms/')) {
    return 'room';
  }
  if (path.includes('/search')) return 'search';
  if (path.includes('/profile')) return 'profile';
  return 'other';
}

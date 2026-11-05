import type { GuestClientInput } from '@starlings/contracts';

/**
 * What the host sees next to a waiting guest: which surface they are on, at the
 * coarsest useful grain. Deliberately not a user-agent string — the lobby needs
 * "browser, on a phone", not a fingerprint, and nothing is authorized on it.
 *
 * `app` is always `web` here; the Mac and iOS clients report their own.
 */
export function guestClient(): GuestClientInput {
  return { app: 'web', device: detectDevice() };
}

function detectDevice(): GuestClientInput['device'] {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;

  // iPadOS defaults to a desktop Safari user agent, so the only reliable tell
  // is a "Mac" that reports touch points.
  const iPadInDesktopMode = /Macintosh/u.test(ua)
    && typeof navigator !== 'undefined'
    && navigator.maxTouchPoints > 1;
  if (/iPad/u.test(ua) || iPadInDesktopMode) return 'tablet';
  // Android tablets omit the `Mobile` token that Android phones carry.
  if (/Android/u.test(ua) && !/Mobile/u.test(ua)) return 'tablet';

  if (/iPhone|iPod|Android|Windows Phone/u.test(ua)) return 'mobile';

  // Client hints are the authoritative answer where they exist; the UA sniffing
  // above is the fallback for Safari and Firefox, which do not implement them.
  const hints = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (hints?.mobile === true) return 'mobile';

  return 'desktop';
}

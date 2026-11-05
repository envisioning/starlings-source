import { t } from './i18n';
/**
 * What this browser can do, asked before the guest spends anything on getting
 * into a meeting it cannot join.
 *
 * The failure this exists for: a browser without WebRTC used to take a name,
 * an email, a Turnstile challenge and a knock, and only fall over at the point
 * the SFU connection was attempted — by which time the owner had been asked to
 * admit someone who could never arrive. Feature detection, never user-agent
 * sniffing: the question is whether the APIs are here, and a UA string is a
 * guess about that at best.
 */

export type BrowserSupport =
  | { ok: true }
  | { ok: false; reason: string };

export function checkBrowserSupport(): BrowserSupport {
  if (typeof window === 'undefined') return { ok: true };
  if (typeof RTCPeerConnection === 'undefined') {
    return {
      ok: false,
      reason: t('This browser cannot make video calls. Open the link in Chrome, Edge, Safari, or Firefox.'),
    };
  }
  // Undefined on plain HTTP and in some embedded webviews. Both are worth the
  // same sentence to a guest — the link works elsewhere.
  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      ok: false,
      reason: t('This browser will not give a page access to a camera or microphone. Open the link in Chrome, Edge, Safari, or Firefox.'),
    };
  }
  return { ok: true };
}

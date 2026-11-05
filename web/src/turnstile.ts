import { t } from './i18n';
// Cloudflare Turnstile for the browser's unauthenticated writes (knock, book,
// bug report). The Worker half is services/control-plane/src/turnstile.ts.

/** How long to wait for a token before giving up and letting the call proceed. */
const TOKEN_TIMEOUT_MS = 12_000;
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

const siteKey = (import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '').trim();

/**
 * False until `VITE_TURNSTILE_SITE_KEY` is set at build time. Every caller has
 * to work in both states — this is off in dev — and the Worker only enforces
 * once its own secret exists, so the two flip together or browser joining
 * breaks. Native knocks skip the check.
 */
export const turnstileEnabled = siteKey !== '';

type TurnstileAPI = {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(widgetId: string): void;
};

declare global {
  interface Window {
    turnstile?: TurnstileAPI;
  }
}

let scriptPromise: Promise<TurnstileAPI> | null = null;

function loadTurnstile(): Promise<TurnstileAPI> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileAPI>((resolve, reject) => {
    if (window.turnstile) {
      resolve(window.turnstile);
      return;
    }
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error(t('Turnstile loaded without its API.')));
    };
    script.onerror = () => {
      // Let the next caller retry rather than caching the failure forever —
      // this is usually a blocked script or a flaky network, not a permanent no.
      scriptPromise = null;
      reject(new Error(t('Turnstile failed to load.')));
    };
    document.head.append(script);
  });
  return scriptPromise;
}

/**
 * Attach a token to a JSON body when a widget is configured. Callers that
 * must not fail closed on a blocked script (bug reports) should catch and
 * send without the field — the Worker decides.
 */
export async function withTurnstileToken<T extends Record<string, unknown>>(
  action: string,
  body: T,
): Promise<T & { turnstile_token?: string }> {
  const token = await turnstileToken(action);
  return token ? { ...body, turnstile_token: token } : body;
}

/**
 * Solve a Turnstile challenge and return the token, or `undefined` when no
 * widget is configured.
 *
 * `interaction-only` means the guest sees nothing at all in the common case —
 * a checkbox appears only when Cloudflare actually wants one. That matters
 * here: this sits in front of joining a meeting, and a visible bot check on
 * every knock would be worse than the spam it prevents.
 *
 * Throws if the challenge fails or times out. Callers on the join and book
 * paths should let that surface — the Worker will reject the write anyway once
 * its secret is set, and a clear "bot check failed" beats a silent 403.
 */
export async function turnstileToken(action: string): Promise<string | undefined> {
  if (!turnstileEnabled) return undefined;
  const api = await loadTurnstile();

  // Empty and invisible in the common case (`interaction-only`). Centred and
  // above everything for the rare time Cloudflare shows a checkbox: a
  // challenge behind the meeting UI is a challenge nobody can solve.
  const container = document.createElement('div');
  container.className = 'fixed top-1/2 left-1/2 z-100 -translate-x-1/2 -translate-y-1/2';
  document.body.append(container);

  let widgetId: string | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(t('Bot check timed out.'))), TOKEN_TIMEOUT_MS);
      const settle = (finish: () => void) => {
        window.clearTimeout(timer);
        finish();
      };
      widgetId = api.render(container, {
        sitekey: siteKey,
        action,
        appearance: 'interaction-only',
        callback: (token: string) => settle(() => resolve(token)),
        'error-callback': () => settle(() => reject(new Error(t('Bot check failed.')))),
        'timeout-callback': () => settle(() => reject(new Error(t('Bot check timed out.')))),
      });
    });
  } finally {
    // Tokens are single-use, so the widget is torn down after every solve
    // rather than kept around and re-executed.
    if (widgetId !== undefined) api.remove(widgetId);
    container.remove();
  }
}

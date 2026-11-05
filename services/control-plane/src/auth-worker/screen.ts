// The sign-in screen on the auth host ( part 1). Plain
// server-rendered HTML: no script, no external style, no font file. The
// copy law holds (docs/DESIGN.md): the workspace's mark and name when the
// begin request carried them, and the buttons. Nothing else. With an auth
// session that may answer, Continue as <address> comes first and Google
// second.
//
// The colours are the house tokens: the app's dark canvas by default
// (web/src/styles.css), the house paper in light (web/marketing/house.css).
// The one action takes the workspace's accent when the begin request carried
// one, through the same palette the workspace draws (workspace-accent.ts);
// otherwise a neutral ink fill. Never Envisioning's accent (MZ, 2026-10-04).
import { PRODUCT_SITE_ORIGIN } from '@starlings/contracts/deployment';
import { CENTRAL_AUTH_START_PATH, EMAIL_LINK_REQUEST_PATH } from '@starlings/contracts/browser-auth';
import { accentPalette } from '@starlings/contracts/workspace-accent';
import { GATHERING_DOTS, GATHERING_MOTION, GATHERING_VIEWBOX } from '@starlings/contracts/gathering-dots';

const STYLE = `
:root{color-scheme:dark;--paper:#202128;--ink:#fafafa;--accent:#fafafa;--accent-hover:#e4e4e7;--accent-down:#c8c8cc;--on-accent:#202128}
@media(prefers-color-scheme:light){:root{color-scheme:light;--paper:#f6f6f3;--ink:#20231f;--accent:#20231f;--accent-hover:#363a34;--accent-down:#0f110e;--on-accent:#f6f6f3}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;display:grid;place-items:center;padding:16px}
main{width:100%;max-width:320px;display:flex;flex-direction:column;align-items:center;gap:20px}
.mark{display:block;width:56px;height:56px;background:var(--ink)}
.flock{width:56px;height:56px;color:var(--ink)}
.flock circle{animation:gathering-drift var(--period) ease-in-out infinite}
@keyframes gathering-drift{0%,100%{r:calc(var(--rest) * ${GATHERING_MOTION.driftLow})}50%{r:calc(var(--rest) * ${GATHERING_MOTION.driftHigh})}}
@media(prefers-reduced-motion:reduce){.flock circle{animation:none}}
h1{margin:0;font-size:28px;line-height:1.15;letter-spacing:-.02em;font-weight:400;text-align:center;overflow-wrap:anywhere}
form{width:100%;margin:0}
button{width:100%;min-height:44px;border:0;border-radius:9px;background:var(--accent);color:var(--on-accent);font:inherit;font-size:15px;font-weight:500;cursor:pointer}
button:hover{background:var(--accent-hover)}
button:active{background:var(--accent-down)}
button:focus-visible,input:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
.host{margin:-12px 0 0;font-size:13px;opacity:.6;overflow-wrap:anywhere;text-align:center}
button{display:flex;align-items:center;justify-content:center;gap:10px}
.g{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:4px;background:#fff;flex:none}
.or{width:100%;display:flex;align-items:center;gap:12px;font-size:13px;opacity:.6}
.or::before,.or::after{content:"";flex:1;height:1px;background:currentColor;opacity:.4}
form.email{display:flex;flex-direction:column;gap:10px}
input{width:100%;min-height:44px;border-radius:9px;border:1px solid color-mix(in srgb,var(--ink) 25%,transparent);background:transparent;color:var(--ink);font:inherit;font-size:15px;padding:0 12px}
button.quiet{background:transparent;color:var(--ink);border:1px solid color-mix(in srgb,var(--ink) 25%,transparent)}
button.quiet:hover{background:color-mix(in srgb,var(--ink) 8%,transparent)}
.foot{margin:8px 0 0;font-size:13px;opacity:.6}
.foot a{color:inherit}
`.replace(/\n/gu, '');

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escape(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => ESCAPES[char]!);
}

export interface SignInScreen {
  ticket: string;
  /** The workspace origin from the binding props, never from the browser. */
  workspaceOrigin: string;
  workspaceName: string | null;
  /** A local path on `workspaceOrigin`, checked by the begin schema. */
  markPath: string | null;
  /** The workspace's accent; null draws the neutral button. */
  accent?: string | null;
  /** The local path the workspace returns to; the email link carries it. */
  returnPath?: string;
  /**
   * The address of this browser's auth session (sessions.ts), when it may
   * answer this attempt. The screen then offers it first, and Google second.
   */
  continueAs?: string | null;
}

/** The workspace's accent as the button's tokens, dark and light; empty when it has none or it is unreadable. */
function accentStyle(accent: string | null | undefined): string {
  const palette = accentPalette(accent);
  if (!palette) return '';
  const { dark, light } = palette;
  return `:root{--accent:${dark.accent};--accent-hover:${dark.hover};--accent-down:${dark.down};--on-accent:${dark.onAccent}}`
    + `@media(prefers-color-scheme:light){:root{--accent:${light.cta};--accent-hover:${light.ctaHover};--accent-down:${light.ctaDown};--on-accent:${dark.onAccent}}}`;
}

/**
 * The Starlings flock, drifting, for a workspace with no mark of its own
 * (MZ, 2026-10-05): inline SVG and a CSS keyframe, no script. The motion is
 * the registry's `drift` (web/src/gathering-dots.css): radius only, each dot
 * on its own clock from the shared table, as the apps draw it.
 */
const FLOCK = `<svg class="flock" viewBox="0 0 ${GATHERING_VIEWBOX} ${GATHERING_VIEWBOX}" fill="currentColor" aria-hidden="true">`
  + GATHERING_DOTS.map((dot) => {
    const period = GATHERING_MOTION.driftSeconds * dot.driftFactor;
    return `<circle cx="${dot.x}" cy="${dot.y}" r="${dot.radius}" style="--rest:${dot.radius}px;--period:${period.toFixed(2)}s;animation-delay:-${(dot.driftPhase * period).toFixed(2)}s"></circle>`;
  }).join('')
  + '</svg>';

/**
 * Google's G, its four official colours, on the white chip Google's own
 * dark button uses, so the brand rules hold on any accent behind it.
 */
const GOOGLE_G = '<span class="g" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 48 48">'
  + '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>'
  + '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>'
  + '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>'
  + '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>'
  + '</svg></span>';

/**
 * The screen's HTML. Each button POSTs the ticket. Continue with Google goes
 * to Google; Continue as <address> answers from the auth session.
 */
export function signInScreenHTML(screen: SignInScreen): string {
  // The workspace's mark in one colour, its outline in the ink, as every
  // client draws it (MZ, 2026-10-05); the flock when it has none.
  const markURL = screen.markPath ? escape(`${screen.workspaceOrigin}${screen.markPath}`) : null;
  const mark = markURL ? `<span class="mark" style="-webkit-mask:url('${markURL}') center/contain no-repeat;mask:url('${markURL}') center/contain no-repeat"></span>` : FLOCK;
  const title = screen.workspaceName ? `Sign in to ${escape(screen.workspaceName)}` : 'Sign in';
  // The address under the name, small: the workspace is its name first.
  const host = `<p class="host">${escape(new URL(screen.workspaceOrigin).host)}</p>`;
  const name = `<h1>${title}</h1>${host}`;
  const continueAs = screen.continueAs
    ? `<form method="post" action="${CENTRAL_AUTH_START_PATH}"><input type="hidden" name="ticket" value="${escape(screen.ticket)}">`
      + `<input type="hidden" name="with" value="session"><button type="submit">Continue as ${escape(screen.continueAs)}</button></form>`
    : '';
  const email = `<div class="or">or</div><form class="email" method="post" action="${escape(`${screen.workspaceOrigin}${EMAIL_LINK_REQUEST_PATH}`)}">`
    + `<input type="hidden" name="return_to" value="${escape(screen.returnPath ?? '/')}">`
    + '<input type="email" name="email" required autocomplete="email" placeholder="you@company.com" aria-label="Email address">'
    + '<button class="quiet" type="submit">Email me a sign-in link</button></form>';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
    + `<title>${title}</title><style>${STYLE}${accentStyle(screen.accent)}</style></head><body><main>${mark}${name}`
    + continueAs
    + `<form method="post" action="${CENTRAL_AUTH_START_PATH}"><input type="hidden" name="ticket" value="${escape(screen.ticket)}">`
    + `<button${screen.continueAs ? ' class="quiet"' : ''} type="submit">${GOOGLE_G}Continue with Google</button></form>${email}`
    + `<p class="foot">Sign-in by <a href="${PRODUCT_SITE_ORIGIN}">Starlings</a></p></main></body></html>`;
}

/**
 * The screen's response headers. No script runs; the form posts only to this
 * host, and its redirect only to Google; no page may frame it.
 */
export function signInScreenHeaders(screen: SignInScreen): Headers {
  return new Headers({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `img-src ${screen.markPath ? screen.workspaceOrigin : "'none'"}`,
      `form-action 'self' https://accounts.google.com ${screen.workspaceOrigin}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; '),
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
  });
}

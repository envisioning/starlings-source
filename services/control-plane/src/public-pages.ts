import { accentPalette } from '@starlings/contracts/workspace-accent';
import { json } from './http';

// The status page and the 404 every public path ends in. Moved out of `index.ts` with the public
// routes. The Mac and iPhone downloads are the product site's
// (services/marketing), not a workspace's.

// Keep server-rendered HTML pages on the same dark surface ladder as the SPA.
// These pages cannot load web/src/styles.css before their first response.
const WEB_DARK_SURFACE_BG = '#202128';
const WEB_DARK_SURFACE_RAISED = '#343640';
const WEB_DARK_TEXT_MUTED = '#a3a3a3';
/** Envisioning's lime, `--accent` on the SPA's dark theme: the link on a workspace with no accent. */
const DEFAULT_LINK = '#d6f249';

/**
 * A one-message page on the workspace host, in Starlings' dark look. The
 * link takes the workspace's accent as the SPA's dark theme draws it
 * (`workspaceAccent`), else the default lime.
 */
export function statusPage(title: string, message: string, status = 200, accent: string | null = null): Response {
  const link = accentPalette(accent)?.dark.accent ?? DEFAULT_LINK;
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · Starlings</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: ${WEB_DARK_SURFACE_BG}; color: #fafafa; font: 16px/1.5 system-ui, sans-serif; }
    main { width: min(100% - 48px, 420px); padding: 32px; background: ${WEB_DARK_SURFACE_RAISED};
      border: 1px solid rgb(255 255 255 / 0.1); border-radius: 12px; }
    h1 { margin: 0 0 12px; font-size: 26px; }
    p { margin: 0; color: ${WEB_DARK_TEXT_MUTED}; }
    a { display: inline-block; margin-top: 24px; color: ${link}; font-weight: 600; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="/">Back to Starlings</a>
  </main>
</body>
</html>`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );
}

export function publicNotFound(request: Request): Response {
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('text/html')) {
    return new Response(
      `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Not found · Starlings</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: ${WEB_DARK_SURFACE_BG}; color: #fafafa; font: 16px/1.45 system-ui, sans-serif; }
    main { text-align: center; padding: 24px; }
    h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; }
    p { margin: 0; color: ${WEB_DARK_TEXT_MUTED}; }
  </style>
</head>
<body>
  <main>
    <h1>Not found</h1>
    <p>This page doesn’t exist.</p>
  </main>
</body>
</html>`,
      {
        status: 404,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    );
  }
  return json({ error: 'Not found.' }, 404);
}

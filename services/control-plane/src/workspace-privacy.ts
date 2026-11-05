import { PRODUCT_SITE_ORIGIN } from '@starlings/contracts/deployment';
import { statusPage } from './public-pages';
import { readWorkspaceDefaults } from './workspace-defaults';
import { workspaceAccent, workspaceDisplayName } from './workspace-profile';

function escape(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/** Workspace contacts stay here; the product's data policy stays on the product site. */
export async function workspacePrivacy(request: Request, env: Env): Promise<Response> {
  const [settings, name, accent] = await Promise.all([readWorkspaceDefaults(env), workspaceDisplayName(env), workspaceAccent(env)]);
  if (settings.source === 'default') {
    const url = new URL(request.url);
    return Response.redirect(`${PRODUCT_SITE_ORIGIN}${url.pathname}${url.search}${url.hash}`, 302);
  }
  const defaults = settings.defaults;
  const response = statusPage(`Privacy · ${escape(name)}`,
    `For privacy requests in this workspace, write to <a href="mailto:${escape(defaults.privacy_email)}">${escape(defaults.privacy_email)}</a>.<br>
     For other questions, write to <a href="mailto:${escape(defaults.contact_email)}">${escape(defaults.contact_email)}</a>.<br>
     <a href="${PRODUCT_SITE_ORIGIN}/privacy">How Starlings handles your data</a>.`, 200, accent);
  return request.method === 'HEAD' ? new Response(null, response) : response;
}

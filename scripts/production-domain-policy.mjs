/** A rollout alias may coexist with the legacy workers.dev primary origin. */
export function customRoutesMatchAliases(routes, aliases) {
  const origins = new Set(String(aliases ?? '').split(',').map(value => value.trim()));
  return routes.every(route => {
    if (!route || typeof route !== 'object' || route.custom_domain !== true || typeof route.pattern !== 'string') return false;
    if (!/^[a-z0-9.-]+$/u.test(route.pattern)) return false;
    try {
      const origin = new URL(`https://${route.pattern}`);
      return origin.hostname === route.pattern && origins.has(origin.origin);
    } catch { return false; }
  });
}

/**
 * A self-hosted workspace's own domain: `origin` is an exact
 * HTTPS origin, and the same config routes that host as a custom domain, so
 * the origin and the route agree.
 */
export function originHasCustomDomainRoute(origin, routes) {
  if (typeof origin !== 'string' || !Array.isArray(routes)) return false;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.protocol !== 'https:' || parsed.origin !== origin) return false;
  return routes.some((route) => route?.custom_domain === true && route.pattern === parsed.hostname);
}

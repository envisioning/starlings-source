// The Worker named `meet`: a forwarder and nothing else (#736).
//
// Envisioning's Worker was `meet` until it was renamed in place to
// `starlings-envisioning`. Its workers.dev host
// belongs to the name, and installed apps, Claude connectors and OAuth clients
// still call it (ADR 0004 decision 14: old addresses are served). This Worker
// keeps the name and passes every request, WebSocket upgrades included, to
// the renamed Worker unchanged, so the original host reaches it and
// PAGE_REDIRECT_FROM and WORKSPACE_ORIGIN_ALIASES apply as before.

interface AliasEnv {
  ENVISIONING: Fetcher;
}

export default {
  fetch(request: Request, env: AliasEnv): Promise<Response> {
    return env.ENVISIONING.fetch(request);
  },
} satisfies ExportedHandler<AliasEnv>;

---
kind: intent
status: active
verified: 2026-10-02
summary: "ADR 0004: the product is Starlings; every instance is <slug>.starlings.example behind one dispatch Worker, a custom domain is an optional upsell for guest links; site.example is the site; Envisioning moves first — accepted, not built"
---

# 0004 — Instance addresses

**Status:** accepted · not built · **Date:** 2026-10-02 · **Decided by:** MZ

Where a firm's instance lives on the web, and how Envisioning's instance moves
there first. This decides addressing and the front door. The delivery model
under it is BUSINESS (HQ Docs) Q3: one instance per firm, its own
Worker and D1, provisioned with no human step. Nothing here adds a
`workspace_id`; isolation is an instance boundary, not a column.

Supersedes [ADR 0002](0002-the-name.md) on the name, and the Free-path and
inbound-email sections of DNS (HQ Docs), which assumed moving the
`org.example` zone to Cloudflare.

---

## Context

- Starlings is served from `legacy.org.example`. Envisioning's old `.com` host
  is a Gandi web-redirect (302) to it, not a host (`curl -sI`, 2026-10-02).
  `SERVED_WEB_ORIGIN`, `WEB_ORIGIN` and `PUBLIC_API_ORIGIN` all name
  workers.dev; `PUBLIC_WEB_ORIGIN` names the `.com` for invites
  ([deployment.ts](../../packages/contracts/src/deployment.ts)).
- `org.example`, `site.example` and `starlings.example` all sit on Gandi
  nameservers. `org.example` carries company mail; nothing lives on the
  other two.
- The product is **Starlings** (MZ, 2026-10-02), not Quorum or Dossier.
  **Starlings** is what Envisioning calls its own instance.
- The code already splits *the host that serves* (`SERVED_WEB_ORIGIN`) from
  *the host guests see* (`PUBLIC_WEB_ORIGIN`). This ADR keeps that split and
  makes it per instance.

## Decisions (locked)

| # | Decision |
| --- | --- |
| 1 | **One dispatch Worker in front, one instance per firm behind it.** The dispatch Worker owns `*.starlings.example`, every custom hostname and `auth.starlings.example`. It resolves the `Host` header against a hostname table and hands the request to that firm's Worker (Workers for Platforms), which has its own D1. The front door is shared; the data never is. |
| 2 | **Two domains, two jobs.** `site.example` is the product site: marketing, pricing, public help, sign-up. `starlings.example` is the app. An instance host serves the instance, never product marketing. |
| 3 | **Every instance gets `<slug>.starlings.example`, permanently.** This is the instance's platform address and the one machines and members use: API, MCP, OAuth metadata, native apps, `llms.txt`, every signed-in page. It never goes away while the instance exists, custom domain or not. |
| 4 | **Slug rules.** `a-z0-9-`, 3–63 characters, no leading or trailing hyphen, no `--` in positions 3–4 (keeps out `xn--` look-alikes). Lowercase only; compared lowercase. **One exception (MZ, 2026-10-03):** `hq`, the platform's own experiment workspace. It is two characters, so no firm can ever take it. |
| 5 | **Reserved slugs.** `www app api auth admin mcp mail in custom status help docs cdn assets static dev staging test billing support starlings starlingshq site` (`site` added 2026-10-04: a workspace's Worker is `starlings-<slug>`, and `starlings-site` is the product site; `keep` and the prefixes `docs-` and `keep-` added 2026-10-04: a workspace's own Docs and Keep answer at `docs-<slug>.starlings.example` and `keep-<slug>.starlings.example`), plus names that impersonate another brand. The list lives in `packages/contracts`, so every surface that validates a slug reads one list. |
| 6 | **Only an admin creates a slug** until self-serve provisioning exists. |
| 7 | **A renamed slug redirects and is never reissued.** Invites, calendar events and MCP connectors carry the old host; handing it to a new firm would deliver them to a stranger. |
| 8 | **A custom domain is an optional upsell, subdomains only.** The firm's own `meet.theirco.com` CNAMEs to `custom.starlings.example`; Cloudflare for SaaS verifies it and issues the certificate, and the dispatch Worker routes it like a slug host. Bare apex domains need Cloudflare Enterprise and are not offered. No price is set here; money lives in BUSINESS (HQ Docs). |
| 9 | **A custom domain carries guest links; the slug host carries everything else.** On the custom domain the instance serves guest-facing paths (rooms, booking, guest threads, invite permalinks) and 301s every other path to the slug host. Members sign in once, on one host. `PUBLIC_WEB_ORIGIN` becomes an instance setting that defaults to the slug host. |
| 10 | **Google sign-in happens on `auth.starlings.example`.** Google does not accept wildcard redirect URIs, so no instance host can be the Google callback. The auth host verifies identity and hands the instance host a one-time code, which the instance exchanges for its own session. One Google OAuth app, named Starlings. MCP OAuth stays per instance host; clients register against each. |
| 11 | **Cookies are host-only.** Never `Domain=.starlings.example`: one instance's host must not read another's session. Every host runs our code only, so listing `starlings.example` on the Public Suffix List is not needed now; revisit if an instance can ever serve its own content. |
| 12 | **An unknown host gets a plain 404 that links `site.example`.** The dispatch Worker answers it without touching any instance. |
| 13 | **Instance mail lives on `starlings.example`.** Inbound: `<slug>.<local>@starlings.example`, one Email Routing catch-all on the apex to the dispatch Worker, which forwards by slug. (Amended 2026-10-07: `in.starlings.example` could not work, because Cloudflare offers a catch-all only on an apex.) Outbound sends from a `starlings.example` sender with the instance's name. `org.example` stays on Gandi and is never touched for Starlings. |
| 14 | **Old addresses are served forever.** Shipped Mac and iOS builds, registered Claude connectors and sent invites carry them. See §What does not move. |

## Envisioning moves first

Envisioning is instance 1: slug `envisioning`, host
`envisioning.starlings.example` (amended 2026-10-19: Envisioning keeps no custom
domain, and invite links name the instance host). Until brings the dispatch Worker, the
existing `meet` Worker takes these hosts directly by route. When the
dispatcher arrives, the `meet` Worker moves behind it with no address change.

| Step | What | By hand or in the repo |
| --- | --- | --- |
| 1 | Add `starlings.example` to Cloudflare (Free) and point Gandi's nameservers at it. | By hand: Cloudflare, Gandi |
| 2 | Worker custom domains `envisioning.starlings.example` and `auth.starlings.example` on the `meet` Worker. No wildcard route yet. | By hand: Cloudflare; then `wrangler.jsonc` routes |
| 3 | Cloudflare for SaaS on `starlings.example`: fallback origin `custom.starlings.example`, custom hostname for a firm's own domain (amended 2026-10-19: Envisioning has none). At Gandi, replace the web-redirect with a CNAME to `custom.starlings.example`. | By hand: Cloudflare, Gandi |
| 4 | Central sign-in on `auth.starlings.example` (decision 10). Add its callback to the Google OAuth client. | Repo; Google Cloud console by hand |
| 5 | One commit that flips the origins: `WEB_ORIGIN`, `PUBLIC_API_ORIGIN`, `SERVED_WEB_ORIGIN` → `https://envisioning.starlings.example`; `PUBLIC_WEB_ORIGIN` followed on 2026-10-19. Same commit: the Swift mirror `EnvisioningIdentity.swift`, the host checks in `StarlingsVersionLine.swift` and `iOS/StarlingsAppVersion.swift`, the allowlist in `scripts/check-production-config.mjs`, and `DOWNLOAD_ORIGIN` in the release scripts. | Repo |
| 6 | Guest-path split on the custom domain and 301s from workers.dev pages (decisions 9, 14). | Repo |
| 7 | Inbound mail: Email Routing on the `starlings.example` apex, catch-all to the `meet` Worker (`scripts/ensure-mail-routing.mjs --apply`), then `INBOUND_EMAIL: "on"` for `meet`. | Script with a scoped API token; then `wrangler.jsonc` |
| 8 | Release Mac and iOS builds with the new origins. | Repo + release |
| 9 | Rewrite DNS (HQ Docs), [WORKERS_DEV.md](../WORKERS_DEV.md), `AGENTS.md`, `/help` and `llms.txt` to the new hosts. | Repo |

Every signed-in browser and native client signs in once more after step 5:
cookies are host-only and `OwnerSessionStore` keys the Keychain per API
endpoint. That is the one-time cost of this move and the reason to make it
once, before makes the native apps instance-aware.

## What does not move

| Kept | Why |
| --- | --- |
| `legacy.org.example` `/mcp`, OAuth endpoints, `/api`, the update feed, `/download` | Registered connectors and every installed app call them. OAuth clients and updaters do not reliably follow redirects. Served, not redirected. Pages there 301. |
| The legacy JWT issuer (`LEGACY_SESSION_ISSUER`) | An identifier, not a URL. Verify accepts it until 2026-12-15, so old tokens live out their lifetime. |
| ICS UIDs in files already sent | Changing them duplicates every calendar event already sent. New files name the instance host. |
| `webcredentials:keep.workers.org.example` | Keep's, not Starlings's. |
| Bundle IDs | Never change. Renaming the app to Starlings is its own release, not part of this move. |

## Consequences

- The address shape for every firm exists before the second firm does, so
  provisions a hostname row and a Worker, not a migration.
- The first firm on its own custom domain dogfoods the upsell. Envisioning
  dropped its `.com` invite host on 2026-10-19.
- Sign-in gains a hop (auth host → instance host). That hop is what lets one
  Google OAuth app serve every firm.
- The product's update feed and downloads belong to Starlings, not to an
  instance; they move to a product host with the rename, and the old
  Envisioning URLs keep serving (decision 14).

## Open questions

1. **How long does a renamed slug redirect** before it 404s (still never
   reissued)?
2. **Do Workers for Platforms user Workers carry what an instance needs?**
   Durable Objects (`RoomCoordinator`, `ThreadCoordinator`), the `email`
   handler behind a dispatcher, rate-limit bindings, Workers AI. Verify
   against Cloudflare's docs before commits to it.
3. **Does Email Routing take the inbound shape in decision 13** at the
   volumes we expect? Verify before step 7. Answered in part on 2026-10-07:
   the shape needs the apex, since a catch-all exists only there; volume is
   still unverified.

// The inbound mailbox's slug comes from a starlings.example origin of the
// workspace (`workspaceSlug`, meet#1056). The suite's config has none, because
// a rollout alias also becomes the site origin of event pages and the
// workspace descriptor. The mail tests give the mailbox one for their file and
// take it back after: `meet-test.<local>@starlings.example`.
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll } from 'vitest';

export const MAILBOX_ALIAS = 'https://meet-test.starlings.example';

export function withInboundMailbox(): void {
  const target = env as unknown as { WORKSPACE_ORIGIN_ALIASES: string };
  let saved = '';
  beforeAll(() => {
    saved = target.WORKSPACE_ORIGIN_ALIASES;
    target.WORKSPACE_ORIGIN_ALIASES = MAILBOX_ALIAS;
  });
  afterAll(() => {
    target.WORKSPACE_ORIGIN_ALIASES = saved;
  });
}

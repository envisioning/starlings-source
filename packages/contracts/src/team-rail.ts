/**
 * The order of Team's PEOPLE and AGENTS blocks, and which conversations trail
 * them, decided once.
 *
 * Whoever you have a conversation with comes first, latest message first; then
 * everybody else, in the order the server gave. Unread does not jump the queue:
 * the dot and the weight say it. A conversation whose other side left the
 * roster trails PEOPLE, drawn from the thread. Swift (Mac and iOS) and the web
 * each wrote this; this is the one statement. Swift mirrors the rules
 * (`Sources/TeamRailRules.swift`), reads the conversation kind from the table
 * generated out of this module, and `fixtures/team-rail.json` pins the rules.
 */

/** The conversation kind that is a person's own (or a group's), as the server names it. */
export const TEAM_RAIL_DIRECT_KIND = 'dm';

/** A direct conversation, reduced to what the order reads. */
export interface TeamRailDirect {
  /** `TEAM_RAIL_DIRECT_KIND` for a direct or group conversation; anything else is not one. */
  kind: string;
  /** A group has more than one other person. It has no row of its own. */
  isGroup: boolean;
  peerEmail: string | null;
  /** Milliseconds since the epoch; null when nothing has been said. */
  lastMessageAt: number | null;
}

/** Whether a conversation is one person's own: a direct, not a group. */
function isOneToOne(direct: TeamRailDirect): boolean {
  return direct.kind === TEAM_RAIL_DIRECT_KIND && !direct.isGroup;
}

/**
 * The roster's emails in rail order: people you have talked with, latest
 * message first, then the rest as they came.
 */
export function teamRailOrder(emails: readonly string[], directs: readonly TeamRailDirect[]): string[] {
  const latest = new Map<string, number>();
  for (const direct of directs) {
    if (!isOneToOne(direct) || !direct.peerEmail || direct.lastMessageAt === null) continue;
    const known = latest.get(direct.peerEmail);
    if (known !== undefined && known >= direct.lastMessageAt) continue;
    latest.set(direct.peerEmail, direct.lastMessageAt);
  }
  const talked = emails
    .filter((email) => latest.has(email))
    .sort((left, right) => (latest.get(right) ?? 0) - (latest.get(left) ?? 0));
  const rest = emails.filter((email) => !latest.has(email));
  return [...talked, ...rest];
}

/** A conversation whose other side is not on the roster and is not you: it trails PEOPLE. */
export function isStrayConversation(
  direct: TeamRailDirect,
  rosterEmails: ReadonlySet<string>,
  selfEmail: string | null | undefined,
): boolean {
  if (!isOneToOne(direct) || !direct.peerEmail) return false;
  return direct.peerEmail !== selfEmail && !rosterEmails.has(direct.peerEmail);
}

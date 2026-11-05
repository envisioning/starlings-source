/**
 * Where an `@mention` is written, read back, and highlighted — the browser
 * mirror of `Sources/MentionMatching.swift`. Same rule everywhere: a mention
 * names a person by their email's local part (`ana.silva`, the piece before
 * the `@`) or by the whole address, never by a display name.
 */

export interface MentionCandidate {
  email: string;
}

/** `ana.silva` from `ana.silva@example.com`. */
export function localPartOf(email: string): string {
  return email.split('@')[0] ?? email;
}

/** A handle character: what an email's local part is made of. Unicode letters,
 * combining marks and numbers stay attached to a handle just as they do in Swift's
 * `Character.isLetter` / `isNumber`; `ana.silva` and `ana_silva` also bound
 * correctly, while sentence punctuation does not become part of one. */
const HANDLE_CHARACTER = /^[\p{L}\p{M}\p{N}._+-]$/u;

function isHandleCharacter(character: string): boolean {
  return HANDLE_CHARACTER.test(character);
}

/** `index` is a UTF-16 offset, as are web highlight ranges. Read one Unicode
 * code point at that boundary without changing those rendering offsets. */
function codePointBefore(text: string, index: number): string {
  if (index <= 0) return '';
  let start = index - 1;
  const lastCodeUnit = text.charCodeAt(start);
  if (lastCodeUnit >= 0xdc00 && lastCodeUnit <= 0xdfff) start -= 1;
  return text.slice(start, index);
}

function codePointAt(text: string, index: number): string {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? '' : String.fromCodePoint(codePoint);
}

/** Every `@needle` in `text` that is a whole handle, not a piece of a longer
 * one — `includes('@ana')` is also true of `@ana.wilson`. Each returned range
 * is `[start, end)` and includes the leading `@`. */
function handleRanges(needle: string, text: string): [number, number][] {
  if (!needle) return [];
  const results: [number, number][] = [];
  const target = `@${needle}`;
  let from = 0;
  for (;;) {
    const hit = text.indexOf(target, from);
    if (hit === -1) break;
    const leadOK = hit === 0 || !isHandleCharacter(codePointBefore(text, hit));
    const end = hit + target.length;
    const tailOK = end >= text.length || !isHandleCharacter(codePointAt(text, end));
    if (leadOK && tailOK) {
      results.push([hit, end]);
      from = end;
    } else {
      from = hit + 1;
    }
  }
  return results;
}

/**
 * Who this text still names. Read back off the finished message rather than
 * remembered as somebody types: a handle completed and then deleted is not a
 * mention.
 */
export function mentionsIn(text: string, candidates: MentionCandidate[]): string[] {
  const lowered = text.toLowerCase();
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    const email = candidate.email.toLowerCase();
    if (!email || seen.has(email)) continue;
    const named = handleRanges(localPartOf(email), lowered).length > 0
      || handleRanges(email, lowered).length > 0;
    if (!named) continue;
    seen.add(email);
    result.push(candidate.email);
  }
  return result;
}

/**
 * Where each candidate is actually named in `text` — widest match first,
 * with nothing overlapping kept twice (a full address wins over the local
 * part sitting inside it). For a renderer drawing a mention differently from
 * the words around it, on the same rule `mentionsIn` decides *whether*
 * something is a mention at all.
 */
export function highlightRanges(
  text: string,
  candidates: MentionCandidate[],
): { start: number; end: number; email: string }[] {
  const lowered = text.toLowerCase();
  const found: { start: number; end: number; email: string }[] = [];
  for (const candidate of candidates) {
    const email = candidate.email.toLowerCase();
    if (!email) continue;
    for (const needle of new Set([localPartOf(email), email])) {
      if (!needle) continue;
      for (const [start, end] of handleRanges(needle, lowered)) {
        found.push({ start, end, email: candidate.email });
      }
    }
  }
  found.sort((left, right) => (right.end - right.start) - (left.end - left.start) || left.start - right.start);
  const kept: { start: number; end: number; email: string }[] = [];
  for (const candidate of found) {
    if (!kept.some((other) => candidate.start < other.end && other.start < candidate.end)) {
      kept.push(candidate);
    }
  }
  return kept.sort((left, right) => left.start - right.start);
}

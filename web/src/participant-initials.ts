/**
 * Same rule as the Mac app's `ParticipantInitials`: the first letter of the
 * first two words, uppercased, after every parenthetical is dropped (a pronoun,
 * a role or a company in brackets is not part of anybody's name; an unclosed
 * one runs to the end). A letter is a character as a person sees it, so a flag
 * or an accent written as two code points is still one. `?` when there is
 * none. `fixtures/participant-initials.json` pins both.
 */
const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : undefined;

function firstLetter(word: string): string {
  if (!graphemes) return [...word][0] ?? '';
  for (const { segment } of graphemes.segment(word)) return segment;
  return '';
}

export function participantInitials(name: string): string {
  const letters = name
    .replace(/\([^)]*(?:\)|$)/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map(firstLetter)
    .filter(Boolean);
  return letters.length === 0 ? '?' : letters.join('').toUpperCase();
}

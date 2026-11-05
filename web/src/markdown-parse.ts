import { DOCS_IMAGE_SCHEME } from '@starlings/contracts/docs-values';
import { highlightRanges, type MentionCandidate } from './mentions';

/**
 * The small Markdown a conversation is actually written in — the parser.
 * `./markdown` draws it; this file has no JSX so the Worker's test suite can
 * read it, and so a document grammar (`./document-markdown-parse`) can share
 * the inline half without importing a renderer.
 *
 * The browser mirror of `Sources/ThreadMarkdown.swift` — same subset, same
 * rules, so a message cannot read one way here and another on the Mac or the
 * phone: paragraphs, headings, bullet and numbered lists, quotes, fenced code,
 * and inline bold / italic / strikethrough / code / links plus bare URLs. Nothing else, and no
 * HTML: every string below becomes a React text node, so a message is data and
 * never markup. `dangerouslySetInnerHTML` has no business in a transcript.
 */

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** Already clamped to http, https or mailto by the parser. */
  link?: string;
  /** The email this run names, when it is somebody's handle a message
   * actually mentioned. Never set by `parseMarkdown` itself — only by
   * `highlightMentions`, from a message's own resolved `mentions`. */
  mention?: string;
  /** Strikethrough, kept in parity with the native conversation renderer. */
  strike?: boolean;
  /** `![alt](url)` — `text` is the alt. */
  image?: string;
  /** `[[target]]` or `[[target|label]]` — `text` is the label, this the target. */
  wikilink?: string;
  /** `[^id]` — a footnote reference; `text` is the id. */
  footnote?: string;
  /** A `link` that stays in this tab: another document on this surface. */
  internal?: boolean;
}

/** What the inline parser accepts beyond the message subset. */
export interface InlineOptions {
  /** Images, wikilinks and footnote references. */
  document?: boolean;
}

export type Block =
  | { kind: 'paragraph' | 'quote'; spans: Span[] }
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'bullet'; level: number; spans: Span[] }
  | { kind: 'ordered'; level: number; index: number; spans: Span[] }
  | { kind: 'code'; text: string };

/** Two spaces (or a tab) is a nesting step, capped so a paste cannot walk off the pane. */
function indentLevel(line: string): number {
  let spaces = 0;
  for (const character of line) {
    if (character === ' ') spaces += 1;
    else if (character === '\t') spaces += 2;
    else break;
  }
  return Math.min(2, Math.floor(spaces / 2));
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (!paragraph.length) return;
    blocks.push({ kind: 'paragraph', spans: parseSpans(paragraph.join('\n')) });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      flush();
      const fence = trimmed.slice(0, 3);
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith(fence)) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      // An unterminated fence still ends here: the alternative is a half-typed
      // message swallowing the rest of the transcript.
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    if (!trimmed) { flush(); continue; }

    const heading = /^(#{1,6}) +(.*)$/u.exec(trimmed);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: Math.min(3, heading[1]!.length), spans: parseSpans(heading[2]!.trim()) });
      continue;
    }

    if (trimmed.startsWith('>')) {
      flush();
      blocks.push({ kind: 'quote', spans: parseSpans(trimmed.slice(1).trim()) });
      continue;
    }

    // The space after the marker is what makes it a list rather than emphasis.
    const bullet = /^[-*+] +(.*)$/u.exec(trimmed);
    if (bullet) {
      flush();
      blocks.push({ kind: 'bullet', level: indentLevel(line), spans: parseSpans(bullet[1]!.trim()) });
      continue;
    }

    const ordered = /^(\d{1,9})[.)] +(.*)$/u.exec(trimmed);
    if (ordered) {
      flush();
      blocks.push({
        kind: 'ordered',
        level: indentLevel(line),
        index: Number(ordered[1]),
        spans: parseSpans(ordered[2]!.trim()),
      });
      continue;
    }

    paragraph.push(trimmed);
  }
  flush();
  return blocks;
}

/**
 * Given a message's resolved mentions — who it actually named — split the
 * plain runs of these blocks so a renderer can draw a mentioned handle
 * differently from the words around it. Skips a span that is already a link
 * or code: a mention inside a code span is a literal `@`, and a link's own
 * text is not a mention target. See `./mentions`, the one rule this and
 * every composer answer to.
 */
export function highlightMentions(blocks: Block[], mentionedEmails: string[]): Block[] {
  if (mentionedEmails.length === 0) return blocks;
  const candidates: MentionCandidate[] = mentionedEmails.map((email) => ({ email }));
  return blocks.map((block) => (
    'spans' in block ? { ...block, spans: block.spans.flatMap((span) => splitMentions(span, candidates)) } : block
  ));
}

function splitMentions(span: Span, candidates: MentionCandidate[]): Span[] {
  if (span.mention !== undefined || span.link !== undefined || span.code) return [span];
  const ranges = highlightRanges(span.text, candidates);
  if (ranges.length === 0) return [span];
  const result: Span[] = [];
  let cursor = 0;
  for (const match of ranges) {
    if (match.start > cursor) result.push({ ...span, text: span.text.slice(cursor, match.start) });
    result.push({ ...span, text: span.text.slice(match.start, match.end), mention: match.email });
    cursor = match.end;
  }
  if (cursor < span.text.length) result.push({ ...span, text: span.text.slice(cursor) });
  return result;
}

/**
 * The only three schemes a message has any business opening. Anything else —
 * `javascript:`, `data:`, a relative path — stays plain text.
 */
/** An image attached to the document (`docs-image:<id>`): only the page that draws it can read it. */
function docsImageSource(target: string): string | undefined {
  return target.startsWith(DOCS_IMAGE_SCHEME) && /^[A-Za-z0-9-]{1,64}$/u.test(target.slice(DOCS_IMAGE_SCHEME.length)) ? target : undefined;
}

export function safeURL(target: string): string | undefined {
  if (!target || target.length > 2048 || /\s/u.test(target)) return undefined;
  const lowered = target.toLowerCase();
  if (!lowered.startsWith('https://') && !lowered.startsWith('http://') && !lowered.startsWith('mailto:')) {
    return undefined;
  }
  try { new URL(target); } catch { return undefined; }
  return target;
}

/**
 * A letter or a digit, where a Swift `Character` (a letter with its accent) says
 * so. The text is split into code points here, so an accent typed as a
 * separate mark counts with its letter: `café_x_` is not emphasis however the
 * `é` was encoded.
 */
function isWord(character: string | undefined): boolean {
  return !!character && /[\p{L}\p{N}\p{M}]/u.test(character);
}

const MARKERS = '\\`*_~[]()#>-+.!';
/** The extra marker a document can escape inside a table cell: `\|`. */
const DOCUMENT_MARKERS = `${MARKERS}|`;

export function parseSpans(text: string, options: InlineOptions = {}): Span[] {
  return inline([...text], {}, options);
}

/**
 * Markdown's content without authoring marks. Compact cards use this instead
 * of leaking source syntax into titles or previews; full readers use Markdown.
 */
export function plainText(text: string): string {
  return parseMarkdown(text).map((block) => {
    if (block.kind === 'code') return block.text;
    const content = block.spans.map((span) => span.text).join('');
    if (block.kind === 'bullet') return `• ${content}`;
    if (block.kind === 'ordered') return `${block.index}. ${content}`;
    return content;
  }).join('\n');
}

/** `plainText` on one line, for a list row or a notification. */
export function plainPreview(text: string): string {
  return plainText(text).replace(/\s+/gu, ' ').trim();
}

function inline(characters: string[], base: Omit<Span, 'text'>, options: InlineOptions = {}): Span[] {
  const spans: Span[] = [];
  let literal = '';
  let index = 0;

  const flush = () => {
    if (!literal) return;
    spans.push({ ...base, text: literal });
    literal = '';
  };

  while (index < characters.length) {
    const character = characters[index];

    // A backslash escape is the only way to type a marker literally.
    if (character === '\\' && index + 1 < characters.length && (options.document ? DOCUMENT_MARKERS : MARKERS).includes(characters[index + 1]!)) {
      literal += characters[index + 1]!;
      index += 2;
      continue;
    }

    if (character === '`') {
      const close = characters.indexOf('`', index + 1);
      if (close > index) {
        flush();
        spans.push({ ...base, code: true, text: characters.slice(index + 1, close).join('') });
        index = close + 1;
        continue;
      }
    }

    // Document-only: `![alt](url)`, `[[target|label]]`, `[^id]`.
    if (options.document && character === '!' && characters[index + 1] === '[') {
      const label = closingBracket(characters, index + 1);
      const paren = label >= 0 && characters[label + 1] === '(' ? characters.indexOf(')', label + 2) : -1;
      const target = paren > 0 ? characters.slice(label + 2, paren).join('').trim() : '';
      const url = target ? safeURL(target) ?? docsImageSource(target) : undefined;
      if (url && label >= 0) {
        flush();
        spans.push({ ...base, image: url, text: characters.slice(index + 2, label).join('') });
        index = paren + 1;
        continue;
      }
    }

    if (options.document && character === '[' && characters[index + 1] === '[') {
      const close = characters.join('').indexOf(']]', index + 2);
      if (close > index + 2) {
        const inner = characters.slice(index + 2, close).join('');
        const bar = inner.indexOf('|');
        const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
        const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim();
        if (target) {
          flush();
          spans.push({ ...base, wikilink: target, text: label || target });
          index = close + 2;
          continue;
        }
      }
    }

    if (options.document && character === '[' && characters[index + 1] === '^') {
      const close = characters.indexOf(']', index + 2);
      const id = close > index + 2 ? characters.slice(index + 2, close).join('').trim() : '';
      if (id && !/\s/u.test(id)) {
        flush();
        spans.push({ ...base, footnote: id, text: id });
        index = close + 1;
        continue;
      }
    }

    if (character === '~' && characters[index + 1] === '~') {
      const close = closingEmphasis(characters, '~', 2, index + 2, index);
      if (close > 0) {
        flush();
        spans.push(...inline(characters.slice(index + 2, close), { ...base, strike: true }, options));
        index = close + 2;
        continue;
      }
    }

    if (character === '[') {
      const label = closingBracket(characters, index);
      const paren = label >= 0 && characters[label + 1] === '('
        ? characters.indexOf(')', label + 2)
        : -1;
      const url = paren > 0 ? safeURL(characters.slice(label + 2, paren).join('').trim()) : undefined;
      if (url && label >= 0) {
        flush();
        spans.push(...inline(characters.slice(index + 1, label), { ...base, link: url }, options));
        index = paren + 1;
        continue;
      }
    }

    if (character === '*' || character === '_') {
      // Up to three: `***both***` is bold and italic at once. A run that never
      // closes at its own width tries a narrower one before giving up, so
      // `***shouty**` is still bold.
      let run = 1;
      while (run < 3 && characters[index + run] === character) run += 1;
      let emphasised = false;
      for (let width = run; width >= 1 && !emphasised; width -= 1) {
        const close = closingEmphasis(characters, character, width, index + width, index);
        if (close < 0) continue;
        flush();
        const inner = width >= 3 ? { ...base, bold: true, italic: true }
          : width === 2 ? { ...base, bold: true }
            : { ...base, italic: true };
        spans.push(...inline(characters.slice(index + width, close), inner, options));
        index = close + width;
        emphasised = true;
      }
      if (emphasised) continue;
    }

    const bare = autolink(characters, index);
    if (bare) {
      flush();
      spans.push({ ...base, link: bare.url, text: bare.display });
      index = bare.end;
      continue;
    }

    literal += character;
    index += 1;
  }
  flush();
  return spans;
}

/** The `]` that closes this `[`, counting nested pairs. */
function closingBracket(characters: string[], from: number): number {
  let depth = 0;
  for (let index = from; index < characters.length; index += 1) {
    if (characters[index] === '[') depth += 1;
    if (characters[index] === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Where this emphasis run ends, or -1 if it never does. No whitespace just
 * inside the markers (`a * b * c` is arithmetic), and `_` only at word
 * boundaries, so `snake_case_names` survives being talked about.
 */
function closingEmphasis(
  characters: string[],
  marker: string,
  width: number,
  from: number,
  opener: number,
): number {
  if (from >= characters.length || /\s/u.test(characters[from]!)) return -1;
  if (marker === '_' && opener > 0 && isWord(characters[opener - 1])) return -1;
  for (let index = from + 1; index + width <= characters.length; index += 1) {
    let matches = true;
    for (let step = 0; step < width; step += 1) {
      if (characters[index + step] !== marker) matches = false;
    }
    if (!matches || /\s/u.test(characters[index - 1]!)) continue;
    if (marker === '_' && isWord(characters[index + width])) continue;
    return index;
  }
  return -1;
}

/** A URL nobody wrapped in brackets. `www.` is the one prefix safe to assume https for. */
function autolink(
  characters: string[],
  index: number,
): { url: string; display: string; end: number } | undefined {
  // Mid-word is a false positive: `see:https://x` is fine, `ahttps` is not.
  if (index > 0 && isWord(characters[index - 1])) return undefined;
  const rest = characters.slice(index, index + 8).join('').toLowerCase();
  const scheme = rest.startsWith('https://') || rest.startsWith('http://') ? ''
    : rest.startsWith('www.') ? 'https://'
      : undefined;
  if (scheme === undefined) return undefined;

  let end = index;
  while (end < characters.length && !/\s/u.test(characters[end]!) && !'<>"\'`'.includes(characters[end]!)) {
    end += 1;
  }
  // Sentence punctuation belongs to the sentence, and a closing paren only
  // belongs to the URL when the URL opened one.
  while (end > index) {
    const last = characters[end - 1]!;
    if ('.,;:!?]}\'"'.includes(last)) { end -= 1; continue; }
    if (last === ')') {
      const seen = characters.slice(index, end).join('');
      const opens = (seen.match(/\(/gu) ?? []).length;
      const closes = (seen.match(/\)/gu) ?? []).length;
      if (opens < closes) { end -= 1; continue; }
    }
    break;
  }
  const display = characters.slice(index, end).join('');
  if (display.length <= (scheme ? 4 : 8)) return undefined;
  const url = safeURL(scheme + display);
  return url ? { url, display, end } : undefined;
}

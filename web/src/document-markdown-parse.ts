import { parseSpans, type Span } from './markdown-parse';

/**
 * Markdown as a document is written, for the Docs page — the
 * parser. `./document-markdown` draws it.
 *
 * `./markdown` is the message subset and mirrors `ThreadMarkdown.swift`; it
 * must keep reading a transcript exactly as the Mac does, so this file owns
 * the document grammar instead of widening that one: six heading levels,
 * nested lists with task items, multi-line and nested quotes, tables with
 * alignment, horizontal rules, images, footnotes, wikilinks resolved to the
 * documents Docs already linked, and a YAML frontmatter block stripped from
 * the top. Same rules as the message subset for what it shares: every string
 * is a React text node, no HTML, links clamped to http/https/mailto.
 */

export type DocumentBlock =
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'quote'; blocks: DocumentBlock[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'table'; align: Array<'left' | 'center' | 'right' | null>; head: Span[][]; rows: Span[][][] }
  | { kind: 'rule' }
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'footnote'; id: string; spans: Span[] };

export interface ListItem {
  spans: Span[];
  /** `- [ ]` / `- [x]`; absent on a plain item. */
  checked?: boolean;
  /** Blocks nested under the item by indentation: a sublist, a paragraph. */
  children: DocumentBlock[];
}

/** How `[[target]]` becomes an address here: Docs' resolved links, by target. */
export interface WikilinkResolver {
  (target: string): string | undefined;
}

const OPTIONS = { document: true } as const;

/** Leading spaces, a tab counting as four — a list's nesting unit. */
function indentOf(line: string): number {
  let width = 0;
  for (const character of line) {
    if (character === ' ') width += 1;
    else if (character === '\t') width += 4;
    else break;
  }
  return width;
}

const BULLET = /^[-*+] +(.*)$/u;
const ORDERED = /^(\d{1,9})[.)] +(.*)$/u;
const TASK = /^\[([ xX])\] +(.*)$/u;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/u;
const TABLE_SEPARATOR = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/u;
const FOOTNOTE_DEFINITION = /^\[\^([^\s\]]+)\]:\s*(.*)$/u;

export function parseDocument(text: string): DocumentBlock[] {
  let lines = text.replace(/\r\n/gu, '\n').split('\n');
  // Frontmatter is Docs' Obsidian-facing projection of the subject links
  // (docs/DOCS.md, decision 5), not something a reader needs to see.
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (close > 0) lines = lines.slice(close + 1);
  }
  return parseBlocks(lines);
}

function parseBlocks(lines: string[]): DocumentBlock[] {
  const at = (position: number): string => lines[position] ?? '';
  const blocks: DocumentBlock[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (!paragraph.length) return;
    const joined = paragraph.join('\n');
    paragraph = [];
    // A paragraph that is only an image is a figure, not a line of text.
    const solo = /^!\[([^\]]*)\]\(([^)\s]+)\)$/u.exec(joined.trim());
    if (solo) {
      const spans = parseSpans(joined.trim(), OPTIONS);
      const image = spans.find((span) => span.image);
      if (spans.length === 1 && image?.image) {
        blocks.push({ kind: 'image', src: image.image, alt: image.text });
        return;
      }
    }
    blocks.push({ kind: 'paragraph', spans: parseSpans(joined, OPTIONS) });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = at(index);
    const trimmed = line.trim();

    const fence = /^(`{3,}|~{3,})\s*(\S*)\s*$/u.exec(trimmed);
    if (fence) {
      flush();
      const marker = fence[1]!;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !at(index).trim().startsWith(marker)) {
        body.push(at(index));
        index += 1;
      }
      blocks.push({ kind: 'code', language: fence[2]!, text: body.join('\n') });
      continue;
    }

    if (!trimmed) { flush(); continue; }

    const heading = /^(#{1,6}) +(.*?)\s*#*$/u.exec(trimmed);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1]!.length, spans: parseSpans(heading[2]!.trim(), OPTIONS) });
      continue;
    }

    // A rule before a table: `---` under a paragraph line is a table
    // separator only when the line above has pipes.
    if (RULE.test(trimmed) && !(paragraph.length === 1 && paragraph[0]!.includes('|') && TABLE_SEPARATOR.test(trimmed))) {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }

    // Table: a header line with pipes, then the separator row, then rows.
    if (trimmed.includes('|') && index + 1 < lines.length && TABLE_SEPARATOR.test(at(index + 1).trim()) && at(index + 1).includes('-')) {
      flush();
      const align = splitRow(at(index + 1)).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
      });
      const head = splitRow(line).map((cell) => parseSpans(cell, OPTIONS));
      const rows: Span[][][] = [];
      index += 2;
      while (index < lines.length && at(index).trim() && at(index).includes('|')) {
        rows.push(splitRow(at(index)).map((cell) => parseSpans(cell, OPTIONS)));
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: 'table', align, head, rows });
      continue;
    }

    if (trimmed.startsWith('>')) {
      flush();
      // Every following line that is quoted, or that continues a quoted
      // paragraph without a blank line, belongs to this quote. One `>` comes
      // off; what is left is parsed again, so quotes nest.
      const inner: string[] = [];
      while (index < lines.length) {
        const candidate = at(index).trim();
        if (candidate.startsWith('>')) {
          inner.push(candidate.slice(1).replace(/^ /u, ''));
        } else if (candidate && inner.length > 0 && (inner[inner.length - 1] ?? "").trim() && !isBlockStart(candidate)) {
          inner.push(candidate);
        } else {
          break;
        }
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: 'quote', blocks: parseBlocks(inner) });
      continue;
    }

    if (BULLET.test(trimmed) || ORDERED.test(trimmed)) {
      flush();
      const ordered = ORDERED.test(trimmed);
      const baseIndent = indentOf(line);
      const items: ListItem[] = [];
      let start = 1;
      while (index < lines.length) {
        const itemLine = at(index);
        const itemTrimmed = itemLine.trim();
        const itemIndent = indentOf(itemLine);
        const marker = ordered ? ORDERED.exec(itemTrimmed) : BULLET.exec(itemTrimmed);
        if (!marker || itemIndent !== baseIndent) break;
        if (ordered && items.length === 0) start = Number(marker[1]!);
        const raw = ordered ? marker[2]! : marker[1]!;
        let content = raw;
        let checked: boolean | undefined;
        const task = TASK.exec(raw);
        if (task) {
          checked = task[1]! !== ' ';
          content = task[2]!;
        }
        // Everything indented past the marker (`- ` is two columns, `10. `
        // four), up to the next item at this level or a blank line followed
        // by an unindented line, is the item's own.
        const childIndent = baseIndent + (itemTrimmed.length - raw.length);
        const nested: string[] = [];
        index += 1;
        while (index < lines.length) {
          const next = at(index);
          const nextTrimmed = next.trim();
          const nextIndent = indentOf(next);
          if (!nextTrimmed) {
            // A blank line ends the item unless what follows is still indented.
            const after = at(index + 1);
            if (after !== undefined && after.trim() && indentOf(after) >= childIndent) {
              nested.push('');
              index += 1;
              continue;
            }
            break;
          }
          // A wrapped line of the item's own paragraph: no blank line yet,
          // not a block start. It joins the content whether it is indented
          // to the marker or lazily flush left, so inline marks that span
          // the wrap (`**bold\n  text**`) still close.
          if (nested.length === 0 && !isBlockStart(nextTrimmed) && !nextTrimmed.startsWith('|') && (nextIndent >= childIndent || nextIndent <= baseIndent)) {
            content += `\n${nextTrimmed}`;
            index += 1;
            continue;
          }
          if (nextIndent >= childIndent) {
            nested.push(next.slice(Math.min(childIndent, nextIndent)));
            index += 1;
            continue;
          }
          break;
        }
        items.push({
          spans: parseSpans(content.trim(), OPTIONS),
          ...(checked === undefined ? {} : { checked }),
          children: nested.length ? parseBlocks(nested) : [],
        });
      }
      index -= 1;
      blocks.push({ kind: 'list', ordered, start, items });
      continue;
    }

    const footnote = FOOTNOTE_DEFINITION.exec(trimmed);
    if (footnote) {
      flush();
      blocks.push({ kind: 'footnote', id: footnote[1]!, spans: parseSpans(footnote[2]!.trim(), OPTIONS) });
      continue;
    }

    paragraph.push(trimmed);
  }
  flush();
  return blocks;
}

/** Whether a trimmed line opens something other than paragraph text. */
function isBlockStart(trimmed: string): boolean {
  return trimmed.startsWith('#') || trimmed.startsWith('>') || trimmed.startsWith('```') || trimmed.startsWith('~~~')
    || BULLET.test(trimmed) || ORDERED.test(trimmed) || RULE.test(trimmed) || FOOTNOTE_DEFINITION.test(trimmed);
}

/** The cells of one table row; `\|` inside a cell is a literal pipe. */
function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '\\' && body[index + 1] === '|') {
      current += '\\|';
      index += 1;
      continue;
    }
    if (character === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

/** Every wikilink in these blocks pointed at an address `resolve` knows. */
export function resolveWikilinks(blocks: DocumentBlock[], resolve: WikilinkResolver): DocumentBlock[] {
  const spans = (list: Span[]): Span[] => list.map((span) => {
    if (!span.wikilink) return span;
    const href = resolve(span.wikilink);
    return href ? { ...span, link: href, internal: true } : span;
  });
  return blocks.map((block): DocumentBlock => {
    switch (block.kind) {
      case 'paragraph':
      case 'heading':
      case 'footnote':
        return { ...block, spans: spans(block.spans) };
      case 'quote':
        return { ...block, blocks: resolveWikilinks(block.blocks, resolve) };
      case 'list':
        return { ...block, items: block.items.map((item) => ({ ...item, spans: spans(item.spans), children: resolveWikilinks(item.children, resolve) })) };
      case 'table':
        return { ...block, head: block.head.map(spans), rows: block.rows.map((row) => row.map(spans)) };
      default:
        return block;
    }
  });
}

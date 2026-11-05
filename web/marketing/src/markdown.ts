/*
 * Rendered HTML to markdown, for the markdown twin of a product-site page
 * (`<path>.md`). The prerender (marketing/prerender.mjs) hands it the page's
 * own `<main>`, so the twin says what the page says and cannot drift from it.
 * Pages whose facts sit in a registry render from the registry instead
 * (`page-markdown.tsx`), and use this for the ReactNode parts of a row.
 *
 * Dependency-free on purpose: the input is React's server output, which is
 * well formed, so a small tokenizer is enough. What a reader without eyes
 * does not get, the twin does not get: `aria-hidden` subtrees, drawings
 * (`svg`, `img`, `canvas`), and controls (`button`, `input`, `form`). A link
 * is kept, a link styled as a button included.
 */

type Element = { tag: string; attrs: Record<string, string>; children: Node[] };
type Node = Element | string;

export type MarkdownOptions = {
  /** The page's absolute URL: relative links resolve against it. */
  base: string;
  /** Added to every heading level, so a page's `<h1>` can sit under the twin's own `#`. */
  headingShift?: number;
};

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const DROP = new Set(['script', 'style', 'svg', 'noscript', 'template', 'button', 'input', 'select', 'textarea', 'form', 'canvas', 'video', 'audio', 'iframe', 'img', 'picture', 'nav', 'head']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'li', 'main', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul',
]);
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', copy: '©' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
}

/** Parse well-formed HTML into a tree. Unclosed tags close at their parent's end. */
export function parseHtml(html: string): Element {
  const root: Element = { tag: '#root', attrs: {}, children: [] };
  const stack: Element[] = [root];
  const source = html.replace(/<!--[\s\S]*?-->/gu, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, '');
  const token = /<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|<!DOCTYPE[^>]*>|[^<]+|</giu;
  for (const [whole, close, open, attrText, selfClose] of source.matchAll(token)) {
    const top = stack[stack.length - 1];
    if (close) {
      const name = close.toLowerCase();
      const at = stack.map((el) => el.tag).lastIndexOf(name);
      if (at > 0) stack.length = at;
    } else if (open) {
      const tag = open.toLowerCase();
      const attrs: Record<string, string> = {};
      for (const [, key, dq, sq, bare] of (attrText ?? '').matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu)) attrs[key.toLowerCase()] = decodeEntities(dq ?? sq ?? bare ?? '');
      const el: Element = { tag, attrs, children: [] };
      top.children.push(el);
      if (!selfClose && !VOID.has(tag)) stack.push(el);
    } else if (!/^<!doctype/iu.test(whole)) {
      top.children.push(decodeEntities(whole));
    }
  }
  return root;
}

const isElement = (node: Node): node is Element => typeof node !== 'string';
/** A drawing with an accessible name (`<svg aria-label>`, `role="img"`) reads as its name. */
const graphicLabel = (el: Element) => ((el.tag === 'svg' || el.attrs.role === 'img') && el.attrs['aria-hidden'] !== 'true' ? el.attrs['aria-label']?.trim() || undefined : undefined);
const dropped = (el: Element) => !graphicLabel(el) && (DROP.has(el.tag) || el.attrs['aria-hidden'] === 'true' || 'hidden' in el.attrs || 'inert' in el.attrs);
const hasBlock = (el: Element): boolean => !graphicLabel(el) && el.children.some((child) => isElement(child) && !dropped(child) && (BLOCK.has(child.tag) || hasBlock(child)));
const escapeText = (text: string) => text.replace(/([\\*_[\]])/gu, '\\$1');
const squash = (text: string) => text.replace(/[ \t\r\n\f]+/gu, ' ');

/** Wrap inline text in a marker, keeping its outer spaces outside the marker. */
function wrap(text: string, mark: string): string {
  const inner = text.trim();
  if (!inner) return text;
  const lead = /^\s/u.test(text) ? ' ' : '';
  const tail = /\s$/u.test(text) ? ' ' : '';
  return `${lead}${mark}${inner}${mark}${tail}`;
}

function resolve(href: string, options: MarkdownOptions): string {
  try {
    return new URL(href, options.base).toString();
  } catch {
    return href;
  }
}

function textContent(node: Node): string {
  if (!isElement(node)) return node;
  return graphicLabel(node) ?? (dropped(node) ? '' : node.children.map(textContent).join(''));
}

function inline(node: Node, options: MarkdownOptions): string {
  if (!isElement(node)) return escapeText(squash(node));
  const label = graphicLabel(node);
  if (label) return escapeText(label);
  if (dropped(node)) return '';
  const inner = () => node.children.map((child) => inline(child, options)).join('');
  switch (node.tag) {
    case 'br': return '\n';
    case 'strong': case 'b': return wrap(inner(), '**');
    case 'em': case 'i': return wrap(inner(), '*');
    case 'code': case 'kbd': case 'samp': {
      const code = squash(textContent(node));
      return code.trim() ? `\`${code.trim()}\`` : '';
    }
    case 'a': {
      const text = inner();
      const href = node.attrs.href;
      if (!text.trim()) return '';
      return href ? `${/^\s/u.test(text) ? ' ' : ''}[${text.trim()}](${resolve(href, options)})${/\s$/u.test(text) ? ' ' : ''}` : text;
    }
    default: return inner();
  }
}

/**
 * One paragraph's text: spaces collapsed, lines trimmed. Two elements the
 * page sets apart by layout alone (a link above its summary, a caption after
 * a sentence) arrive with no space between them; they get one back.
 */
const tidy = (text: string) => text
  .replace(/(\]\([^)\s]+\))(?=\p{Lu})/gu, '$1: ')
  .replace(/(\p{Ll}[.!?])(?=\p{Lu})/gu, '$1 ')
  .split('\n').map((line) => line.replace(/ {2,}/gu, ' ').trim()).filter(Boolean).join('\n');

/** A step number drawn as its own line ("01") repeats the order the text already has. */
const isStepNumber = (text: string) => /^0\d$/u.test(text);

/** The blocks a list of sibling nodes makes: runs of inline content become paragraphs. */
function blocksOf(nodes: readonly Node[], options: MarkdownOptions): string[] {
  const out: string[] = [];
  let run = '';
  const flush = () => {
    const text = tidy(run);
    if (text && !isStepNumber(text)) out.push(text);
    run = '';
  };
  for (const node of nodes) {
    if (isElement(node) && dropped(node)) continue;
    if (isElement(node) && (BLOCK.has(node.tag) || hasBlock(node))) {
      flush();
      out.push(...block(node, options));
    } else {
      run += inline(node, options);
    }
  }
  flush();
  return out;
}

const indent = (text: string, by: string) => text.split('\n').map((line, index) => (index === 0 || !line ? line : `${by}${line}`)).join('\n');
const oneLine = (text: string) => text.replace(/\s*\n\s*/gu, ' ').trim();
const headingText = (block: string) => block.replace(/^#+\s+/u, '');

function block(el: Element, options: MarkdownOptions): string[] {
  const children = () => blocksOf(el.children, options);
  const heading = /^h([1-6])$/u.exec(el.tag);
  if (heading) {
    const text = oneLine(el.children.map((child) => inline(child, options)).join(''));
    return text ? [`${'#'.repeat(Math.min(6, Number(heading[1]) + (options.headingShift ?? 0)))} ${text}`] : [];
  }
  switch (el.tag) {
    case 'hr': return ['---'];
    case 'pre': {
      const code = textContent(el).replace(/\n$/u, '');
      return code.trim() ? [`\`\`\`\n${code}\n\`\`\``] : [];
    }
    case 'blockquote': return children().map((text) => text.split('\n').map((line) => `> ${line}`).join('\n'));
    case 'ul': case 'ol': return list(el, options);
    case 'dl': return definitions(el, options);
    case 'table': return table(el, options);
    case 'summary': return children().map((text) => `**${oneLine(text)}**`);
    case 'a': {
      // A card that is one link: its heading is the link, the rest follows.
      const parts = children().map(headingText).map(oneLine).filter(Boolean);
      const href = el.attrs.href;
      if (parts.length === 0) return [];
      if (!href) return [parts.join(': ')];
      return [`[${parts[0]}](${resolve(href, options)})${parts.length > 1 ? `: ${parts.slice(1).join(' ')}` : ''}`];
    }
    default: return children();
  }
}

function list(el: Element, options: MarkdownOptions): string[] {
  const ordered = el.tag === 'ol';
  const items = el.children.filter((child): child is Element => isElement(child) && child.tag === 'li' && !dropped(child));
  const lines = items.map((item, index) => {
    let parts = blocksOf(item.children, options);
    // A step number drawn as text duplicates the list's own numbering.
    if (ordered && parts.length > 1 && /^\d+\.?$/u.test(parts[0])) parts = parts.slice(1);
    // A card drawn as a list item: its heading leads the item in bold.
    if (parts.length > 0 && /^#+\s/u.test(parts[0])) {
      const title = `**${headingText(parts[0])}**`;
      parts = parts.length > 1 && !/^(?:[-*] |\d+\. |\||>|```)/u.test(parts[1]) ? [`${title}: ${parts[1]}`, ...parts.slice(2)] : [title, ...parts.slice(1)];
    }
    const marker = ordered ? `${index + 1}. ` : '- ';
    const pad = ' '.repeat(marker.length);
    return `${marker}${indent(parts.join('\n\n'), pad)}`;
  });
  return lines.length ? [lines.join('\n')] : [];
}

function definitions(el: Element, options: MarkdownOptions): string[] {
  // `<dt>`/`<dd>` may sit directly in the list or in one wrapper `<div>` per pair.
  const flat = el.children.flatMap((child) => (isElement(child) && child.tag === 'div' ? child.children : [child])).filter(isElement).filter((child) => !dropped(child));
  const lines: string[] = [];
  for (const child of flat) {
    const text = oneLine(blocksOf(child.children, options).join(' '));
    if (!text) continue;
    if (child.tag === 'dt') {
      lines.push(`- **${text}**`);
      continue;
    }
    if (child.tag !== 'dd') continue;
    // The first answer follows its term after a colon; a second one after a semicolon.
    const last = lines.length - 1;
    if (last < 0) lines.push(`- ${text}`);
    else lines[last] = `${lines[last]}${/\*\*$/u.test(lines[last]) ? ':' : ';'} ${text}`;
  }
  return lines.length ? [lines.join('\n')] : [];
}

function table(el: Element, options: MarkdownOptions): string[] {
  type Row = { head: boolean; cells: Element[] };
  const rows: Row[] = [];
  const collect = (node: Element, head: boolean) => {
    for (const child of node.children) {
      if (!isElement(child) || dropped(child)) continue;
      if (child.tag === 'tr') rows.push({ head, cells: child.children.filter((cell): cell is Element => isElement(cell) && (cell.tag === 'th' || cell.tag === 'td')) });
      else if (child.tag === 'thead') collect(child, true);
      else if (child.tag !== 'caption') collect(child, head);
    }
  };
  collect(el, false);
  if (rows.length === 0) return [];
  // Lay the cells on a grid, so colspan and rowspan keep every column in place.
  const grid: string[][] = rows.map(() => []);
  rows.forEach((row, r) => {
    let c = 0;
    for (const cell of row.cells) {
      while (grid[r][c] !== undefined) c += 1;
      const text = oneLine(blocksOf(cell.children, options).join(' ')).replace(/\|/gu, '\\|');
      const across = Math.max(1, Number(cell.attrs.colspan) || 1);
      const down = Math.max(1, Number(cell.attrs.rowspan) || 1);
      for (let dr = 0; dr < down && r + dr < rows.length; dr += 1) {
        for (let dc = 0; dc < across; dc += 1) grid[r + dr][c + dc] = dr === 0 && (dc === 0 || row.head) ? text : '';
      }
      c += across;
    }
  });
  const width = Math.max(...grid.map((cells) => cells.length));
  const filled = grid.map((cells) => Array.from({ length: width }, (_, i) => cells[i] ?? ''));
  const headCount = Math.max(1, rows.findIndex((row) => !row.head) === -1 ? rows.length : rows.findIndex((row) => !row.head));
  const header = Array.from({ length: width }, (_, i) => [...new Set(filled.slice(0, headCount).map((cells) => cells[i]).filter(Boolean))].join(' · '));
  const body = filled.slice(headCount);
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [[line(header), line(header.map(() => '---')), ...body.map(line)].join('\n')];
}

/** HTML to markdown blocks, separated by blank lines. */
export function htmlToMarkdown(html: string, options: MarkdownOptions): string {
  const text = blocksOf(parseHtml(html).children, options).join('\n\n').trim();
  return text ? `${text}\n` : '';
}

/** One run of inline HTML (a row's ReactNode, rendered) as one line of markdown. */
export function inlineMarkdown(html: string, options: MarkdownOptions): string {
  return oneLine(blocksOf(parseHtml(html).children, options).map(headingText).join(' '));
}

/** The page's `<main>` element, or the whole input when it has none. */
export function mainOf(html: string): string {
  const start = html.search(/<main[\s>]/u);
  const end = html.lastIndexOf('</main>');
  return start >= 0 && end > start ? html.slice(start, end + '</main>'.length) : html;
}

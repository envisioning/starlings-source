import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom/worker';
import { fetchPage } from './link-preview';

/**
 * The article behind a saved link, as markdown.
 *
 * A link save keeps what the page says, not only what it says about itself:
 * the card's metadata comes from `link-preview.ts`, and the article from the
 * same fetch, read here. The Worker reads the page, never the device — the
 * reason is the one `link-preview.ts` gives.
 *
 * Readability finds the article; the markdown is written here, from a short
 * list of elements, so nothing the page carries reaches the body as HTML.
 * Pictures become links, never embeds: an embed would make every reader's
 * client call the publisher on open, which is what Docs copies covers into R2
 * to avoid.
 *
 * Paywalls are detected, never bypassed. A page that says its content is not
 * free keeps what it shows without a subscription and is marked `paywalled`;
 * the full text comes from the person's browser (`page_html`, the bookmarklet),
 * which captures the page as its reader sees it.
 */

/** Past any article. A page bigger than this is cut, and Readability reads what arrived. */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
/** Longer than the card's: the whole page comes down, not only its head. */
const ARTICLE_TIMEOUT_MS = 10_000;
/** Room under Docs' body limit for the person's notes. */
export const MAX_ARTICLE_CHARS = 150_000;
/** Less text than this is a teaser or a cookie wall, not an article. */
const MIN_ARTICLE_CHARS = 280;

export interface LinkArticle {
  markdown: string;
  paywalled: boolean;
  /** Where it came from, as a person says it: `nytimes.com`. */
  host: string;
}

export interface FetchedPage {
  html: string;
  url: URL;
}

/** One page's HTML, at most `MAX_PAGE_BYTES`, under the reader's rules. */
export async function fetchPageHTML(raw: string): Promise<FetchedPage> {
  const { response, url } = await fetchPage(raw, ARTICLE_TIMEOUT_MS);
  const bytes = await readBounded(response, MAX_PAGE_BYTES);
  return { html: decode(bytes, response.headers.get('content-type')), url };
}

/** The article in `html`, or null when the page has none worth keeping. Never throws. */
export function extractArticle(html: string, url: URL): LinkArticle | null {
  try {
    const { document } = parseHTML(html);
    // Before Readability: it strips the scripts the paywall markup lives in.
    const paywalled = isPaywalled(document);
    const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: MIN_ARTICLE_CHARS, keepClasses: true }).parse();
    if (!article?.content) return null;
    const { document: content } = parseHTML(`<!doctype html><html><body>${article.content}</body></html>`);
    let markdown = tidyMarkdown(toMarkdown(content.body, url));
    if (markdown.replace(/\s+/gu, ' ').length < MIN_ARTICLE_CHARS) return null;
    if (markdown.length > MAX_ARTICLE_CHARS) {
      markdown = `${markdown.slice(0, MAX_ARTICLE_CHARS).replace(/\s+\S*$/u, '')}\n\n*Cut at ${MAX_ARTICLE_CHARS.toLocaleString('en')} characters.*`;
    }
    return { markdown, paywalled, host: url.hostname.replace(/^www\./u, '') };
  } catch {
    return null;
  }
}

/**
 * The publisher's own word that this page is behind a paywall: schema.org's
 * `isAccessibleForFree: false`, which publishers write for search engines, or
 * `article:content_tier` set to `locked`.
 */
export function isPaywalled(document: ReturnType<typeof parseHTML>['document']): boolean {
  const tier = document.querySelector('meta[property="article:content_tier"]')?.getAttribute('content');
  if (tier?.trim().toLowerCase() === 'locked') return true;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      if (declaresNotFree(JSON.parse(script.textContent ?? ''))) return true;
    } catch {
      // A page's broken JSON-LD says nothing either way.
    }
  }
  return false;
}

function declaresNotFree(value: unknown, depth = 0): boolean {
  if (depth > 6 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => declaresNotFree(item, depth + 1));
  const record = value as Record<string, unknown>;
  const free = record.isAccessibleForFree;
  if (free === false || (typeof free === 'string' && free.trim().toLowerCase() === 'false')) return true;
  return Object.values(record).some((item) => declaresNotFree(item, depth + 1));
}

async function readBounded(response: Response, max: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const room = max - read;
      chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
      read += Math.min(value.byteLength, room);
      if (read >= max) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(read);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decode(bytes: Uint8Array, contentType: string | null): string {
  const charset = /charset=["']?([\w-]+)/iu.exec(contentType ?? '')?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// ---- markdown ---------------------------------------------------------------

const SKIP = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'canvas', 'svg',
  'video', 'audio', 'form', 'button', 'input', 'select', 'textarea', 'nav', 'aside', 'footer',
]);
const BLOCKS = new Set([
  'div', 'section', 'article', 'main', 'header', 'figure', 'figcaption', 'details', 'summary',
  'dl', 'dt', 'dd', 'address', 'center',
]);

interface DOMNode {
  nodeType: number;
  textContent: string | null;
  childNodes: ArrayLike<DOMNode>;
  tagName?: string;
  getAttribute?(name: string): string | null;
  children?: ArrayLike<DOMNode>;
}

function toMarkdown(node: DOMNode, base: URL, pre = false): string {
  if (node.nodeType === 3) {
    const text = node.textContent ?? '';
    return pre ? text : escapeText(text.replace(/\s+/gu, ' '));
  }
  if (node.nodeType !== 1 || !node.tagName) return '';
  const tag = node.tagName.toLowerCase();
  if (SKIP.has(tag)) return '';
  const inner = () => children(node, base, pre);
  const attr = (name: string) => node.getAttribute?.(name) ?? null;

  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const text = oneLine(inner());
      return text ? block(`${'#'.repeat(Number(tag[1]))} ${text}`) : '';
    }
    case 'p': return block(escapeLineStart(inner().trim()));
    case 'br': return '  \n';
    case 'hr': return block('---');
    case 'strong': case 'b': return wrap(inner(), '**');
    case 'em': case 'i': return wrap(inner(), '*');
    case 'del': case 's': return wrap(inner(), '~~');
    case 'code': return pre ? (node.textContent ?? '') : inlineCode(node.textContent ?? '');
    case 'pre': return block(fence(node));
    case 'blockquote': {
      const text = tidyMarkdown(inner());
      return text ? block(text.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')) : '';
    }
    case 'a': {
      const text = oneLine(inner());
      const href = safeURL(attr('href'), base, ['http:', 'https:', 'mailto:']);
      if (!href) return text;
      return `[${text || href}](${href})`;
    }
    case 'img': {
      const src = safeURL(attr('src') ?? attr('data-src'), base, ['http:', 'https:']);
      if (!src) return '';
      const alt = oneLine(escapeText(attr('alt') ?? '')) || 'Image';
      return `[${alt}](${src})`;
    }
    case 'ul': case 'ol': return block(list(node, base, tag === 'ol'));
    case 'table': return block(table(node, base));
    default:
      return BLOCKS.has(tag) || tag === 'li' ? block(inner()) : inner();
  }
}

function children(node: DOMNode, base: URL, pre: boolean): string {
  let out = '';
  for (const child of Array.from(node.childNodes)) out += toMarkdown(child, base, pre);
  return out;
}

function elements(node: DOMNode, ...tags: string[]): DOMNode[] {
  return Array.from(node.children ?? []).filter((child) => tags.includes(child.tagName?.toLowerCase() ?? ''));
}

function list(node: DOMNode, base: URL, ordered: boolean): string {
  const start = Number.parseInt(node.getAttribute?.('start') ?? '1', 10) || 1;
  return elements(node, 'li').map((item, index) => {
    const marker = ordered ? `${start + index}. ` : '- ';
    const body = tidyMarkdown(children(item, base, false));
    const pad = ' '.repeat(marker.length);
    return marker + body.split('\n').map((line, i) => (i === 0 || !line ? line : pad + line)).join('\n');
  }).join('\n');
}

function table(node: DOMNode, base: URL): string {
  const rows: DOMNode[] = [];
  const collect = (parent: DOMNode) => {
    for (const child of Array.from(parent.children ?? [])) {
      const tag = child.tagName?.toLowerCase();
      if (tag === 'tr') rows.push(child);
      else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') collect(child);
    }
  };
  collect(node);
  const cells = rows
    .map((row) => elements(row, 'td', 'th').map((cell) => oneLine(children(cell, base, false)).replace(/\|/gu, '\\|')))
    .filter((row) => row.length);
  if (!cells.length) return '';
  const width = Math.max(...cells.map((row) => row.length));
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
  const [head = [], ...body] = cells;
  return [line(head), `| ${Array(width).fill('---').join(' | ')} |`, ...body.map(line)].join('\n');
}

function fence(node: DOMNode): string {
  const code = (node.textContent ?? '').replace(/\n+$/u, '');
  const classes = `${node.getAttribute?.('class') ?? ''} ${elements(node, 'code')[0]?.getAttribute?.('class') ?? ''}`;
  const language = /(?:language|lang)-([\w+-]+)/u.exec(classes)?.[1] ?? '';
  const longest = Math.max(0, ...(code.match(/`+/gu) ?? []).map((run) => run.length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${language}\n${code}\n${ticks}`;
}

function inlineCode(text: string): string {
  const code = text.replace(/\s+/gu, ' ');
  if (!code.trim()) return '';
  const longest = Math.max(0, ...(code.match(/`+/gu) ?? []).map((run) => run.length));
  const ticks = '`'.repeat(longest + 1);
  const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${code}${pad}${ticks}`;
}

/** Emphasis hugs its text; the spaces around it stay outside. */
function wrap(text: string, mark: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/u.exec(text);
  if (!match?.[2]) return text;
  return `${match[1]}${mark}${match[2]}${mark}${match[3]}`;
}

function block(text: string): string {
  const body = text.trim();
  return body ? `\n\n${body}\n\n` : '';
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Text that markdown would read as syntax, or a renderer as HTML. */
function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<>]/gu, '\\$&');
}

/** A paragraph that starts like a heading or a list item is still a paragraph. */
function escapeLineStart(text: string): string {
  return text.replace(/^(#{1,6}\s|[-+]\s|\d+)([.)]\s)?/u, (whole, lead: string, dot?: string) => {
    if (/^\d+$/u.test(lead)) return dot ? `${lead}\\${dot}` : whole;
    return `\\${whole}`;
  });
}

function tidyMarkdown(text: string): string {
  return text
    .replace(/^[ \t]+$/gmu, '')
    .replace(/[ \t]+\n/gu, (spaces) => (spaces.startsWith('  ') ? '  \n' : '\n'))
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** An absolute address in one of `protocols`, with the characters markdown would end a link on escaped. */
function safeURL(raw: string | null, base: URL, protocols: string[]): string | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim(), base);
    if (!protocols.includes(url.protocol)) return null;
    return url.toString().replace(/[()\s<>]/gu, (char) => encodeURIComponent(char).replace('(', '%28').replace(')', '%29'));
  } catch {
    return null;
  }
}

// Markdown rendering, plus the two things Obsidian habits demand: wikilinks
// resolve to internal routes, and any rendered HTML is sanitized. The vault
// contains raw HTML in places, so sanitizing is not optional.

import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

/**
 * `[[Target]]` and `[[Target|alias]]` become internal links before marked
 * sees them, so they render as links rather than literal brackets. Escaped so
 * a note title containing markup cannot inject anything.
 */
function linkifyWikilinks(source: string, resolve: (target: string) => string | null): string {
  return source.replace(
    /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]*))?\]\]/gu,
    (_all, target: string, alias?: string) => {
      const label = escapeHTML((alias ?? target).trim());
      const href = resolve(target.trim());
      return href
        ? `<a class="wikilink" href="${escapeHTML(href)}">${label}</a>`
        : `<span class="wikilink wikilink-missing" title="No document named “${escapeHTML(target.trim())}” yet">${label}</span>`;
    },
  );
}

export function renderMarkdown(
  source: string,
  resolve: (target: string) => string | null = () => null,
): string {
  const withLinks = linkifyWikilinks(source, resolve);
  const html = marked.parse(withLinks, { async: false });
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
}

export function escapeHTML(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Reading time, shown next to long research notes. */
export function readingMinutes(source: string): number {
  return Math.max(1, Math.round(source.trim().split(/\s+/u).length / 220));
}

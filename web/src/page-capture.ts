import { DOCS_PAGE_HTML_MAX_CHARS } from '@starlings/contracts';

/**
 * Saving a page from the browser: the bookmarklet and the `/save` popup it
 * opens (docs/DOCS.md, link saves).
 *
 * The bookmarklet runs on the page being saved, so it does as little as it
 * can: it opens `/save` on this workspace, waits for the popup to say it is
 * ready, and hands it the page's address, title and HTML. Nothing goes in the
 * popup's address, so the page a person saves never lands in a log. The
 * popup runs on the workspace's own origin, with the person's session; the
 * Worker reads the article out of the HTML, with the one reader every link
 * save uses.
 *
 * The page is a stranger, so the popup believes only what the browser
 * vouches for: the message must come from the window that opened it, and the
 * address it names must be on the origin that sent it. Nothing saves until
 * the person presses Save.
 */

export const PAGE_READY = 'starlings:ready';
export const PAGE_MESSAGE = 'starlings:page';
export const SAVE_PATH = '/save';

/** The bookmarklet for one workspace, as an `href`. */
export function bookmarkletHref(origin: string): string {
  const code = `(()=>{var o=${JSON.stringify(origin)},w=window.open(o+${JSON.stringify(SAVE_PATH)},"starlings-save","popup,width=520,height=640");`
    + `if(!w)return;var p={type:${JSON.stringify(PAGE_MESSAGE)},url:location.href,title:document.title,html:document.documentElement.outerHTML};`
    + `addEventListener("message",function(e){if(e.source===w&&e.origin===o&&e.data&&e.data.type===${JSON.stringify(PAGE_READY)})w.postMessage(p,o)})})();void 0`;
  return `javascript:${encodeURIComponent(code)}`;
}

export interface CapturedPage {
  url: string;
  title: string;
  html: string;
}

/**
 * The page a message carries, or null. `opener` is the window that opened
 * the popup: a message from anywhere else is ignored, and so is one whose
 * page is not on the origin that sent it.
 */
export function readPageMessage(event: MessageEvent, opener: unknown): CapturedPage | null {
  if (!opener || event.source !== opener) return null;
  const data: unknown = event.data;
  if (!data || typeof data !== 'object') return null;
  const { type, url, title, html } = data as Record<string, unknown>;
  if (type !== PAGE_MESSAGE || typeof url !== 'string' || typeof html !== 'string') return null;
  let page: URL;
  try {
    page = new URL(url);
  } catch {
    return null;
  }
  if (page.protocol !== 'https:' || page.origin !== event.origin) return null;
  return { url: page.toString(), title: typeof title === 'string' ? title.trim().slice(0, 200) : '', html };
}

/** What the reader never uses: code, styling, media and frames. */
const STRIP = 'script:not([type="application/ld+json"]), style, link, noscript, template, svg, canvas, iframe, object, embed, video, audio, source, picture > source';

/**
 * The page without what the Worker's reader ignores, so a long page fits
 * the request. The structured data stays: it carries the page's own account
 * of itself. Null when even that is too long to send.
 */
export function slimPageHTML(html: string): string | null {
  const document = new DOMParser().parseFromString(html, 'text/html');
  for (const element of document.querySelectorAll(STRIP)) element.remove();
  for (const element of document.querySelectorAll('[style]')) element.removeAttribute('style');
  const slim = `<!doctype html>${document.documentElement.outerHTML}`;
  return slim.length > DOCS_PAGE_HTML_MAX_CHARS ? null : slim;
}

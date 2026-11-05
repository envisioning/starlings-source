import { describe, expect, it } from 'vitest';
import { bookmarkletHref, PAGE_MESSAGE, PAGE_READY, readPageMessage, slimPageHTML } from './page-capture';

/**
 * The popup trusts only what the browser vouches for: the window that opened
 * it, and a page on the origin that sent the message.
 */

const opener = {} as Window;
const page = { type: PAGE_MESSAGE, url: 'https://news.example.com/story', title: ' Story ', html: '<html></html>' };

function message(data: unknown, origin = 'https://news.example.com', source: unknown = opener): MessageEvent {
  return { data, origin, source } as MessageEvent;
}

describe('a page message', () => {
  it('is read from the window that opened the popup', () => {
    expect(readPageMessage(message(page), opener)).toEqual({ url: 'https://news.example.com/story', title: 'Story', html: '<html></html>' });
  });

  it('is ignored from any other window, or with no opener', () => {
    expect(readPageMessage(message(page, undefined, {}), opener)).toBeNull();
    expect(readPageMessage(message(page), null)).toBeNull();
  });

  it('is ignored when its page is not on the origin that sent it', () => {
    expect(readPageMessage(message(page, 'https://evil.example'), opener)).toBeNull();
    expect(readPageMessage(message({ ...page, url: 'http://news.example.com/story' }, 'http://news.example.com'), opener)).toBeNull();
  });

  it('is ignored when it is not a page', () => {
    for (const data of [null, 'text', { ...page, type: 'other' }, { ...page, html: 4 }, { ...page, url: 'not a url' }]) {
      expect(readPageMessage(message(data), opener)).toBeNull();
    }
  });
});

describe('the bookmarklet', () => {
  it('opens /save on its own workspace and answers only that origin', () => {
    const href = bookmarkletHref('https://hq.starlings.example');
    expect(href.startsWith('javascript:')).toBe(true);
    const code = decodeURIComponent(href.slice('javascript:'.length));
    expect(code).toContain('"https://hq.starlings.example"');
    expect(code).toContain('"/save"');
    expect(code).toContain(`e.data.type===${JSON.stringify(PAGE_READY)}`);
    expect(code).toContain('w.postMessage(p,o)');
    expect(() => new Function(code)).not.toThrow();
  });
});

describe('a page to send', () => {
  it('loses its code and styling and keeps its text and structured data', () => {
    const slim = slimPageHTML(`<html><head><style>p{}</style><script>track()</script>
      <script type="application/ld+json">{"isAccessibleForFree":false}</script></head>
      <body><p style="color:red">The text.</p><svg><path/></svg><iframe src="x"></iframe></body></html>`)!;
    expect(slim).toContain('The text.');
    expect(slim).toContain('isAccessibleForFree');
    expect(slim).not.toContain('track()');
    expect(slim).not.toContain('<style');
    expect(slim).not.toContain('<svg');
    expect(slim).not.toContain('<iframe');
    expect(slim).not.toContain('color:red');
  });

  it('is null when even the slim page is too long to send', () => {
    expect(slimPageHTML(`<p>${'x'.repeat(2_000_001)}</p>`)).toBeNull();
  });
});

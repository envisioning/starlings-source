import { describe, expect, it } from 'vitest';
import { extractArticle, isPaywalled, MAX_ARTICLE_CHARS } from '../src/link-article';
import { linkSaveBody, linkSaveNotes } from '../src/docs';
import { parseHTML } from 'linkedom/worker';

/**
 * A link save keeps the article. These pin what reaches the body: markdown
 * from a short list of elements, pictures as links, and a paywall said out
 * loud rather than worked around.
 */

const BASE = new URL('https://news.example.com/2026/10/story');
const DAY = new Date('2026-10-07T12:00:00Z');
const PARAGRAPH = 'The committee met on Tuesday and agreed the plan in full, after a long discussion of what it would cost and who would pay for it. ';

function page(article: string, head = ''): string {
  return `<!doctype html><html><head><title>Story</title>${head}</head><body>
    <nav><a href="/">Home</a><a href="/world">World</a></nav>
    <article><h1>The headline</h1>${article}</article>
    <footer>Copyright Example News</footer>
  </body></html>`;
}

describe('the article behind a saved link', () => {
  it('turns the article into markdown and drops the page around it', () => {
    const result = extractArticle(page(`
      <p>${PARAGRAPH}<strong>Bold claim</strong> and <em>a quiet one</em>.</p>
      <h2>What changed</h2>
      <ul><li>First <a href="/related">related story</a></li><li>Second</li></ul>
      <blockquote><p>${PARAGRAPH}</p></blockquote>
      <pre><code class="language-ts">const a = 1;</code></pre>
      <p>${PARAGRAPH}</p>
    `), BASE);
    expect(result).not.toBeNull();
    const markdown = result!.markdown;
    expect(markdown).toContain('**Bold claim** and *a quiet one*.');
    expect(markdown).toContain('## What changed');
    expect(markdown).toContain('- First [related story](https://news.example.com/related)');
    expect(markdown).toContain('> The committee met');
    expect(markdown).toContain('```ts\nconst a = 1;\n```');
    expect(markdown).not.toContain('Copyright Example News');
    expect(markdown).not.toContain('<');
    expect(result!.paywalled).toBe(false);
  });

  it('links pictures and never embeds them', () => {
    const result = extractArticle(page(`
      <p>${PARAGRAPH}</p>
      <figure><img src="/img/chart.png" alt="The chart"></figure>
      <p>${PARAGRAPH}</p>
    `), BASE);
    expect(result!.markdown).toContain('[The chart](https://news.example.com/img/chart.png)');
    expect(result!.markdown).not.toContain('![');
  });

  it('keeps what the page wrote as text, not as markup', () => {
    const result = extractArticle(page(`
      <p>${PARAGRAPH}Use &lt;script&gt; and *stars* and [brackets].</p>
      <p><a href="javascript:alert(1)">a trap</a> ${PARAGRAPH}</p>
    `), BASE);
    expect(result!.markdown).toContain('Use \\<script\\> and \\*stars\\* and \\[brackets\\].');
    expect(result!.markdown).not.toContain('javascript:');
    expect(result!.markdown).toContain('a trap');
  });

  it('answers nothing for a page with no article', () => {
    expect(extractArticle('<!doctype html><html><body><p>Sign in to continue.</p></body></html>', BASE)).toBeNull();
    expect(extractArticle('', BASE)).toBeNull();
  });

  it('cuts an article longer than the body has room for', () => {
    const result = extractArticle(page(`<p>${PARAGRAPH.repeat(1500)}</p>`), BASE);
    expect(result!.markdown.length).toBeLessThan(MAX_ARTICLE_CHARS + 100);
    expect(result!.markdown).toMatch(/Cut at 150,000 characters\.\*$/u);
  });
});

describe('a paywall', () => {
  const locked = '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"NewsArticle","isAccessibleForFree":"False","hasPart":{"@type":"WebPageElement","isAccessibleForFree":"False","cssSelector":".paywall"}}]}</script>';

  it('is read from the schema.org markup publishers write for search engines', () => {
    expect(isPaywalled(parseHTML(page('', locked)).document)).toBe(true);
    expect(isPaywalled(parseHTML(page('', '<meta property="article:content_tier" content="locked">')).document)).toBe(true);
  });

  it('is not assumed', () => {
    expect(isPaywalled(parseHTML(page('', '<meta property="article:content_tier" content="free">')).document)).toBe(false);
    expect(isPaywalled(parseHTML(page('', '<script type="application/ld+json">{"isAccessibleForFree":true}</script>')).document)).toBe(false);
    expect(isPaywalled(parseHTML(page('', '<script type="application/ld+json">{broken</script>')).document)).toBe(false);
  });

  it('marks the save, and keeps the part the page shows', () => {
    const result = extractArticle(page(`<p>${PARAGRAPH}</p><p>${PARAGRAPH}</p><p>${PARAGRAPH}</p>`, locked), BASE);
    expect(result!.paywalled).toBe(true);
    expect(result!.host).toBe('news.example.com');
    expect(linkSaveBody(undefined, result!, DAY)).toMatch(/^\*Saved from news\.example\.com on 2026-10-07\.\*\n\n> Paywalled\. Saved what the page shows without a subscription\.\n\n\S/u);
  });
});

describe('a link save body', () => {
  const article = { markdown: 'The article.\n\n---\n\nIts second part.', paywalled: false, host: 'example.com' };
  const opener = '*Saved from example.com on 2026-10-07.*';

  it('puts the notes on top and the article under a rule, opened by where and when', () => {
    expect(linkSaveBody('My notes.', article, DAY)).toBe(`My notes.\n\n---\n\n${opener}\n\n${article.markdown}`);
  });

  it('is the notes alone when there is no article, and the article alone without notes', () => {
    expect(linkSaveBody('My notes.', undefined, DAY)).toBe('My notes.');
    expect(linkSaveBody('  ', article, DAY)).toBe(`${opener}\n\n${article.markdown}`);
    expect(linkSaveBody(undefined, undefined, DAY)).toBe('');
  });

  it('gives back the notes, so a save from the browser replaces only the article', () => {
    const notes = 'Mine.\n\n---\n\nStill mine, under my own rule.';
    expect(linkSaveNotes(linkSaveBody(notes, article, DAY))).toBe(notes);
    expect(linkSaveNotes(linkSaveBody(undefined, article, DAY))).toBe('');
    expect(linkSaveNotes('Notes on a save that never had an article.')).toBe('Notes on a save that never had an article.');
  });
});

import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToMarkdown, inlineMarkdown, mainOf } from './markdown';

const base = 'https://site.example/workspace';
const md = (html: string, headingShift = 0) => htmlToMarkdown(html, { base, headingShift });

/*
 * The converter behind every product page's markdown twin (`<path>.md`). Its
 * input is React's server output; each case below is a shape a page draws.
 */
describe('htmlToMarkdown', () => {
  it('writes headings and paragraphs, shifted under the twin title', () => {
    expect(md('<h1>Title</h1><p>One <strong>bold</strong> and <em>soft</em> word.</p><h2>Next</h2>', 1))
      .toBe('## Title\n\nOne **bold** and *soft* word.\n\n### Next\n');
  });

  it('keeps links, resolved against the page', () => {
    expect(md('<p>See <a href="/pricing">pricing</a>, <a href="#calls">calls</a> and <a href="https://zod.dev">Zod</a>.</p>'))
      .toBe('See [pricing](https://site.example/pricing), [calls](https://site.example/workspace#calls) and [Zod](https://zod.dev/).\n');
  });

  it('drops what a screen reader skips: aria-hidden, inert, drawings and controls', () => {
    const html = '<div><span aria-hidden="true">01</span><svg><text>x</text></svg><div inert="">sample call</div><button>Play</button><input value="x"/><p>Kept.</p></div>';
    expect(md(html)).toBe('Kept.\n');
  });

  it('reads a labelled drawing as its name', () => {
    expect(md('<p>Mac <svg aria-label="Works"><path d=""/></svg></p>')).toBe('Mac Works\n');
  });

  it('writes nested and ordered lists, with a card heading as the item lead', () => {
    expect(md('<ul><li>One<ul><li>Inner</li></ul></li><li>Two</li></ul>')).toBe('- One\n\n  - Inner\n- Two\n');
    expect(md('<ol><li><span>01</span><h2>Kick-off</h2><p>Send a link.</p></li><li><h2>After</h2><p>Files.</p></li></ol>'))
      .toBe('1. **Kick-off**: Send a link.\n2. **After**: Files.\n');
  });

  it('writes a definition list as labelled bullets', () => {
    expect(md('<dl><div><dt>Talk</dt><dd>The thread.</dd></div><dt>History</dt><dd>Every call.</dd></dl>'))
      .toBe('- **Talk**: The thread.\n- **History**: Every call.\n');
  });

  it('writes a table, keeping columns under colspan and rowspan', () => {
    const html = '<table><thead><tr><th rowspan="2">Agent</th><th colspan="2">With Starlings</th></tr><tr><th>MCP</th><th>Team</th></tr></thead>'
      + '<tbody><tr><td><a href="/integrations/claude">Claude</a></td><td>Works</td><td>a | b</td></tr></tbody></table>';
    expect(md(html)).toBe([
      '| Agent | With Starlings · MCP | With Starlings · Team |',
      '| --- | --- | --- |',
      '| [Claude](https://site.example/integrations/claude) | Works | a \\| b |',
      '',
    ].join('\n'));
  });

  it('writes a card that is one link as the link and its text', () => {
    expect(md('<a href="/security"><span aria-hidden="true">i</span><h2>Security</h2><p>Where data lives.</p></a>'))
      .toBe('[Security](https://site.example/security): Where data lives.\n');
  });

  it('separates text the page sets apart by layout alone', () => {
    expect(md('<p><span>Lets them in.</span><span>This is a simulation.</span></p>')).toBe('Lets them in. This is a simulation.\n');
    expect(md('<ul><li><a href="/help/x">X</a><span>Summary here</span></li></ul>')).toBe('- [X](https://site.example/help/x): Summary here\n');
  });

  it('decodes entities and escapes markdown in text', () => {
    expect(decodeEntities('a &amp; b &#x27;c&#39; &nbsp;&lt;d&gt;')).toBe("a & b 'c'  <d>");
    expect(md('<p>2 * 3 [note] snake_case</p>')).toBe('2 \\* 3 \\[note\\] snake\\_case\n');
  });

  it('writes code, quotes, preformatted text and rules', () => {
    expect(md('<p>Run <code>pnpm build</code>.</p><blockquote><p>Quoted.</p></blockquote><pre>line 1\nline 2</pre><hr/>'))
      .toBe('Run `pnpm build`.\n\n> Quoted.\n\n```\nline 1\nline 2\n```\n\n---\n');
  });
});

describe('inlineMarkdown and mainOf', () => {
  it('turns a rendered row into one line', () => {
    expect(inlineMarkdown('Link a <a href="https://github.com" target="_blank">GitHub<svg aria-hidden="true"></svg></a> repository', { base }))
      .toBe('Link a [GitHub](https://github.com/) repository');
  });

  it('takes the page main and leaves the chrome', () => {
    expect(mainOf('<header>nav</header><main id="main"><p>Body</p></main><footer>f</footer>')).toBe('<main id="main"><p>Body</p></main>');
  });
});

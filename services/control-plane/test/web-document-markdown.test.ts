import { describe, expect, it } from 'vitest';
import { parseDocument } from '../../../web/src/document-markdown-parse';
import { parseMarkdown, parseSpans } from '../../../web/src/markdown-parse';

/**
 * The document grammar the Docs page reads (meet#167), and the promise that
 * the message subset did not move with it.
 */
describe('document markdown', () => {
  it('keeps every heading level and strips frontmatter', () => {
    const blocks = parseDocument('---\ntitle: x\nsubjects: []\n---\n# One\n\n#### Four ##\n\ntext');
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, spans: [{ text: 'One' }] },
      { kind: 'heading', level: 4, spans: [{ text: 'Four' }] },
      { kind: 'paragraph', spans: [{ text: 'text' }] },
    ]);
  });

  it('reads a table with alignment and escaped pipes', () => {
    const [table] = parseDocument('| Name | Count |\n|:-----|------:|\n| a \\| b | **2** |\n| c |\n');
    expect(table).toMatchObject({ kind: 'table', align: ['left', 'right'] });
    if (table?.kind !== 'table') throw new Error('not a table');
    expect(table.head.map((cell) => cell.map((span) => span.text).join(''))).toEqual(['Name', 'Count']);
    expect(table.rows[0]![0]![0]!.text).toBe('a | b');
    expect(table.rows[0]![1]![0]).toEqual({ text: '2', bold: true });
    expect(table.rows[1]).toHaveLength(1);
  });

  it('tells a rule from a table separator', () => {
    expect(parseDocument('above\n\n---\n\nbelow').map((block) => block.kind)).toEqual(['paragraph', 'rule', 'paragraph']);
    expect(parseDocument('a | b\n---|---\n1 | 2')[0]!.kind).toBe('table');
  });

  it('nests lists by indentation and reads task items', () => {
    const [list] = parseDocument('- [x] done\n- [ ] open\n  - child\n\n  more\n- plain');
    if (list?.kind !== 'list') throw new Error('not a list');
    expect(list.items.map((item) => item.checked)).toEqual([true, false, undefined]);
    expect(list.items[1]!.children.map((block) => block.kind)).toEqual(['list', 'paragraph']);
    const [numbered] = parseDocument('3. three\n4. four');
    expect(numbered).toMatchObject({ kind: 'list', ordered: true, start: 3 });
  });

  it('gathers a quote across lines and nests one inside another', () => {
    const [quote] = parseDocument('> outer\n> > inner\n>\n> back');
    if (quote?.kind !== 'quote') throw new Error('not a quote');
    expect(quote.blocks.map((block) => block.kind)).toEqual(['paragraph', 'quote', 'paragraph']);
  });

  it('reads images, footnotes, wikilinks and strikethrough', () => {
    const blocks = parseDocument('![A chart](https://x.test/c.png)\n\nSee [[Proposal|the proposal]] and ~~old~~ text[^1].\n\n[^1]: The note.');
    expect(blocks[0]).toEqual({ kind: 'image', src: 'https://x.test/c.png', alt: 'A chart' });
    const paragraph = blocks[1];
    if (paragraph?.kind !== 'paragraph') throw new Error('not a paragraph');
    expect(paragraph.spans).toEqual([
      { text: 'See ' },
      { text: 'the proposal', wikilink: 'Proposal' },
      { text: ' and ' },
      { text: 'old', strike: true },
      { text: ' text' },
      { text: '1', footnote: '1' },
      { text: '.' },
    ]);
    expect(blocks[2]).toEqual({ kind: 'footnote', id: '1', spans: [{ text: 'The note.' }] });
  });

  it('never opens a scheme a message would refuse', () => {
    const [image] = parseDocument('![x](javascript:alert(1))');
    expect(image?.kind).toBe('paragraph');
  });

  it('keeps document-only syntax out of messages', () => {
    // Strikethrough belongs to both grammars; the other document marks do not.
    expect(parseSpans('~~old~~ [[wiki]] ![i](https://x.test/i.png) note[^1]')).toEqual([
      { text: 'old', strike: true },
      { text: ' [[wiki]] !' },
      { text: 'i', link: 'https://x.test/i.png' },
      { text: ' note[^1]' },
    ]);
    expect(parseSpans('\\~x')).toEqual([{ text: '~x' }]);
    expect(parseMarkdown('#### deep')).toEqual([{ kind: 'heading', level: 3, spans: [{ text: 'deep' }] }]);
    expect(parseMarkdown('| a | b |\n|---|---|').map((block) => block.kind)).toEqual(['paragraph']);
  });
});

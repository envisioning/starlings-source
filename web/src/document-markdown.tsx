import { Fragment, type ReactNode } from 'react';
import { Checkbox } from '@/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { InlineImageContext, Runs, type Span } from './markdown';
import { parseDocument, resolveWikilinks, type DocumentBlock, type WikilinkResolver } from './document-markdown-parse';
import { t } from './i18n';

export { parseDocument, type DocumentBlock, type ListItem, type WikilinkResolver } from './document-markdown-parse';

/**
 * How a page draws an image the body names: `inline` inside a line of text,
 * else as a figure. Docs passes one that reads `docs-image:<id>` with the
 * member's session; without it an image is a plain `img`.
 */
export type ImageRenderer = (src: string, alt: string, inline: boolean) => ReactNode;

/**
 * The document, rendered. Headings keep their level, one step down so the
 * page's title is the `h1` and the outline's root: `#` is an `h2`. Footnote
 * definitions gather at the end in the order they were written. The look is
 * `.md` in styles.css, shared with message text.
 */
export function DocumentMarkdown({ text, resolveWikilink, renderImage }: { text: string; resolveWikilink?: WikilinkResolver; renderImage?: ImageRenderer }) {
  let blocks = parseDocument(text);
  if (resolveWikilink) blocks = resolveWikilinks(blocks, resolveWikilink);
  const footnotes = collectFootnotes(blocks);
  const content = <Blocks blocks={blocks} renderImage={renderImage} />;
  return (
    <div className="md">
      {renderImage
        ? <InlineImageContext.Provider value={(src, alt) => renderImage(src, alt, true)}>{content}</InlineImageContext.Provider>
        : content}
      {footnotes.length > 0 && (
        <ol className="md-footnotes">
          {footnotes.map((note) => (
            <li key={note.id} id={`fn-${note.id}`}>
              <Runs spans={note.spans} />
              {' '}
              <a href={`#fnref-${note.id}`} className="md-footnote-back" aria-label={t('Back to text')}>↩</a>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function collectFootnotes(blocks: DocumentBlock[]): Array<{ id: string; spans: Span[] }> {
  const notes: Array<{ id: string; spans: Span[] }> = [];
  for (const block of blocks) {
    if (block.kind === 'footnote') notes.push({ id: block.id, spans: block.spans });
    if (block.kind === 'quote') notes.push(...collectFootnotes(block.blocks));
    if (block.kind === 'list') for (const item of block.items) notes.push(...collectFootnotes(item.children));
  }
  return notes;
}

function Blocks({ blocks, renderImage }: { blocks: DocumentBlock[]; renderImage?: ImageRenderer }) {
  return <>{blocks.map((block, index) => <Fragment key={index}><Block block={block} renderImage={renderImage} /></Fragment>)}</>;
}

function Block({ block, renderImage }: { block: DocumentBlock; renderImage?: ImageRenderer }) {
  switch (block.kind) {
    case 'paragraph':
      return <p><Runs spans={block.spans} /></p>;
    case 'heading': {
      const level = Math.min(6, block.level + 1);
      const Tag = `h${level}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return <Tag><Runs spans={block.spans} /></Tag>;
    }
    case 'quote':
      return <blockquote><Blocks blocks={block.blocks} renderImage={renderImage} /></blockquote>;
    case 'code':
      return (
        <pre data-language={block.language || undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case 'rule':
      return <hr />;
    case 'image':
      return (
        <figure>
          {renderImage ? renderImage(block.src, block.alt, false) : <img src={block.src} alt={block.alt} loading="lazy" />}
          {block.alt && <figcaption>{block.alt}</figcaption>}
        </figure>
      );
    case 'table':
      return (
        <div className="md-table">
          <Table>
            <TableHeader>
              <TableRow>
                {block.head.map((cell, index) => (
                  <TableHead key={index} style={alignStyle(block.align[index])}><Runs spans={cell} /></TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {block.rows.map((row, rowIndex) => (
                <TableRow key={rowIndex}>
                  {block.head.map((_, index) => (
                    <TableCell key={index} style={alignStyle(block.align[index])}>
                      {row[index] ? <Runs spans={row[index]} /> : null}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      );
    case 'list': {
      const children = block.items.map((item, index) => (
        <li key={index} className={item.checked === undefined ? undefined : 'md-task'}>
          {item.checked !== undefined && (
            <Checkbox className="pointer-events-none mr-2 align-[-0.1em]" checked={item.checked} tabIndex={-1} aria-label={item.checked ? 'Done' : 'Not done'} />
          )}
          <Runs spans={item.spans} />
          {item.children.length > 0 && <Blocks blocks={item.children} renderImage={renderImage} />}
        </li>
      ));
      return block.ordered
        ? <ol start={block.start}>{children}</ol>
        : <ul>{children}</ul>;
    }
    case 'footnote':
      // Rendered at the end by DocumentMarkdown; nothing in place.
      return null;
  }
}

function alignStyle(align: 'left' | 'center' | 'right' | null): React.CSSProperties | undefined {
  return align ? { textAlign: align } : undefined;
}

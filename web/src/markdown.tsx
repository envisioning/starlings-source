import { createContext, Fragment, useContext, type ReactNode } from 'react';
import { highlightMentions, parseMarkdown, type Block, type Span } from './markdown-parse';

export {
  highlightMentions,
  parseMarkdown,
  parseSpans,
  plainText,
  safeURL,
  type Block,
  type InlineOptions,
  type Span,
} from './markdown-parse';

/** The message Markdown, drawn. The grammar and its rules live in `./markdown-parse`. */
/** The message, rendered. Inline marks first, then the block each one sits in.
 * `mentions` is a message's own resolved list — who it actually named — so
 * the matching `@handle` run draws in accent rather than being guessed at
 * render time. Omit it for anything that is not a channel/DM message. */
export function Markdown({ text, mentions = [] }: { text: string; mentions?: string[] }) {
  const blocks = highlightMentions(parseMarkdown(text), mentions);
  const rendered: ReactNode[] = [];
  let index = 0;

  while (index < blocks.length) {
    const block = blocks[index];
    if (block.kind === 'bullet' || block.kind === 'ordered') {
      // Consecutive items of the same shape are one list, so the browser draws
      // the spacing a list has rather than a stack of paragraphs.
      const kind = block.kind;
      const start = block.kind === 'ordered' ? block.index : 1;
      const items: { level: number; spans: Span[] }[] = [];
      const key = `list-${index}`;
      while (index < blocks.length) {
        const next = blocks[index];
        if (next.kind !== 'bullet' && next.kind !== 'ordered') break;
        if (next.kind !== kind) break;
        items.push({ level: next.level, spans: next.spans });
        index += 1;
      }
      const children = items.map((item, position) => (
        <li key={position} style={item.level ? { marginInlineStart: `${item.level * 1.1}rem` } : undefined}>
          <Runs spans={item.spans} />
        </li>
      ));
      rendered.push(kind === 'bullet'
        ? <ul key={key}>{children}</ul>
        : <ol key={key} start={start}>{children}</ol>);
      continue;
    }
    rendered.push(<Leaf key={index} block={block} />);
    index += 1;
  }
  return <div className="md md--message">{rendered}</div>;
}

function Leaf({ block }: { block: Block }) {
  switch (block.kind) {
    case 'code':
      return <pre><code>{block.text}</code></pre>;
    case 'quote':
      return <blockquote><Runs spans={block.spans} /></blockquote>;
    case 'heading': {
      // Never `h1`: a message is inside somebody else's document outline.
      const Tag = (block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5') as 'h3' | 'h4' | 'h5';
      return <Tag><Runs spans={block.spans} /></Tag>;
    }
    default:
      return <p><Runs spans={block.spans} /></p>;
  }
}

/**
 * How a document draws an image in a line of text (`DocumentMarkdown`'s
 * `renderImage`): one attached to the document is read with the member's
 * session. A message has none and draws a plain `img`.
 */
export const InlineImageContext = createContext<((src: string, alt: string) => ReactNode) | null>(null);

/** The inline marks of one block. Shared with the document renderer. */
export function Runs({ spans }: { spans: Span[] }) {
  const renderImage = useContext(InlineImageContext);
  return <>{spans.map((span, index) => {
    if (span.image) {
      return renderImage
        ? <Fragment key={index}>{renderImage(span.image, span.text)}</Fragment>
        : <img key={index} className="md-image" src={span.image} alt={span.text} loading="lazy" />;
    }
    if (span.footnote) {
      return <sup key={index} className="md-footnote-ref"><a href={`#fn-${span.footnote}`} id={`fnref-${span.footnote}`}>{span.text}</a></sup>;
    }
    let node: ReactNode = span.code ? <code>{span.text}</code> : span.text;
    if (span.bold) node = <strong>{node}</strong>;
    if (span.italic) node = <em>{node}</em>;
    if (span.strike) node = <del>{node}</del>;
    if (span.wikilink && !span.link) {
      // Unresolved on this surface: the words stay, marked as a link that
      // goes nowhere yet, rather than vanishing or becoming a dead anchor.
      node = <span className="md-wikilink md-wikilink--unresolved">{node}</span>;
    }
    if (span.link) {
      node = span.internal
        ? <a href={span.link} className={span.wikilink ? 'md-wikilink' : undefined}>{node}</a>
        : <a href={span.link} target="_blank" rel="noreferrer noopener">{node}</a>;
    }
    if (span.mention) {
      node = <span className="md-mention">{node}</span>;
    }
    return <Fragment key={index}>{node}</Fragment>;
  })}</>;
}

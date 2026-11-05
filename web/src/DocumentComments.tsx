import { useCallback, useEffect, useState, type RefObject } from 'react';
import { Textarea } from '@/ui/textarea';
import { Button } from '@/ui/button';
import { SendIcon } from './action-icons';
import { composerFieldPadding, composerSendClass } from './composer-send';
import { Badge } from '@/ui/badge';
import { Card } from '@/ui/card';
import { cn } from '@/lib/utils';
import { ErrorNotice } from './ErrorNotice';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { Markdown } from './markdown';
import { formatTime } from './meeting-time';
import {
  createDocsAnnotation,
  fetchDocsAnnotations,
  threadsOf,
  updateDocsAnnotation,
  type DocsAnnotation,
  type DocsTextAnchor,
  type DocsThread,
} from './docs';
import { t, dateLocale } from './i18n';

/**
 * Comments on a document — Docs annotations: a thread on a
 * selected passage, replies, resolve / reopen by any member. The column
 * beside the document on a wide window, a Sheet elsewhere.
 *
 * Anchors are the rendered text: the quote plus forty characters either
 * side, which is what Docs re-anchors on after an edit. A quote that spans
 * inline markup (`**bold**`) will not match the markdown source and comes
 * back `orphaned`; the thread still reads, it just no longer points.
 */

const CONTEXT = 40;

/** The reader's text as one string, and where each text node starts in it. */
function readerText(root: HTMLElement): { text: string; nodes: Array<{ node: Text; start: number }> } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Array<{ node: Text; start: number }> = [];
  let text = '';
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const node = current as Text;
    nodes.push({ node, start: text.length });
    text += node.data;
  }
  return { text, nodes };
}

function offsetOf(nodes: Array<{ node: Text; start: number }>, container: Node, offset: number): number | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const entry = nodes.find((candidate) => candidate.node === container);
    return entry ? entry.start + offset : null;
  }
  // An element boundary: the offset counts child nodes; take the first
  // text node at or after that child.
  const child = container.childNodes[offset] ?? null;
  if (child) {
    const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
    const first = (child.nodeType === Node.TEXT_NODE ? child : walker.nextNode()) as Text | null;
    const entry = first ? nodes.find((candidate) => candidate.node === first) : undefined;
    if (entry) return entry.start;
  }
  const last = nodes[nodes.length - 1];
  return last ? last.start + last.node.data.length : 0;
}

/** Where the anchor's quote is in the text — the occurrence whose context fits best. */
function locate(text: string, anchor: DocsTextAnchor): number {
  let best = -1;
  let bestScore = -1;
  let from = 0;
  for (;;) {
    const at = text.indexOf(anchor.quote, from);
    if (at === -1) break;
    let score = 0;
    if (anchor.prefix && text.slice(Math.max(0, at - anchor.prefix.length), at) === anchor.prefix) score += 2;
    if (anchor.suffix && text.slice(at + anchor.quote.length, at + anchor.quote.length + anchor.suffix.length) === anchor.suffix) score += 2;
    if (score > bestScore) { best = at; bestScore = score; }
    from = at + 1;
  }
  return best;
}

function rangeFor(nodes: Array<{ node: Text; start: number }>, start: number, end: number): Range | null {
  const startEntry = [...nodes].reverse().find((entry) => entry.start <= start);
  const endEntry = [...nodes].reverse().find((entry) => entry.start < end) ?? startEntry;
  if (!startEntry || !endEntry) return null;
  const range = document.createRange();
  range.setStart(startEntry.node, Math.min(start - startEntry.start, startEntry.node.data.length));
  range.setEnd(endEntry.node, Math.min(end - endEntry.start, endEntry.node.data.length));
  return range;
}

export interface ReaderSelection {
  anchor: DocsTextAnchor;
  /** Viewport box of the selection's end, for the Comment affordance. */
  x: number;
  y: number;
}

/** A text selection inside the reader, as an anchor, or null. */
export function useReaderSelection(reader: RefObject<HTMLElement | null>, enabled: boolean): ReaderSelection | null {
  const [selection, setSelection] = useState<ReaderSelection | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSelection(null);
      return;
    }
    const read = () => {
      const root = reader.current;
      const live = window.getSelection();
      if (!root || !live || live.rangeCount === 0 || live.isCollapsed) {
        setSelection(null);
        return;
      }
      const range = live.getRangeAt(0);
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
        setSelection(null);
        return;
      }
      const { text, nodes } = readerText(root);
      const start = offsetOf(nodes, range.startContainer, range.startOffset);
      const end = offsetOf(nodes, range.endContainer, range.endOffset);
      if (start === null || end === null || end <= start) {
        setSelection(null);
        return;
      }
      const quote = text.slice(start, end);
      if (!quote.trim() || quote.length > 2000) {
        setSelection(null);
        return;
      }
      const rects = range.getClientRects();
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
      setSelection({
        anchor: {
          type: 'text',
          quote,
          prefix: text.slice(Math.max(0, start - CONTEXT), start),
          suffix: text.slice(end, end + CONTEXT),
        },
        x: last.right,
        y: last.bottom,
      });
    };
    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, [reader, enabled]);

  return selection;
}

/**
 * The anchored passages, lit. The CSS Custom Highlight API paints ranges
 * without touching the DOM React owns; a browser without it draws nothing
 * and the thread still shows its quote.
 */
export function useAnchorHighlights(reader: RefObject<HTMLElement | null>, threads: DocsThread[], selected: string | null, body: string): void {
  useEffect(() => {
    const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const HighlightClass = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    const root = reader.current;
    if (!highlights || !HighlightClass || !root) return;
    const { text, nodes } = readerText(root);
    const open: Range[] = [];
    const current: Range[] = [];
    for (const thread of threads) {
      const anchor = thread.root.anchor;
      if (!anchor || anchor.type !== 'text' || thread.status === 'resolved') continue;
      const at = locate(text, anchor);
      if (at === -1) continue;
      const range = rangeFor(nodes, at, at + anchor.quote.length);
      if (!range) continue;
      (thread.id === selected ? current : open).push(range);
    }
    highlights.set('docs-comment', new HighlightClass(...open));
    highlights.set('docs-comment-current', new HighlightClass(...current));
    return () => {
      highlights.delete('docs-comment');
      highlights.delete('docs-comment-current');
    };
  }, [reader, threads, selected, body]);
}

export function DocumentComments({ documentID, pending, onPendingDone, selected, onSelect, onCountChange, onOpenQuote }: {
  documentID: string;
  /** A passage just chosen in the reader, waiting for its first comment. */
  pending: DocsTextAnchor | null;
  onPendingDone: () => void;
  selected: string | null;
  onSelect: (threadID: string | null) => void;
  onCountChange: (open: number) => void;
  /** Bring the passage into view. */
  onOpenQuote: (anchor: DocsTextAnchor) => void;
}) {
  const [annotations, setAnnotations] = useState<DocsAnnotation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [showResolved, setShowResolved] = useState(false);

  const load = useCallback(async () => {
    try {
      setAnnotations(await fetchDocsAnnotations(documentID));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t load the comments.'));
    }
    setLoaded(true);
  }, [documentID]);

  useEffect(() => { void load(); }, [load]);

  const threads = threadsOf(annotations);
  const open = threads.filter((thread) => thread.status === 'open');
  const resolved = threads.filter((thread) => thread.status === 'resolved');

  useEffect(() => { onCountChange(open.length); }, [open.length, onCountChange]);

  async function post(input: { body_md: string; anchor?: DocsTextAnchor; parent_id?: string }) {
    const created = await createDocsAnnotation(documentID, input);
    setAnnotations((current) => [...current, created]);
    return created;
  }

  async function setStatus(thread: DocsThread, status: 'open' | 'resolved') {
    try {
      const updated = await updateDocsAnnotation(thread.root.id, { status });
      setAnnotations((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t change the comment.'));
    }
  }

  return (
    <aside aria-label={t('Comments')}>
      <div className="mb-1 flex min-h-9 items-center justify-between" data-comments-head>
        <h3 className="m-0 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{t('Comments')}</h3>
        {resolved.length > 0 && (
          <Button type="button" variant="ghost" size="xs" className="font-normal text-muted-foreground hover:text-foreground" onClick={() => setShowResolved((current) => !current)}>
            {showResolved ? t('Hide resolved') : `${resolved.length} resolved`}
          </Button>
        )}
      </div>
      {error && <ErrorNotice message={error} action={<Button type="button" variant="outline" size="xs" onClick={() => void load()}>{t('Retry')}</Button>} />}
      {pending && (
        <Composer
          quote={pending.quote}
          placeholder={t('Comment on this passage')}
          submitLabel="Comment"
          onCancel={onPendingDone}
          onSubmit={async (body) => {
            await post({ body_md: body, anchor: pending });
            onPendingDone();
          }}
        />
      )}
      {!loaded && !error && <PlaceholderRows count={2} glyph={false} label={t('Loading…')} />}
      {loaded && !pending && threads.length === 0 && (
        <p className="mt-3.5 mb-0 text-[13px] text-muted-foreground">{t('Select a passage to comment on it.')}</p>
      )}
      {open.map((thread) => (
        <Thread
          key={thread.id}
          thread={thread}
          selected={thread.id === selected}
          onSelect={() => { onSelect(thread.id); if (thread.root.anchor?.type === 'text' && !thread.root.orphaned) onOpenQuote(thread.root.anchor); }}
          onReply={(body) => post({ body_md: body, parent_id: thread.root.id })}
          onResolve={() => void setStatus(thread, 'resolved')}
        />
      ))}
      {showResolved && resolved.map((thread) => (
        <Thread
          key={thread.id}
          thread={thread}
          selected={thread.id === selected}
          onSelect={() => onSelect(thread.id)}
          onReply={(body) => post({ body_md: body, parent_id: thread.root.id })}
          onReopen={() => void setStatus(thread, 'open')}
        />
      ))}
    </aside>
  );
}

/** The passage a thread is about: a quote with the accent rule, struck through once it is gone. */
function Quote({ text, orphaned = false }: { text: string; orphaned?: boolean }) {
  return (
    <blockquote
      className={cn(
        'docs-thread-quote m-0 mb-2 line-clamp-3 border-s-2 border-(--accent) py-0.5 ps-2 text-xs leading-snug text-muted-foreground',
        orphaned && 'border-border line-through',
      )}
    >
      {text}
    </blockquote>
  );
}

function Thread({ thread, selected, onSelect, onReply, onResolve, onReopen }: {
  thread: DocsThread;
  selected: boolean;
  onSelect: () => void;
  onReply: (body: string) => Promise<unknown>;
  onResolve?: () => void;
  onReopen?: () => void;
}) {
  const [replying, setReplying] = useState(false);
  const anchor = thread.root.anchor;
  return (
    <Card
      role="article"
      onClick={onSelect}
      className={cn(
        'mb-2.5 cursor-pointer gap-0 bg-muted px-3 py-2.5 shadow-none',
        selected && 'border-(--accent)',
        thread.status === 'resolved' && 'opacity-70',
      )}
    >
      {anchor?.type === 'text' && <Quote text={anchor.quote} orphaned={thread.root.orphaned} />}
      {thread.root.orphaned && <p className="m-0 mb-2 text-xs text-muted-foreground">{t('This passage is no longer in the document.')}</p>}
      <Comment annotation={thread.root} />
      {thread.replies.map((reply) => <Comment key={reply.id} annotation={reply} />)}
      <div className="-ml-1.5 mt-0.5 flex gap-1">
        {!replying && <Button type="button" variant="ghost" size="xs" className="font-normal text-muted-foreground hover:text-foreground" onClick={(event) => { event.stopPropagation(); setReplying(true); }}>{t('Reply')}</Button>}
        {onResolve && <Button type="button" variant="ghost" size="xs" className="font-normal text-muted-foreground hover:text-foreground" onClick={(event) => { event.stopPropagation(); onResolve(); }}>{t('Resolve')}</Button>}
        {onReopen && <Button type="button" variant="ghost" size="xs" className="font-normal text-muted-foreground hover:text-foreground" onClick={(event) => { event.stopPropagation(); onReopen(); }}>{t('Reopen')}</Button>}
      </div>
      {replying && (
        <Composer
          placeholder={t('Reply')}
          submitLabel="Reply"
          onCancel={() => setReplying(false)}
          onSubmit={async (body) => { await onReply(body); setReplying(false); }}
        />
      )}
    </Card>
  );
}

function Comment({ annotation }: { annotation: DocsAnnotation }) {
  const at = new Date(annotation.created_at);
  const when = Number.isNaN(at.valueOf()) ? '' : at.toDateString() === new Date().toDateString()
    ? formatTime(at)
    : at.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' });
  const who = annotation.author_name || annotation.author.split('@')[0] || annotation.author;
  return (
    <div className="docs-comment mb-2 text-[13px] [&_.md]:text-foreground [&_.md_p]:mt-0 [&_.md_p]:mb-[0.4em]">
      <div className="mb-0.5 flex items-baseline gap-1.5">
        <strong className="font-semibold">{who}</strong>
        {annotation.author_kind === 'agent' && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal tracking-[0.06em] text-muted-foreground uppercase">{t('Agent')}</Badge>
        )}
        {when && <small className="text-[11px] text-muted-foreground">{when}</small>}
      </div>
      <Markdown text={annotation.body_md} />
    </div>
  );
}

function Composer({ quote, placeholder, submitLabel, onSubmit, onCancel }: {
  quote?: string;
  placeholder: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
      setBody('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t post the comment.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="mb-2.5 cursor-default rounded-xl border border-(--accent) bg-card px-3 py-2.5"
      data-docs-composer
      onSubmit={(event) => void submit(event)}
      onClick={(event) => event.stopPropagation()}
    >
      {quote && <Quote text={quote} />}
      {/* Submit sits inside the field on its right edge (meet#621). */}
      <div className="relative">
      <Textarea
        value={body}
        placeholder={placeholder}
        aria-label={placeholder}
        rows={3}
        maxLength={16_000}
        autoFocus
        className={cn('resize-none text-[13px] md:text-[13px]', composerFieldPadding)}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit(event);
          // Escape drops an empty composer; written text stays until Cancel.
          if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
            event.stopPropagation();
            if (!body.trim()) onCancel();
          }
        }}
      />
      <Button type="submit" size="icon" className={composerSendClass} aria-label={submitLabel} title={submitLabel} disabled={busy || !body.trim()}>
        <SendIcon />
      </Button>
      </div>
      {error && <ErrorNotice inline className="mt-1.5 text-xs" message={error} />}
      <div className="mt-2 flex gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>{t('Cancel')}</Button>
      </div>
    </form>
  );
}

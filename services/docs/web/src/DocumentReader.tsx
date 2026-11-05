import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Annotation, DocumentDetail } from '@docs/contracts';
import { api } from './api';
import { navigate } from './App';
import { renderMarkdown } from './markdown';

/**
 * Reader shared by staff and guests. Selecting text opens a comment box
 * anchored to that quote; document-level comments are the same thing with no
 * anchor, which is what "feedback" means here.
 */
export function DocumentReader({
  document: doc,
  canComment,
  onChanged,
}: {
  document: DocumentDetail;
  canComment: boolean;
  onChanged?: () => void;
}) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selection, setSelection] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    void api
      .annotations(doc.id)
      .then((result) => setAnnotations(result.annotations))
      .catch(() => setAnnotations([]));
  }, [doc.id]);

  useEffect(load, [load]);
  useEffect(() => {
    void api.visit(doc.id);
  }, [doc.id]);

  const resolveLink = useMemo(() => {
    const byTarget = new Map(doc.links.map((link) => [link.target, link.to_path]));
    return (target: string) => {
      const path = byTarget.get(target);
      return path ? `/doc${path}` : null;
    };
  }, [doc.links]);

  const html = useMemo(
    () => (doc.kind === 'markdown' ? renderMarkdown(doc.body_md ?? '', resolveLink) : ''),
    [doc.body_md, doc.kind, resolveLink],
  );

  // Intercept wikilink clicks so they route in-app instead of reloading.
  // Any other http(s) link in the body is reported as a click, and the
  // browser follows it as it would have anyway.
  useEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const report = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement).closest('a');
      // Off-site links only: an in-app link is navigation, not a click out.
      if (
        anchor instanceof HTMLAnchorElement &&
        /^https?:$/u.test(anchor.protocol) &&
        anchor.origin !== window.location.origin
      ) {
        api.click(doc.id, anchor.href);
      }
    };
    const onClick = (event: MouseEvent) => {
      const wikilink = (event.target as HTMLElement).closest('a.wikilink');
      const href = wikilink?.getAttribute('href');
      if (href?.startsWith('/doc/')) {
        event.preventDefault();
        navigate(href);
        return;
      }
      report(event);
    };
    node.addEventListener('click', onClick);
    // A middle click opens a tab without a `click` event.
    const onAuxClick = (event: MouseEvent) => {
      if (event.button === 1) report(event);
    };
    node.addEventListener('auxclick', onAuxClick);
    return () => {
      node.removeEventListener('click', onClick);
      node.removeEventListener('auxclick', onAuxClick);
    };
  }, [html, doc.id]);

  function captureSelection() {
    if (!canComment) return;
    const text = window.getSelection()?.toString().trim();
    // Anything shorter is noise, anything longer stops being an anchor.
    if (text && text.length > 3 && text.length < 1000) setSelection(text);
  }

  async function submit(anchorQuote: string | null) {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await api.addAnnotation(doc.id, {
        body_md: draft,
        anchor: anchorQuote ? { type: 'text', quote: anchorQuote } : null,
      });
      setDraft('');
      setSelection(null);
      load();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  const threads = useMemo(() => {
    const roots = annotations.filter((annotation) => !annotation.parent_id);
    return roots.map((root) => ({
      root,
      replies: annotations.filter((annotation) => annotation.parent_id === root.id),
    }));
  }, [annotations]);

  return (
    <div className="reader">
      <div className="reader-body">
        {doc.kind === 'pdf' ? (
          <iframe className="pdf" title={doc.title} src={`/api/docs/${doc.id}/raw`} />
        ) : (
          <div
            ref={bodyRef}
            className="prose"
            onMouseUp={captureSelection}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}

        {doc.backlinks.length ? (
          <section className="backlinks">
            <h4>Linked from</h4>
            <ul>
              {doc.backlinks.map((link) => (
                <li key={link.id}>
                  <a
                    href={`/doc${link.path}`}
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(`/doc${link.path}`);
                    }}
                  >
                    {link.title}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <aside className="comments">
        <h4>
          Comments{' '}
          {annotations.length ? <span className="count">{annotations.filter((a) => a.status === 'open').length}</span> : null}
        </h4>

        {selection ? (
          <div className="comment-compose anchored">
            <blockquote>{selection}</blockquote>
            <textarea
              autoFocus
              value={draft}
              placeholder="Comment on this passage…"
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="row">
              <button className="button" disabled={busy} onClick={() => void submit(selection)}>
                Comment
              </button>
              <button className="button ghost" onClick={() => { setSelection(null); setDraft(''); }}>
                Cancel
              </button>
            </div>
          </div>
        ) : canComment ? (
          <div className="comment-compose">
            <textarea
              value={draft}
              placeholder="Leave feedback on the whole document, or select text to comment on a passage."
              onChange={(event) => setDraft(event.target.value)}
            />
            <button className="button" disabled={busy || !draft.trim()} onClick={() => void submit(null)}>
              Send feedback
            </button>
          </div>
        ) : null}

        <ul className="threads">
          {threads.map(({ root, replies }) => (
            <li key={root.id} className={root.status === 'resolved' ? 'resolved' : ''}>
              {root.anchor?.type === 'text' ? (
                <blockquote className={root.orphaned ? 'orphaned' : ''}>
                  {root.anchor.quote}
                  {root.orphaned ? <em> — this passage has since changed</em> : null}
                </blockquote>
              ) : null}
              <p className="comment-body">{root.body_md}</p>
              <p className="meta">
                {root.author_name ?? root.author} · {new Date(root.created_at).toLocaleString()}
                {root.author_kind === 'agent' ? ' · agent' : ''}
              </p>
              {replies.map((reply) => (
                <p key={reply.id} className="reply">
                  <strong>{reply.author_name ?? reply.author}</strong> {reply.body_md}
                </p>
              ))}
              {canComment ? (
                <button
                  className="link"
                  onClick={() => {
                    void api.resolveAnnotation(root.id, root.status === 'open' ? 'resolved' : 'open').then(load);
                  }}
                >
                  {root.status === 'open' ? 'Resolve' : 'Reopen'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

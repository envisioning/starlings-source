import { useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { PlaceholderBar } from '@/ui/placeholder-rows';
import { ErrorNotice } from './ErrorNotice';
import { docsImageID, fetchDocsImageURL } from './docs';
import { t } from './i18n';

/**
 * An image in a document body. `docs-image:<id>` is one attached to the
 * document (the form every client writes, `DOCS_IMAGE_SCHEME`): its bytes
 * are behind the member's session, so they are read here and drawn from an
 * object URL. Any other source is an ordinary `https` image.
 */
export function DocumentImage({ documentID, src, alt, inline = false }: {
  documentID: string | undefined;
  src: string;
  alt: string;
  /** Inside a line of text: no box, no notice that would break the paragraph. */
  inline?: boolean;
}) {
  const id = docsImageID(src);
  const [url, setURL] = useState<string | null>(id ? null : src);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!id) return;
    if (!documentID) {
      setError(t('Couldn’t load the image.'));
      return;
    }
    let cancelled = false;
    setError('');
    fetchDocsImageURL(documentID, id).then(
      (next) => { if (!cancelled) setURL(next); },
      (cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t load the image.')); },
    );
    return () => { cancelled = true; };
  }, [documentID, id, attempt]);

  const className = inline ? 'md-image' : undefined;
  if (error) {
    if (inline) return <span className="text-(--danger-ink)" role="img" aria-label={error}>{alt || t('Image')}</span>;
    return (
      <ErrorNotice
        message={alt ? `${error} ${alt}` : error}
        action={<Button type="button" variant="outline" size="xs" onClick={() => setAttempt((current) => current + 1)}>{t('Retry')}</Button>}
      />
    );
  }
  if (!url) {
    return inline
      ? <span className="inline-block h-[1.5em] w-[3em] rounded bg-muted align-middle" aria-label={t('Loading…')} />
      : <PlaceholderBar className="h-40 w-full max-w-[420px] rounded-lg" />;
  }
  return <img className={className} src={url} alt={alt} loading="lazy" />;
}

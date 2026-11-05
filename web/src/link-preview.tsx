import { useEffect, useState } from 'react';
import type { LinkPreview, LinkPreviewResponse } from '@starlings/contracts';
import { apiFetch } from './api';
import { parseMarkdown } from './markdown';
import { t } from './i18n';
import { Card } from '@/ui/card';

/**
 * The card under a message that carries a link.
 *
 * The browser never reads the linked page — the Worker does, and answers the
 * text. See `services/control-plane/src/link-preview.ts` for why: a device
 * unfurling its own links tells every site anybody pastes the address of every
 * participant who was in the room at the time, and the guests did not paste
 * anything.
 *
 * Everything on the card is a React text node. A preview is metadata written
 * by whoever owns the page at the other end of a link somebody pasted, which
 * makes it the least trustworthy string in the app; `dangerouslySetInnerHTML`
 * has no business anywhere near it.
 */

/** How a surface asks. Owner pages have a session cookie; a guest has a token. */
export type PreviewLoader = (url: string) => Promise<LinkPreview>;

/** The signed-in member's door. */
export const ownerPreviewLoader: PreviewLoader = async (url) => {
  const body = await apiFetch<LinkPreviewResponse>(
    `/link-preview?url=${encodeURIComponent(url)}`,
    { fallbackError: t('Couldn’t read that link.') },
  );
  return body.preview;
};

/** A guest's door: same answer, authorized by the meeting rather than an account. */
export function guestPreviewLoader(
  roomSlug: string,
  meetingID: string,
  artifactToken: string,
): PreviewLoader {
  return async (url) => {
    const body = await apiFetch<LinkPreviewResponse>(
      `/rooms/${encodeURIComponent(roomSlug)}/meetings/${encodeURIComponent(meetingID)}`
      + `/link-preview?url=${encodeURIComponent(url)}`,
      { token: artifactToken, fallbackError: t('Couldn’t read that link.') },
    );
    return body.preview;
  };
}

/**
 * One request per link per page load, shared by every message that names it.
 *
 * The promise is cached rather than the result, so ten messages quoting the
 * same link on first render make one request between them instead of ten.
 * A failure is cached as `null` too: a link that cannot be read cannot be read,
 * and retrying it once per re-render is how a bad paste becomes a loop.
 */
const inFlight = new Map<string, Promise<LinkPreview | null>>();

function load(url: string, loader: PreviewLoader): Promise<LinkPreview | null> {
  const cached = inFlight.get(url);
  if (cached) return cached;
  const promise = loader(url).catch(() => null);
  inFlight.set(url, promise);
  return promise;
}

/**
 * The first link in a message, if it has one.
 *
 * Reuses the Markdown parser rather than running a second URL pattern over the
 * text: that parser already decides what counts as a link here — including
 * bare URLs and `www.` — and two answers to that question is one too many.
 * Only the first is previewed; a message that is a list of links wants to stay
 * a list of links, not become a wall of cards.
 */
export function firstPreviewableLink(text: string): string | null {
  for (const block of parseMarkdown(text)) {
    if (block.kind === 'code') continue;
    for (const span of block.spans) {
      // http:// is skipped on purpose — the Worker refuses it, so asking would
      // only ever produce an error the reader cannot act on.
      if (span.link?.startsWith('https://')) return span.link;
    }
  }
  return null;
}

/** The preview for a message's first link, once it arrives. Never throws. */
export function useLinkPreview(text: string, loader: PreviewLoader): LinkPreview | null {
  const url = firstPreviewableLink(text);
  const [preview, setPreview] = useState<LinkPreview | null>(null);

  useEffect(() => {
    if (!url) {
      setPreview(null);
      return undefined;
    }
    let stopped = false;
    void load(url, loader).then((result) => {
      if (!stopped) setPreview(result);
    });
    return () => { stopped = true; };
    // The loader is rebuilt per render on some surfaces; the URL is what
    // identifies the request, and the cache above is what makes that safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return preview;
}

/**
 * A message's link, drawn as a card.
 *
 * Nothing is drawn until there is something to say: a card that is only a
 * spinner, or only a domain the link already shows, is noise under every
 * message. `rel` is the usual pair plus `noreferrer`, which matters more here
 * than usual — the whole point of the Worker reading the page was that the
 * site learns nothing about the room, and a referrer on the click would hand
 * back the address of the meeting.
 */
export function LinkPreviewCard({ preview }: { preview: LinkPreview | null }) {
  if (!preview || (!preview.title && !preview.description)) return null;
  return (
    // The Card is the look: a quiet block bounded to 32rem, the
    // accent on its leading edge. The colours sit on the Card and its lines;
    // the anchor itself takes the text around it.
    <a
      className="group/link mt-1.5 block max-w-[min(100%,32rem)] no-underline"
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      <Card className="gap-0.5 rounded-lg border-s-[3px] border-s-primary/55 bg-muted px-2.5 py-2 shadow-none [overflow-wrap:anywhere] group-hover/link:bg-[linear-gradient(var(--ui-accent),var(--ui-accent))]">
        {preview.image_url && (
          // Meet's own address, never the publisher's — see `image_url` in the
          // contract. `loading="lazy"` because a thread can carry many of these
          // and none of them is why somebody opened it; the fixed box (the
          // og:image banner ratio) keeps the transcript from reflowing as each
          // one lands.
          <img
            className="mb-1 aspect-[1.91/1] w-full rounded-md bg-popover object-cover"
            src={preview.image_url}
            alt={preview.image_alt ?? ''}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={(event) => {
              // A publisher can take an image down after the Worker cached its
              // metadata. Keep the card readable and avoid leaving a broken
              // image glyph in the conversation.
              event.currentTarget.remove();
            }}
          />
        )}
        <span className="text-[11px] font-semibold tracking-[.02em] text-muted-foreground">{preview.site_name ?? preview.domain}</span>
        {preview.title && <span className="text-[13px] leading-tight font-semibold text-foreground">{preview.title}</span>}
        {/* Two lines is a summary; more is the article, and the article has its own page. */}
        {preview.description && (
          <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">{preview.description}</span>
        )}
      </Card>
    </a>
  );
}

/** The card for a message, fetched and drawn in one step. */
export function MessageLinkPreview({ text, loader }: { text: string; loader: PreviewLoader }) {
  const preview = useLinkPreview(text, loader);
  return <LinkPreviewCard preview={preview} />;
}

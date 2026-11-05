import { useState, type ReactNode } from 'react';
import type { CrmSubject } from './crm-work';

/** The one leading well every Work row shares — round for areas/identity,
 * square for actionable records. A task's checkmark, a note's pencil, and an
 * issue's state glyph sit directly in the square well; do not nest a square
 * glyph inside it. */
export type GlyphMarkShape = 'round' | 'square';

/**
 * The well: a hairline circle on the raised rung, in neutral ink, the accent
 * budget's default for an icon (the Mac's `WorkGlyphMarkView`, the phone's
 * `WorkGlyphMark`). Inside a Home row's mark the row sets the ink and the
 * well inherits it (primary when late, accent for our own room).
 */
const GLYPH_MARK = 'relative inline-grid flex-none place-items-center overflow-hidden border border-border bg-popover text-muted-foreground [.home-row-mark_&]:text-inherit [[data-home-mark]>&]:text-inherit';

export function GlyphMark({ size = 26, shape = 'round', children }: {
  size?: number;
  shape?: GlyphMarkShape;
  children: ReactNode;
}) {
  return (
    <span className={`${GLYPH_MARK} ${shape === 'square' ? 'rounded-[25%]' : 'rounded-full'}`} style={{ width: size, height: size }} aria-hidden="true">
      {children}
    </span>
  );
}

/**
 * A subject's mark: the organization's logo when Core has one, the kind's
 * glyph otherwise — the web's `WorkOrgLogoMarkView` / `WorkGlyphMarkView`
 * (Sources/WorkSidebarRowView.swift). The glyph draws first and the logo
 * covers it once loaded, so a row never waits on a picture; a failed fetch
 * stays on the glyph, never a blank well. Same glyphs as the Mac and the
 * phone: folder for a project, flag for a lead, building for a partner,
 * calendar for an event.
 */
export function SubjectMark({ subject, size = 28 }: {
  subject: Pick<CrmSubject, 'kind' | 'organization_logo_url'>;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const url = subject.organization_logo_url?.trim() || null;
  const showLogo = url !== null && !failed;
  return (
    <GlyphMark size={size}>
      <KindGlyph kind={subject.kind} size={Math.round(size * 0.5)} />
      {showLogo && (
        <img
          className="absolute inset-0 size-full bg-white object-cover"
          src={url}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
    </GlyphMark>
  );
}

function KindGlyph({ kind, size }: { kind: CrmSubject['kind']; size: number }) {
  const common = { width: size, height: size, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true as const };
  switch (kind) {
    case 'project':
      // folder.fill
      return (
        <svg {...common}>
          <path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2c.4 0 .8.16 1.06.44L8.5 3.7h4.5A1.5 1.5 0 0 1 14.5 5.2v1H1.5v-2.7ZM1.5 7.2h13v4.8A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V7.2Z" />
        </svg>
      );
    case 'lead':
      // flag.fill
      return (
        <svg {...common}>
          <path d="M3 1.5a.75.75 0 0 1 .75.75v.32c1.9-.9 3.6-.8 5.6.1 1.7.75 3 .8 4.4.2a.75.75 0 0 1 1 .7v6.1a.75.75 0 0 1-.45.69c-1.9.8-3.6.8-5.6-.1-1.7-.75-3-.8-4.4-.2v4.2a.75.75 0 0 1-1.5 0V2.25A.75.75 0 0 1 3 1.5Z" />
        </svg>
      );
    case 'event':
      // megaphone.fill: a published event, as on Mac, iPhone and Home
      return (
        <svg {...common}>
          <path d="M12.1 2.1a.75.75 0 0 1 1.15.63v10.54a.75.75 0 0 1-1.15.63L7.3 11H6.6l.6 2.3a.75.75 0 0 1-1.45.38L5.05 11H3.5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3.8l4.8-2.9Z" />
          <path d="M14.25 6.4a.75.75 0 0 1 .75.75v1.7a.75.75 0 0 1-1.5 0v-1.7a.75.75 0 0 1 .75-.75Z" />
        </svg>
      );
    case 'organization':
      // building.2.fill
      return (
        <svg {...common}>
          <path d="M2 2.5A1 1 0 0 1 3 1.5h5a1 1 0 0 1 1 1V6h3.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-11Zm2 1.5v1.5h1.5V4H4Zm2.5 0v1.5H8V4H6.5ZM4 7v1.5h1.5V7H4Zm2.5 0v1.5H8V7H6.5ZM4 10v1.5h1.5V10H4Zm2.5 0v1.5H8V10H6.5Zm4-2v1.5H12V8h-1.5Zm0 3v1.5H12V11h-1.5Z" />
        </svg>
      );
  }
}

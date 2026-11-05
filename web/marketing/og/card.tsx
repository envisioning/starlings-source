import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CSSProperties, ReactNode } from 'react';
import satori from 'satori';
import { t } from '@shared/i18n';
import { GATHERING_DOTS, GATHERING_VIEWBOX, STARLINGS_WORDMARK } from '@starlings/contracts/gathering-dots';
import { PRODUCT_SITE_ORIGIN } from '@starlings/contracts/deployment';
import sharp from 'sharp';

/*
 * The share card for each product-site page, 1200x630 PNG, in the Starlings
 * house style (docs/DESIGN.md, Public site): one of the four painted
 * wallpapers as the stage, and on it an opaque window in the app's dark
 * surface that holds the copy. The wallpaper never sits behind text. The
 * headline is Inter 400, as the site's h1; the footer holds the wordmark with
 * its flock, the page family and the address. No accent: a card is not an
 * action.
 *
 * Satori turns text into paths, and sharp rasterises the SVG, so a card looks
 * the same on every machine that builds the site.
 */

export const OG_SIZE = { width: 1200, height: 630 } as const;
/** The wallpaper margin around the window: the showcase stage's widest padding. */
const STAGE = 44;
/** Inside the window. Stage plus window padding keeps the title inside a square centre crop's height. */
const PAD = 60;
/** The dark rungs and ink of web/src/styles.css. */
const SURFACE = '#202128';
const INK = '#fafafa';
const MUTED = '#a3a3a3';
const RULE = 'rgba(255,255,255,0.1)';
const FONT = 'Inter';
const ADDRESS = new URL(PRODUCT_SITE_ORIGIN).host;
const WALLPAPERS = ['hills', 'meadow', 'coast', 'lake'] as const;

export type OgCard = { path: string; title: string; description?: string };

/**
 * The page family a card's footer names, by path. The home card names none.
 * In the page's language: the prerender loads this module once per language,
 * after that language's table.
 */
const FAMILIES: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ['/use-cases', t('Use cases')], ['/workspace', t('Product')], ['/why', t('Why Starlings')], ['/integrations', t('Integrations')], ['/security', t('Security')],
  ['/download', t('Download')], ['/pricing', t('Pricing')], ['/for', t('For teams')], ['/compare', t('Compare')],
  ['/customers', t('Customer story')], ['/faq', t('FAQ')], ['/about', t('About')], ['/help', t('Help')], ['/agents', t('Open standard')],
  ['/skills', t('Open standard')], ['/spec', t('Open standard')], ['/changelog', t('Changelog')], ['/privacy', t('Legal')], ['/terms', t('Legal')],
  ['/interest', t('Early access')], ['/sign-in', t('Sign in')],
];

export function familyOf(pagePath: string): string | undefined {
  return FAMILIES.find(([prefix]) => pagePath === prefix || pagePath.startsWith(`${prefix}/`))?.[1];
}

/** Where a page's card is served: `/og/home.png` for `/`, else `/og<path>.png`. */
export const ogImagePath = (pagePath: string) => `/og${pagePath === '/' ? '/home' : pagePath}.png`;

/** Step the headline down as it grows, so a long title stays inside three lines. */
function titleSize(text: string) {
  if (text.length <= 28) return 96;
  if (text.length <= 60) return 76;
  return 62;
}

/** FNV-1a: the same path always gets the same wallpaper. */
function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A block of copy clamped to N lines with an ellipsis. `lineClamp` is a Satori style React's types do not list. */
function Clamp({ lines, style, children }: { lines: number; style: CSSProperties; children: ReactNode }) {
  return <div style={{ display: 'block', lineClamp: lines, overflow: 'hidden', textOverflow: 'ellipsis', ...style } as CSSProperties}>{children}</div>;
}

/** The wordmark as SiteChrome draws it (`StarlingsWordmark`), with the flock at rest. */
function Wordmark({ size }: { size: number }) {
  const flock = Math.round(size * STARLINGS_WORDMARK.flockEm);
  return (
    <div style={{ alignItems: 'center', display: 'flex', fontSize: size, fontWeight: 600, gap: Math.round(size * STARLINGS_WORDMARK.gapEm), letterSpacing: `${STARLINGS_WORDMARK.trackingEm}em`, lineHeight: 1 }}>
      {STARLINGS_WORDMARK.word}
      <svg width={flock} height={flock} viewBox={`0 0 ${GATHERING_VIEWBOX} ${GATHERING_VIEWBOX}`}>
        {GATHERING_DOTS.map((dot) => <circle key={`${dot.x}-${dot.y}`} cx={dot.x} cy={dot.y} r={dot.radius} fill={INK} />)}
      </svg>
    </div>
  );
}

function Card({ card: { path: pagePath, title, description }, wallpaper }: { card: OgCard; wallpaper: string }) {
  const family = familyOf(pagePath);
  return (
    <div style={{ backgroundImage: `url(${wallpaper})`, backgroundSize: '100% 100%', display: 'flex', height: '100%', padding: STAGE, width: '100%', fontFamily: FONT }}>
      <div style={{ backgroundColor: SURFACE, borderRadius: 20, boxShadow: '0 24px 60px -20px rgba(0,0,0,0.45)', color: INK, display: 'flex', flex: 1, flexDirection: 'column', justifyContent: 'space-between', overflow: 'hidden', padding: PAD }}>
        <div style={{ display: 'flex', flex: 1, flexDirection: 'column', gap: 22, justifyContent: 'center', maxWidth: 900 }}>
          {/* The clamp hides overflow, so the line box has to hold the descenders (g, y, p) of the last line. */}
          <Clamp lines={3} style={{ fontSize: titleSize(title), fontWeight: 400, letterSpacing: '-0.022em', lineHeight: 1.08, paddingBottom: '0.08em' }}>{title}</Clamp>
          {/* A title long enough to wrap to three lines leaves room for one line of description above the footer. */}
          {description ? <Clamp lines={title.length > 36 ? 1 : 2} style={{ color: MUTED, fontSize: 30, lineHeight: 1.4 }}>{description}</Clamp> : null}
        </div>
        <div style={{ alignItems: 'center', borderTop: `1px solid ${RULE}`, display: 'flex', gap: 40, justifyContent: 'space-between', paddingTop: 24, width: '100%' }}>
          <Wordmark size={34} />
          <div style={{ color: MUTED, display: 'flex', fontSize: 24, gap: 14 }}>
            {family ? <div style={{ display: 'flex' }}>{family}</div> : null}
            {family ? <div style={{ display: 'flex' }}>·</div> : null}
            <div style={{ display: 'flex' }}>{ADDRESS}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fontDir = path.join(here, 'fonts');
let fonts: Promise<Array<{ name: string; data: Buffer; weight: 400 | 600; style: 'normal' }>> | null = null;
function loadFonts() {
  fonts ??= Promise.all(([['Inter-Regular.ttf', 400], ['Inter-SemiBold.ttf', 600]] as const).map(async ([file, weight]) => (
    { name: FONT, data: await readFile(path.join(fontDir, file)), weight, style: 'normal' as const }
  )));
  return fonts;
}

/** Satori reads PNG and JPEG, not WebP: each wallpaper is cropped to the card once and kept as a JPEG data URL. */
const wallpapers = new Map<string, Promise<string>>();
function wallpaperFor(pagePath: string) {
  const name = WALLPAPERS[hashString(pagePath) % WALLPAPERS.length];
  let url = wallpapers.get(name);
  if (!url) {
    url = sharp(path.join(here, '..', 'wallpapers', `${name}.webp`))
      .resize(OG_SIZE.width, OG_SIZE.height, { fit: 'cover' })
      .jpeg({ quality: 88 })
      .toBuffer()
      .then((buffer) => `data:image/jpeg;base64,${buffer.toString('base64')}`);
    wallpapers.set(name, url);
  }
  return url;
}

/** The card as SVG, then PNG. */
export async function ogImagePng(card: OgCard): Promise<Buffer> {
  const svg = await satori(<Card card={card} wallpaper={await wallpaperFor(card.path)} />, { ...OG_SIZE, fonts: await loadFonts() });
  return sharp(Buffer.from(svg)).png().toBuffer();
}

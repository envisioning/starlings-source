#!/usr/bin/env node

/**
 * Generates the browser and PWA icons from the still Starlings glyph.
 *
 * `public/starlings.svg` is generated from `STARLINGS_GLYPH_RADII` in
 * packages/contracts/src/gathering-dots.ts, the table the Mac and iOS app
 * icons are drawn from too. The glyph sits on a rounded graphite tile at
 * `STARLINGS_GLYPH_ICON_SPAN`, as on the app icons. After changing the table, run
 * `pnpm registries:gen`, then `pnpm --filter web generate:icons`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { STARLINGS_GLYPH_ICON_SPAN } from '../../packages/contracts/src/gathering-dots.ts';
const ROOT = resolve(import.meta.dirname, '..');
const PUBLIC = resolve(ROOT, 'public');
const SOURCE_GLYPH = resolve(PUBLIC, 'starlings.svg');

const BACKGROUND = '#202128';
const GLYPH = '#d6f249';
const PADDING = (1 - STARLINGS_GLYPH_ICON_SPAN) / 2;
const RADIUS = 0.22;

const PNG_OUTPUTS = [
  { size: 16, output: 'favicon-16.png' },
  { size: 32, output: 'favicon-32.png' },
  { size: 180, output: 'apple-touch-icon.png' },
  { size: 192, output: 'icon-192.png' },
  { size: 512, output: 'icon-512.png' },
];
const ICO_SIZES = [16, 32, 48];

function glyphBody(svg) {
  const inner = svg
    .replace(/^\s*<\?xml[^>]*>\s*/i, '')
    .replace(/<!--[\s\S]*?-->\s*/g, '')
    .replace(/<svg\b[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '');
  if (inner === svg) throw new Error(`Could not read SVG root from ${SOURCE_GLYPH}`);
  return inner.replaceAll(/#[0-9a-f]{3,8}\b/giu, GLYPH);
}

function iconSvg(size, innerGlyph) {
  const radius = Math.round(size * RADIUS);
  const padding = Number((size * PADDING).toFixed(4));
  const scale = Number(((size - padding * 2) / 28).toFixed(4));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${BACKGROUND}"/>
  <g fill="${GLYPH}" transform="translate(${padding} ${padding}) scale(${scale})">${innerGlyph}</g>
</svg>`;
}

function encodeIco(images) {
  const headerSize = 6;
  const directoryEntrySize = 16;
  let offset = headerSize + directoryEntrySize * images.length;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  for (const { size, png } of images) {
    const entry = Buffer.alloc(directoryEntrySize);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]);
}

async function renderPng(size, innerGlyph) {
  return sharp(Buffer.from(iconSvg(size, innerGlyph)), { density: 384 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function main() {
  const source = await readFile(SOURCE_GLYPH, 'utf8');
  const innerGlyph = glyphBody(source);
  const pngs = new Map();

  await writeFile(resolve(PUBLIC, 'favicon.svg'), iconSvg(512, innerGlyph));
  console.log('  ✓ public/favicon.svg');

  for (const { size, output } of PNG_OUTPUTS) {
    const destination = resolve(PUBLIC, output);
    const png = await renderPng(size, innerGlyph);
    await writeFile(destination, png);
    pngs.set(size, png);
    console.log(`  ✓ public/${output}`);
  }

  const icoImages = [];
  for (const size of ICO_SIZES) {
    let png = pngs.get(size);
    if (!png) {
      png = await renderPng(size, innerGlyph);
    }
    icoImages.push({ size, png });
  }
  await writeFile(resolve(PUBLIC, 'favicon.ico'), encodeIco(icoImages));
  console.log('  ✓ public/favicon.ico');

  const manifest = {
    name: 'Starlings',
    short_name: 'Starlings',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    theme_color: BACKGROUND,
    background_color: BACKGROUND,
    display: 'standalone',
  };
  await writeFile(resolve(PUBLIC, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('  ✓ public/manifest.webmanifest');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

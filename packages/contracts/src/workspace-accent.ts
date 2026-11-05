/**
 * A workspace's accent (; docs/TENANCY_READINESS.md §Brand rule).
 *
 * A workspace names one colour, `WORKSPACE_ACCENT`. Everything the clients
 * draw with it is derived here, once: the fill and its hover and pressed
 * shades, the ink that sits on the fill, and the darker shades the light
 * theme uses for a call to action, a mark and the focus ring. An accent that
 * cannot carry readable text is refused, not drawn.
 *
 * Envisioning sets no accent: its lime and its hand-picked shades in
 * web/src/styles.css stay a fixed profile. Dependency-free, so the Worker,
 * the deploy check and a generator for the native apps can all read it.
 */

/** `#rrggbb`. */
export const WORKSPACE_ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/u;

/** Text on an accent fill must reach this contrast (WCAG AA, normal text). */
export const ACCENT_TEXT_CONTRAST = 4.5;
/** A focus ring or a mark against the light canvas must reach this (WCAG non-text). */
export const ACCENT_UI_CONTRAST = 3;

const INK = '#1a1a1a';
const WHITE = '#ffffff';
/** The light theme's canvas, `--surface-bg` in web/src/styles.css. */
const LIGHT_CANVAS = '#efefef';

export interface AccentPalette {
  /** The dark theme, which is also the default. */
  dark: { accent: string; hover: string; down: string; onAccent: string };
  /** The light theme's own shades: a fill that holds `onAccent`, and a focus ring that shows on the canvas. */
  light: { cta: string; ctaHover: string; ctaDown: string; mark: string; focus: string };
  /**
   * The fixed shades of the accent ramp, the same in both themes: presence
   * (busy, in a meeting) and the calendar's company layers. Envisioning's lime
   * keeps its hand-picked values in web/src/styles.css; another accent gets
   * these, so its people see their colour there too (MZ, 2026-10-05).
   */
  ramp: { busy: string; inMeeting: string; events: string; milestones: string; tasks: string; availability: string };
}

type Rgb = [number, number, number];

function parse(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function format([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

/** `amount` of the way from `from` to `to`, in sRGB. */
export function mix(from: string, to: string, amount: number): string {
  const a = parse(from);
  const b = parse(to);
  return format([0, 1, 2].map((i) => a[i]! + (b[i]! - a[i]!) * amount) as Rgb);
}

function luminance(hex: string): number {
  const [r, g, b] = parse(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrast(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** The first of `candidates` that reaches `minimum` against `against`, or null. */
function firstReaching(candidates: readonly string[], against: string, minimum: number): string | null {
  return candidates.find((candidate) => contrast(candidate, against) >= minimum) ?? null;
}

/**
 * Every shade the clients draw from one accent, or null when the accent is
 * not `#rrggbb` or no ink on it reaches `ACCENT_TEXT_CONTRAST`.
 */
export function accentPalette(input: string | null | undefined): AccentPalette | null {
  const accent = input?.trim().toLowerCase() ?? '';
  if (!WORKSPACE_ACCENT_PATTERN.test(accent)) return null;
  const onAccent = contrast(accent, INK) >= contrast(accent, WHITE) ? INK : WHITE;
  if (contrast(accent, onAccent) < ACCENT_TEXT_CONTRAST) return null;

  // On a light canvas a pale fill disappears, so the light theme's fill goes
  // darker under dark ink, as far as the ink still reads on it. A dark
  // accent under white ink already shows on a light canvas.
  const darker = [0.2, 0.15, 0.1, 0.05].map((amount) => mix(accent, '#000000', amount));
  const cta = onAccent === INK ? firstReaching(darker, INK, ACCENT_TEXT_CONTRAST) ?? accent : accent;
  const focus = firstReaching([0.45, 0.55, 0.65, 0.75].map((amount) => mix(accent, '#000000', amount)), LIGHT_CANVAS, ACCENT_UI_CONTRAST) ?? INK;

  const busy = mix(accent, '#000000', 0.22);
  const inMeeting = mix(accent, '#444444', 0.6);
  return {
    dark: { accent, hover: mix(accent, '#ffffff', 0.25), down: mix(accent, '#000000', 0.2), onAccent },
    light: { cta, ctaHover: mix(cta, '#ffffff', 0.15), ctaDown: mix(cta, '#000000', 0.15), mark: cta, focus },
    ramp: {
      busy,
      inMeeting,
      events: mix(accent, '#000000', 0.06),
      milestones: busy,
      tasks: mix(accent, '#555555', 0.45),
      availability: inMeeting,
    },
  };
}

/**
 * The palette as CSS custom properties over web/src/styles.css: the same
 * selectors, so it replaces exactly the tokens the fixed profile sets. The
 * Worker puts it last in `<head>`, after the stylesheet.
 */
export function accentStylesheet(palette: AccentPalette): string {
  const { dark, light, ramp } = palette;
  const rampTokens = `--busy:${ramp.busy};--presence-in-meeting:${ramp.inMeeting};--layer-events:${ramp.events};`
    + `--layer-milestones:${ramp.milestones};--layer-tasks:${ramp.tasks};--layer-availability:${ramp.availability};`;
  const lightTokens = `--accent-down:${light.ctaDown};--accent-mark:${light.mark};--accent-cta:${light.cta};`
    + `--accent-cta-hover:${light.ctaHover};--accent-cta-down:${light.ctaDown};--focus:${light.focus};${rampTokens}`;
  return `:root{--accent:${dark.accent};--accent-hover:${dark.hover};--accent-down:${dark.down};--on-accent:${dark.onAccent};${rampTokens}}`
    + `:root[data-theme="light"]{${lightTokens}}`
    + `@media (prefers-color-scheme: light){:root[data-theme="auto"]{${lightTokens}}}`;
}

/**
 * The operator console's design tokens (docs/OPS_CONSOLE.md §Look).
 * One source for both halves of `the ops host`: the shadcn dashboard
 * (`web/ops`, through the `virtual:ops-tokens.css` module in its Vite config)
 * and the Worker's server-rendered pages (`src/ops-worker/page.ts`). Change a
 * value here and both move.
 *
 * The names are the shared kit's: every `--ui-*` value and hover token that
 * `web/src/ui-theme.css` maps onto Tailwind, plus the dashboard's own chart
 * series and two states. The values are shadcn's neutral palette, light and
 * dark by the system appearance. The radius scale (`--ui-radius` minus 4px,
 * minus 2px) and the type are the kit's too.
 */
export const OPS_TOKENS = {
  /** The same in both appearances. */
  shared: {
    '--ui-radius': '0.625rem',
    '--ui-font-sans': 'ui-sans-serif, system-ui, sans-serif',
    '--ui-font-mono': 'ui-monospace, monospace',
  },
  light: {
    '--ui-background': 'oklch(0.985 0 0)',
    '--ui-foreground': 'oklch(0.145 0 0)',
    '--ui-card': 'oklch(1 0 0)',
    '--ui-card-foreground': 'oklch(0.145 0 0)',
    '--ui-popover': 'oklch(1 0 0)',
    '--ui-popover-foreground': 'oklch(0.145 0 0)',
    '--ui-primary': 'oklch(0.205 0 0)',
    '--ui-primary-foreground': 'oklch(0.985 0 0)',
    '--ui-secondary': 'oklch(0.97 0 0)',
    '--ui-secondary-foreground': 'oklch(0.205 0 0)',
    '--ui-muted': 'oklch(0.97 0 0)',
    '--ui-muted-foreground': 'oklch(0.556 0 0)',
    '--ui-accent': 'oklch(0.97 0 0)',
    '--ui-accent-foreground': 'oklch(0.205 0 0)',
    '--ui-destructive': 'oklch(0.577 0.245 27.325)',
    '--ui-border': 'oklch(0.922 0 0)',
    '--ui-input': 'oklch(0.922 0 0)',
    '--ui-ring': 'oklch(0.708 0 0)',
    '--ui-chart-1': 'oklch(0.646 0.222 41.116)',
    '--ui-chart-2': 'oklch(0.6 0.118 184.704)',
    '--ui-chart-3': 'oklch(0.398 0.07 227.392)',
    '--ui-chart-4': 'oklch(0.828 0.189 84.429)',
    '--ui-chart-5': 'oklch(0.769 0.188 70.08)',
    '--ui-ok': 'oklch(0.6 0.15 150)',
    '--ui-warn': 'oklch(0.7 0.15 70)',
    '--hover-lift': 'oklch(0 0 0 / 0.04)',
    '--hover-border': 'oklch(0.8 0 0)',
    '--accent-cta-hover': 'oklch(0.3 0 0)',
  },
  dark: {
    '--ui-background': 'oklch(0.145 0 0)',
    '--ui-foreground': 'oklch(0.985 0 0)',
    '--ui-card': 'oklch(0.205 0 0)',
    '--ui-card-foreground': 'oklch(0.985 0 0)',
    '--ui-popover': 'oklch(0.269 0 0)',
    '--ui-popover-foreground': 'oklch(0.985 0 0)',
    '--ui-primary': 'oklch(0.922 0 0)',
    '--ui-primary-foreground': 'oklch(0.205 0 0)',
    '--ui-secondary': 'oklch(0.269 0 0)',
    '--ui-secondary-foreground': 'oklch(0.985 0 0)',
    '--ui-muted': 'oklch(0.269 0 0)',
    '--ui-muted-foreground': 'oklch(0.708 0 0)',
    '--ui-accent': 'oklch(0.269 0 0)',
    '--ui-accent-foreground': 'oklch(0.985 0 0)',
    '--ui-destructive': 'oklch(0.704 0.191 22.216)',
    '--ui-border': 'oklch(1 0 0 / 10%)',
    '--ui-input': 'oklch(1 0 0 / 15%)',
    '--ui-ring': 'oklch(0.556 0 0)',
    '--ui-chart-1': 'oklch(0.488 0.243 264.376)',
    '--ui-chart-2': 'oklch(0.696 0.17 162.48)',
    '--ui-chart-3': 'oklch(0.769 0.188 70.08)',
    '--ui-chart-4': 'oklch(0.627 0.265 303.9)',
    '--ui-chart-5': 'oklch(0.645 0.246 16.439)',
    '--ui-ok': 'oklch(0.75 0.17 150)',
    '--ui-warn': 'oklch(0.8 0.15 80)',
    '--hover-lift': 'oklch(1 0 0 / 0.06)',
    '--hover-border': 'oklch(1 0 0 / 25%)',
    '--accent-cta-hover': 'oklch(0.85 0 0)',
  },
} as const satisfies Record<'shared' | 'light' | 'dark', Record<`--${string}`, string>>;

const declarations = (tokens: Record<string, string>) =>
  Object.entries(tokens).map(([name, value]) => `  ${name}: ${value};`).join('\n');

/**
 * The tokens as a stylesheet: `:root` in light, and the dark values under
 * `prefers-color-scheme: dark`. No selector but `:root`, so it sits under any
 * page's own rules.
 */
export function opsTokensCSS(): string {
  return `:root {
  color-scheme: light dark;
${declarations(OPS_TOKENS.shared)}
${declarations(OPS_TOKENS.light)}
}
@media (prefers-color-scheme: dark) {
  :root {
${declarations(OPS_TOKENS.dark).replace(/^/gmu, '  ')}
  }
}
`;
}

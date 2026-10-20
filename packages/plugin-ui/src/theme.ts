/**
 * Korsi's theme as CSS variables, so a plugin's page looks like the Korsi around it.
 *
 * Korsi sends its colours, its mode and its font stack in `korsi:init`, and again whenever the
 * person changes them. `applyContext` writes them onto the document as variables and attributes a
 * stylesheet reads -- no framework, no build step:
 *
 *     body { background: var(--k-bg); color: var(--k-text); font-family: var(--k-font); }
 *     .button { background: var(--k-primary); color: var(--k-on-primary); }
 *     :root[data-mode='dark'] .card { box-shadow: none; }
 *
 * Every variable has a value from the start (Korsi's own light theme), so a page outside Korsi, or
 * before `korsi:init`, still looks right.
 */
import type { KorsiContext, KorsiPalette, KorsiTheme } from '@korsi/bridge';

/** Each palette colour, and the variable it is written to. */
export const PALETTE_VARIABLES = Object.freeze({
  primary: '--k-primary',
  on_primary: '--k-on-primary',
  secondary: '--k-secondary',
  success: '--k-success',
  warning: '--k-warning',
  error: '--k-error',
  info: '--k-info',
  background: '--k-bg',
  paper: '--k-paper',
  text: '--k-text',
  text_secondary: '--k-text-2',
  divider: '--k-divider',
} as const satisfies Record<keyof KorsiPalette, string>);

/** The font stack's variable. */
export const FONT_VARIABLE = '--k-font';

/** Behind Korsi's own faces, a face every system has. */
export const FALLBACK_FONT = 'system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif';

/** Korsi's light theme: what a page shows before Korsi says otherwise. */
export const DEFAULT_THEME: KorsiTheme = Object.freeze({
  mode: 'light',
  font_family: 'YekanBakh',
  palette: Object.freeze({
    primary: '#00A76F',
    on_primary: '#FFFFFF',
    secondary: '#8E33FF',
    success: '#22C55E',
    warning: '#FFAB00',
    error: '#FF5630',
    info: '#00B8D9',
    background: '#FFFFFF',
    paper: '#FFFFFF',
    text: '#1C252E',
    text_secondary: '#637381',
    divider: 'rgba(145, 158, 171, 0.2)',
  }),
}) as KorsiTheme;

/** The variables for `theme`, missing colours filled from Korsi's defaults. Pure: for SSR, tests. */
export function themeVariables(
  theme: Partial<KorsiTheme> | null | undefined
): Record<string, string> {
  const palette = { ...DEFAULT_THEME.palette, ...(theme?.palette ?? {}) };
  const variables: Record<string, string> = {};
  for (const [key, name] of Object.entries(PALETTE_VARIABLES)) {
    const value = palette[key as keyof KorsiPalette];
    if (value) variables[name] = value;
  }
  const family = theme?.font_family || DEFAULT_THEME.font_family;
  variables[FONT_VARIABLE] = `${family}, ${FALLBACK_FONT}`;
  return variables;
}

/** The variables as a CSS rule, for a `<style>` a server renders before any script runs. */
export function themeCss(
  theme: Partial<KorsiTheme> | null | undefined,
  selector = ':root'
): string {
  const body = Object.entries(themeVariables(theme))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return `${selector} {\n${body}\n  color-scheme: ${theme?.mode === 'dark' ? 'dark' : 'light'};\n}`;
}

/** Write `theme` onto `root`: the variables, `data-mode`, and `color-scheme` for form controls. */
export function applyTheme(
  theme: Partial<KorsiTheme> | null | undefined,
  root: HTMLElement = document.documentElement
): void {
  for (const [name, value] of Object.entries(themeVariables(theme))) {
    root.style.setProperty(name, value);
  }
  const mode = theme?.mode === 'dark' ? 'dark' : 'light';
  root.dataset.mode = mode;
  root.style.colorScheme = mode;
}

/**
 * Everything in `korsi:init` a page's look depends on: the theme, the language (`lang`), the
 * direction (`dir`), and the organization's calendar and digits (`data-calendar`,
 * `data-numerals`) for a stylesheet that cares.
 */
export function applyContext(
  context: KorsiContext,
  root: HTMLElement = document.documentElement
): void {
  applyTheme(context.theme, root);
  if (context.locale) root.lang = context.locale;
  root.dir = context.dir === 'ltr' ? 'ltr' : 'rtl';
  root.dataset.calendar = context.calendar_system === 'jalali' ? 'jalali' : 'gregorian';
  root.dataset.numerals = context.numerals === 'latin' ? 'latin' : 'persian';
}

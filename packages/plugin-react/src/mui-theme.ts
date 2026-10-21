/**
 * An MUI theme that matches the Korsi around the page: its colours for the current mode, its font
 * stack, its direction, its corner radius, type scale and card shadow.
 *
 *     import { ThemeProvider } from '@mui/material/styles';
 *     import { createKorsiTheme } from '@korsi/plugin-react/mui';
 *
 *     const context = useKorsiContext();
 *     const theme = useMemo(() => createKorsiTheme(context), [context]);
 *     return <ThemeProvider theme={theme}>...</ThemeProvider>;
 *
 * Right to left needs one more thing MUI leaves to the app: an emotion cache with
 * `stylis-plugin-rtl`, so `margin-left` is flipped. The theme sets `direction`; the cache flips the
 * styles. `KorsiPage` does both, as Korsi's own shell does.
 */
import { createTheme, type Theme, type ThemeOptions } from '@mui/material/styles';

import type { KorsiContext, KorsiTheme } from '@korsi/bridge';
import { DEFAULT_THEME, FALLBACK_FONT } from '@korsi/plugin-ui';

const rem = (px: number) => `${px / 16}rem`;

function isContext(value: KorsiContext | KorsiTheme): value is KorsiContext {
  return 'theme' in value && typeof value.theme === 'object';
}

/** Korsi's card: a hairline and a soft drop, in the mode's own shade. */
const CARD_SHADOW = {
  light: '0 0 2px 0 rgba(145,158,171,0.2), 0 12px 24px -4px rgba(145,158,171,0.12)',
  dark: '0 0 2px 0 rgba(0,0,0,0.2), 0 12px 24px -4px rgba(0,0,0,0.12)',
} as const;

type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/** `over` merged into `under`, object by object; anything else in `over` replaces. */
function merge(under: Plain, over: Plain): Plain {
  const merged: Plain = { ...under };
  for (const [key, value] of Object.entries(over)) {
    const below = merged[key];
    merged[key] = isPlain(value) && isPlain(below) ? merge(below, value) : value;
  }
  return merged;
}

/**
 * The Korsi theme for `source` -- `korsi:init`'s context or just its theme -- with `overrides`
 * merged over it in order.
 */
export function createKorsiTheme(
  source: KorsiContext | KorsiTheme | null | undefined,
  ...overrides: ThemeOptions[]
): Theme {
  const theme = source ? (isContext(source) ? source.theme : source) : DEFAULT_THEME;
  const direction = source && isContext(source) && source.dir === 'ltr' ? 'ltr' : 'rtl';
  const palette = { ...DEFAULT_THEME.palette, ...(theme.palette ?? {}) };
  const mode = theme.mode === 'dark' ? 'dark' : 'light';
  const fontFamily = `${theme.font_family || DEFAULT_THEME.font_family}, ${FALLBACK_FONT}`;

  const base: ThemeOptions = {
    direction,
    palette: {
      mode,
      primary: { main: palette.primary!, contrastText: palette.on_primary },
      secondary: { main: palette.secondary! },
      success: { main: palette.success! },
      warning: { main: palette.warning! },
      error: { main: palette.error! },
      info: { main: palette.info! },
      background: { default: palette.background!, paper: palette.paper! },
      text: { primary: palette.text!, secondary: palette.text_secondary! },
      divider: palette.divider!,
    },
    shape: { borderRadius: 8 },
    typography: {
      fontFamily,
      fontWeightLight: 300,
      fontWeightRegular: 400,
      fontWeightMedium: 500,
      fontWeightBold: 700,
      h1: { fontWeight: 800, lineHeight: 80 / 64, fontSize: rem(40) },
      h2: { fontWeight: 800, lineHeight: 64 / 48, fontSize: rem(32) },
      h3: { fontWeight: 700, lineHeight: 1.5, fontSize: rem(24) },
      h4: { fontWeight: 700, lineHeight: 1.5, fontSize: rem(20) },
      h5: { fontWeight: 700, lineHeight: 1.5, fontSize: rem(18) },
      h6: { fontWeight: 600, lineHeight: 28 / 18, fontSize: rem(17) },
      subtitle1: { fontWeight: 600, lineHeight: 1.5, fontSize: rem(16) },
      subtitle2: { fontWeight: 600, lineHeight: 22 / 14, fontSize: rem(14) },
      body1: { lineHeight: 1.5, fontSize: rem(16) },
      body2: { lineHeight: 22 / 14, fontSize: rem(14) },
      caption: { lineHeight: 1.5, fontSize: rem(12) },
      overline: { fontWeight: 700, lineHeight: 1.5, fontSize: rem(12) },
      button: { fontWeight: 700, lineHeight: 24 / 14, fontSize: rem(14), textTransform: 'unset' },
    },
    components: {
      MuiCard: {
        styleOverrides: {
          root: { position: 'relative', borderRadius: 16, boxShadow: CARD_SHADOW[mode] },
        },
      },
      MuiChip: { styleOverrides: { root: { fontWeight: 600 } } },
      MuiButton: { defaultProps: { disableElevation: true } },
      MuiPaper: { defaultProps: { elevation: 0 } },
    },
  };
  // Options are merged before the theme is made, so an override is read as MUI reads options:
  // `spacing: 4` is a scale, a palette colour gets its light and dark shades.
  return createTheme(
    overrides.reduce<Plain>((merged, over) => merge(merged, over as Plain), base as Plain)
  );
}

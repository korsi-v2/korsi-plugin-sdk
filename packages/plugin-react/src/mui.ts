/**
 * An MUI theme that matches the Korsi around the page: its colours for the current mode, its font
 * stack, its direction, its corner radius and type scale.
 *
 *     import { ThemeProvider } from '@mui/material/styles';
 *     import { createKorsiTheme } from '@korsi/plugin-react/mui';
 *
 *     const context = useKorsiContext();
 *     const theme = useMemo(() => createKorsiTheme(context), [context]);
 *     return <ThemeProvider theme={theme}>...</ThemeProvider>;
 *
 * Right to left needs one more thing MUI leaves to the app: an emotion cache with
 * `stylis-plugin-rtl` (`@mui/stylis-plugin-rtl`), so `margin-left` is flipped. The theme sets
 * `direction`; the cache flips the styles. Korsi's own shell does the same.
 */
import { createTheme, type Theme, type ThemeOptions } from '@mui/material/styles';

import type { KorsiContext, KorsiTheme } from '@korsi/bridge';
import { DEFAULT_THEME, FALLBACK_FONT } from '@korsi/plugin-ui';

const rem = (px: number) => `${px / 16}rem`;

function isContext(value: KorsiContext | KorsiTheme): value is KorsiContext {
  return 'theme' in value && typeof value.theme === 'object';
}

/** The Korsi theme for `source` -- `korsi:init`'s context or just its theme -- over `overrides`. */
export function createKorsiTheme(
  source: KorsiContext | KorsiTheme | null | undefined,
  overrides: ThemeOptions = {}
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
      MuiCard: { styleOverrides: { root: { borderRadius: 16 } } },
      MuiButton: { defaultProps: { disableElevation: true } },
      MuiPaper: { defaultProps: { elevation: 0 } },
    },
  };
  return createTheme(base, overrides);
}

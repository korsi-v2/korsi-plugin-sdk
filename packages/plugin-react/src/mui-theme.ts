/**
 * An MUI theme that matches the Korsi around the page: its colours for the current mode, its font
 * stack, its direction, and Korsi's own look for MUI's components -- text fields and selects,
 * menus and popovers, dialogs, tabs, tooltips, checkboxes and switches, chips, alerts, tables,
 * lists and the rest -- ported from Korsi's theme, with its grey scale and shadows.
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
 *
 * As in Korsi, `<Button variant="soft">` and `<Chip variant="soft">` (a chip's default) are the
 * colour's tint behind its darker shade, and each palette colour carries Korsi's `lighter` and
 * `darker` shades beside `light` and `dark`, with `background.neutral` for grey wells.
 */
import { arSA, faIR, type Localization } from '@mui/material/locale';
import { createTheme, type Shadows, type Theme, type ThemeOptions } from '@mui/material/styles';

import type { KorsiContext, KorsiDisplay, KorsiTheme } from '@korsi/bridge';
import { DEFAULT_THEME, FALLBACK_FONT } from '@korsi/plugin-ui';

import { inputComponents } from './mui-theme-inputs.js';
import { surfaceComponents } from './mui-theme-surfaces.js';
import {
  COLOR_KEYS,
  COMMON,
  DARK_NEUTRAL,
  GREY,
  fade,
  normalizeColor,
  shadowsOf,
  shippedShades,
} from './mui-theme-tokens.js';

const rem = (px: number) => `${px / 16}rem`;

/** A heading's size on wider screens, as Korsi's type scale grows it. */
const growing = (sizes: { sm?: number; md?: number; lg?: number }) =>
  Object.fromEntries(
    (
      [
        ['sm', 600],
        ['md', 900],
        ['lg', 1200],
      ] as const
    )
      .filter(([key]) => sizes[key] !== undefined)
      .map(([key, width]) => [`@media (min-width:${width}px)`, { fontSize: rem(sizes[key]!) }])
  );

function isContext(value: KorsiContext | KorsiTheme): value is KorsiContext {
  return 'theme' in value && typeof value.theme === 'object';
}

/** MUI's elevation shadows, cast in Korsi's grey on a light page (black on a dark one). */
let muiShadows: Shadows | null = null;
function shadowsFor(mode: 'light' | 'dark'): Shadows {
  muiShadows ??= createTheme().shadows;
  if (mode === 'dark') return muiShadows;
  return muiShadows.map((shadow) =>
    shadow.replace(/rgba\(0,0,0,([\d.]+)\)/g, 'rgba(145,158,171,$1)')
  ) as Shadows;
}

/** Korsi's `palette.action`: hovers, selections and disabled states in its grey. */
function actionFor(mode: 'light' | 'dark') {
  return {
    active: mode === 'light' ? GREY[600] : GREY[500],
    hover: fade(GREY[500], 0.08),
    selected: fade(GREY[500], 0.16),
    focus: fade(GREY[500], 0.24),
    disabled: fade(GREY[500], 0.8),
    disabledBackground: fade(GREY[500], 0.24),
    hoverOpacity: 0.08,
    selectedOpacity: 0.08,
    focusOpacity: 0.12,
    activatedOpacity: 0.12,
    disabledOpacity: 0.48,
  };
}

type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const asLayers = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

/**
 * Where a value is a style override: one slot of a component's `styleOverrides`, or the whole of
 * `MuiCssBaseline`'s. Such values are layered, never merged into each other -- a style is often a
 * function of the theme, and a merge would replace it.
 */
function isStyleOverride(path: readonly string[], key: string): boolean {
  if (path[0] !== 'components') return false;
  if (path.length === 2) return path[1] === 'MuiCssBaseline' && key === 'styleOverrides';
  return path.length === 3 && path[2] === 'styleOverrides' && path[1] !== 'MuiCssBaseline';
}

/**
 * `over` merged into `under`, object by object; anything else in `over` replaces. A style
 * override becomes the list of both, which MUI applies in order (Korsi's first, then the page's),
 * and a component's `variants` are both lists.
 */
function merge(under: Plain, over: Plain, path: readonly string[] = []): Plain {
  const merged: Plain = { ...under };
  for (const [key, value] of Object.entries(over)) {
    const below = merged[key];
    if (below !== undefined && isStyleOverride(path, key)) {
      merged[key] = [...asLayers(below), ...asLayers(value)];
    } else if (
      key === 'variants' &&
      path[0] === 'components' &&
      Array.isArray(below) &&
      Array.isArray(value)
    ) {
      merged[key] = [...below, ...value];
    } else {
      merged[key] = isPlain(value) && isPlain(below) ? merge(below, value, [...path, key]) : value;
    }
  }
  return merged;
}

/**
 * Each palette colour with all of Korsi's shades when Korsi ships it: Korsi sends only the main
 * one. Done after the overrides, so a page that picks another main colour gets that colour's
 * shades (MUI's derived ones) rather than Korsi's.
 */
function withShades(options: Plain): Plain {
  if (!isPlain(options.palette)) return options;
  const palette: Plain = { ...options.palette };
  for (const key of COLOR_KEYS) {
    const color = palette[key];
    if (!isPlain(color) || typeof color.main !== 'string') continue;
    const shipped = shippedShades(color.main);
    if (shipped) palette[key] = { ...shipped, ...color };
  }
  return { ...options, palette };
}

const measure = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * The person's display settings as Korsi applies them to its own theme
 * (`korsi-app/src/theme/density.js`): the spacing unit, the corner, the root font size every rem
 * is a multiple of, and for high contrast its cards' lighter `z1` shadow. `density` is kept on the
 * theme as Korsi keeps it, for a measurement in neither unit (`theme.density === 'compact'`).
 * Nothing without `display`: an older Korsi's page keeps MUI's 8px and 16px.
 */
function displayOptions(display: KorsiDisplay | undefined): Plain {
  if (!isPlain(display)) return {};
  const options: Plain = {};
  const components: Plain = {};
  if (display.density === 'compact' || display.density === 'comfortable') {
    options.density = display.density;
  }
  if (measure(display.spacing)) options.spacing = display.spacing;
  if (measure(display.radius)) options.shape = { borderRadius: display.radius };
  if (measure(display.font_size)) {
    components.MuiCssBaseline = { styleOverrides: { html: { fontSize: display.font_size } } };
  }
  if (display.contrast === 'high') {
    components.MuiCard = {
      styleOverrides: {
        root: ({ theme }: { theme: Theme }) => ({ '--card-shadow': shadowsOf(theme).z1 }),
      },
    };
  }
  return Object.keys(components).length ? { ...options, components } : options;
}

/**
 * MUI's own words in the person's language -- an autocomplete's "no options", a pagination's
 * labels, an alert's close button -- as Korsi passes them to its own theme. English is MUI's.
 */
const MUI_LOCALES: Record<string, Localization> = { fa: faIR, ar: arSA };

function localeOptions(source: KorsiContext | KorsiTheme | null | undefined): Plain {
  if (!source || !isContext(source) || typeof source.locale !== 'string') return {};
  const components = MUI_LOCALES[source.locale.split('-')[0]!.toLowerCase()]?.components;
  return components ? { components: components as Plain } : {};
}

/**
 * The Korsi theme for `source` -- `korsi:init`'s context or just its theme -- with `overrides`
 * merged over it in order. The person's density, root font size and contrast (`theme.display`)
 * and MUI's words in their language come before the overrides, as in Korsi.
 */
export function createKorsiTheme(
  source: KorsiContext | KorsiTheme | null | undefined,
  ...overrides: ThemeOptions[]
): Theme {
  const theme = source ? (isContext(source) ? source.theme : source) : DEFAULT_THEME;
  const direction = source && isContext(source) && source.dir === 'ltr' ? 'ltr' : 'rtl';
  const given = { ...DEFAULT_THEME.palette, ...(theme.palette ?? {}) };
  const color = (key: keyof typeof given) => {
    const value = given[key];
    return normalizeColor(typeof value === 'string' && value ? value : DEFAULT_THEME.palette[key]!);
  };
  const mode = theme.mode === 'dark' ? 'dark' : 'light';
  const fontFamily = `${theme.font_family || DEFAULT_THEME.font_family}, ${FALLBACK_FONT}`;
  // `neutral` is Korsi's: the grey well behind a table head or a segmented control.
  const background = {
    default: color('background'),
    paper: color('paper'),
    neutral: mode === 'dark' ? DARK_NEUTRAL : GREY[200],
  };

  const base: ThemeOptions = {
    direction,
    palette: {
      mode,
      primary: { main: color('primary'), contrastText: color('on_primary') },
      secondary: { main: color('secondary') },
      success: { main: color('success') },
      warning: { main: color('warning') },
      error: { main: color('error') },
      info: { main: color('info') },
      grey: GREY,
      common: COMMON,
      background,
      text: {
        primary: color('text'),
        secondary: color('text_secondary'),
        disabled: mode === 'dark' ? GREY[600] : GREY[500],
      },
      divider: color('divider'),
      action: actionFor(mode),
    },
    shape: { borderRadius: 8 },
    shadows: shadowsFor(mode),
    typography: {
      fontFamily,
      fontWeightLight: 300,
      fontWeightRegular: 400,
      fontWeightMedium: 500,
      fontWeightBold: 700,
      h1: {
        fontWeight: 800,
        lineHeight: 80 / 64,
        fontSize: rem(40),
        ...growing({ sm: 52, md: 58, lg: 64 }),
      },
      h2: {
        fontWeight: 800,
        lineHeight: 64 / 48,
        fontSize: rem(32),
        ...growing({ sm: 40, md: 44, lg: 48 }),
      },
      h3: {
        fontWeight: 700,
        lineHeight: 1.5,
        fontSize: rem(24),
        ...growing({ sm: 26, md: 30, lg: 32 }),
      },
      h4: { fontWeight: 700, lineHeight: 1.5, fontSize: rem(20), ...growing({ md: 24 }) },
      h5: { fontWeight: 700, lineHeight: 1.5, fontSize: rem(18), ...growing({ sm: 19 }) },
      h6: { fontWeight: 600, lineHeight: 28 / 18, fontSize: rem(17), ...growing({ sm: 18 }) },
      subtitle1: { fontWeight: 600, lineHeight: 1.5, fontSize: rem(16) },
      subtitle2: { fontWeight: 600, lineHeight: 22 / 14, fontSize: rem(14) },
      body1: { lineHeight: 1.5, fontSize: rem(16) },
      body2: { lineHeight: 22 / 14, fontSize: rem(14) },
      caption: { lineHeight: 1.5, fontSize: rem(12) },
      overline: {
        fontWeight: 700,
        lineHeight: 1.5,
        fontSize: rem(12),
        textTransform: 'uppercase',
      },
      button: { fontWeight: 700, lineHeight: 24 / 14, fontSize: rem(14), textTransform: 'unset' },
    },
    // Korsi's recipes are written as Korsi writes them -- styles that are functions of the theme,
    // with `variants` chosen by predicates -- which MUI's component types do not describe.
    components: {
      ...surfaceComponents,
      ...inputComponents,
    } as unknown as ThemeOptions['components'],
  };
  // Options are merged before the theme is made, so an override is read as MUI reads options:
  // `spacing: 4` is a scale, a palette colour gets its light and dark shades.
  const korsi = [displayOptions(theme.display), localeOptions(source)].reduce(
    (merged, layer) => merge(merged, layer),
    base as Plain
  );
  return createTheme(
    withShades(overrides.reduce<Plain>((merged, over) => merge(merged, over as Plain), korsi))
  );
}

/* Korsi's density on the theme, as Korsi's own theme carries it. */
declare module '@mui/material/styles' {
  interface Theme {
    /** The person's density, when Korsi sent it (`korsi:init`'s `theme.display`). */
    density?: 'compact' | 'comfortable';
  }
  interface ThemeOptions {
    density?: 'compact' | 'comfortable';
  }
}

/* The variants Korsi adds to MUI's components, typed for a page written in TypeScript. */
declare module '@mui/material/Button' {
  interface ButtonPropsVariantOverrides {
    soft: true;
  }
}
declare module '@mui/material/Chip' {
  interface ChipPropsVariantOverrides {
    soft: true;
  }
}
declare module '@mui/material/ButtonGroup' {
  interface ButtonGroupPropsVariantOverrides {
    soft: true;
  }
}
declare module '@mui/material/Pagination' {
  interface PaginationPropsVariantOverrides {
    soft: true;
  }
}
declare module '@mui/material/PaginationItem' {
  interface PaginationItemPropsVariantOverrides {
    soft: true;
  }
}
declare module '@mui/material/Fab' {
  interface FabPropsVariantOverrides {
    outlined: true;
    outlinedExtended: true;
    soft: true;
    softExtended: true;
  }
}
declare module '@mui/material/Badge' {
  interface BadgePropsVariantOverrides {
    online: true;
    always: true;
    busy: true;
    offline: true;
    invisible: true;
  }
}
declare module '@mui/material/Tabs' {
  interface TabsPropsIndicatorColorOverrides {
    inherit: true;
    custom: true;
  }
}

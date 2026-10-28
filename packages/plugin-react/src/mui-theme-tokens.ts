/**
 * Korsi's fixed design tokens and the style recipes its components share, copied from Korsi's own
 * theme (`korsi-app/src/theme/core`): the grey scale, every shade of each colour Korsi ships, its
 * shadows and opacities, and the menu item, dropdown paper, filled and soft recipes.
 *
 * Korsi tells a page only each colour's main shade. Korsi's theme is built on CSS variables
 * (`theme.vars`, `varAlpha(channel)`); a plugin's theme is a plain MUI theme rebuilt whenever Korsi
 * sends a new context, so the recipes here read `theme.palette` and fade colours with `fade`.
 */
import { autocompleteClasses } from '@mui/material/Autocomplete';
import { checkboxClasses } from '@mui/material/Checkbox';
import { dividerClasses } from '@mui/material/Divider';
import { menuItemClasses } from '@mui/material/MenuItem';
import { alpha, darken, lighten, type PaletteColor, type Theme } from '@mui/material/styles';

/** A style object as the recipes build it: CSS properties, nested selectors, `variants`. */
export interface Css {
  [key: string]: unknown;
  variants?: Variant[];
}

/** What a style override is called with: the theme, the component's props and its owner state. */
export interface StyleArgs {
  theme: Theme;
  ownerState?: Record<string, unknown>;
  [prop: string]: unknown;
}

export type Style = Css | ((args: StyleArgs) => Css);

/** A style applied when the props match (an object of values, or a predicate). */
export interface Variant {
  props: Css | ((args: StyleArgs) => boolean);
  style: Style;
}

export interface ComponentTheme {
  defaultProps?: Css;
  styleOverrides?: Record<string, Style>;
}

export type ComponentThemes = Record<string, ComponentTheme>;

/** Korsi's grey scale: every neutral surface, border and shadow in Korsi is one of these. */
export const GREY = Object.freeze({
  50: '#FCFDFD',
  100: '#F9FAFB',
  200: '#F4F6F8',
  300: '#DFE3E8',
  400: '#C4CDD5',
  500: '#919EAB',
  600: '#637381',
  700: '#454F5B',
  800: '#1C252E',
  900: '#141A21',
});

export const COMMON = Object.freeze({ black: '#000000', white: '#FFFFFF' });

/** A dark page's neutral well (`background.neutral`); a light page's is `GREY[200]`. */
export const DARK_NEUTRAL = '#28323D';

export const COLOR_KEYS = ['primary', 'secondary', 'info', 'success', 'warning', 'error'] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];

/** A colour with every shade Korsi draws it in. */
export interface Shades {
  lighter: string;
  light: string;
  main: string;
  dark: string;
  darker: string;
  contrastText: string;
}

const shades = (
  lighter: string,
  light: string,
  main: string,
  dark: string,
  darker: string,
  contrastText: string = COMMON.white
): Shades => ({ lighter, light, main, dark, darker, contrastText });

/**
 * Every colour Korsi ships, found by its main shade: its palette and the primary colours an
 * organization can pick. A colour Korsi does not ship gets MUI's derived shades instead.
 */
const SHIPPED: readonly Shades[] = [
  shades('#C8FAD6', '#5BE49B', '#00A76F', '#007867', '#004B50'),
  shades('#EFD6FF', '#C684FF', '#8E33FF', '#5119B7', '#27097A'),
  shades('#CAFDF5', '#61F3F3', '#00B8D9', '#006C9C', '#003768'),
  shades('#D3FCD2', '#77ED8B', '#22C55E', '#118D57', '#065E49'),
  shades('#FFF5CC', '#FFD666', '#FFAB00', '#B76E00', '#7A4100', GREY[800]),
  shades('#FFE9D5', '#FFAC82', '#FF5630', '#B71D18', '#7A0916'),
  shades('#CCF4FE', '#68CDF9', '#078DEE', '#0351AB', '#012972'),
  shades('#EBD6FD', '#B985F4', '#7635DC', '#431A9E', '#200A69'),
  shades('#CDE9FD', '#6BB1F8', '#0C68E9', '#063BA7', '#021D6F'),
  shades('#FEF4D4', '#FED680', '#FDA92D', '#B66816', '#793908', GREY[800]),
  shades('#FFE3D5', '#FFC1AC', '#FF3030', '#B71833', '#7A0930'),
];

const SHIPPED_BY_MAIN = new Map(SHIPPED.map((color) => [color.main.toUpperCase(), color]));

/** The shades Korsi has for the colour whose main shade is `main`, if Korsi ships it. */
export const shippedShades = (main: string): Shades | undefined =>
  SHIPPED_BY_MAIN.get(main.trim().toUpperCase());

/** The shades of a palette colour, `lighter` and `darker` derived when it has none. */
export function shadesOf(theme: Theme, key: ColorKey): Shades {
  const color = theme.palette[key] as PaletteColor & Partial<Shades>;
  return {
    lighter: color.lighter ?? lighten(color.main, 0.76),
    light: color.light,
    main: color.main,
    dark: color.dark,
    darker: color.darker ?? darken(color.main, 0.52),
    contrastText: color.contrastText,
  };
}

const SPACED_RGB = /^(rgba?)\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?)\s*)?\)$/i;

/**
 * A colour in a form MUI's colour helpers read. Korsi writes some of its colours in the CSS
 * variable form (`rgba(145 158 171 / 20%)`, its divider), which MUI's `alpha` cannot parse.
 */
export function normalizeColor(color: string): string {
  const match = SPACED_RGB.exec(color.trim());
  if (!match) return color;
  const [, , r, g, b, a, percent] = match;
  if (a === undefined) return `rgb(${r}, ${g}, ${b})`;
  return `rgba(${r}, ${g}, ${b}, ${percent ? Number(a) / 100 : Number(a)})`;
}

/** `color` at `opacity`, whatever form it is in (`currentColor` too). */
export function fade(color: string, opacity: number): string {
  const percent = `${Number((opacity * 100).toFixed(2))}%`;
  if (color.trim().toLowerCase() === 'currentcolor') {
    return `color-mix(in srgb, currentColor ${percent}, transparent)`;
  }
  try {
    return alpha(normalizeColor(color), opacity);
  } catch {
    return `color-mix(in srgb, ${color} ${percent}, transparent)`;
  }
}

/** Korsi's opacities (`core/opacity`). */
export const OPACITY = Object.freeze({
  switchTrack: 1,
  switchTrackDisabled: 0.48,
  inputUnderline: 0.32,
  outlinedBorder: 0.48,
  softBg: 0.16,
  softHoverBg: 0.32,
  softBorder: 0.24,
});

export const isDark = (theme: Theme) => theme.palette.mode === 'dark';

/** The background of Korsi's neutral wells: a table head, the custom tab strip. */
export const neutralOf = (theme: Theme): string =>
  (theme.palette.background as { neutral?: string }).neutral ??
  (isDark(theme) ? DARK_NEUTRAL : GREY[200]);

/** Korsi's `palette.shared`: the hairlines of inputs, papers and outlined buttons. */
export function sharedOf(theme: Theme) {
  const grey = theme.palette.grey[500];
  return {
    inputUnderline: fade(grey, OPACITY.inputUnderline),
    inputOutlined: fade(grey, 0.2),
    paperOutlined: fade(grey, 0.16),
    buttonOutlined: fade(grey, 0.32),
  };
}

/** Korsi's `customShadows`: grey on a light page, black on a dark one. */
export function shadowsOf(theme: Theme) {
  const ink = isDark(theme) ? COMMON.black : theme.palette.grey[500];
  const at = (opacity: number) => fade(ink, opacity);
  return {
    z1: `0 1px 2px 0 ${at(0.16)}`,
    z4: `0 4px 8px 0 ${at(0.16)}`,
    z8: `0 8px 16px 0 ${at(0.16)}`,
    z12: `0 12px 24px -4px ${at(0.16)}`,
    z16: `0 16px 32px -4px ${at(0.16)}`,
    z20: `0 20px 40px -4px ${at(0.16)}`,
    z24: `0 24px 48px 0 ${at(0.16)}`,
    dialog: `-40px 40px 80px -8px ${fade(COMMON.black, 0.24)}`,
    card: `0 0 2px 0 ${at(0.2)}, 0 12px 24px -4px ${at(0.12)}`,
    dropdown: `0 0 2px 0 ${at(0.24)}, -20px 20px 40px -4px ${at(0.24)}`,
    /** A temporary drawer's, cast away from the side it opens on (1: left, -1: right). */
    drawer: (side: 1 | -1) => `${side * 40}px 40px 80px -8px ${at(0.24)}`,
    color: (key: ColorKey) => `0 8px 16px 0 ${fade(theme.palette[key].main, 0.24)}`,
  };
}

/** A radius as a multiple of the theme's corner. */
export const radius = (theme: Theme, times: number) => Number(theme.shape.borderRadius) * times;

/* Korsi's dropdown paper glows faintly cyan in one corner and red in the other. */
const CYAN_SHAPE =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTIwIiBoZWlnaHQ9IjEyMCIgdmlld0JveD0iMCAwIDEyMCAxMjAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIxMjAiIGhlaWdodD0iMTIwIiBmaWxsPSJ1cmwoI3BhaW50MF9yYWRpYWxfNDQ2NF81NTMzOCkiIGZpbGwtb3BhY2l0eT0iMC4xIi8+CjxkZWZzPgo8cmFkaWFsR3JhZGllbnQgaWQ9InBhaW50MF9yYWRpYWxfNDQ2NF81NTMzOCIgY3g9IjAiIGN5PSIwIiByPSIxIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSIgZ3JhZGllbnRUcmFuc2Zvcm09InRyYW5zbGF0ZSgxMjAgMS44MTgxMmUtMDUpIHJvdGF0ZSgtNDUpIHNjYWxlKDEyMy4yNSkiPgo8c3RvcCBzdG9wLWNvbG9yPSIjMDBCOEQ5Ii8+CjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzAwQjhEOSIgc3RvcC1vcGFjaXR5PSIwIi8+CjwvcmFkaWFsR3JhZGllbnQ+CjwvZGVmcz4KPC9zdmc+Cg==';

const RED_SHAPE =
  'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTIwIiBoZWlnaHQ9IjEyMCIgdmlld0JveD0iMCAwIDEyMCAxMjAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIxMjAiIGhlaWdodD0iMTIwIiBmaWxsPSJ1cmwoI3BhaW50MF9yYWRpYWxfNDQ2NF81NTMzNykiIGZpbGwtb3BhY2l0eT0iMC4xIi8+CjxkZWZzPgo8cmFkaWFsR3JhZGllbnQgaWQ9InBhaW50MF9yYWRpYWxfNDQ2NF81NTMzNyIgY3g9IjAiIGN5PSIwIiByPSIxIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSIgZ3JhZGllbnRUcmFuc2Zvcm09InRyYW5zbGF0ZSgwIDEyMCkgcm90YXRlKDEzNSkgc2NhbGUoMTIzLjI1KSI+CjxzdG9wIHN0b3AtY29sb3I9IiNGRjU2MzAiLz4KPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjRkY1NjMwIiBzdG9wLW9wYWNpdHk9IjAiLz4KPC9yYWRpYWxHcmFkaWVudD4KPC9kZWZzPgo8L3N2Zz4K';

/**
 * Korsi's floating paper (`paperStyles`): 90% paper over a blur, with its two corner glows. A
 * dropdown (a select's options, a popover, an autocomplete's list) also gets an inset, the
 * dropdown shadow and a wider corner.
 */
export function paperStyles(theme: Theme, { dropdown = false } = {}): Css {
  return {
    backgroundImage: `url(${CYAN_SHAPE}), url(${RED_SHAPE})`,
    backgroundSize: '50%, 50%',
    backgroundRepeat: 'no-repeat',
    backgroundPosition:
      theme.direction === 'rtl' ? 'top left, right bottom' : 'top right, left bottom',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    backgroundColor: fade(theme.palette.background.paper, 0.9),
    ...(dropdown && {
      padding: theme.spacing(0.5),
      boxShadow: shadowsOf(theme).dropdown,
      borderRadius: `${radius(theme, 1.25)}px`,
    }),
  };
}

/** Korsi's menu item (`menuItemStyles`), also an autocomplete's option. */
export function menuItemStyles(theme: Theme): Css {
  const { action } = theme.palette;
  return {
    ...theme.typography.body2,
    padding: theme.spacing(0.75, 1),
    borderRadius: radius(theme, 0.75),
    '&:not(:last-of-type)': { marginBottom: 4 },
    [`&.${menuItemClasses.selected}`]: {
      fontWeight: 600,
      backgroundColor: action.selected,
      '&:hover': { backgroundColor: action.hover },
    },
    [`& .${checkboxClasses.root}`]: {
      padding: theme.spacing(0.5),
      marginLeft: theme.spacing(-0.5),
      marginRight: theme.spacing(0.5),
    },
    [`&.${autocompleteClasses.option}[aria-selected="true"]`]: {
      backgroundColor: action.selected,
      '&:hover': { backgroundColor: action.hover },
    },
    [`&+.${dividerClasses.root}`]: { margin: theme.spacing(0.5, 0) },
  };
}

const withHover = (hover: boolean | Css | undefined, base: Css): Css =>
  hover ? { '&:hover': { ...base, ...(typeof hover === 'object' ? hover : {}) } } : {};

/**
 * Korsi's filled surface (`filledStyles`): `default` is grey on grey, `inherit` is ink (dark on a
 * light page, light on a dark one), a palette colour is its main shade.
 */
export function filledStyles(
  theme: Theme,
  key: 'default' | 'inherit' | ColorKey,
  hover?: boolean | Css
): Css {
  const { grey, common } = theme.palette;
  if (key === 'default') {
    return {
      color: grey[800],
      backgroundColor: grey[300],
      ...withHover(hover, { backgroundColor: grey[400] }),
    };
  }
  if (key === 'inherit') {
    const dark = isDark(theme);
    return {
      color: dark ? grey[800] : common.white,
      backgroundColor: dark ? common.white : grey[800],
      ...withHover(hover, { backgroundColor: dark ? grey[400] : grey[700] }),
    };
  }
  const color = theme.palette[key];
  return {
    color: color.contrastText,
    backgroundColor: color.main,
    ...withHover(hover, { backgroundColor: color.dark }),
  };
}

/**
 * Korsi's soft surface (`softStyles`): a colour's own tint behind its darker shade (its lighter
 * one on a dark page); `inherit` is a grey tint.
 */
export function softStyles(
  theme: Theme,
  key: 'default' | 'inherit' | ColorKey,
  hover?: boolean | Css
): Css {
  if (key === 'default') return { ...filledStyles(theme, 'default', hover), boxShadow: 'none' };
  if (key === 'inherit') {
    const grey = theme.palette.grey[500];
    return {
      boxShadow: 'none',
      backgroundColor: fade(grey, OPACITY.softBg),
      ...withHover(hover, { backgroundColor: fade(grey, OPACITY.softHoverBg) }),
    };
  }
  const color = theme.palette[key];
  return {
    boxShadow: 'none',
    color: isDark(theme) ? color.light : color.dark,
    backgroundColor: fade(color.main, OPACITY.softBg),
    ...withHover(hover, { backgroundColor: fade(color.main, OPACITY.softHoverBg) }),
  };
}

/**
 * A Korsi plugin page that looks and reads like Korsi, with no framework:
 *
 * - `mountKorsiPage` -- connect, apply the theme, follow its changes, size the frame;
 * - `applyContext` / `themeVariables` -- Korsi's theme as CSS variables (`--k-primary`, ...);
 * - `loadKorsiFonts` -- Korsi's own typefaces, from the Korsi framing the page;
 * - `formatDate`, `formatNumber`, ... -- the organization's calendar and digits, through `Intl`.
 */
export {
  applyContext,
  applyTheme,
  DEFAULT_THEME,
  FALLBACK_FONT,
  FONT_VARIABLE,
  PALETTE_VARIABLES,
  themeCss,
  themeVariables,
} from './theme.js';
export {
  calendarParts,
  formatDate,
  formatDateTime,
  formatNumber,
  formatTime,
  localeTag,
  organizationDigits,
  toLatinDigits,
  toPersianDigits,
  type FormatContext,
} from './format.js';
export {
  fontStylesheetUrl,
  fontsUrl,
  KORSI_FONTS,
  loadKorsiFonts,
  type KorsiFontFace,
} from './fonts.js';
export { mountKorsiPage, type KorsiPage, type MountOptions } from './page.js';

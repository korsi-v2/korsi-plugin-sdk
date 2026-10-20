/**
 * Korsi's own typefaces, from the Korsi that frames the page.
 *
 * Korsi serves them at `<korsi>/sdk/fonts/`, readable from any origin, beside the Bridge. The faces
 * are the ones `korsi:init`'s font stack names:
 *
 * - **YekanBakh** in its `FaNum` cut, Korsi's typeface for Persian and Latin text;
 * - **Korsi Latin Digits**, the ten Latin digits only, which Korsi's stack puts first when the
 *   organization writes Latin digits -- so a stack that names it draws its digits from it.
 *
 * `loadKorsiFonts` registers them with the FontFace API: no stylesheet to fetch, and the page's
 * `Content-Security-Policy` needs only `font-src <korsi origins>`. A page that prefers CSS links
 * `fontStylesheetUrl(origin)` instead (then `style-src` must allow the Korsi origin too).
 */
import { normaliseOrigin } from '@korsi/bridge';

export interface KorsiFontFace {
  family: string;
  file: string;
  weight: string;
  unicodeRange: string;
}

/** The faces Korsi serves, as `korsi-fonts.css` declares them. */
export const KORSI_FONTS: readonly KorsiFontFace[] = Object.freeze([
  {
    family: 'YekanBakh',
    file: 'YekanBakhFaNum-VF.woff2',
    weight: '100 1000',
    unicodeRange:
      'U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF, U+1EE00-1EEFF, ' +
      'U+200C-200D, U+25CC, U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, ' +
      'U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  },
  {
    family: 'Korsi Latin Digits',
    file: 'public-sans-latin-wght-normal.woff2',
    weight: '100 900',
    unicodeRange: 'U+0030-0039',
  },
]);

/** Where a Korsi serves its fonts. */
export function fontsUrl(korsiOrigin: string): string {
  return `${normaliseOrigin(korsiOrigin) ?? korsiOrigin}/sdk/fonts/`;
}

/** The stylesheet declaring every face, for a page that links it rather than calling `loadKorsiFonts`. */
export function fontStylesheetUrl(korsiOrigin: string): string {
  return `${fontsUrl(korsiOrigin)}korsi-fonts.css`;
}

const loaded = new Map<string, Promise<FontFace[]>>();

/**
 * Register Korsi's faces from `korsiOrigin` with the document, once per origin, and resolve when
 * they are loaded. Resolves with nothing where the FontFace API is missing (a server, a test DOM);
 * a face that fails to load is left out rather than failing the page -- the stack falls back.
 */
export function loadKorsiFonts(
  korsiOrigin: string,
  { target = typeof document === 'undefined' ? undefined : document }: { target?: Document } = {}
): Promise<FontFace[]> {
  if (!target?.fonts || typeof FontFace === 'undefined') return Promise.resolve([]);
  const base = fontsUrl(korsiOrigin);
  let pending = loaded.get(base);
  if (!pending) {
    pending = Promise.all(
      KORSI_FONTS.map(async (face) => {
        const font = new FontFace(face.family, `url("${base}${face.file}") format("woff2")`, {
          weight: face.weight,
          unicodeRange: face.unicodeRange,
          display: 'swap',
        });
        target.fonts.add(font);
        try {
          return await font.load();
        } catch {
          target.fonts.delete(font);
          return null;
        }
      })
    ).then((faces) => faces.filter((face): face is FontFace => face !== null));
    loaded.set(base, pending);
  }
  return pending;
}

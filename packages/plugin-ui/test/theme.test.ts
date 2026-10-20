// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { MESSAGES, PROTOCOL } from '@korsi/bridge';
import {
  applyContext,
  DEFAULT_THEME,
  fontStylesheetUrl,
  KORSI_FONTS,
  loadKorsiFonts,
  mountKorsiPage,
  themeCss,
  themeVariables,
} from '@korsi/plugin-ui';

import {
  context,
  frameInKorsi,
  hasRuntime,
  importRuntime,
  KORSI,
} from '../../bridge/test/korsi-frame.js';

describe("Korsi's theme as CSS variables", () => {
  it('has a value for every variable from the start', () => {
    const variables = themeVariables(null);
    expect(variables['--k-primary']).toBe(DEFAULT_THEME.palette.primary);
    expect(variables['--k-font']).toMatch(/^YekanBakh, system-ui/);
    expect(Object.keys(variables)).toHaveLength(13);
  });

  it("takes Korsi's colours over the defaults, and its whole font stack", () => {
    const variables = themeVariables({
      mode: 'dark',
      font_family: '"Korsi Latin Digits", YekanBakh',
      palette: { primary: '#123456' },
    });
    expect(variables['--k-primary']).toBe('#123456');
    expect(variables['--k-on-primary']).toBe('#FFFFFF');
    expect(variables['--k-font']).toMatch(/^"Korsi Latin Digits", YekanBakh, /);
    expect(themeCss({ mode: 'dark', palette: {} })).toContain('color-scheme: dark;');
  });

  it('writes the context onto the document', () => {
    const root = document.documentElement;
    applyContext(context() as never, root);
    expect(root.style.getPropertyValue('--k-primary')).toBe('#00A76F');
    expect(root.style.getPropertyValue('--k-bg')).toBe('#141A21');
    expect(root.dataset.mode).toBe('dark');
    expect(root.dataset.calendar).toBe('jalali');
    expect(root.dataset.numerals).toBe('persian');
    expect(root.lang).toBe('fa');
    expect(root.dir).toBe('rtl');
  });
});

describe("Korsi's fonts", () => {
  it('are served under /sdk/fonts, and declared as the font stack names them', () => {
    expect(fontStylesheetUrl(`${KORSI}/anything`)).toBe(`${KORSI}/sdk/fonts/korsi-fonts.css`);
    expect(KORSI_FONTS.map((face) => face.family)).toEqual(['YekanBakh', 'Korsi Latin Digits']);
  });

  it('load to nothing where the FontFace API is missing', async () => {
    expect(await loadKorsiFonts(KORSI)).toEqual([]);
  });

  it('are registered with the FontFace API, once per Korsi', async () => {
    const added: unknown[] = [];
    class FakeFace {
      constructor(
        readonly family: string,
        readonly source: string
      ) {}
      load() {
        return Promise.resolve(this);
      }
    }
    vi.stubGlobal('FontFace', FakeFace);
    const target = { fonts: { add: (face: unknown) => added.push(face), delete: () => true } };
    const faces = await loadKorsiFonts('https://fonts.test', { target: target as never });
    await loadKorsiFonts('https://fonts.test', { target: target as never });
    vi.unstubAllGlobals();
    expect(faces).toHaveLength(2);
    expect(added).toHaveLength(2);
    expect((faces[0] as unknown as FakeFace).source).toBe(
      'url("https://fonts.test/sdk/fonts/YekanBakhFaNum-VF.woff2") format("woff2")'
    );
  });
});

describe.skipIf(!hasRuntime)('a page mounted in Korsi', () => {
  it('looks like Korsi, follows its changes, and calls its server as the person', async () => {
    const { posted, deliver } = frameInKorsi();
    window.history.replaceState({}, '', `/app?korsi_origin=${encodeURIComponent(KORSI)}`);
    const changes: string[] = [];
    const mounting = mountKorsiPage({
      allowedOrigins: [KORSI],
      importModule: importRuntime,
      onChange: (next) => changes.push(next.theme.mode),
    });
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    deliver({ protocol: PROTOCOL, type: MESSAGES.init, payload: context() });
    const page = await mounting;
    expect(page).not.toBeNull();
    const root = document.documentElement;
    expect(root.dataset.mode).toBe('dark');

    // The person switched Korsi to light: the page follows.
    deliver({
      protocol: PROTOCOL,
      type: MESSAGES.init,
      payload: context({ theme: { mode: 'light', palette: { background: '#FFFFFF' } } }),
    });
    expect(root.dataset.mode).toBe('light');
    expect(root.style.getPropertyValue('--k-bg')).toBe('#FFFFFF');
    expect(changes).toEqual(['light']);
    expect(page!.context.theme.mode).toBe('light');

    // The frame is told how tall the page is.
    expect(posted.some(({ message }) => message.type === MESSAGES.resize)).toBe(true);
    page!.stop();
  });
});

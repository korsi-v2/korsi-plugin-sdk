// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KorsiBridge, KorsiContext } from '@korsi/bridge';
import {
  KorsiProvider,
  useHandle,
  useKorsi,
  useKorsiContext,
  useKorsiNavigation,
  usePluginApi,
} from '@korsi/plugin-react';
import { createKorsiTheme } from '@korsi/plugin-react/mui';
import type { KorsiPage, MountOptions } from '@korsi/plugin-ui';

import { context } from '../../bridge/test/korsi-frame.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakePage(first: KorsiContext) {
  let onChange: MountOptions['onChange'];
  let navigateListener: ((path: string) => void) | null = null;
  const navigated: string[] = [];
  const bridge = {
    getHandle: vi.fn(async () => 'kph_live'),
    onNavigate: (listener: (path: string) => void) => {
      navigateListener = listener;
      return () => {
        navigateListener = null;
      };
    },
    navigate: (path: string) => navigated.push(path),
  } as unknown as KorsiBridge;
  const stop = vi.fn();
  const mount = vi.fn(async (options: MountOptions): Promise<KorsiPage> => {
    onChange = options.onChange;
    return {
      bridge,
      context: first,
      korsiOrigin: 'https://acme.korsi.test',
      api: { fetch: vi.fn(), request: vi.fn(async () => ({ ok: true })) as never },
      stop,
    };
  });
  return {
    mount,
    stop,
    bridge,
    navigated,
    change: (next: KorsiContext) => onChange?.(next),
    korsiNavigates: (path: string) => navigateListener?.(path),
  };
}

function Probe() {
  const { status } = useKorsi();
  const korsi = useKorsiContext();
  return (
    <p>
      {status}:{korsi?.theme.mode ?? 'none'}
    </p>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('KorsiProvider', () => {
  it('connects once, and re-renders when Korsi’s context changes', async () => {
    const page = fakePage(context() as KorsiContext);
    const { unmount } = render(
      <KorsiProvider allowedOrigins={['https://acme.korsi.test']} mount={page.mount}>
        <Probe />
      </KorsiProvider>
    );
    await screen.findByText('ready:dark');
    act(() => page.change(context({ theme: { mode: 'light', palette: {} } }) as KorsiContext));
    await screen.findByText('ready:light');
    expect(page.mount).toHaveBeenCalledTimes(1);
    expect(page.mount.mock.calls[0]?.[0].allowedOrigins).toEqual(['https://acme.korsi.test']);
    unmount();
    expect(page.stop).toHaveBeenCalled();
  });

  it('shows what it shows outside Korsi, or when connecting failed', async () => {
    render(
      <KorsiProvider mount={async () => null} outside={<p>open me in Korsi</p>}>
        <Probe />
      </KorsiProvider>
    );
    await screen.findByText('open me in Korsi');
    render(
      <KorsiProvider
        mount={async () => {
          throw new Error('Korsi did not answer');
        }}
        failed={(error) => <p>failed: {error.message}</p>}
      >
        <Probe />
      </KorsiProvider>
    );
    await screen.findByText('failed: Korsi did not answer');
  });

  it('gives a live handle, the server as the person, and Korsi’s address', async () => {
    const page = fakePage(context() as KorsiContext);
    const seen: string[] = [];
    let handle: (() => Promise<string>) | undefined;
    let api: ReturnType<typeof usePluginApi> | undefined;
    let go: ((path: string) => void) | undefined;
    function Consumer() {
      handle = useHandle();
      api = usePluginApi();
      go = useKorsiNavigation((path) => seen.push(path));
      return null;
    }
    render(
      <KorsiProvider mount={page.mount}>
        <Consumer />
      </KorsiProvider>
    );
    await waitFor(() => expect(page.mount).toHaveBeenCalled());
    await waitFor(async () => expect(await handle!()).toBe('kph_live'));
    expect(await api!.request('/api/me')).toEqual({ ok: true });
    go!('/messages/1');
    expect(page.navigated).toEqual(['/messages/1']);
    act(() => page.korsiNavigates('/back'));
    expect(seen).toEqual(['/back']);
  });

  it('refuses a hook outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/inside <KorsiProvider>/);
  });
});

describe('createKorsiTheme', () => {
  it("is Korsi's colours, font, direction and shape", () => {
    const theme = createKorsiTheme(context() as KorsiContext);
    expect(theme.palette.mode).toBe('dark');
    expect(theme.palette.primary.main).toBe('#00A76F');
    expect(theme.palette.background.default).toBe('#141A21');
    expect(theme.direction).toBe('rtl');
    expect(theme.shape.borderRadius).toBe(8);
    expect(theme.typography.fontFamily).toMatch(/^YekanBakh, -apple-system/);
  });

  it("falls back to Korsi's light theme, and takes overrides", () => {
    const theme = createKorsiTheme(null, { shape: { borderRadius: 4 } });
    expect(theme.palette.mode).toBe('light');
    expect(theme.palette.primary.main).toBe('#00A76F');
    expect(theme.shape.borderRadius).toBe(4);
  });
});

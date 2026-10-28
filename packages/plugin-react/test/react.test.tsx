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
  useKorsiTitle,
  usePluginApi,
} from '@korsi/plugin-react';
import { createKorsiTheme } from '@korsi/plugin-react/mui';
import type { KorsiPage, MountOptions } from '@korsi/plugin-ui';

import { context } from '../../bridge/test/korsi-frame.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakePage(first: KorsiContext) {
  let onChange: MountOptions['onChange'];
  const navigateListeners = new Set<(path: string) => void>();
  const navigated: string[] = [];
  const moves: Array<[string, unknown]> = [];
  const bridge = {
    getHandle: vi.fn(async () => 'kph_live'),
    onNavigate: (listener: (path: string) => void) => {
      navigateListeners.add(listener);
      return () => {
        navigateListeners.delete(listener);
      };
    },
    navigate: (path: string, options?: unknown) => {
      navigated.push(path);
      moves.push([path, options]);
    },
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
    moves,
    change: (next: KorsiContext) => onChange?.(next),
    korsiNavigates: (path: string) => navigateListeners.forEach((listener) => listener(path)),
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

  it('steps Korsi back with `back`, carrying `replace` for a Korsi that has no `back`', async () => {
    const page = fakePage(context() as KorsiContext);
    let go: ReturnType<typeof useKorsiNavigation> | undefined;
    let status: string | undefined;
    function Consumer() {
      go = useKorsiNavigation();
      status = useKorsi().status;
      return null;
    }
    render(
      <KorsiProvider mount={page.mount}>
        <Consumer />
      </KorsiProvider>
    );
    await waitFor(() => expect(status).toBe('ready'));
    go!('/criteria/7', { back: true });
    go!('/criteria/7/edit');
    go!('/redirected', { replace: true });
    expect(page.moves).toEqual([
      ['/criteria/7', { replace: true, back: true }],
      ['/criteria/7/edit', undefined],
      ['/redirected', { replace: true }],
    ]);
  });

  it('refuses a hook outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/inside <KorsiProvider>/);
  });
});

describe('useKorsiTitle', () => {
  function Screen({ title }: { title: string | null }) {
    const move = useKorsiNavigation();
    useKorsiTitle(title);
    return <button onClick={() => move('/positions/7/role')}>{title ?? 'none'}</button>;
  }

  it('names the screen while mounted, again after every move, and clears it on unmount', async () => {
    const page = fakePage(context() as KorsiContext);
    const setTitle = vi.fn();
    Object.assign(page.bridge, { setTitle });
    const inKorsi = (title: string | null) => (
      <KorsiProvider allowedOrigins={['https://acme.korsi.test']} mount={page.mount}>
        <Screen title={title} />
      </KorsiProvider>
    );
    const { rerender, unmount } = render(inKorsi('مدیر محصول'));
    await waitFor(() => expect(setTitle).toHaveBeenLastCalledWith('مدیر محصول'));

    rerender(inKorsi(null));
    expect(setTitle).toHaveBeenLastCalledWith(null);
    rerender(inKorsi('مراحل استخدام · مدیر محصول'));
    expect(setTitle).toHaveBeenLastCalledWith('مراحل استخدام · مدیر محصول');

    // Korsi lets a title go after a move: said again, whoever moved, without clearing first.
    setTitle.mockClear();
    act(() => page.korsiNavigates('/positions/7'));
    expect(setTitle.mock.calls).toEqual([['مراحل استخدام · مدیر محصول']]);
    setTitle.mockClear();
    act(() => screen.getByRole('button').click());
    expect(page.navigated).toEqual(['/positions/7/role']);
    expect(setTitle.mock.calls).toEqual([['مراحل استخدام · مدیر محصول']]);

    setTitle.mockClear();
    unmount();
    expect(setTitle.mock.calls).toEqual([[null]]);
  });

  it('is quiet on a Korsi without a title to show', async () => {
    const page = fakePage(context() as KorsiContext);
    render(
      <KorsiProvider allowedOrigins={['https://acme.korsi.test']} mount={page.mount}>
        <Screen title="مدیر محصول" />
      </KorsiProvider>
    );
    await waitFor(() => expect(page.mount).toHaveBeenCalled());
    expect((await screen.findByRole('button')).textContent).toBe('مدیر محصول');
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

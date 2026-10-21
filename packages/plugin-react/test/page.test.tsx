// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import Card from '@mui/material/Card';
import { useTheme } from '@mui/material/styles';

import type { KorsiContext } from '@korsi/bridge';
import {
  languageOf,
  useKorsiFormat,
  useMessages,
  usePluginData,
  type PluginData,
} from '@korsi/plugin-react';
import {
  EmptyState,
  KorsiPage,
  Label,
  NameAvatar,
  StatCard,
  createKorsiTheme,
} from '@korsi/plugin-react/mui';
import type { KorsiPage as MountedPage, MountOptions } from '@korsi/plugin-ui';

import { context } from '../../bridge/test/korsi-frame.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A Korsi that answers at once, and a server that answers with the path it was asked. */
function korsi(first: Record<string, unknown> = {}) {
  let onChange: MountOptions['onChange'];
  const request = vi.fn(async (path: string) => {
    if (path === '/api/broken') throw new Error('the server is down');
    return { path };
  });
  const mount = vi.fn(async (options: MountOptions): Promise<MountedPage> => {
    onChange = options.onChange;
    return {
      bridge: {} as MountedPage['bridge'],
      context: context(first) as KorsiContext,
      korsiOrigin: 'https://acme.korsi.test',
      api: { fetch: vi.fn(), request: request as never },
      stop: vi.fn(),
    };
  });
  return {
    mount,
    request,
    change: (next: Record<string, unknown>) => act(() => onChange?.(context(next) as KorsiContext)),
  };
}

const MESSAGES = {
  fa: { hello: 'سلام {name}' },
  en: { hello: 'Hello {name}', only: 'English only' },
};

describe('KorsiPage', () => {
  it("draws the page in Korsi's theme and direction, through a right-to-left cache", async () => {
    const page = korsi();
    function Look() {
      const theme = useTheme();
      return (
        <Card>
          {theme.direction}:{theme.palette.mode}:{theme.palette.primary.main}
        </Card>
      );
    }
    render(
      <KorsiPage mount={page.mount}>
        <Look />
      </KorsiPage>
    );
    await screen.findByText('rtl:dark:#00A76F');
    expect(document.head.querySelector('style[data-emotion^="kp-rtl"]')).not.toBeNull();
    page.change({ dir: 'ltr', locale: 'en', theme: { mode: 'light', palette: {} } });
    await screen.findByText('ltr:light:#00A76F');
    expect(page.mount).toHaveBeenCalledTimes(1);
  });

  it('says so outside Korsi and when Korsi did not answer, in the browser’s language', async () => {
    render(
      <KorsiPage mount={async () => null}>
        <p>the app</p>
      </KorsiPage>
    );
    await screen.findByText('This page opens inside Korsi');
    render(
      <KorsiPage
        mount={async () => {
          throw new Error('no answer');
        }}
      >
        <p>the app</p>
      </KorsiPage>
    );
    await screen.findByText('Korsi did not answer');
    expect(screen.queryByText('the app')).toBeNull();
  });

  it('takes its own views for each of them', async () => {
    render(
      <KorsiPage
        mount={async () => {
          throw new Error('no answer');
        }}
        failed={(error) => <p>failed: {error.message}</p>}
      >
        <p>the app</p>
      </KorsiPage>
    );
    await screen.findByText('failed: no answer');
  });

  it("draws an icon given by name with the page's own icons, and an element as it is", async () => {
    const page = korsi();
    const Icon = ({ icon, width }: { icon: string; width?: number }) => (
      <i data-testid="icon">
        {icon}@{width}
      </i>
    );
    render(
      <KorsiPage mount={page.mount} iconComponent={Icon}>
        <Label icon="solar:check-circle-bold" color="success">
          kept
        </Label>
        <StatCard icon="solar:letter-bold-duotone" value="12" label="read" />
        <EmptyState icon={<b>its own</b>} title="nothing yet" />
        <NameAvatar name={'"Sara Ahmadi" <sara@acme.test>'} />
      </KorsiPage>
    );
    await screen.findByText('kept');
    expect(screen.getAllByTestId('icon').map((icon) => icon.textContent)).toEqual([
      'solar:check-circle-bold@14',
      'solar:letter-bold-duotone@26',
    ]);
    expect(screen.getByText('its own')).toBeTruthy();
    expect(screen.getByText('S')).toBeTruthy();
  });
});

describe('the hooks a page reads Korsi with', () => {
  it('speaks the language Korsi asks for and writes its digits, following a change', async () => {
    const page = korsi();
    function Words() {
      const t = useMessages(MESSAGES);
      const format = useKorsiFormat();
      return (
        <p>
          {t('hello', { name: 'Ana' })}|{t('only')}|{t('missing')}|{format.number(1234)}|
          {format.date(null)}
        </p>
      );
    }
    render(
      <KorsiPage mount={page.mount}>
        <Words />
      </KorsiPage>
    );
    const persian = await screen.findByText(/^سلام Ana\|English only\|missing\|/);
    expect(persian.textContent).toMatch(/۱.?۲۳۴\|$/);
    page.change({ locale: 'en', numerals: 'latin' });
    await screen.findByText('Hello Ana|English only|missing|1,234|');
  });

  it('chooses a language the page has: Korsi’s, else Persian, else the browser’s outside Korsi', () => {
    expect(languageOf({ locale: 'en-GB' }, MESSAGES)).toBe('en');
    expect(languageOf({ locale: 'ar' }, MESSAGES)).toBe('fa');
    expect(languageOf({ locale: 'ar' }, { en: {} })).toBe('en');
    // jsdom's browser speaks English.
    expect(languageOf(null, MESSAGES)).toBe('en');
  });

  it("reads the plugin's server as the person, again on reload and on another record", async () => {
    const page = korsi();
    let read: PluginData<{ path: string }> | undefined;
    function Reader({ path }: { path: string | null }) {
      read = usePluginData<{ path: string }>(path);
      return <p>{read.loading ? 'loading' : (read.error?.message ?? read.data?.path ?? 'none')}</p>;
    }
    const { rerender } = render(
      <KorsiPage mount={page.mount}>
        <Reader path="/api/me" />
      </KorsiPage>
    );
    await screen.findByText('/api/me');
    act(() => read!.reload());
    await waitFor(() => expect(page.request).toHaveBeenCalledTimes(2));
    page.change({ theme: { mode: 'light', palette: {} } });
    page.change({ context: { kind: 'case', id: 'c2' } });
    await waitFor(() => expect(page.request).toHaveBeenCalledTimes(3));

    rerender(
      <KorsiPage mount={page.mount}>
        <Reader path="/api/broken" />
      </KorsiPage>
    );
    await screen.findByText('the server is down');
    expect(read!.data).toEqual({ path: '/api/me' });

    rerender(
      <KorsiPage mount={page.mount}>
        <Reader path={null} />
      </KorsiPage>
    );
    expect(page.request).toHaveBeenCalledTimes(4);
  });
});

describe("createKorsiTheme's cards and overrides", () => {
  it("gives cards Korsi's shadow for the mode, and merges overrides in order", () => {
    const root = (theme: ReturnType<typeof createKorsiTheme>) =>
      theme.components?.MuiCard?.styleOverrides?.root as { boxShadow: string };
    expect(root(createKorsiTheme(context() as KorsiContext)).boxShadow).toContain('rgba(0,0,0');
    const light = createKorsiTheme(null, { shape: { borderRadius: 4 } }, { spacing: 4 });
    expect(root(light).boxShadow).toContain('rgba(145,158,171');
    expect(light.shape.borderRadius).toBe(4);
    expect(light.spacing(2)).toBe('8px');
  });
});

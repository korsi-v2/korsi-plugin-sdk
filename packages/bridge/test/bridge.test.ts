// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BRIDGE_FUNCTIONS,
  BridgeTrustError,
  BridgeVersionError,
  bridgeUrl,
  connectKorsi,
  createPluginApi,
  korsiOrigin,
  loadBridge,
  MESSAGES,
  originAllowed,
  PluginApiError,
  PROTOCOL,
  type KorsiBridge,
} from '@korsi/bridge';

import { context, frameInKorsi, hasRuntime, importRuntime, KORSI } from './korsi-frame.js';

function at(search: string): Location {
  return { search, ancestorOrigins: undefined } as unknown as Location;
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('where Korsi is', () => {
  it('is the address’s korsi_origin, normalised, when the page trusts it', () => {
    expect(korsiOrigin([KORSI], at(`?korsi_origin=${KORSI}/some/path`))).toBe(KORSI);
    expect(korsiOrigin(['https://*.korsi.test'], at(`?korsi_origin=${KORSI}`))).toBe(KORSI);
    expect(korsiOrigin([], at(`?korsi_origin=${KORSI}`))).toBeNull();
  });

  it('is trusted by exact origin or by a subdomain pattern, nothing looser', () => {
    const allowed = ['https://*.korsi.test', 'https://korsi.acme.ir'];
    expect(originAllowed('https://acme.korsi.test', allowed)).toBe(true);
    expect(originAllowed('https://a.b.korsi.test', allowed)).toBe(true);
    expect(originAllowed('https://korsi.acme.ir', allowed)).toBe(true);
    expect(originAllowed('https://korsi.test', allowed)).toBe(false);
    expect(originAllowed('https://evilkorsi.test', allowed)).toBe(false);
    expect(originAllowed('http://acme.korsi.test', allowed)).toBe(false);
    expect(originAllowed('https://acme.korsi.test:8443', allowed)).toBe(false);
  });

  it('is not believed outside the allowed origins', () => {
    expect(korsiOrigin(['https://other.test'], at(`?korsi_origin=${KORSI}`))).toBeNull();
    expect(korsiOrigin([`${KORSI}/`], at(`?korsi_origin=${KORSI}`))).toBe(KORSI);
  });

  it('must agree with the browser’s record of the parent', () => {
    const location = {
      search: `?korsi_origin=${KORSI}`,
      ancestorOrigins: ['https://evil.test'],
    } as unknown as Location;
    expect(korsiOrigin([KORSI], location)).toBeNull();
  });

  it('is remembered for the tab, and assumed when only one is allowed', () => {
    window.sessionStorage.setItem('korsi-bridge:origin', KORSI);
    expect(korsiOrigin([KORSI], at(''))).toBe(KORSI);
    window.sessionStorage.clear();
    expect(korsiOrigin([KORSI], at(''))).toBe(KORSI);
    expect(korsiOrigin(['https://*.korsi.test'], at(''))).toBeNull();
  });

  it('serves its Bridge under /sdk', () => {
    expect(bridgeUrl(`${KORSI}/x`)).toBe(`${KORSI}/sdk/korsi-bridge.js`);
  });
});

describe('loading the Bridge', () => {
  const fake = (extra: object = {}) =>
    Object.fromEntries([
      ['MESSAGES', MESSAGES],
      ...BRIDGE_FUNCTIONS.map((name) => [name, () => undefined]),
      ...Object.entries(extra),
    ]);

  it('imports it once per Korsi', async () => {
    const importModule = vi.fn(async () => fake({ PROTOCOL }));
    const first = await loadBridge('https://one.test', { importModule });
    const again = await loadBridge('https://one.test', { importModule });
    expect(first).toBe(again);
    expect(importModule).toHaveBeenCalledWith('https://one.test/sdk/korsi-bridge.js');
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it('refuses a module that is not the Bridge, or speaks another protocol', async () => {
    await expect(
      loadBridge('https://two.test', { importModule: async () => ({ connect() {} }) })
    ).rejects.toThrow(/not the Bridge/);
    await expect(
      loadBridge('https://three.test', {
        importModule: async () => fake({ PROTOCOL: 'korsi-bridge/2' }),
      })
    ).rejects.toBeInstanceOf(BridgeVersionError);
  });

  it('is not tried outside a frame', async () => {
    const importModule = vi.fn();
    expect(await connectKorsi({ allowedOrigins: [KORSI], importModule })).toBeNull();
    expect(importModule).not.toHaveBeenCalled();
  });

  it('needs an origin the page trusts: the address alone is no proof', async () => {
    await expect(connectKorsi({})).rejects.toBeInstanceOf(BridgeTrustError);
  });

  it('never runs code from a site that framed the page and named itself', async () => {
    frameInKorsi();
    window.history.replaceState({}, '', '/app?korsi_origin=https%3A%2F%2Fevil.test');
    const importModule = vi.fn();
    expect(
      await connectKorsi({ allowedOrigins: ['https://*.korsi.test'], importModule })
    ).toBeNull();
    expect(importModule).not.toHaveBeenCalled();
  });
});

describe('the plugin’s own server, as the person', () => {
  it('gets the handle and the installation on every call, and Korsi’s code on a refusal', async () => {
    const bridge = {
      getContext: () => ({ installation_id: 'inst-1' }),
      getHandle: async () => 'kph_live',
    } as unknown as KorsiBridge;
    const seen: Headers[] = [];
    const api = createPluginApi(bridge, {
      base: '/plugins/acme/',
      fetch: async (input, init) => {
        seen.push(new Headers(init?.headers));
        return String(input).endsWith('/broke')
          ? new Response(JSON.stringify({ code: 'plugin.wallet_insufficient', detail: 'buy' }), {
              status: 402,
            })
          : new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(await api.request('/api/me')).toEqual({ ok: true });
    expect(seen[0]?.get('authorization')).toBe('Bearer kph_live');
    expect(seen[0]?.get('x-korsi-installation')).toBe('inst-1');
    const error = await api.request('/broke', { method: 'POST', body: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(PluginApiError);
    expect(error).toMatchObject({ status: 402, code: 'plugin.wallet_insufficient' });
  });
});

describe.skipIf(!hasRuntime)("Korsi's own runtime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is what these types describe', async () => {
    const runtime = await importRuntime();
    expect(runtime.MESSAGES).toEqual(MESSAGES);
    expect(runtime.PROTOCOL ?? PROTOCOL).toBe(PROTOCOL);
    for (const name of BRIDGE_FUNCTIONS) expect(typeof runtime[name]).toBe('function');
    const exported = Object.keys(runtime).filter((key) => typeof runtime[key] === 'function');
    expect(exported.sort()).toEqual([...BRIDGE_FUNCTIONS].sort());
  });

  it('connects through connectKorsi: ready, init, a handle, and Korsi’s dialogs', async () => {
    const { posted, deliver } = frameInKorsi();
    window.history.replaceState({}, '', `/app?korsi_origin=${encodeURIComponent(KORSI)}`);
    const connecting = connectKorsi({ allowedOrigins: [KORSI], importModule: importRuntime });
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    expect(posted[0]).toEqual({
      message: { protocol: PROTOCOL, type: MESSAGES.ready, payload: {} },
      origin: KORSI,
    });

    // A stranger's init is ignored; Korsi's pins the origin.
    deliver({ protocol: PROTOCOL, type: MESSAGES.init, payload: context() }, 'https://evil.test');
    deliver({ protocol: PROTOCOL, type: MESSAGES.init, payload: context() });
    const korsi = await connecting;
    expect(korsi?.korsiOrigin).toBe(KORSI);
    expect(korsi?.context.theme.mode).toBe('dark');
    expect(await korsi?.bridge.getHandle()).toBe('kph_first');
    expect(window.sessionStorage.getItem('korsi-bridge:origin')).toBe(KORSI);

    // A question is Korsi's dialog; the page is told the answer.
    const asking = korsi!.bridge.confirm({ title: 'Read this email?' });
    await vi.waitFor(() => expect(posted.at(-1)?.message.type).toBe(MESSAGES.confirm));
    const question = posted.at(-1)!.message;
    expect(question).toMatchObject({
      type: MESSAGES.confirm,
      payload: { title: 'Read this email?' },
    });
    deliver({
      protocol: PROTOCOL,
      type: MESSAGES.reply,
      id: question.id,
      ok: true,
      result: { confirmed: true },
    });
    expect(await asking).toBe(true);

    // A refusal comes back with its code.
    const picking = korsi!.bridge.pickCase();
    await vi.waitFor(() => expect(posted.at(-1)?.message.type).toBe(MESSAGES.pickCase));
    const pick = posted.at(-1)!.message;
    deliver({
      protocol: PROTOCOL,
      type: MESSAGES.reply,
      id: pick.id,
      ok: false,
      error: { code: 'busy', message: 'another question is open' },
    });
    await expect(picking).rejects.toMatchObject({ code: 'busy' });
  });
});

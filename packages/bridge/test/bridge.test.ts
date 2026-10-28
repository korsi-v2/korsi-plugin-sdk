// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BRIDGE_FUNCTIONS,
  OPTIONAL_BRIDGE_FUNCTIONS,
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
  type KorsiConnection,
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

  it('loads an older Korsi that lacks what a newer one added', async () => {
    const older: Record<string, unknown> = fake();
    for (const name of OPTIONAL_BRIDGE_FUNCTIONS) delete older[name];
    const bridge = await loadBridge('https://older.test', { importModule: async () => older });
    expect(bridge.openProposal).toBeUndefined();
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

  it('asks Korsi for a lost credential again, and tells a refusal from a wait that ran out', async () => {
    let lost = true;
    let renewal: () => Promise<void> = async () => {
      lost = false;
    };
    const renewCredential = vi.fn(() => renewal());
    const bridge = {
      getContext: () => ({ installation_id: 'inst-1' }),
      getHandle: async () => 'kph_live',
      renewCredential,
    } as unknown as KorsiBridge;
    const api = createPluginApi(bridge, {
      fetch: async () =>
        lost
          ? new Response(JSON.stringify({ code: 'plugin.unprovisioned' }), { status: 409 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    const rejecting = (code: string) => async () => {
      throw Object.assign(new Error(`korsi-bridge: ${code}`), { code });
    };

    // Given again: the call is made once more, and goes through.
    expect(await api.request('/api/me')).toEqual({ ok: true });
    expect(renewCredential).toHaveBeenCalledTimes(1);

    // Refused: Korsi's own answer for an installation no longer shown, not the server's 409.
    lost = true;
    renewal = rejecting('failed');
    const refused = await api.fetch('/api/me');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: 'plugin.not_visible' });
    expect(await api.request('/api/me').catch((e) => e)).toMatchObject({
      status: 403,
      code: 'plugin.not_visible',
    });

    // The wait ran out: the server's 409, since it may still be coming back.
    renewal = rejecting('timeout');
    expect(await api.request('/api/me').catch((e) => e)).toMatchObject({
      status: 409,
      code: 'plugin.unprovisioned',
    });
    expect(renewCredential).toHaveBeenCalledTimes(4);
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
    expect(exported.sort()).toEqual([...BRIDGE_FUNCTIONS, ...OPTIONAL_BRIDGE_FUNCTIONS].sort());
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

    // A proposal is decided in Korsi's own form; the page learns how it ended.
    const opening = korsi!.bridge.openProposal!('6f0c1d3e-5b8a-4c2e-9d1f-0a2b3c4d5e6f', {
      reject: true,
    });
    await vi.waitFor(() => expect(posted.at(-1)?.message.type).toBe(MESSAGES.openProposal));
    const opened = posted.at(-1)!.message;
    expect(opened.payload).toEqual({
      proposal_id: '6f0c1d3e-5b8a-4c2e-9d1f-0a2b3c4d5e6f',
      intent: 'reject',
    });
    deliver({
      protocol: PROTOCOL,
      type: MESSAGES.reply,
      id: opened.id,
      ok: true,
      result: { status: 'rejected', action_id: null, error_code: null },
    });
    expect(await opening).toEqual({ status: 'rejected', action_id: null, error_code: null });
  });

  it('tells Korsi a move back with `replace` too, for a Korsi that knows only that', async () => {
    const { posted, deliver } = frameInKorsi();
    window.history.replaceState({}, '', `/app?korsi_origin=${encodeURIComponent(KORSI)}`);
    const connected: { korsi?: KorsiConnection | null } = {};
    void connectKorsi({ allowedOrigins: [KORSI], importModule: importRuntime }).then((korsi) => {
      connected.korsi = korsi;
    });
    await vi.waitFor(
      () => {
        deliver({ protocol: PROTOCOL, type: MESSAGES.init, payload: context() });
        if (!connected.korsi) throw new Error('not connected yet');
      },
      { timeout: 5000 }
    );
    const { bridge } = connected.korsi!;
    bridge.navigate('/criteria/7/edit');
    bridge.navigate('/criteria/7', { back: true });
    bridge.navigate('/criteria', { replace: true });
    const moves = posted.filter((entry) => entry.message.type === MESSAGES.navigate);
    expect(moves.map((entry) => entry.message.payload)).toEqual([
      { path: '/criteria/7/edit', replace: false },
      { path: '/criteria/7', replace: true, back: true },
      { path: '/criteria', replace: true },
    ]);
  });

  it('names the app page’s screen for the status bar, as one line of plain text', async () => {
    const { posted, deliver } = frameInKorsi();
    window.history.replaceState({}, '', `/app?korsi_origin=${encodeURIComponent(KORSI)}`);
    const connected: { korsi?: KorsiConnection | null } = {};
    void connectKorsi({ allowedOrigins: [KORSI], importModule: importRuntime }).then((korsi) => {
      connected.korsi = korsi;
    });
    // Korsi answers the page's ready -- or, connected by the test before, speaks to it again.
    await vi.waitFor(
      () => {
        deliver({ protocol: PROTOCOL, type: MESSAGES.init, payload: context() });
        if (!connected.korsi) throw new Error('not connected yet');
      },
      { timeout: 5000 }
    );
    const { bridge } = connected.korsi!;
    expect(typeof bridge.setTitle).toBe('function');

    bridge.setTitle!('  مدیر محصول\n  ·\u202e  تهران ');
    bridge.setTitle!('   ');
    bridge.setTitle!(null);
    bridge.setTitle!('ا'.repeat(130));
    const titles = posted.filter((entry) => entry.message.type === MESSAGES.title);
    expect(titles.map((entry) => entry.message.payload)).toEqual([
      { title: 'مدیر محصول · تهران' },
      { title: null },
      { title: null },
      { title: 'ا'.repeat(120) },
    ]);
    // Told, not asked: nothing waits for an answer, and it goes only to the Korsi pinned.
    expect(titles.every((entry) => entry.message.id === undefined && entry.origin === KORSI)).toBe(
      true
    );
  });
});

import { beforeEach, describe, expect, it } from 'vitest';

import {
  CredentialMismatch,
  EventInProgress,
  HandleRejected,
  KorsiPlugin,
  KorsiRefused,
  MalformedRequest,
  MemoryEventLog,
  SignatureInvalid,
  SignatureStale,
  sign,
  UnknownInstallation,
  type Installation,
  type InstallationStore,
  type KorsiEvent,
} from '@korsi/plugin';

import {
  ANA,
  API_BASE,
  FakeKorsi,
  FOREIGN_HANDLE,
  HANDLE,
  INSTALLATION,
  problem,
  SECRET,
  TOKEN,
} from './fake-korsi.js';

class Store implements InstallationStore {
  rows = new Map<string, Installation>();
  async installation(id: string) {
    return this.rows.get(id) ?? null;
  }
  async saveInstallation(installation: Installation) {
    this.rows.set(installation.id, installation);
  }
  async removeInstallation(id: string) {
    this.rows.delete(id);
  }
}

const body = (payload: object) => JSON.stringify(payload);

const installed = (overrides: object = {}) => ({
  event: 'installed',
  installation_id: INSTALLATION,
  plugin_id: 'ir.acme.sample',
  version: '1.2.0',
  plugin_api: '1.0',
  api_base: API_BASE,
  token: TOKEN,
  token_expires_at: null,
  signing_secret: SECRET,
  scopes: ['records.own'],
  settings: {},
  ...overrides,
});

const event = (overrides: object = {}) => ({
  id: '00000000-0000-4000-8000-000000000007',
  sequence: 7,
  topic: 'plugin.proposal.settled',
  installation_id: INSTALLATION,
  subject_id: null,
  data: { external_id: 'm1#1', status: 'applied' },
  occurred_at: '2026-10-20T10:00:00+00:00',
  ...overrides,
});

let korsi: FakeKorsi;
let store: Store;
let plugin: KorsiPlugin;

beforeEach(() => {
  korsi = new FakeKorsi();
  store = new Store();
  plugin = new KorsiPlugin(store, { fetch: korsi.fetch });
});

async function install() {
  const raw = body(installed());
  expect((await plugin.lifecycle(raw, sign(SECRET, raw))).status).toBe('installed');
}

describe('installed', () => {
  it('is confirmed with Korsi, then kept as Korsi describes it', async () => {
    await install();
    const kept = store.rows.get(INSTALLATION);
    expect(kept).toMatchObject({ token: TOKEN, signingSecret: SECRET, settings: { x: 1 } });
    expect(korsi.count('GET', '/installation')).toBe(1);
  });

  it('is refused with a bad signature, or for another installation', async () => {
    const raw = body(installed());
    await expect(plugin.lifecycle(raw, sign('another', raw))).rejects.toBeInstanceOf(
      SignatureInvalid
    );
    const other = body(installed({ installation_id: '33333333-3333-4333-8333-333333333333' }));
    await expect(plugin.lifecycle(other, sign(SECRET, other))).rejects.toBeInstanceOf(
      CredentialMismatch
    );
    expect(store.rows.size).toBe(0);
  });

  it('cannot move a known installation to another Korsi', async () => {
    await install();
    const raw = body(
      installed({ api_base: 'https://evil.test/plugin/v1', signing_secret: 'evil' })
    );
    await expect(plugin.lifecycle(raw, sign('evil', raw))).rejects.toThrow(/another Korsi/);
    expect(store.rows.get(INSTALLATION)?.apiBase).toBe(API_BASE);
  });

  it('never makes the plugin call an address that is not a plane', async () => {
    for (const apiBase of ['http://10.0.0.5/plugin/v1', 'https://korsi.test/plugin/v1?x=/admin']) {
      const raw = body(installed({ api_base: apiBase }));
      await expect(plugin.lifecycle(raw, sign(SECRET, raw))).rejects.toBeInstanceOf(
        CredentialMismatch
      );
    }
    expect(korsi.calls).toEqual([]);
  });

  it('accepts trusted Korsis by pattern', async () => {
    const strict = new KorsiPlugin(store, {
      fetch: korsi.fetch,
      trustedApiBases: ['https://*.test/plugin/v1'],
    });
    const raw = body(installed());
    expect((await strict.lifecycle(raw, sign(SECRET, raw))).status).toBe('installed');
  });

  it('comes only from trusted Korsis when the plugin names them', async () => {
    const strict = new KorsiPlugin(store, {
      fetch: korsi.fetch,
      trustedApiBases: ['https://acme.korsi.ai/plugin/v1/'],
    });
    const raw = body(installed());
    await expect(strict.lifecycle(raw, sign(SECRET, raw))).rejects.toThrow(/not a Korsi/);
  });

  it('is not kept when Korsi refuses the credential', async () => {
    korsi.tokenAnswer = () => problem(401, 'auth.unauthenticated');
    const raw = body(installed());
    await expect(plugin.lifecycle(raw, sign(SECRET, raw))).rejects.toBeInstanceOf(KorsiRefused);
    expect(store.rows.size).toBe(0);
  });

  it('is what a development credential goes through too', async () => {
    const kept = await plugin.register({
      installationId: INSTALLATION,
      token: TOKEN,
      signingSecret: SECRET,
      apiBase: `${API_BASE}/`,
    });
    expect(kept).toMatchObject({ pluginId: 'ir.acme.sample', apiBase: API_BASE });
  });

  it('answers garbage as malformed', async () => {
    await expect(plugin.lifecycle('not json', null)).rejects.toBeInstanceOf(MalformedRequest);
    await expect(plugin.lifecycle(body({ event: 'upgraded' }), null)).rejects.toBeInstanceOf(
      MalformedRequest
    );
  });
});

describe('removed', () => {
  it.each([
    [null, 'still_installed'],
    [() => problem(401, 'auth.unauthenticated'), 'removed'],
    [() => problem(403, 'plugin.not_a_plugin'), 'removed'],
    [() => problem(403, 'plugin.installation_inactive', { state: 'removed' }), 'removed'],
    [() => problem(403, 'plugin.installation_inactive', { state: 'suspended' }), 'unconfirmed'],
    [() => problem(503, 'service.unavailable'), 'unconfirmed'],
    [() => new Response('bad gateway', { status: 502 }), 'unconfirmed'],
    // Not Korsi answering: a proxy's bare 401, a redirect to another host.
    [() => new Response('Unauthorized', { status: 401 }), 'unconfirmed'],
    [
      () => new Response(null, { status: 301, headers: { location: 'https://x.test/' } }),
      'unconfirmed',
    ],
  ] as const)('is believed only when Korsi refuses the credential (%#)', async (answer, status) => {
    await install();
    korsi.tokenAnswer = answer;
    const result = await plugin.lifecycle(
      body({ event: 'removed', installation_id: INSTALLATION }),
      null
    );
    expect(result.status).toBe(status);
    expect(store.rows.has(INSTALLATION)).toBe(status !== 'removed');
  });

  it('is unknown for a stranger', async () => {
    const result = await plugin.lifecycle(
      body({ event: 'removed', installation_id: '33333333-3333-4333-8333-333333333333' }),
      null
    );
    expect(result.status).toBe('unknown');
  });
});

describe('events', () => {
  it('are handled once', async () => {
    await install();
    const handled: KorsiEvent[] = [];
    const raw = body(event());
    const handler = async (_: Installation, received: KorsiEvent) => {
      handled.push(received);
    };
    expect(await plugin.event(raw, sign(SECRET, raw), handler)).toBe('handled');
    expect(await plugin.event(raw, sign(SECRET, raw), handler)).toBe('duplicate');
    expect(handled).toHaveLength(1);
    expect(handled[0]?.data.status).toBe('applied');
    expect(handled[0]?.occurredAt).toBeInstanceOf(Date);
  });

  it("run again on Korsi's retry when the handler failed", async () => {
    await install();
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('database down');
    };
    const raw = body(event());
    await expect(plugin.event(raw, sign(SECRET, raw), flaky)).rejects.toThrow('database down');
    expect(await plugin.event(raw, sign(SECRET, raw), flaky)).toBe('handled');
    expect(attempts).toBe(2);
  });

  it('are refused unsigned; one for an installation not known yet is retried', async () => {
    await install();
    const raw = body(event());
    const forged = await plugin.event(raw, sign('not-it', raw), () => undefined).catch((e) => e);
    expect(forged).toBeInstanceOf(SignatureInvalid);
    expect(forged.status).toBe(401);
    // Korsi's signature, but stale: refused, and answered 503 so a skewed clock loses nothing.
    const stale = await plugin.verifiedEvent(raw, sign(SECRET, raw, { now: 1 })).catch((e) => e);
    expect(stale).toBeInstanceOf(SignatureStale);
    expect(stale.status).toBe(503);
    // The plugin may have been down when Korsi delivered `installed`: a 4xx would lose the event.
    const stranger = body(event({ installation_id: '33333333-3333-4333-8333-333333333333' }));
    const error = await plugin
      .verifiedEvent(stranger, sign(SECRET, stranger))
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(UnknownInstallation);
    expect(error.status).toBe(503);
  });

  it('still running elsewhere are retried, not answered as done', async () => {
    await install();
    const raw = body(event());
    let release!: () => void;
    let runs = 0;
    const slow = () => {
      runs += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const first = plugin.event(raw, sign(SECRET, raw), slow);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const busy = await plugin.event(raw, sign(SECRET, raw), slow).catch((e) => e);
    expect(busy).toBeInstanceOf(EventInProgress);
    expect(busy.status).toBe(503);
    release();
    expect(await first).toBe('handled');
    expect(await plugin.event(raw, sign(SECRET, raw), slow)).toBe('duplicate');
    expect(runs).toBe(1);
  });

  it('run again once a dead delivery’s lease ends', async () => {
    const log = new MemoryEventLog();
    let now = 1_000_000;
    log.now = () => now;
    const leased = new KorsiPlugin(store, {
      fetch: korsi.fetch,
      events: log,
      eventLeaseSeconds: 60,
    });
    const raw = body(installed());
    await leased.lifecycle(raw, sign(SECRET, raw));
    const delivery = body(event());
    // A delivery that claimed it, then the process died: nothing finished, nothing forgot.
    expect(await log.claim(INSTALLATION, '00000000-0000-4000-8000-000000000007', 60)).toBe('new');
    await expect(
      leased.event(delivery, sign(SECRET, delivery), () => undefined)
    ).rejects.toBeInstanceOf(EventInProgress);
    now += 61_000;
    expect(await leased.event(delivery, sign(SECRET, delivery), () => undefined)).toBe('handled');
  });

  it('are remembered per installation, and only the newest', async () => {
    const log = new MemoryEventLog(2);
    for (const [installation, id] of [
      ['a', '1'],
      ['b', '1'],
      ['a', '2'],
    ] as const) {
      expect(await log.claim(installation, id, 60)).toBe('new');
      await log.finish(installation, id);
    }
    expect(await log.claim('a', '2', 60)).toBe('done');
    expect(await log.claim('a', '1', 60)).toBe('new');
    await log.forget('a', '2'); // a finished event is not given back
    expect(await log.claim('a', '2', 60)).toBe('done');
  });
});

describe('tools and pages', () => {
  it('verify a tool call, which reads Korsi as the person', async () => {
    await install();
    const raw = body({
      installation_id: INSTALLATION,
      user_id: ANA,
      arguments: { q: 'x' },
      handle: HANDLE,
      api_base: API_BASE,
      locale: 'fa',
    });
    const { installation, call } = await plugin.toolCall('find', raw, sign(SECRET, raw));
    expect(call).toMatchObject({ name: 'find', userId: ANA, arguments: { q: 'x' } });
    expect((await plugin.client(installation, call.handle).whoami()).userId).toBe(ANA);
  });

  it("ask Korsi about a page's handle once", async () => {
    await install();
    const before = korsi.count('GET', '/installation');
    for (let n = 0; n < 3; n += 1) {
      const who = await plugin.person({
        authorization: `Bearer ${HANDLE}`,
        installationId: INSTALLATION,
      });
      expect(who.userId).toBe(ANA);
    }
    expect(korsi.count('GET', '/installation')).toBe(before + 1);
  });

  it.each([
    [undefined, 401],
    ['Basic abc', 401],
    ['Bearer ', 401],
    ['Bearer    ', 401],
    ['Bearer nobody', 401],
    [`Bearer ${FOREIGN_HANDLE}`, 403],
    [`Bearer ${TOKEN}`, 403],
  ])('let no page claim to be anybody (%s)', async (authorization, status) => {
    await install();
    const error = await plugin
      .person({ authorization, installationId: INSTALLATION })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(HandleRejected);
    expect(error.status).toBe(status);
  });

  it('need the page to name its installation', async () => {
    await install();
    await expect(
      plugin.person({ authorization: `Bearer ${HANDLE}`, installationId: null })
    ).rejects.toBeInstanceOf(MalformedRequest);
    await expect(
      plugin.person({
        authorization: `Bearer ${HANDLE}`,
        installationId: '33333333-3333-4333-8333-333333333333',
      })
    ).rejects.toBeInstanceOf(UnknownInstallation);
  });
});

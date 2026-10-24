import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  Code,
  amountText,
  compareAmounts,
  isRateLimited,
  isWalletInsufficient,
  KorsiClient,
  KorsiRefused,
  KorsiUnreachable,
  PLUGIN_API,
  ROUTES,
  Wallet,
} from '@korsi/plugin';

import { ANA, API_BASE, FakeKorsi, HANDLE, INSTALLATION, TOKEN } from './fake-korsi.js';

let korsi: FakeKorsi;
const client = (bearer = TOKEN) => new KorsiClient(API_BASE, bearer, { fetch: korsi.fetch });

beforeEach(() => {
  korsi = new FakeKorsi();
});

describe('the plugin plane', () => {
  it('says who a handle is, and which contract it speaks', async () => {
    const plane = client(HANDLE);
    const me = await plane.whoami();
    expect(plane.pluginApi).toBe('1.0');
    expect(me).toMatchObject({ installationId: INSTALLATION, userId: ANA, isPerson: true });
    expect((await client().whoami()).isPerson).toBe(false);
  });

  it('leaves out inactive colleagues unless asked', async () => {
    expect((await client().people()).map((person) => person.label)).toEqual(['Ana']);
    expect(await client().people({ includeInactive: true })).toHaveLength(2);
  });

  it("carries Korsi's problem when it refuses", async () => {
    const error = await client('nobody')
      .whoami()
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(KorsiRefused);
    expect(error).toMatchObject({ status: 401, code: Code.unauthenticated, requestId: 'req-1' });
  });

  it('says when to ask again once a budget is spent', async () => {
    const error = await client()
      .proposals()
      .catch((caught) => caught);
    expect(error).toMatchObject({ status: 429, code: Code.pluginRateLimited, retryAfter: 7 });
    expect(isRateLimited(error)).toBe(true);
    expect(isRateLimited(new Error('x'))).toBe(false);
  });

  it('calls a gateway page or a dead network unreachable, not refused', async () => {
    const down = new KorsiClient(API_BASE, TOKEN, {
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(down.wallet()).rejects.toBeInstanceOf(KorsiUnreachable);
    korsi.gatewayDown = true;
    await expect(client().wallet()).rejects.toBeInstanceOf(KorsiUnreachable);
    const moved = new KorsiClient(API_BASE, TOKEN, {
      fetch: async () => new Response(null, { status: 301, headers: { location: 'https://x/' } }),
    });
    await expect(moved.whoami()).rejects.toBeInstanceOf(KorsiUnreachable);
  });

  it('reads a missing record as null and sends ids quoted', async () => {
    const plane = client();
    expect(await plane.record('thread', 'a/b c')).toBeNull();
    const written = await plane.putRecord(
      'thread',
      'a/b c',
      { subject: 'x' },
      {
        ownerUserId: ANA,
        expectedVersion: 3,
      }
    );
    expect(written.external_id).toBe('a%2Fb%20c');
    expect(await plane.record('thread', 'a/b c')).not.toBeNull();
    await plane.deleteRecord('thread', 'a/b c');
    expect(await plane.record('thread', 'a/b c')).toBeNull();
    const put = korsi.calls.find((call) => call.method === 'PUT');
    expect(put?.body).toEqual({ data: { subject: 'x' }, owner_user_id: ANA, expected_version: 3 });
  });

  it('follows the cursor through every record, and the stream to its end', async () => {
    const plane = client();
    for (let n = 0; n < 5; n += 1) await plane.putRecord('thread', `t${n}`, { n });
    const seen: string[] = [];
    for await (const record of plane.iterRecords('thread', { pageSize: 2 })) {
      seen.push(record.external_id);
    }
    expect(seen).toEqual(['t0', 't1', 't2', 't3', 't4']);
    const sequences: number[] = [];
    for await (const event of plane.iterEvents({ after: 1, pageSize: 2 })) {
      sequences.push(event.sequence);
    }
    expect(sequences).toEqual([2, 3, 4, 5]);
  });

  it('sends exact quantities, and says an empty wallet by code', async () => {
    const hold = await client().consume('message.read', '1.5', {
      idempotencyKey: 'k',
      reference: 'r',
    });
    expect(hold.status).toBe('settled');
    expect(korsi.calls.at(-1)?.body.quantity).toBe('1.5');
    const error = await client()
      .consume('message.read', 1000, { idempotencyKey: 'k', reference: 'r' })
      .catch((caught) => caught);
    expect(error.status).toBe(402);
    expect(isWalletInsufficient(error)).toBe(true);
    expect(() => client().consume('x', 1e-7, { idempotencyKey: 'k', reference: 'r' })).toThrow(
      TypeError
    );
  });

  it('settles a reservation for what was used, and releases it when the service fails', async () => {
    const pages = await client().reserve(
      'pages.ocr',
      10,
      { idempotencyKey: 'k', reference: 'doc' },
      async (reservation) => {
        reservation.use(4);
        return ['p1', 'p2', 'p3', 'p4'];
      }
    );
    expect(pages).toHaveLength(4);
    const [settled] = [...korsi.holds.values()];
    expect(settled).toMatchObject({ status: 'settled', quantity: '4' });

    await expect(
      client().reserve('pages.ocr', 10, { idempotencyKey: 'k2', reference: 'doc' }, async () => {
        throw new Error('ocr failed');
      })
    ).rejects.toThrow('ocr failed');
    const released = [...korsi.holds.values()].at(-1);
    expect(released?.status).toBe('released');
  });

  it('reads the wallet exactly', async () => {
    const wallet = Wallet.of(await client().wallet());
    expect(wallet.available).toBe('10.0000');
    expect(wallet.hasPlan).toBe(true);
    expect(wallet.covers('9.99')).toBe(true);
    expect(wallet.covers('10')).toBe(true);
    expect(wallet.covers('10.0001')).toBe(false);
    expect(compareAmounts('0.1', '0.10')).toBe(0);
    expect(compareAmounts('-1.5', '1')).toBe(-1);
    expect(compareAmounts(2n, '1.999999')).toBe(1);
    // Korsi's Numeric(28,10), as pydantic writes it.
    expect(compareAmounts('0E-10', '0')).toBe(0);
    expect(compareAmounts('5.000E-7', '0.0000005')).toBe(0);
    expect(compareAmounts('1E+2', '100')).toBe(0);
    expect(new Wallet({ ...(await client().wallet()), available: '0E-10' }).covers('1')).toBe(
      false
    );
    expect(() => compareAmounts('-', '1')).toThrow(TypeError);
    expect(() => amountText(0.1 + 0.2)).toThrow(/decimal string/);
    expect(amountText(3)).toBe('3');
  });
});

describe("Korsi's contract", () => {
  it('has a method for every route of the plane, and nothing else', () => {
    const document = JSON.parse(
      readFileSync(new URL('../../../openapi/plugin-v1.json', import.meta.url), 'utf8')
    );
    const routes = Object.entries(document.paths).flatMap(([path, operations]) =>
      Object.keys(operations as object).map(
        (method) => `${method.toUpperCase()} ${path.replace('/plugin/v1', '')}`
      )
    );
    expect(Object.keys(ROUTES).sort()).toEqual(routes.sort());
    for (const name of Object.values(ROUTES)) {
      expect(typeof (KorsiClient.prototype as any)[name]).toBe('function');
    }
  });

  it('says the version of the document it was generated from', () => {
    const document = JSON.parse(
      readFileSync(new URL('../../../openapi/plugin-v1.json', import.meta.url), 'utf8')
    );
    expect(PLUGIN_API).toBe(document.info.version);
  });
});

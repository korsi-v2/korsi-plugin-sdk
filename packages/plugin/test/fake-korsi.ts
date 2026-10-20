/**
 * A Korsi plugin plane, faked as a `fetch`: it answers the way Korsi does, and records what it was
 * asked. Bearers are what Korsi would see: the installation's token, a person's handle, or something
 * it refuses with a problem document.
 */
export const INSTALLATION = '11111111-1111-4111-8111-111111111111';
export const OTHER_INSTALLATION = '22222222-2222-4222-8222-222222222222';
export const ANA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const BEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const TOKEN = 'machine-token';
export const HANDLE = 'kph_ana';
export const FOREIGN_HANDLE = 'kph_foreign';
export const SECRET = 'signing-secret';
export const API_BASE = 'https://korsi.test/plugin/v1';

export function problem(
  status: number,
  code: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {}
) {
  return new Response(
    JSON.stringify({ type: 'about:blank', title: code, status, code, params, request_id: 'req-1' }),
    { status, headers: { 'content-type': 'application/problem+json', ...headers } }
  );
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

type Call = { method: string; path: string; body: any };

export class FakeKorsi {
  tokenAnswer: (() => Response) | null = null;
  /** A gateway in front of Korsi, answering for it. */
  gatewayDown = false;
  calls: Call[] = [];
  records = new Map<string, any>();
  holds = new Map<string, any>();
  events = [1, 2, 3, 4, 5].map((n) => ({
    sequence: n,
    id: `00000000-0000-4000-8000-00000000000${n}`,
    topic: 'plugin.wallet.low',
    subject_id: null,
    data: {},
    occurred_at: '2026-10-20T10:00:00+00:00',
  }));

  count(method: string, path: string): number {
    return this.calls.filter((call) => call.method === method && call.path === path).length;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const bearer = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
    const path = url.pathname.replace(/^\/plugin\/v1/, '');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    this.calls.push({ method, path, body });
    if (this.gatewayDown) return new Response('<html>bad gateway</html>', { status: 502 });
    let who: Record<string, unknown>;
    if (bearer === TOKEN) {
      if (this.tokenAnswer) return this.tokenAnswer();
      who = { installation_id: INSTALLATION, authority: 'installation', user_id: null };
    } else if (bearer === HANDLE) {
      who = { installation_id: INSTALLATION, authority: 'delegated', user_id: ANA };
    } else if (bearer === FOREIGN_HANDLE) {
      who = { installation_id: OTHER_INSTALLATION, authority: 'delegated', user_id: BEN };
    } else {
      return problem(401, 'auth.unauthenticated');
    }

    if (path === '/installation') {
      return json(
        200,
        {
          plugin_id: 'ir.acme.sample',
          version: '1.2.0',
          state: 'active',
          tenant_ref: 't-1',
          scopes: ['records.own'],
          settings: { x: 1 },
          locale: 'fa',
          timezone: 'Asia/Tehran',
          ...who,
        },
        { 'korsi-plugin-api': '1.0' }
      );
    }
    if (path === '/people') {
      return json(200, {
        items: [
          { user_id: ANA, label: 'Ana', email: 'ana@acme.ir', status: 'active', avatar_url: null },
          { user_id: BEN, label: 'Ben', email: null, status: 'suspended', avatar_url: null },
        ],
      });
    }
    if (path.startsWith('/records/')) {
      const rest = url.pathname.split('/records/')[1] ?? '';
      const [typeKey, externalId] = rest.split('/');
      if (externalId === undefined) {
        const items = [...this.records.values()].sort((a, b) =>
          a.external_id.localeCompare(b.external_id)
        );
        const start = Number(url.searchParams.get('cursor') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const following = start + limit;
        return json(200, {
          items: items.slice(start, following),
          next_cursor: following < items.length ? String(following) : null,
        });
      }
      if (method === 'GET') {
        const found = this.records.get(externalId);
        return found ? json(200, found) : problem(404, 'plugin.record_not_found');
      }
      if (method === 'DELETE') {
        this.records.delete(externalId);
        return json(204, null);
      }
      const record = { external_id: externalId, type_key: typeKey, version: 1, ...body };
      this.records.set(externalId, record);
      return json(201, record);
    }
    if (path === '/wallet') {
      return json(200, {
        installation_id: INSTALLATION,
        plan_key: 'pro',
        plan_period: 'monthly',
        period_ends_at: '2026-11-01T00:00:00+00:00',
        balance: '10.5000',
        reserved: '0.5',
        available: '10.0000',
        consumed_this_period: '2',
        credited_this_period: '12.5',
      });
    }
    if (path === '/wallet/consume' || path === '/wallet/holds') {
      if (Number(body.quantity) > 100) return problem(402, 'plugin.wallet_insufficient');
      const hold = {
        id: crypto.randomUUID(),
        service: body.service,
        quantity: body.quantity,
        amount_mu: String(Number(body.quantity) / 2),
        status: path.endsWith('consume') ? 'settled' : 'open',
        expires_at: '2026-10-20T11:00:00+00:00',
        reference: body.reference ?? null,
      };
      this.holds.set(hold.id, hold);
      return json(path.endsWith('holds') ? 201 : 200, hold);
    }
    if (path.startsWith('/wallet/holds/')) {
      const [holdId, action] = path.replace('/wallet/holds/', '').split('/');
      const hold = this.holds.get(holdId!);
      hold.status = action === 'settle' ? 'settled' : 'released';
      if (action === 'settle' && body?.quantity !== undefined) hold.quantity = body.quantity;
      return json(200, hold);
    }
    if (path === '/proposals' && method === 'GET') {
      return problem(429, 'plugin.rate_limited', {}, { 'retry-after': '7' });
    }
    if (path === '/events') {
      const after = Number(url.searchParams.get('after') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const page = this.events.filter((event) => event.sequence > after).slice(0, limit);
      return json(200, { items: page, next_after: page.at(-1)?.sequence ?? after });
    }
    return problem(404, 'resource.not_found');
  };
}

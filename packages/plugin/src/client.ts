/**
 * The plugin plane (`{apiBase}` = `https://<korsi>/plugin/v1`), as one bearer.
 *
 * The bearer is the installation's own token when the plugin acts for itself, or a person's sealed
 * handle when it acts for them -- in which case Korsi narrows everything to what that person may
 * see and do. Every route of the plane is here (`ROUTES`); the shapes are generated from Korsi's
 * OpenAPI document (`./models.ts`).
 */
import { KorsiRefused, KorsiUnreachable, type ProblemFieldError } from './errors.js';
import type {
  Authority,
  Colleague,
  HoldView,
  InstallationState,
  IntakeResult,
  IntakeSource,
  PeoplePage,
  PluginEventPage,
  PluginEventView,
  PluginSelf,
  ProposalPage,
  ProposalView,
  RecordPage,
  RecordView,
  SubmitProposal,
  WalletView,
} from './models.js';
import { amountText, type Quantity } from './wallet.js';

/** Korsi answers a person's page in well under this; a plugin that waits longer looks broken. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** The plane's version, sent by Korsi on every response. */
export const VERSION_HEADER = 'Korsi-Plugin-API';
/** The plugin API this SDK was generated for. */
export const PLUGIN_API = '1.0';

/** Every route of the plane, and the method that calls it. A test holds it to Korsi's document. */
export const ROUTES = Object.freeze({
  'GET /installation': 'whoami',
  'GET /people': 'people',
  'GET /records/{type_key}': 'records',
  'GET /records/{type_key}/{external_id}': 'record',
  'PUT /records/{type_key}/{external_id}': 'putRecord',
  'DELETE /records/{type_key}/{external_id}': 'deleteRecord',
  'POST /proposals': 'propose',
  'GET /proposals': 'proposals',
  'GET /proposals/{proposal_id}': 'proposal',
  'POST /sources': 'bringIn',
  'GET /wallet': 'wallet',
  'POST /wallet/holds': 'openHold',
  'POST /wallet/holds/{hold_id}/settle': 'settleHold',
  'POST /wallet/holds/{hold_id}/release': 'releaseHold',
  'POST /wallet/consume': 'consume',
  'GET /events': 'events',
} as const);

/** Korsi's codes for a status, when something in front of Korsi answered without a problem. */
const STATUS_CODES: Record<number, string> = {
  400: 'request.invalid',
  401: 'auth.unauthenticated',
  403: 'auth.forbidden',
  404: 'resource.not_found',
  409: 'resource.conflict',
  422: 'request.invalid',
  429: 'request.rate_limited',
};

/** Who Korsi says a bearer is (`GET /installation`). */
export interface Caller {
  installationId: string;
  pluginId: string;
  version: string;
  state: InstallationState;
  /** A stable label for the organization, the same for this plugin every time; never its name. */
  tenantRef: string;
  /** `installation` -- the plugin itself -- or `delegated`: a person, through their handle. */
  authority: Authority;
  userId: string | null;
  scopes: string[];
  settings: Record<string, unknown>;
  locale: string;
  timezone: string;
  /** Whether the bearer is a person's handle rather than the installation's own token. */
  isPerson: boolean;
}

export function callerOf(view: PluginSelf): Caller {
  const userId = view.user_id ?? null;
  return {
    installationId: view.installation_id,
    pluginId: view.plugin_id,
    version: view.version,
    state: view.state,
    tenantRef: view.tenant_ref,
    authority: view.authority,
    userId,
    scopes: [...(view.scopes ?? [])],
    settings: view.settings ?? {},
    locale: view.locale || 'fa',
    timezone: view.timezone || 'Asia/Tehran',
    isPerson: view.authority === 'delegated' && userId !== null,
  };
}

export interface KorsiClientOptions {
  /** Per request, in milliseconds. */
  timeout?: number;
  /** A `fetch` to call Korsi with: a proxy-aware one, or a fake in tests. */
  fetch?: typeof fetch;
}

/** What `reserve` hands the service it wraps. */
export interface Reservation {
  /** The hold as Korsi opened it. */
  readonly hold: HoldView;
  /** Settle for `quantity` rather than everything reserved: the service used less. */
  use(quantity: Quantity): void;
}

const id = (value: string): string => encodeURIComponent(value);

/** The plugin plane, as one bearer. Cheap to make: one per bearer, per request if need be. */
export class KorsiClient {
  readonly apiBase: string;
  /** The plane's version Korsi last reported (`Korsi-Plugin-API`), once anything was asked. */
  pluginApi: string | null = null;
  readonly #bearer: string;
  readonly #timeout: number;
  readonly #fetch: typeof fetch;

  constructor(apiBase: string, bearer: string, options: KorsiClientOptions = {}) {
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.#bearer = bearer;
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async #call<T>(
    method: string,
    path: string,
    { json, params }: { json?: unknown; params?: Record<string, unknown> } = {}
  ): Promise<T> {
    const url = new URL(this.apiBase + path);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { authorization: `Bearer ${this.#bearer}` };
    if (json !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch (error) {
      throw new KorsiUnreachable(`${method} ${path}: ${(error as Error).name}`, { cause: error });
    }
    this.pluginApi = response.headers.get(VERSION_HEADER) ?? this.pluginApi;
    if (response.status >= 400) throw await refusal(response);
    const text = await response.text();
    return (response.status === 204 || !text ? null : JSON.parse(text)) as T;
  }

  // -- who ----------------------------------------------------------------------------------------

  /** Who this bearer is, and what it may do. The way to check a credential or a handle. */
  async whoami(): Promise<Caller> {
    return callerOf(await this.#call<PluginSelf>('GET', '/installation'));
  }

  /** Colleagues a proposal may be addressed to. Only active ones unless asked otherwise. */
  async people({ includeInactive = false }: { includeInactive?: boolean } = {}): Promise<
    Colleague[]
  > {
    const page = await this.#call<PeoplePage>('GET', '/people');
    return page.items.filter((person) => includeInactive || person.status === 'active');
  }

  // -- the plugin's own records -------------------------------------------------------------------

  /** One page of this plugin's records of a type; `next_cursor` reads the next. */
  records(
    typeKey: string,
    { caseId, cursor, limit = 50 }: { caseId?: string; cursor?: string | null; limit?: number } = {}
  ): Promise<RecordPage> {
    return this.#call('GET', `/records/${id(typeKey)}`, {
      params: { case_id: caseId, cursor, limit },
    });
  }

  /** Every record of a type, page by page. */
  async *iterRecords(
    typeKey: string,
    { caseId, pageSize = 200 }: { caseId?: string; pageSize?: number } = {}
  ): AsyncGenerator<RecordView> {
    let cursor: string | null = null;
    do {
      const page: RecordPage = await this.records(typeKey, { caseId, cursor, limit: pageSize });
      yield* page.items;
      cursor = page.next_cursor ?? null;
    } while (cursor);
  }

  /** One of this plugin's records, or `null` when there is none by that id. */
  async record(typeKey: string, externalId: string): Promise<RecordView | null> {
    try {
      return await this.#call<RecordView>('GET', `/records/${id(typeKey)}/${id(externalId)}`);
    } catch (error) {
      if (error instanceof KorsiRefused && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Create or replace one of this plugin's records, keyed by the plugin's own id for it.
   * `expectedVersion` makes the write conditional: Korsi refuses it with
   * `plugin.record_version_conflict` if somebody wrote the record since.
   */
  putRecord(
    typeKey: string,
    externalId: string,
    data: Record<string, unknown>,
    {
      caseId,
      ownerUserId,
      expectedVersion,
    }: { caseId?: string; ownerUserId?: string; expectedVersion?: number } = {}
  ): Promise<RecordView> {
    const body: Record<string, unknown> = { data };
    if (caseId !== undefined) body.case_id = caseId;
    if (ownerUserId !== undefined) body.owner_user_id = ownerUserId;
    if (expectedVersion !== undefined) body.expected_version = expectedVersion;
    return this.#call('PUT', `/records/${id(typeKey)}/${id(externalId)}`, { json: body });
  }

  async deleteRecord(typeKey: string, externalId: string): Promise<void> {
    await this.#call('DELETE', `/records/${id(typeKey)}/${id(externalId)}`);
  }

  // -- into Korsi's own records: proposals and sources --------------------------------------------

  /**
   * Propose a change to one of Korsi's records. A person -- or the organization's rule for a
   * low-risk type -- applies it; the verdict comes back as `plugin.proposal.settled`.
   */
  propose(proposal: SubmitProposal): Promise<ProposalView> {
    return this.#call('POST', '/proposals', { json: proposal });
  }

  async proposals(): Promise<ProposalView[]> {
    return (await this.#call<ProposalPage>('GET', '/proposals')).items;
  }

  proposal(proposalId: string): Promise<ProposalView> {
    return this.#call('GET', `/proposals/${id(proposalId)}`);
  }

  /**
   * Bring a message or a document in. It waits for a person's review; the same `external_id`
   * twice is the same source (`created` is false the second time).
   */
  bringIn(source: IntakeSource): Promise<IntakeResult> {
    return this.#call('POST', '/sources', { json: source });
  }

  // -- the wallet ---------------------------------------------------------------------------------

  /** This installation's wallet. `Wallet.of` reads its amounts exactly. */
  wallet(): Promise<WalletView> {
    return this.#call('GET', '/wallet');
  }

  /** Reserve MU before a service, at the active plan's rate. Prefer `reserve`. */
  openHold(
    service: string,
    quantity: Quantity,
    { idempotencyKey }: { idempotencyKey: string }
  ): Promise<HoldView> {
    return this.#call('POST', '/wallet/holds', {
      json: { service, quantity: amountText(quantity), idempotency_key: idempotencyKey },
    });
  }

  /** Spend a reservation: all of it, or `quantity` of what was reserved. */
  settleHold(
    holdId: string,
    { reference, quantity }: { reference: string; quantity?: Quantity }
  ): Promise<HoldView> {
    const body: Record<string, unknown> = { reference };
    if (quantity !== undefined) body.quantity = amountText(quantity);
    return this.#call('POST', `/wallet/holds/${id(holdId)}/settle`, { json: body });
  }

  /** Give a reservation back: the service was not done. */
  releaseHold(holdId: string): Promise<HoldView> {
    return this.#call('POST', `/wallet/holds/${id(holdId)}/release`);
  }

  /**
   * Reserve and spend in one call, for a service that is done the moment it is asked for. Korsi
   * prices `service` from the active plan's rate; the same `idempotencyKey` twice is charged once.
   * Throws `KorsiRefused` with `plugin.wallet_insufficient` (402) when the wallet cannot cover it.
   */
  consume(
    service: string,
    quantity: Quantity,
    { idempotencyKey, reference }: { idempotencyKey: string; reference: string }
  ): Promise<HoldView> {
    return this.#call('POST', '/wallet/consume', {
      json: {
        service,
        quantity: amountText(quantity),
        idempotency_key: idempotencyKey,
        reference,
      },
    });
  }

  /**
   * Reserve before a service and settle after it. `service` runs between the two: if it returns,
   * the hold is settled -- for what `use()` said was used, or all of it; if it throws, the hold is
   * released and the error goes on, so a service that failed costs nothing.
   *
   *     const pages = await korsi.reserve('pages.ocr', 10, { idempotencyKey, reference },
   *       async (hold) => { const pages = await ocr(doc); hold.use(pages.length); return pages; });
   */
  async reserve<T>(
    service: string,
    quantity: Quantity,
    { idempotencyKey, reference }: { idempotencyKey: string; reference: string },
    work: (reservation: Reservation) => Promise<T>
  ): Promise<T> {
    const hold = await this.openHold(service, quantity, { idempotencyKey });
    let used: Quantity | undefined;
    let result: T;
    try {
      result = await work({
        hold,
        use: (value) => {
          used = value;
        },
      });
    } catch (error) {
      // The service's own failure is the error worth throwing; an unreleased hold expires.
      await this.releaseHold(hold.id).catch(() => undefined);
      throw error;
    }
    await this.settleHold(hold.id, { reference, quantity: used });
    return result;
  }

  // -- events, by polling -------------------------------------------------------------------------

  /** This installation's events after a sequence number; `next_after` reads on. */
  events({
    after = 0,
    limit = 100,
  }: { after?: number; limit?: number } = {}): Promise<PluginEventPage> {
    return this.#call('GET', '/events', { params: { after, limit } });
  }

  /**
   * Every event after `after`, until the stream is read to its end. For a plugin Korsi cannot
   * reach: remember the last `sequence` handled and start from it next time.
   */
  async *iterEvents({
    after = 0,
    pageSize = 100,
  }: { after?: number; pageSize?: number } = {}): AsyncGenerator<PluginEventView> {
    let cursor = after;
    for (;;) {
      const page = await this.events({ after: cursor, limit: pageSize });
      yield* page.items;
      if (!page.items.length || page.next_after <= cursor) return;
      cursor = page.next_after;
    }
  }
}

function retryAfter(response: Response): number | null {
  const seconds = Number(response.headers.get('retry-after') ?? NaN);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) : null;
}

async function refusal(response: Response): Promise<KorsiRefused | KorsiUnreachable> {
  const status = response.status;
  const text = await response.text().catch(() => '');
  if ((response.headers.get('content-type') ?? '').startsWith('application/problem+json')) {
    try {
      const problem = JSON.parse(text) as Record<string, unknown>;
      return new KorsiRefused(
        status,
        String(problem.code ?? STATUS_CODES[status] ?? `http.${status}`),
        (problem.title as string | undefined) ?? (problem.detail as string | undefined) ?? null,
        {
          params: (problem.params as Record<string, unknown> | undefined) ?? {},
          requestId: (problem.request_id as string | undefined) ?? null,
          errors: (problem.errors as ProblemFieldError[] | undefined) ?? [],
          retryAfter: retryAfter(response),
        }
      );
    } catch {
      // Not JSON after all: fall through to the status.
    }
  }
  if (status >= 500) {
    // Not Korsi's problem document: a proxy or a gateway in front of it. Nothing was refused.
    return new KorsiUnreachable(`HTTP ${status} without a problem document`);
  }
  return new KorsiRefused(status, STATUS_CODES[status] ?? `http.${status}`, text.slice(0, 300), {
    retryAfter: retryAfter(response),
  });
}

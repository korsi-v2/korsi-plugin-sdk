/**
 * The plugin plane (`{apiBase}` = `https://<korsi>/plugin/v1`), as one bearer.
 *
 * The bearer is the installation's own token when the plugin acts for itself, or a person's sealed
 * handle when it acts for them -- in which case Korsi narrows everything to what that person may
 * see and do. Every route of the plane is here (`ROUTES`); the shapes are generated from Korsi's
 * OpenAPI document (`./models.ts`).
 *
 * Korsi is reached through the egress proxy the environment names, if any (`./proxy.ts`): a plugin
 * Korsi runs has no other way out of its container.
 */
import {
  Code,
  isTextPending,
  KorsiRefused,
  KorsiUnreachable,
  textPendingSeconds,
  type ProblemFieldError,
} from './errors.js';
import type {
  Authority,
  Colleague,
  FindFreeSlots,
  FreeSlotPage,
  HoldView,
  HostMeeting,
  InstallationState,
  IntakeResult,
  IntakeSource,
  LiveTranscript,
  MeetingDetail,
  ModelCompletion,
  PeoplePage,
  PluginEventPage,
  PluginEventView,
  PluginFile,
  PluginFileText,
  PluginModel,
  PluginModelPage,
  PluginSelf,
  ProposalPage,
  ProposalView,
  QueryRecords,
  RecordPage,
  RecordView,
  RequestCompletion,
  SubmitProposal,
  WalletView,
} from './models.js';
import { PlaneOperations, type CallOptions } from './operations.js';
import { korsiFetch } from './proxy.js';
import { amountText, type Quantity } from './wallet.js';

export { ROUTES } from './operations.js';

/** Korsi answers a person's page in well under this; a plugin that waits longer looks broken. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * How long a model completion may take: more than Korsi gives the model (180 seconds), so the
 * answer -- or Korsi's own refusal -- arrives rather than this SDK giving up first.
 */
export const MODEL_TIMEOUT_MS = 210_000;
/** How long a file's bytes may take to arrive, the whole transfer. */
export const CONTENT_TIMEOUT_MS = 120_000;
/** How long `fileText(id, { wait: true })` waits for a scan to be read, by default. */
export const TEXT_WAIT_MS = 600_000;
/** The plane's version, sent by Korsi on every response. */
export const VERSION_HEADER = 'Korsi-Plugin-API';
/** The plugin API this SDK was generated for. */
export const PLUGIN_API = '1.2';

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
  /**
   * The plugin's own permissions (ADR-0082) the person holds in this installation, by their bare
   * keys (`see_compensation`); empty for the installation itself. Korsi enforces them where it shows
   * the plugin's things; inside the plugin's own routes the plugin does, by this list. A page's
   * caller is reused for `handleCacheSeconds` (60 by default), so a revoke reaches the plugin that
   * much later; set it lower where that matters.
   */
  permissions: string[];
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
    permissions: [...(view.permissions ?? [])],
    settings: view.settings ?? {},
    locale: view.locale || 'fa',
    timezone: view.timezone || 'Asia/Tehran',
    isPerson: view.authority === 'delegated' && userId !== null,
  };
}

export interface KorsiClientOptions {
  /** Per request, in milliseconds. */
  timeout?: number;
  /**
   * A `fetch` to call Korsi with: a fake in tests. By default the environment's proxy, if it
   * names one, else Node's own (`korsiFetch`).
   */
  fetch?: typeof fetch;
}

/** What `call` carries, and how long it may take. */
interface SendOptions extends CallOptions {
  timeout?: number;
}

/** How a model completion is asked. */
export interface CompleteOptions {
  /** In milliseconds; `MODEL_TIMEOUT_MS` by default. */
  timeout?: number;
  /**
   * How many times to ask again, with the same `idempotency_key`, when Korsi did not answer or
   * said to try again (`503 service.unavailable`, `502 provider.unreachable`). Korsi answers a key
   * it has answered with that answer, and a retry that arrives while the first attempt is still
   * running waits for it, so asking again is never a second completion. 2 by default; 0 never.
   */
  retries?: number;
}

/** Waiting for a scan's text. */
export interface FileTextOptions {
  /**
   * Wait while Korsi reads a scan (`409 plugin.text_pending`), asking again when it says, rather
   * than throwing at once. Each ask is a read; once read, the text costs nothing more.
   */
  wait?: boolean;
  /** How long to wait in all, in milliseconds; `TEXT_WAIT_MS` by default. */
  waitMs?: number;
  /** Stop waiting. */
  signal?: AbortSignal;
}

/** What `reserve` hands the service it wraps. */
export interface Reservation {
  /** The hold as Korsi opened it. */
  readonly hold: HoldView;
  /** Settle for `quantity` rather than everything reserved: the service used less. */
  use(quantity: Quantity): void;
}

const id = (value: string): string => encodeURIComponent(value);

/** Backoff before each repeat of a model completion, in milliseconds. */
const COMPLETE_BACKOFF_MS = [1_000, 4_000, 10_000];

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', stop, { once: true });
  });

/** Whether a completion that failed this way is worth asking again with the same key. */
function completionRetryable(error: unknown): boolean {
  if (error instanceof KorsiUnreachable) return true;
  return (
    error instanceof KorsiRefused &&
    error.problem &&
    (error.code === Code.serviceUnavailable || error.code === Code.providerUnreachable)
  );
}

/** A query value as Korsi reads it: ISO times, `true`, lists repeated. */
function queryValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(queryValues);
  if (value instanceof Date) return [value.toISOString()];
  return [String(value)];
}

/**
 * The plugin plane, as one bearer. Cheap to make: one per bearer, per request if need be.
 *
 * The routes Korsi added after the first ones are generated (`./operations.ts`): each is a method
 * named after the function Korsi serves it with, and `ROUTES` names the method of every route.
 */
export class KorsiClient extends PlaneOperations {
  readonly apiBase: string;
  /** The plane's version Korsi last reported (`Korsi-Plugin-API`), once anything was asked. */
  pluginApi: string | null = null;
  readonly #bearer: string;
  readonly #timeout: number;
  readonly #fetch: typeof fetch;

  constructor(apiBase: string, bearer: string, options: KorsiClientOptions = {}) {
    super();
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.#bearer = bearer;
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? korsiFetch();
  }

  protected call<T>(method: string, path: string, options: CallOptions = {}): Promise<T> {
    return this.#request<T>(method, path, options);
  }

  async #request<T>(method: string, path: string, options: SendOptions): Promise<T> {
    const response = await this.#send(method, path, options);
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new KorsiUnreachable(`${method} ${path}: ${(error as Error).name}`, { cause: error });
    }
    return (response.status === 204 || !text ? null : JSON.parse(text)) as T;
  }

  /** Korsi's answer, once it is not a refusal; its body not read yet. */
  async #send(
    method: string,
    path: string,
    { json, params, timeout }: SendOptions = {}
  ): Promise<Response> {
    const url = new URL(this.apiBase + path);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null) continue;
      for (const item of queryValues(value)) url.searchParams.append(key, item);
    }
    const headers: Record<string, string> = { authorization: `Bearer ${this.#bearer}` };
    if (json !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: AbortSignal.timeout(timeout ?? this.#timeout),
        // The plane does not redirect. Following one would carry the bearer to another host, or
        // arrive without it and read as a refusal; neither is Korsi's answer.
        redirect: 'manual',
      });
    } catch (error) {
      throw new KorsiUnreachable(`${method} ${path}: ${(error as Error).name}`, { cause: error });
    }
    this.pluginApi = response.headers.get(VERSION_HEADER) ?? this.pluginApi;
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      // Unread, the body would hold its connection open until it is collected.
      await response.body?.cancel().catch(() => undefined);
      throw new KorsiUnreachable(
        `${method} ${path}: redirected (${response.status}), not followed`
      );
    }
    if (response.status >= 400) throw await refusal(response);
    return response;
  }

  // -- who ----------------------------------------------------------------------------------------

  /** Who this bearer is, and what it may do. The way to check a credential or a handle. */
  async whoami(): Promise<Caller> {
    return callerOf(await this.call<PluginSelf>('GET', '/installation'));
  }

  /** Colleagues a proposal may be addressed to. Only active ones unless asked otherwise. */
  async people({ includeInactive = false }: { includeInactive?: boolean } = {}): Promise<
    Colleague[]
  > {
    const page = await this.call<PeoplePage>('GET', '/people');
    return page.items.filter((person) => includeInactive || person.status === 'active');
  }

  // -- the plugin's own records -------------------------------------------------------------------

  /**
   * One page of this plugin's records of a type, newest first; `next_cursor` reads the next.
   * `query` keeps those with these words in their title.
   */
  records(
    typeKey: string,
    {
      caseId,
      query,
      cursor,
      limit = 50,
    }: { caseId?: string; query?: string; cursor?: string | null; limit?: number } = {}
  ): Promise<RecordPage> {
    return this.call('GET', `/records/${id(typeKey)}`, {
      params: { case_id: caseId, query, cursor, limit },
    });
  }

  /** Every record of a type, page by page. */
  async *iterRecords(
    typeKey: string,
    { caseId, query, pageSize = 200 }: { caseId?: string; query?: string; pageSize?: number } = {}
  ): AsyncGenerator<RecordView> {
    let cursor: string | null = null;
    do {
      const page: RecordPage = await this.records(typeKey, {
        caseId,
        query,
        cursor,
        limit: pageSize,
      });
      yield* page.items;
      cursor = page.next_cursor ?? null;
    } while (cursor);
  }

  /**
   * This plugin's records of a type, by the fields the type declares (ADR-0085): up to five
   * conditions, all of which must hold --
   *
   *     await korsi.queryRecords('application', {
   *       where: [{ field: 'stage', op: 'in', value: ['screening', 'interview'] },
   *               { field: 'fit', op: 'gte', value: 70 }],
   *       order_by: { field: 'received_at', dir: 'desc' },
   *     });
   *
   * Operators `eq`, `in`, `gt`, `gte`, `lt`, `lte`, `prefix`, `exists`. Read through the same
   * visibility as `records()`: on a person's behalf, only what that person may see. A field the
   * type does not declare is `422 plugin.record_field_unknown`. Pass `next_cursor` back as `cursor`,
   * with the same order.
   */
  queryRecords(typeKey: string, query: QueryRecords = {}): Promise<RecordPage> {
    return this.call('POST', `/records/${id(typeKey)}/query`, { json: query });
  }

  /** Every record a query finds, page by page. */
  async *iterQueryRecords(
    typeKey: string,
    {
      pageSize = 200,
      ...query
    }: Omit<QueryRecords, 'cursor' | 'limit'> & { pageSize?: number } = {}
  ): AsyncGenerator<RecordView> {
    let cursor: string | null = null;
    do {
      const page: RecordPage = await this.queryRecords(typeKey, {
        ...query,
        cursor,
        limit: pageSize,
      });
      yield* page.items;
      cursor = page.next_cursor ?? null;
    } while (cursor);
  }

  /** One of this plugin's records, or `null` when there is none by that id. */
  async record(typeKey: string, externalId: string): Promise<RecordView | null> {
    try {
      return await this.call<RecordView>('GET', `/records/${id(typeKey)}/${id(externalId)}`);
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
    return this.call('PUT', `/records/${id(typeKey)}/${id(externalId)}`, { json: body });
  }

  async deleteRecord(typeKey: string, externalId: string): Promise<void> {
    await this.call('DELETE', `/records/${id(typeKey)}/${id(externalId)}`);
  }

  // -- into Korsi's own records: proposals and sources --------------------------------------------

  /**
   * Propose a change to one of Korsi's records. A person -- or the organization's rule for a
   * low-risk type -- applies it; the verdict comes back as `plugin.proposal.settled`.
   */
  propose(proposal: SubmitProposal): Promise<ProposalView> {
    return this.call('POST', '/proposals', { json: proposal });
  }

  async proposals(): Promise<ProposalView[]> {
    return (await this.call<ProposalPage>('GET', '/proposals')).items;
  }

  proposal(proposalId: string): Promise<ProposalView> {
    return this.call('GET', `/proposals/${id(proposalId)}`);
  }

  /**
   * Bring a message or a document in. It waits for a person's review; the same `external_id`
   * twice is the same source (`created` is false the second time).
   */
  bringIn(source: IntakeSource): Promise<IntakeResult> {
    return this.call('POST', '/sources', { json: source });
  }

  // -- the wallet ---------------------------------------------------------------------------------

  /** This installation's wallet. `Wallet.of` reads its amounts exactly. */
  wallet(): Promise<WalletView> {
    return this.call('GET', '/wallet');
  }

  /** Reserve MU before a service, at the active plan's rate. Prefer `reserve`. */
  openHold(
    service: string,
    quantity: Quantity,
    { idempotencyKey }: { idempotencyKey: string }
  ): Promise<HoldView> {
    return this.call('POST', '/wallet/holds', {
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
    return this.call('POST', `/wallet/holds/${id(holdId)}/settle`, { json: body });
  }

  /** Give a reservation back: the service was not done. */
  releaseHold(holdId: string): Promise<HoldView> {
    return this.call('POST', `/wallet/holds/${id(holdId)}/release`);
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
    return this.call('POST', '/wallet/consume', {
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

  // -- files a person handed the plugin -------------------------------------------------------------

  /**
   * A file a person handed this installation in Korsi's own picker (the Bridge's `pickFile`,
   * `files.read`). Any other is `404 plugin.file_not_granted`. Read on their behalf or, for work
   * done later, as the installation itself.
   */
  file(fileId: string): Promise<PluginFile> {
    return this.call('GET', `/files/${id(fileId)}`);
  }

  /**
   * The file's bytes as the person gave them, streamed: read `response.body`, or
   * `await response.arrayBuffer()`. `timeout` (`CONTENT_TIMEOUT_MS`) covers the whole transfer.
   * `file()`'s `media_type` is what Korsi read them as: for showing, never for trusting.
   */
  fileContent(
    fileId: string,
    { timeout = CONTENT_TIMEOUT_MS }: { timeout?: number } = {}
  ): Promise<Response> {
    return this.#send('GET', `/files/${id(fileId)}/content`, { timeout });
  }

  /**
   * The text Korsi read out of the file: plain text, Word, Excel, OpenDocument, PowerPoint and a
   * PDF's own text layer (`extraction: local`), at no cost.
   *
   * A scan is read by OCR, a paid service only with `models.use`, billed to the publisher once:
   * the first ask queues it and is refused `409 plugin.text_pending` (`isTextPending`, with
   * `textPendingSeconds`); once read, every ask answers its text (`extraction: ocr`). With
   * `{ wait: true }` this asks again when Korsi says, until the text is there or `waitMs` ran out
   * -- then it throws the last refusal. Without `models.use`, or for a file Korsi does not read,
   * it is `409 plugin.text_unavailable` with `params.reason`: `scan`, `ocr_unavailable`, `archive`,
   * `kind`, `too_large` or `unreadable`. `402 plugin.publisher_funds` while the publisher's paid
   * services are paused.
   */
  async fileText(
    fileId: string,
    { wait = false, waitMs = TEXT_WAIT_MS, signal }: FileTextOptions = {}
  ): Promise<PluginFileText> {
    const until = Date.now() + waitMs;
    for (;;) {
      try {
        return await this.call<PluginFileText>('GET', `/files/${id(fileId)}/text`);
      } catch (error) {
        if (!wait || !isTextPending(error)) throw error;
        const pause = textPendingSeconds(error) * 1000;
        if (Date.now() + pause > until) throw error;
        await sleep(pause, signal);
      }
    }
  }

  // -- Korsi's language models (models.use, a trusted scope) ------------------------------------

  /** The models Korsi lends this plugin, with their price per million tokens in dollars. */
  async models(): Promise<PluginModel[]> {
    return (await this.call<PluginModelPage>('GET', '/models')).items;
  }

  /**
   * One answer from one of Korsi's models, at the publisher's cost (ADR-0081): Korsi calls the
   * model for the plugin, so the plugin brings no key and the organization's data goes nowhere
   * Korsi's own does not. `usd_cost` is what Korsi charged the publisher, as an exact decimal
   * string; `finish_reason` `length` is an answer cut at `max_tokens`.
   *
   *     const answer = await korsi.complete({
   *       model, // one of models()
   *       max_tokens: 800,
   *       purpose: 'cv_extract', // shown in the publisher's ledger
   *       idempotency_key: `cv:${fileId}:v1`,
   *       messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: text }],
   *       response_format: { type: 'json_object' },
   *     });
   *
   * The same `idempotency_key` is answered with the first answer for an hour, at no cost, and this
   * asks again with it when Korsi did not answer (`retries`). Refusals to branch on:
   * `402 plugin.publisher_funds` (`isPublisherFunds`: the publisher's paid services are paused),
   * `422 plugin.model_not_allowed`, `429 plugin.rate_limited` (the `models` budget; `retryAfter`),
   * and `422 request.invalid` for a key used for another request.
   */
  async complete(
    request: RequestCompletion,
    { timeout = MODEL_TIMEOUT_MS, retries = 2 }: CompleteOptions = {}
  ): Promise<ModelCompletion> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#request<ModelCompletion>('POST', '/models/complete', {
          json: request,
          timeout,
        });
      } catch (error) {
        if (attempt >= retries || !completionRetryable(error)) throw error;
        await sleep(COMPLETE_BACKOFF_MS[Math.min(attempt, COMPLETE_BACKOFF_MS.length - 1)]!);
      }
    }
  }

  // -- the calendar and meetings ----------------------------------------------------------------

  /**
   * When every one of these people -- active members, at most 20 -- is free for
   * `duration_minutes`, from day `from` to day `to` (`2026-11-02`, at most 31 days), inside the
   * organization's working hours unless `within_hours` is false (ADR-0085). Times only, never
   * what fills anybody's time; nothing is booked. On a person's behalf only, under `calendar.read`.
   */
  freeSlots(search: FindFreeSlots): Promise<FreeSlotPage> {
    return this.call('POST', '/calendar/free-slots', { json: search });
  }

  /**
   * Host a meeting for the person in front of the plugin (`meetings.host`, a trusted scope;
   * ADR-0083): they create it, and must be able to open `case_id`. The same `external_id` answers
   * the meeting already made. Its attendees are `participant_user_ids` (members, the person in front
   * of the plugin too when named) and `guests`, people with no account by `{ name }` alone (at most
   * 10, 50 people in all): a guest's name grants nothing. A `restricted` meeting is seen only by its
   * participants, the people in its case and this installation, and never enters the
   * organization's memory. With `recording.consent: 'required'` (the default) Korsi asks for
   * consent before it records.
   * The room is Korsi's own: the Bridge's `showInKorsi({ kind: 'meeting', id })` opens the meeting's
   * page, where the person enters it.
   */
  hostMeeting(meeting: HostMeeting): Promise<MeetingDetail> {
    return this.call('POST', '/meetings', { json: meeting });
  }

  /**
   * What is being said in a meeting this installation hosts (`meetings.live.read`, a trusted
   * scope): a preview, not the record -- the transcript read from the recording is, announced by
   * `meeting.transcript_ready`. Poll it, passing `covered_through` back as `since` for what came
   * after. `speaker_key` stays the same for one voice, so earlier lines can take a name it is
   * given later. Any other meeting is `404 plugin.meeting_not_hosted`.
   */
  liveTranscript(
    meetingId: string,
    { since }: { since?: string | Date | null } = {}
  ): Promise<LiveTranscript> {
    return this.call('GET', `/meetings/${id(meetingId)}/live/transcript`, { params: { since } });
  }

  // -- events, by polling -------------------------------------------------------------------------

  /** This installation's events after a sequence number; `next_after` reads on. */
  events({
    after = 0,
    limit = 100,
  }: { after?: number; limit?: number } = {}): Promise<PluginEventPage> {
    return this.call('GET', '/events', { params: { after, limit } });
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
    problem: false,
  });
}

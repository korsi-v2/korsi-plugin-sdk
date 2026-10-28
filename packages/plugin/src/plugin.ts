/**
 * The server side of a plugin, in one object: `KorsiPlugin`.
 *
 * It does, the same way for every plugin, what each one would otherwise write again -- and get
 * subtly wrong:
 *
 * - **the lifecycle** (`lifecycle`): `installed` is verified, the credential is confirmed with
 *   Korsi (`GET /installation`) before it is kept, and an installation's Korsi cannot be changed
 *   by a later message; `removed`, unsigned by design, is believed only once Korsi refuses the
 *   stored credential;
 * - **events** (`event`): verified with the installation's secret, deduplicated, and given back to
 *   the log when the handler fails, so Korsi's retry runs it again;
 * - **tool calls** (`toolCall`): verified, parsed, with the person's handle;
 * - **action calls** (`registerAction`, `actionCall`): a change a person confirmed on a card the
 *   plugin's specialist prepared (ADR-0080) -- verified, run once per change, its answer kept to
 *   Korsi's limits;
 * - **connection calls** (`connectionCall`): verified, parsed, each answered once;
 * - **a page's caller** (`person`): the handle a page sends is checked with Korsi before anything
 *   is done with it, so a page can never claim to be somebody it is not;
 * - **the client** (`client`): the plugin plane as the installation or as a person.
 *
 * **A plugin that keeps nothing** -- a container with no disk, restarted -- does not know an
 * installation Korsi calls about. Every delivery kind then answers `Unprovisioned`, a 409 with
 * `{ "code": "plugin.unprovisioned" }` in its body, and Korsi gives it the credential again and
 * asks once more (ADR-0086). Render the code: Korsi reads it, never a bare 409. Korsi delivers at
 * least once, so handlers are idempotent; what must survive a restart lives in the plugin's
 * records.
 *
 * Framework-free: give it the raw body and the headers; it throws `RequestRejected` (with the HTTP
 * `status` to answer) or Korsi's own errors. Where installations are kept is the plugin's business
 * (`InstallationStore`).
 */
import { createHash } from 'node:crypto';

import { DEFAULT_TIMEOUT_MS, KorsiClient, type Caller } from './client.js';
import { DEFAULT_LEASE_SECONDS, MemoryEventLog, type EventLog } from './dedupe.js';
import {
  installationOf,
  MalformedRequest,
  parseActionCall,
  parseConnectionCall,
  parseEvent,
  parseLifecycle,
  parseToolCall,
  readJson,
  type ActionCall,
  type ConnectionCall,
  type Installation,
  type KorsiEvent,
  type RecordRef,
  type Removed,
  type ToolCall,
} from './deliveries.js';
import { credentialRefused, KorsiError, KorsiRefused, RequestRejected } from './errors.js';
import { DEFAULT_TOLERANCE_SECONDS, verifySignature, type RawBody } from './signature.js';
import { apiBaseProblem } from './trust.js';

/**
 * The header a plugin's page names its installation in, beside `Authorization: Bearer <handle>`.
 * Korsi does not read it; it is how this SDK's page helpers and server helpers agree.
 */
export const INSTALLATION_HEADER = 'X-Korsi-Installation';

/**
 * A call for an installation this plugin does not have. What this SDK throws is always its
 * subclass `Unprovisioned`, so `instanceof UnknownInstallation` still catches it.
 */
export class UnknownInstallation extends RequestRejected {
  constructor(message: string, status = 404) {
    super(message, status);
  }
}

/**
 * A delivery -- an event, a tool or action call, a connection call, a page's call -- for an
 * installation this plugin has no credential for: usually a plugin with no disk, restarted. 409
 * with `{ "code": "plugin.unprovisioned" }` in the body: Korsi gives the credential again and asks
 * once more (ADR-0086). A page's call comes back through the Bridge, which asks Korsi to do so.
 */
export class Unprovisioned extends UnknownInstallation {
  override readonly code: string = 'plugin.unprovisioned';
  constructor(message: string) {
    super(message, 409);
  }
}

/** An action call for a tool this plugin registered no handler for. 404: Korsi marks it failed. */
export class ActionUnknown extends RequestRejected {
  constructor(message: string) {
    super(message, 404);
  }
}

/** Arguments the action's own `parse` refused. 422: Korsi marks the change failed. */
export class ActionArgumentsRejected extends RequestRejected {
  constructor(message: string) {
    super(message, 422);
  }
}

/** A connection call seen before: a signed body sent again within the signature's tolerance. */
export class CallReplayed extends RequestRejected {
  constructor(message: string) {
    super(message, 400);
  }
}

/**
 * The event is being handled by another delivery right now. 503: Korsi comes back later -- any
 * 4xx but 429 would make it give the event up for good.
 */
export class EventInProgress extends RequestRejected {
  constructor(message: string) {
    super(message, 503);
  }
}

/** `installed` with a credential Korsi says belongs elsewhere, or from another Korsi. Answer 400. */
export class CredentialMismatch extends RequestRejected {
  constructor(message: string) {
    super(message, 400);
  }
}

/**
 * A page's caller Korsi does not vouch for: 401 for no handle or one Korsi no longer accepts (the
 * page asks the Bridge for a fresh one), 403 for a handle that is not this installation's person.
 */
export class HandleRejected extends RequestRejected {
  constructor(message: string, status: 401 | 403 = 403) {
    super(message, status);
  }
}

/** Where the plugin keeps its installations. Keep `token` and `signingSecret` sealed. */
export interface InstallationStore {
  installation(installationId: string): Promise<Installation | null>;
  saveInstallation(installation: Installation): Promise<void>;
  removeInstallation(installationId: string): Promise<void>;
}

/**
 * What a lifecycle call came to. Answer Korsi `{ status }`.
 *
 * - `installed` -- the credential was confirmed with Korsi and kept;
 * - `removed` -- Korsi refuses the stored credential, so the installation was forgotten;
 * - `still_installed` -- a `removed` Korsi contradicts: the stored credential still works;
 * - `unconfirmed` -- a `removed` Korsi could not be asked about (down, suspended): kept;
 * - `unknown` -- a `removed` for an installation this plugin never had.
 */
export type LifecycleStatus =
  'installed' | 'removed' | 'still_installed' | 'unconfirmed' | 'unknown';

export interface LifecycleResult {
  status: LifecycleStatus;
  installationId: string;
  installation: Installation | null;
}

export type EventStatus = 'handled' | 'duplicate';

/** A page's caller, as Korsi confirmed it: the installation, who, and their handle. */
export interface Person {
  installation: Installation;
  caller: Caller;
  userId: string;
  handle: string;
}

/**
 * What an action answers Korsi: the change made, or refused and why. A refusal is an answer, not
 * an error: the card shows `message` beside the change, as the plugin's own words in the call's
 * `locale`. Throwing instead -- or answering late -- tells Korsi only that it cannot say whether
 * the change was made.
 */
export type ActionAnswer =
  | {
      ok: true;
      /** What was done, in one short sentence in the call's locale; cut at 300 characters. */
      summary?: string | null;
      /** The plugin's own records the change wrote; the first 20 are kept. */
      records?: RecordRef[];
    }
  | {
      ok: false;
      /** `code` is the plugin's own (`position_closed`); `message` is cut at 500 characters. */
      error: { code: string; message: string };
      summary?: string | null;
      records?: RecordRef[];
    };

/** What an action's handler is given. */
export interface ActionContext<A = Record<string, unknown>> {
  installation: Installation;
  call: ActionCall;
  /** The arguments the card showed, as the registration's `parse` returned them. */
  arguments: A;
  /** The person who confirmed the card, as Korsi vouches for them: `caller.permissions` included. */
  caller: Caller;
  /** The plugin plane as that person. */
  korsi: KorsiClient;
  /** Aborted a little before Korsi stops waiting: stop, and answer what was done. */
  signal: AbortSignal;
}

export type ActionHandler<A = Record<string, unknown>> = (
  context: ActionContext<A>
) => ActionAnswer | Promise<ActionAnswer>;

export interface ActionOptions<A> {
  /**
   * The plugin's own check of the arguments -- a zod schema's `parse`, say -- returning what the
   * handler gets. Korsi has checked them against the tool's `input_schema` already. A throw is
   * `ActionArgumentsRejected` (422), and the handler does not run.
   */
  parse?: (args: Record<string, unknown>) => A;
}

/** How long an action's answer is kept for a repeat of the same change, in milliseconds. */
const ACTION_ANSWER_TTL_MS = 3_600_000;
/** How much sooner than Korsi's deadline the handler's signal is aborted, in milliseconds. */
const ACTION_MARGIN_MS = 2_000;
/** Korsi's limits on an action's answer (`PluginActionAnswer`). */
const SUMMARY_CHARACTERS = 300;
const MESSAGE_CHARACTERS = 500;
const ANSWER_RECORDS = 20;
const REFUSAL_CODE = /^[a-z][a-z0-9_.]{0,63}$/;

/** At most `limit` characters, counted as Korsi counts them: by code point, never mid-letter. */
function clip(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length > limit ? points.slice(0, limit).join('') : value;
}

/** The handler's answer within Korsi's limits, or a `TypeError` naming what no limit can fix. */
function keptAnswer(answer: ActionAnswer, name: string): ActionAnswer {
  if (!answer || typeof answer !== 'object' || typeof answer.ok !== 'boolean') {
    throw new TypeError(`action ${name}: the handler answered no { ok }`);
  }
  const summary = answer.summary ? clip(String(answer.summary).trim(), SUMMARY_CHARACTERS) : '';
  const records = (answer.records ?? []).slice(0, ANSWER_RECORDS).map((record) => ({
    type: record.type,
    external_id: record.external_id,
  }));
  const kept = { ...(summary ? { summary } : {}), records };
  if (answer.ok) return { ok: true, ...kept };
  const code = answer.error?.code;
  const message = clip(String(answer.error?.message ?? '').trim(), MESSAGE_CHARACTERS);
  if (typeof code !== 'string' || !REFUSAL_CODE.test(code) || !message) {
    throw new TypeError(
      `action ${name}: a refusal needs error.code matching ${REFUSAL_CODE} and an error.message`
    );
  }
  return { ok: false, error: { code, message }, ...kept };
}

export interface KorsiPluginOptions {
  /** The event log for deduplication; in memory when not given. */
  events?: EventLog;
  /**
   * The Korsi plugin planes this plugin accepts installations from
   * (`https://acme.korsi.ai/plugin/v1`, or `https://*.korsi.ai/plugin/v1`). Unset accepts any that
   * looks like a plane -- right only for a plugin in a public catalogue (see `./trust.ts`).
   */
  trustedApiBases?: Iterable<string>;
  /** Accept a plain-`http` plane beyond this machine, for development. */
  allowHttp?: boolean;
  /** How long a delivery holds an event before another may take it over: longer than any handler. */
  eventLeaseSeconds?: number;
  /** How old a signature may be, in seconds. */
  tolerance?: number;
  /**
   * How long Korsi's word on a page's handle is reused, in seconds: 60 by default. A permission
   * the organization takes back reaches `Caller.permissions` that much later.
   */
  handleCacheSeconds?: number;
  /** Per request to Korsi, in milliseconds. */
  timeout?: number;
  fetch?: typeof fetch;
}

const trimBase = (base: string): string => base.replace(/\/+$/, '');

/** One plugin's dealings with every Korsi it is installed in. */
export class KorsiPlugin {
  readonly installations: InstallationStore;
  readonly eventLog: EventLog;
  readonly #trusted: string[] | null;
  readonly #allowHttp: boolean;
  readonly #lease: number;
  readonly #tolerance: number;
  readonly #handleTtlMs: number;
  readonly #timeout: number;
  readonly #fetch: typeof fetch | undefined;
  readonly #handles = new Map<string, { until: number; caller: Caller }>();
  /** Connection calls already answered, for the signature's tolerance and a little more. */
  readonly #calls = new Map<string, number>();
  readonly #actions = new Map<
    string,
    { handler: ActionHandler<unknown>; parse: ((args: Record<string, unknown>) => unknown) | null }
  >();
  /** Each change's answer, by installation and idempotency key, while a repeat may still come. */
  readonly #answers = new Map<string, { until: number; answer: Promise<ActionAnswer> }>();

  constructor(installations: InstallationStore, options: KorsiPluginOptions = {}) {
    this.installations = installations;
    this.eventLog = options.events ?? new MemoryEventLog();
    this.#trusted = options.trustedApiBases ? [...options.trustedApiBases] : null;
    this.#allowHttp = options.allowHttp ?? false;
    this.#lease = options.eventLeaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.#tolerance = options.tolerance ?? DEFAULT_TOLERANCE_SECONDS;
    this.#handleTtlMs = (options.handleCacheSeconds ?? 60) * 1000;
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch;
  }

  /**
   * The plugin plane as `bearer` -- a person's handle -- or, with none, as the installation itself.
   * An empty handle is a handle (Korsi refuses it), never the installation's token.
   */
  client(installation: Installation, bearer?: string): KorsiClient {
    return new KorsiClient(installation.apiBase, bearer ?? installation.token, {
      timeout: this.#timeout,
      fetch: this.#fetch,
    });
  }

  /** The installation, or `Unprovisioned`: Korsi gives its credential again (ADR-0086). */
  async #known(installationId: string): Promise<Installation> {
    const installation = await this.installations.installation(installationId);
    if (!installation) {
      throw new Unprovisioned(`installation ${installationId} has no credentials here`);
    }
    return installation;
  }

  // -- 1. lifecycle -------------------------------------------------------------------------------

  /** `POST /korsi/lifecycle`: `installed` or `removed`. */
  async lifecycle(body: RawBody, signature: string | null | undefined): Promise<LifecycleResult> {
    const message = parseLifecycle(readJson(body));
    if (message.event === 'removed') return this.#removed(message);
    // Signed with the secret it carries, so the signature proves integrity only. What proves the
    // credential is Korsi's is Korsi accepting it, in accept().
    verifySignature(message.signingSecret, body, signature, { tolerance: this.#tolerance });
    const installation = await this.accept(installationOf(message));
    return { status: 'installed', installationId: installation.id, installation };
  }

  /**
   * Keep a credential once Korsi confirms it is this installation's. What `installed` does after
   * its signature, and what a *development* installation's credential -- read once from Korsi's
   * installation page -- goes through too (`register`).
   */
  async accept(installation: Installation): Promise<Installation> {
    const apiBase = trimBase(installation.apiBase.trim());
    const problem = apiBaseProblem(apiBase, this.#trusted, { allowHttp: this.#allowHttp });
    if (problem) throw new CredentialMismatch(problem);
    const known = await this.installations.installation(installation.id);
    if (known && trimBase(known.apiBase) !== apiBase) {
      // A real Korsi never moves an installation; a message that tries is somebody else's.
      throw new CredentialMismatch('this installation belongs to another Korsi');
    }
    const me = await this.client({ ...installation, apiBase }).whoami();
    if (me.installationId !== installation.id || me.authority !== 'installation') {
      throw new CredentialMismatch('Korsi says the credential belongs to another installation');
    }
    const confirmed: Installation = {
      ...installation,
      pluginId: me.pluginId || installation.pluginId,
      version: me.version || installation.version,
      apiBase,
      scopes: me.scopes,
      settings: me.settings,
    };
    await this.installations.saveInstallation(confirmed);
    return confirmed;
  }

  /** Keep a development installation's credential, read from Korsi's installation page. */
  register({
    installationId,
    token,
    signingSecret,
    apiBase,
  }: {
    installationId: string;
    token: string;
    signingSecret: string;
    apiBase: string;
  }): Promise<Installation> {
    return this.accept({
      id: installationId.toLowerCase(),
      pluginId: '',
      version: '',
      apiBase,
      token,
      signingSecret,
      scopes: [],
      settings: {},
    });
  }

  async #removed(removed: Removed): Promise<LifecycleResult> {
    // Unsigned by design -- the secret is gone on Korsi's side -- so it is believed only once Korsi
    // refuses the stored credential; otherwise anybody could make the plugin forget.
    const known = await this.installations.installation(removed.installationId);
    if (!known)
      return { status: 'unknown', installationId: removed.installationId, installation: null };
    try {
      await this.client(known).whoami();
    } catch (error) {
      if (error instanceof KorsiRefused && credentialRefused(error)) {
        await this.installations.removeInstallation(known.id);
        this.#forgetHandles(known.id);
        return { status: 'removed', installationId: known.id, installation: null };
      }
      if (error instanceof KorsiError) {
        return { status: 'unconfirmed', installationId: known.id, installation: known };
      }
      throw error;
    }
    return { status: 'still_installed', installationId: known.id, installation: known };
  }

  // -- 2. events ----------------------------------------------------------------------------------

  /**
   * An event's body, verified with its installation's secret and parsed. No deduplication. An
   * installation not known here is `Unprovisioned` (409 `plugin.unprovisioned`): the plugin
   * restarted with nothing kept, or was down when Korsi delivered `installed`. Korsi gives the
   * credential again and delivers once more, and keeps the event's normal retries.
   */
  async verifiedEvent(
    body: RawBody,
    signature: string | null | undefined
  ): Promise<{ installation: Installation; event: KorsiEvent }> {
    const event = parseEvent(readJson(body));
    const installation = await this.#known(event.installationId);
    verifySignature(installation.signingSecret, body, signature, { tolerance: this.#tolerance });
    return { installation, event };
  }

  /**
   * `POST /korsi/events`: verify, skip a repeat, run `handler` when it is its turn. Answer Korsi 2xx
   * for both outcomes. Throws `EventInProgress` (503) while another delivery of the same event is
   * still running it, so Korsi comes back rather than taking a 2xx for done. If `handler` throws,
   * the event is given back to the log and the error goes on: answer Korsi 5xx and it delivers the
   * event again later.
   */
  async event(
    body: RawBody,
    signature: string | null | undefined,
    handler: (installation: Installation, event: KorsiEvent) => unknown
  ): Promise<EventStatus> {
    const { installation, event } = await this.verifiedEvent(body, signature);
    const claimed = await this.eventLog.claim(installation.id, event.id, this.#lease);
    if (claimed === 'done') return 'duplicate';
    if (claimed === 'busy') {
      throw new EventInProgress(`event ${event.id} is being handled; come back later`);
    }
    try {
      await handler(installation, event);
    } catch (error) {
      await this.eventLog.forget(installation.id, event.id);
      throw error;
    }
    await this.eventLog.finish(installation.id, event.id);
    return 'handled';
  }

  // -- 3. tools -----------------------------------------------------------------------------------

  /**
   * `POST /korsi/tools/{name}`: verified and parsed. Read Korsi with
   * `plugin.client(installation, call.handle)` -- as the person, not as the plugin.
   * `call.permissions` are the plugin's own permissions the person holds.
   */
  async toolCall(
    name: string,
    body: RawBody,
    signature: string | null | undefined
  ): Promise<{ installation: Installation; call: ToolCall }> {
    const call = parseToolCall(name, readJson(body));
    const installation = await this.#known(call.installationId);
    verifySignature(installation.signingSecret, body, signature, { tolerance: this.#tolerance });
    return { installation, call };
  }

  // -- 4. actions ---------------------------------------------------------------------------------

  /**
   * What `POST /korsi/actions/{name}` runs for one of the manifest's action tools (`kind: action`,
   * ADR-0080). Korsi calls it only after the person confirmed the card the plugin's specialist
   * prepared, with the card's arguments -- their edits included.
   *
   *     plugin.registerAction('create_position', async ({ call, arguments: args, korsi }) => {
   *       const caseId = call.earlier.case?.result?.case_id as string | undefined;
   *       const position = await createPosition(korsi, args, caseId, call.idempotencyKey);
   *       return { ok: true, summary: said(call.locale, 'position_created'),
   *                records: [{ type: 'position', external_id: position.id }] };
   *     });
   */
  registerAction<A = Record<string, unknown>>(
    name: string,
    handler: ActionHandler<A>,
    { parse }: ActionOptions<A> = {}
  ): this {
    this.#actions.set(name, {
      handler: handler as ActionHandler<unknown>,
      parse: parse ?? null,
    });
    return this;
  }

  /**
   * An action call's body, verified with its installation's secret and parsed, nothing run: for a
   * plugin that dispatches actions itself. The body must name the tool the path does -- the
   * signature does not cover the path.
   */
  async verifiedAction(
    name: string,
    body: RawBody,
    signature: string | null | undefined
  ): Promise<{ installation: Installation; call: ActionCall }> {
    const call = parseActionCall(name, readJson(body));
    const installation = await this.#known(call.installationId);
    verifySignature(installation.signingSecret, body, signature, { tolerance: this.#tolerance });
    return { installation, call };
  }

  /**
   * `POST /korsi/actions/{name}`: verify, run the handler registered for `name` as the person who
   * confirmed the card, and answer Korsi 200 with what it returns -- cut to Korsi's limits, so a
   * long summary never turns a change that was made into a failure.
   *
   * **Once per change.** A repeat of the same `idempotencyKey` while this process lives is
   * answered what the first was, and the handler does not run again; a handler that throws is
   * forgotten, so Korsi's next delivery runs it. After a restart this memory is gone: make the
   * change under `call.idempotencyKey` in the plugin's records, so a repeat finds it made.
   * `ActionUnknown` (404) for a name nothing was registered for.
   */
  async actionCall(
    name: string,
    body: RawBody,
    signature: string | null | undefined
  ): Promise<ActionAnswer> {
    const { installation, call } = await this.verifiedAction(name, body, signature);
    const registered = this.#actions.get(name);
    if (!registered) throw new ActionUnknown(`no handler is registered for action ${name}`);
    const now = Date.now();
    // Oldest first, as inserted: drop what no repeat can still ask for.
    for (const [key, { until }] of this.#answers) {
      if (until > now && this.#answers.size <= 10_000) break;
      this.#answers.delete(key);
    }
    const key = `${installation.id}:${call.idempotencyKey}`;
    const seen = this.#answers.get(key);
    if (seen) return seen.answer;
    const answer = this.#runAction(installation, call, registered);
    this.#answers.set(key, { until: now + ACTION_ANSWER_TTL_MS, answer });
    try {
      return await answer;
    } catch (error) {
      this.#answers.delete(key);
      throw error;
    }
  }

  async #runAction(
    installation: Installation,
    call: ActionCall,
    {
      handler,
      parse,
    }: {
      handler: ActionHandler<unknown>;
      parse: ((args: Record<string, unknown>) => unknown) | null;
    }
  ): Promise<ActionAnswer> {
    const signal = AbortSignal.timeout(
      Math.max(call.deadlineSeconds * 1000 - ACTION_MARGIN_MS, 1000)
    );
    const caller = await this.#vouch(installation, call.handle);
    if (caller.installationId !== installation.id || caller.userId !== call.userId) {
      throw new HandleRejected('that handle is not the person who confirmed the card');
    }
    let args: unknown = call.arguments;
    if (parse) {
      try {
        args = parse(call.arguments);
      } catch (error) {
        throw new ActionArgumentsRejected(
          `action ${call.name}: the arguments were refused: ${(error as Error).message}`
        );
      }
    }
    const korsi = this.client(installation, call.handle);
    const answer = await handler({ installation, call, arguments: args, caller, korsi, signal });
    return keptAnswer(answer, call.name);
  }

  // -- 5. connections -----------------------------------------------------------------------------

  /**
   * `POST /korsi/connections`: verified, parsed, and refused if it was seen before.
   *
   * Dispatch on `call.call` (`VERIFY`, `SYNC`, `CALENDAR`) and answer 200 with the call's answer --
   * a refusal by the other system included, as `{ error: ... }`. An installation this plugin does
   * not have is `Unprovisioned` (409), as on every delivery.
   */
  async connectionCall(
    body: RawBody,
    signature: string | null | undefined
  ): Promise<{ installation: Installation; call: ConnectionCall }> {
    const call = parseConnectionCall(readJson(body));
    const installation = await this.#known(call.installationId);
    verifySignature(installation.signingSecret, body, signature, { tolerance: this.#tolerance });
    const now = Date.now();
    // Oldest first, as inserted: drop what the signature's tolerance no longer admits.
    for (const [id, at] of this.#calls) {
      if (at >= now - 2 * this.#tolerance * 1000) break;
      this.#calls.delete(id);
    }
    if (this.#calls.has(call.callId)) {
      throw new CallReplayed(`call ${call.callId} was answered already`);
    }
    this.#calls.set(call.callId, now);
    return { installation, call };
  }

  // -- 6. a page's caller -------------------------------------------------------------------------

  /**
   * The person a page's request is for, as Korsi vouches for them. `authorization` is the
   * request's `Authorization` header (`Bearer <handle>`, from the Bridge's `getHandle()`);
   * `installationId` its `X-Korsi-Installation`. Korsi's answer is reused for `handleCacheSeconds`.
   *
   * An installation this plugin has no credential for is `Unprovisioned`: answer the page 409 with
   * `{ code: 'plugin.unprovisioned' }`, and `@korsi/bridge`'s `createPluginApi` asks Korsi to give
   * the credential again and calls once more.
   */
  async person({
    authorization,
    installationId,
  }: {
    authorization: string | null | undefined;
    installationId: string | null | undefined;
  }): Promise<Person> {
    if (!authorization || !/^bearer /i.test(authorization)) {
      throw new HandleRejected('a handle is required', 401);
    }
    const handle = authorization.slice(7).trim();
    if (!handle) throw new HandleRejected('a handle is required', 401);
    if (!installationId || !/^[0-9a-f-]{36}$/i.test(installationId)) {
      throw new MalformedRequest(`${INSTALLATION_HEADER} is required`);
    }
    const installation = await this.#known(installationId.toLowerCase());
    const caller = await this.#vouch(installation, handle);
    if (caller.installationId !== installation.id || !caller.isPerson || !caller.userId) {
      throw new HandleRejected('that handle is not a person of this installation');
    }
    return { installation, caller, userId: caller.userId, handle };
  }

  async #vouch(installation: Installation, handle: string): Promise<Caller> {
    const key = createHash('sha256').update(`${installation.id}:${handle}`).digest('hex');
    const now = Date.now();
    const cached = this.#handles.get(key);
    if (cached && cached.until > now) return cached.caller;
    let caller: Caller;
    try {
      caller = await this.client(installation, handle).whoami();
    } catch (error) {
      if (error instanceof KorsiRefused && (error.status === 401 || error.status === 403)) {
        throw new HandleRejected(`Korsi refused the handle: ${error.code}`, error.status);
      }
      throw error;
    }
    this.#handles.delete(key);
    this.#handles.set(key, { until: now + this.#handleTtlMs, caller });
    while (this.#handles.size > 10_000) {
      const oldest = this.#handles.keys().next().value;
      if (oldest === undefined) break;
      this.#handles.delete(oldest);
    }
    return caller;
  }

  #forgetHandles(installationId: string): void {
    for (const [key, { caller }] of this.#handles) {
      if (caller.installationId === installationId) this.#handles.delete(key);
    }
  }
}

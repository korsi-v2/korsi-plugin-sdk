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
 * - **a page's caller** (`person`): the handle a page sends is checked with Korsi before anything
 *   is done with it, so a page can never claim to be somebody it is not;
 * - **the client** (`client`): the plugin plane as the installation or as a person.
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
  parseEvent,
  parseLifecycle,
  parseToolCall,
  readJson,
  type Installation,
  type KorsiEvent,
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

/** A call for an installation this plugin does not have. Answer 404 -- 503 for an event. */
export class UnknownInstallation extends RequestRejected {
  constructor(message: string, status = 404) {
    super(message, status);
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
  /** How long Korsi's word on a page's handle is reused, in seconds. */
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

  async #known(installationId: string, status = 404): Promise<Installation> {
    const installation = await this.installations.installation(installationId);
    if (!installation) {
      throw new UnknownInstallation(`installation ${installationId} is not known here`, status);
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
   * installation not known *yet* is answered 503, not 404: the plugin may have been down when
   * Korsi delivered `installed`, and Korsi gives up on an event answered with a 4xx.
   */
  async verifiedEvent(
    body: RawBody,
    signature: string | null | undefined
  ): Promise<{ installation: Installation; event: KorsiEvent }> {
    const event = parseEvent(readJson(body));
    const installation = await this.#known(event.installationId, 503);
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

  // -- 4. a page's caller -------------------------------------------------------------------------

  /**
   * The person a page's request is for, as Korsi vouches for them. `authorization` is the
   * request's `Authorization` header (`Bearer <handle>`, from the Bridge's `getHandle()`);
   * `installationId` its `X-Korsi-Installation`. Korsi's answer is reused for `handleCacheSeconds`.
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

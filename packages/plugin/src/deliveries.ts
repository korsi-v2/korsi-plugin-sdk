/**
 * What Korsi sends a plugin's server, read into typed values.
 *
 * Korsi calls four addresses under the plugin's `base_url`, each signed (`./signature.ts`):
 *
 * - `POST /korsi/lifecycle` -- `installed` (with the credential) or `removed`;
 * - `POST /korsi/events` -- an event, at least once;
 * - `POST /korsi/tools/{name}` -- Korsyar asks on a person's behalf, with their sealed handle;
 * - `POST /korsi/connections` -- a `ConnectionCall` about a person's connected account: check these
 *   credentials, tell me what changed, act on their calendar (ADR-0067). The person's secrets are
 *   in it, for this call only.
 *
 * These parse a body that has already been verified; `KorsiPlugin` does both.
 */
import { RequestRejected } from './errors.js';
import type { RawBody } from './signature.js';

/** Where Korsi calls, under the plugin's `base_url`. */
export const LIFECYCLE_PATH = '/korsi/lifecycle';
export const EVENTS_PATH = '/korsi/events';
export const TOOLS_PATH = '/korsi/tools/';
export const CONNECTIONS_PATH = '/korsi/connections';

/** The kinds of connection call, as `ConnectionCall.call` names them. */
export const VERIFY = 'connection.verify';
export const SYNC = 'connection.sync';
export const CALENDAR = 'connection.calendar';

/** Topics of the plugin's own life, always delivered. Others are those its manifest asks for. */
export const Topic = Object.freeze({
  proposalSettled: 'plugin.proposal.settled',
  installationUpdated: 'plugin.installation.updated',
  installationRemoved: 'plugin.installation.removed',
  walletLow: 'plugin.wallet.low',
  planChanged: 'plugin.plan.changed',
  sourceReviewed: 'plugin.source.reviewed',
  /**
   * A message arrived in the mail of a person who turned this plugin on for it (ADR-0067).
   * Delivered with `KorsiEvent.handle`: read it as them with `GET /mail/{subjectId}`.
   */
  mailReceived: 'source.message.received',
  /** Their mailbox no longer has a message. Korsi keeps it; it may be filed or cited. */
  mailDeleted: 'source.message.deleted',
} as const);

/** A body that is not what Korsi sends. Answer 400. */
export class MalformedRequest extends RequestRejected {
  constructor(message: string) {
    super(message, 400);
  }
}

type Json = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readJson(body: RawBody): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body));
  } catch {
    throw new MalformedRequest('the body is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MalformedRequest('the body is not a JSON object');
  }
  return parsed as Json;
}

function uuid(payload: Json, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new MalformedRequest(`${key} is missing or not an id`);
  }
  return value.toLowerCase();
}

function text(payload: Json, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value) throw new MalformedRequest(`${key} is missing`);
  return value;
}

function object(payload: Json, key: string): Json {
  const value = payload[key] ?? {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new MalformedRequest(`${key} is not an object`);
  }
  return value as Json;
}

/**
 * What a plugin keeps about one installation: Korsi's address for it and its credential. `token`
 * and `signingSecret` are secrets: keep them encrypted at rest.
 */
export interface Installation {
  id: string;
  pluginId: string;
  version: string;
  /** The plugin plane of the Korsi this installation is in: `https://<korsi>/plugin/v1`. */
  apiBase: string;
  /** The installation's own credential, for `/plugin/v1` and Korsi's MCP server. */
  token: string;
  /** What Korsi signs every event and tool call for this installation with. */
  signingSecret: string;
  scopes: string[];
  settings: Record<string, unknown>;
}

/** `installed`: the installation's credential, delivered once Korsi registered it. */
export interface Installed {
  event: 'installed';
  installationId: string;
  pluginId: string;
  version: string;
  pluginApi: string | null;
  apiBase: string;
  token: string;
  tokenExpiresAt: string | null;
  signingSecret: string;
  scopes: string[];
  settings: Record<string, unknown>;
}

/** `removed`: *claimed*, unsigned -- Korsi no longer holds the secret to sign it with. */
export interface Removed {
  event: 'removed';
  installationId: string;
}

export function parseLifecycle(payload: Json): Installed | Removed {
  if (payload.event === 'installed') {
    return {
      event: 'installed',
      installationId: uuid(payload, 'installation_id'),
      pluginId: text(payload, 'plugin_id'),
      version: text(payload, 'version'),
      pluginApi: (payload.plugin_api as string | undefined) ?? null,
      apiBase: text(payload, 'api_base').replace(/\/+$/, ''),
      token: text(payload, 'token'),
      tokenExpiresAt: (payload.token_expires_at as string | undefined) ?? null,
      signingSecret: text(payload, 'signing_secret'),
      scopes: Array.isArray(payload.scopes) ? payload.scopes.map(String) : [],
      settings: object(payload, 'settings'),
    };
  }
  if (payload.event === 'removed') {
    return { event: 'removed', installationId: uuid(payload, 'installation_id') };
  }
  throw new MalformedRequest(`unknown lifecycle event ${JSON.stringify(payload.event)}`);
}

export function installationOf(installed: Installed): Installation {
  return {
    id: installed.installationId,
    pluginId: installed.pluginId,
    version: installed.version,
    apiBase: installed.apiBase,
    token: installed.token,
    signingSecret: installed.signingSecret,
    scopes: installed.scopes,
    settings: installed.settings,
  };
}

/**
 * One event in the installation's stream: thin -- a topic, ids, a little data, no content.
 * Delivered at least once: the same `id` may arrive again, and is the same event.
 */
export interface KorsiEvent {
  id: string;
  sequence: number;
  topic: string;
  installationId: string;
  subjectId: string | null;
  data: Record<string, unknown>;
  occurredAt: Date;
  /**
   * A person's event, for the connection they turned on (ADR-0067): whose it is, and a handle to
   * read with as them -- minted for this delivery, good for five minutes, and only while the
   * connection is on. `null` for the installation's own events.
   */
  connectionId: string | null;
  userId: string | null;
  handle: string | null;
}

export function parseEvent(payload: Json): KorsiEvent {
  const occurredAt = new Date(text(payload, 'occurred_at'));
  if (Number.isNaN(occurredAt.getTime())) throw new MalformedRequest('occurred_at is malformed');
  const subject = payload.subject_id;
  return {
    id: uuid(payload, 'id'),
    sequence: Number(payload.sequence ?? 0),
    topic: text(payload, 'topic'),
    installationId: uuid(payload, 'installation_id'),
    subjectId: typeof subject === 'string' && subject ? subject : null,
    data: object(payload, 'data'),
    occurredAt,
    connectionId: payload.connection_id ? uuid(payload, 'connection_id') : null,
    userId: payload.user_id ? uuid(payload, 'user_id') : null,
    handle: payload.handle ? String(payload.handle) : null,
  };
}

/**
 * Korsyar asking one of the plugin's tools, for a person. Read Korsi with `handle`: it is that
 * person, narrowed to this installation's scopes, for five minutes. Answer `{ content }` within ten
 * seconds, and change nothing: a tool that wants a change sends a proposal.
 */
export interface ToolCall {
  name: string;
  installationId: string;
  userId: string;
  arguments: Record<string, unknown>;
  handle: string;
  locale: string | null;
}

export function parseToolCall(name: string, payload: Json): ToolCall {
  return {
    name,
    installationId: uuid(payload, 'installation_id'),
    userId: uuid(payload, 'user_id'),
    arguments: object(payload, 'arguments'),
    handle: text(payload, 'handle'),
    locale: (payload.locale as string | undefined) ?? null,
  };
}

/**
 * Korsi asking about one person's connection (ADR-0067).
 *
 * `call` is `VERIFY` (are these credentials an account? answer `{ ok: true, account: { subject,
 * label, address, host } }` or `{ ok: false, error: { code: 'auth_failed', message } }`), `SYNC`
 * (what changed since `state`? answer `{ changes, state, more, skipped }`) or `CALENDAR` (`op` with
 * `args`; answer `{ result }`). The shapes are published as `korsi-connection-calls.schema.json`.
 *
 * `secrets` are the person's, opened by Korsi for this call only: never log them, never keep them
 * (they are left out of `JSON.stringify` and `console.log`). Answer within `deadlineSeconds` --
 * stop early and say `more` rather than run over.
 */
export interface ConnectionCall {
  call: typeof VERIFY | typeof SYNC | typeof CALENDAR;
  callId: string;
  installationId: string;
  connectionId: string;
  connectionKey: string;
  userId: string;
  locale: string;
  timezone: string;
  values: Record<string, string>;
  readonly secrets: Record<string, string>;
  settings: Record<string, unknown>;
  deadlineSeconds: number;
  issuedAt: Date;
  /** A sync's: what this plugin answered as `state` last time, or `null` on a first sync. */
  state: Record<string, unknown> | null;
  /** A sync's: `max_items`, `max_bytes`, `backfill_days`. */
  limits: Record<string, unknown>;
  /** A calendar call's operation and its arguments. */
  op: string | null;
  args: Record<string, unknown>;
}

const strings = (value: Json): Record<string, string> =>
  Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));

export function parseConnectionCall(payload: Json): ConnectionCall {
  const call = payload.call;
  if (call !== VERIFY && call !== SYNC && call !== CALENDAR) {
    throw new MalformedRequest(`not a connection call: ${JSON.stringify(call)}`);
  }
  const state = payload.state ?? null;
  if (state !== null && (typeof state !== 'object' || Array.isArray(state))) {
    throw new MalformedRequest('state is not an object');
  }
  const issuedAt = new Date(text(payload, 'issued_at'));
  const deadlineSeconds = Number(payload.deadline_seconds ?? 0);
  if (Number.isNaN(issuedAt.getTime()) || !Number.isInteger(deadlineSeconds)) {
    throw new MalformedRequest('issued_at or deadline_seconds is not readable');
  }
  const parsed = {
    call,
    callId: uuid(payload, 'call_id'),
    installationId: uuid(payload, 'installation_id'),
    connectionId: uuid(payload, 'connection_id'),
    connectionKey: text(payload, 'connection_key'),
    userId: uuid(payload, 'user_id'),
    locale: String(payload.locale || 'fa'),
    timezone: String(payload.timezone || 'UTC'),
    values: strings(object(payload, 'values')),
    settings: object(payload, 'settings'),
    deadlineSeconds,
    issuedAt,
    state: state as Record<string, unknown> | null,
    limits: object(payload, 'limits'),
    op: typeof payload.op === 'string' ? payload.op : null,
    args: object(payload, 'args'),
  };
  // Not enumerable: a log line that prints the call never prints the person's secrets.
  return Object.defineProperty(parsed, 'secrets', {
    value: strings(object(payload, 'secrets')),
    enumerable: false,
  }) as ConnectionCall;
}

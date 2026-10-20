/**
 * What Korsi sends a plugin's server, read into typed values.
 *
 * Korsi calls three addresses under the plugin's `base_url`, each signed (`./signature.ts`):
 *
 * - `POST /korsi/lifecycle` -- `installed` (with the credential) or `removed`;
 * - `POST /korsi/events` -- an event, at least once;
 * - `POST /korsi/tools/{name}` -- Korsyar asks on a person's behalf, with their sealed handle.
 *
 * These parse a body that has already been verified; `KorsiPlugin` does both.
 */
import { RequestRejected } from './errors.js';
import type { RawBody } from './signature.js';

/** Where Korsi calls, under the plugin's `base_url`. */
export const LIFECYCLE_PATH = '/korsi/lifecycle';
export const EVENTS_PATH = '/korsi/events';
export const TOOLS_PATH = '/korsi/tools/';

/** Topics of the plugin's own life, always delivered. Others are those its manifest asks for. */
export const Topic = Object.freeze({
  proposalSettled: 'plugin.proposal.settled',
  installationUpdated: 'plugin.installation.updated',
  installationRemoved: 'plugin.installation.removed',
  walletLow: 'plugin.wallet.low',
  planChanged: 'plugin.plan.changed',
  sourceReviewed: 'plugin.source.reviewed',
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

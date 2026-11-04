/**
 * Feeds: what an organization's own systems write into Korsi, and the door they write through
 * (ADR-0097, plugin API 1.8).
 *
 * **A plugin declares a feed** in its manifest -- a shape an organization's ticket system, ERP or
 * script may write into the plugin's own records. `defineFeed` builds the entry and `checkFeeds`
 * finds, before Korsi does, what Korsi would refuse in it. The plugin never talks to the system:
 * it stays `egress: none`, reads its records as always, and learns that a run was applied from the
 * `plugin.feed.run` event.
 *
 * **An organization's IT writes a feed** through Korsi's machine door, `/system/v1`, with a system
 * connection's client id and secret from the connections page. `SystemClient` gets the token
 * (`grant_type=client_credentials` at ZITADEL's token endpoint) and makes the calls; `push` opens a
 * run, sends it in batches and commits it; `readRows` reads CSV, JSON or JSON lines into rows by
 * the feed's header words; `checkRows` validates rows against a feed's published schema without
 * asking Korsi. The `korsi-feed` command is all of it on a command line.
 */
import { createHash } from 'node:crypto';

import { KorsiRefused, KorsiUnreachable } from './errors.js';
import type { FeedSpec, LocalizedText } from './manifest.js';
import { createKorsiFetch } from './proxy.js';

/** The door's contract version, sent by Korsi on every answer. */
export const SYSTEM_API = '1.0';
export const SYSTEM_VERSION_HEADER = 'Korsi-System-API';
/** Korsi's own feed: the staff list. */
export const PEOPLE_FEED = 'korsi.people';
export const BATCH_MAX_ROWS = 500;
export const BATCH_MAX_BYTES = 1_000_000;
export const MAX_FEEDS = 5;
export const MAX_FEED_SOURCE_KEY = 200;
/** The environment variables a connection's credential is read from. */
export const ENV = {
  clientId: 'KORSI_SYSTEM_CLIENT_ID',
  clientSecret: 'KORSI_SYSTEM_CLIENT_SECRET',
  tokenEndpoint: 'KORSI_SYSTEM_TOKEN_ENDPOINT',
  scope: 'KORSI_SYSTEM_SCOPE',
  apiBase: 'KORSI_SYSTEM_API',
} as const;

export type ConnectionMode = 'trial' | 'active' | 'paused';
export type RunStatus = 'open' | 'trial' | 'held' | 'applied' | 'failed' | 'expired';
export type RowStatus = 'pending' | 'created' | 'updated' | 'unchanged' | 'waiting' | 'refused';
export type Row = Record<string, unknown>;

export interface FeedGrant {
  feed: string;
  create_people: boolean;
}

export interface SystemSelf {
  connection_id: string;
  name: string;
  mode: ConnectionMode;
  feeds: FeedGrant[];
  limits: Record<string, number>;
}

/** `GET /system/v1/feeds/{feed}`: a row's JSON Schema, the file headers and a sample row. */
export interface FeedSchema {
  feed: string;
  kind: 'korsi' | 'plugin';
  names: Record<string, string | null>;
  plugin_id: string | null;
  record_type: string | null;
  visibility: string | null;
  source_key: string;
  person_fields: Record<string, string[]>;
  upsert: string | null;
  row_schema: Record<string, unknown>;
  headers: Record<string, Record<string, string[]>>;
  refused_fields: string[];
  sample: Row;
  max_rows: number;
}

export interface FeedCounts {
  created: number;
  updated: number;
  unchanged: number;
  waiting: number;
  refused: number;
}

export interface FeedRunView {
  id: string;
  feed: string;
  status: RunStatus;
  complete: boolean;
  dry_run: boolean;
  connection_id: string | null;
  by_person: boolean;
  rows: number;
  counts: FeedCounts;
  held_reason: string | null;
  changes: number | null;
  existing: number | null;
  missing: number;
  created_at: string;
  committed_at: string | null;
  applied_at: string | null;
  applied_by_name: string | null;
  expires_at: string | null;
}

export interface FeedRowOutcome {
  id: string;
  position: number;
  source_key: string | null;
  status: RowStatus;
  action: string | null;
  reason: string | null;
  field: string | null;
  member_id: string | null;
  record_id: string | null;
  display_name: string | null;
  notes: string[];
}

export interface FeedRunReport {
  run: FeedRunView;
  outcomes: FeedRowOutcome[];
  next_after: number | null;
}

export interface BatchReceipt {
  run_id: string;
  seq: number;
  repeated: boolean;
  accepted: number;
  outcomes: FeedRowOutcome[];
}

export interface FedRow {
  source_key: string;
  member_id: string | null;
  record_id: string | null;
  fields: Row;
  updated_at: string | null;
  missing_since: string | null;
}

export interface FedRowResult {
  run: FeedRunView | null;
  outcome: FeedRowOutcome;
}

// ---------------------------------------------------------------------------
// Declaring a feed in a plugin's manifest
// ---------------------------------------------------------------------------

export type FeedMatchWay = 'source_key' | 'personnel_number' | 'email';

export interface DefineFeed {
  names: LocalizedText;
  consent: LocalizedText;
  recordType: string;
  sourceKey: string;
  fields: string[];
  /** Each field naming a colleague, and how Korsi finds them in order. */
  personFields?: Record<string, FeedMatchWay[]>;
  upsert?: 'merge' | 'replace';
  onMissing?: 'keep' | 'mark';
  maxRows?: number;
  headers?: Record<string, Partial<Record<'fa' | 'en' | 'ar', string[]>>>;
}

/** A manifest's `feeds` entry. */
export function defineFeed(key: string, feed: DefineFeed): FeedSpec {
  const spec: FeedSpec = {
    key,
    names: feed.names,
    consent: feed.consent,
    record_type: feed.recordType,
    source_key: feed.sourceKey,
    fields: [...feed.fields],
    upsert: feed.upsert ?? 'merge',
    on_missing: feed.onMissing ?? 'keep',
    max_rows: feed.maxRows ?? 5000,
  };
  if (feed.personFields) {
    spec.person_fields = Object.entries(feed.personFields).map(([field, match]) => ({
      field,
      match,
    }));
  }
  if (feed.headers) spec.headers = feed.headers;
  return spec;
}

const FEED_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FEEDABLE = new Set(['organization', 'case_members']);

type Json = Record<string, unknown>;

const typesOf = (prop: unknown): Set<string> => {
  const declared = (prop as Json | undefined)?.type;
  const all = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : [];
  return new Set(all.map(String).filter((type) => type !== 'null'));
};

/**
 * What Korsi would refuse in a manifest's `feeds`, one sentence each; empty when nothing. The rules
 * Korsi applies when it reads the manifest.
 */
export function checkFeeds(manifest: Json): string[] {
  const feeds = (manifest.feeds as Json[] | undefined) ?? [];
  if (!feeds.length) return [];
  const problems: string[] = [];
  if (feeds.length > MAX_FEEDS) problems.push(`a plugin declares at most ${MAX_FEEDS} feeds`);
  const scopes = (manifest.scopes as Json | undefined) ?? {};
  const asked = new Set([
    ...((scopes.required as string[] | undefined) ?? []),
    ...((scopes.optional as string[] | undefined) ?? []),
  ]);
  if (!asked.has('records.own')) {
    problems.push('feeds write records, so they need the records.own scope');
  }
  const types = new Map(
    ((manifest.record_types as Json[] | undefined) ?? []).map((item) => [item.key, item])
  );
  for (const feed of feeds) {
    const label = `feed ${String(feed.key)}`;
    if (!FEED_KEY.test(String(feed.key))) {
      problems.push(`${label}: a key is lower case, a letter first, at most 40 characters`);
    }
    const fields = (feed.fields as string[] | undefined) ?? [];
    const sourceKey = String(feed.source_key);
    for (const name of [...fields, sourceKey]) {
      if (!FIELD_NAME.test(name)) problems.push(`${label}: '${name}' is not a property name`);
    }
    if (fields.includes(sourceKey)) {
      problems.push(`${label}: the source key is the record's id, not one of its fields`);
    }
    const people = ((feed.person_fields as Json[] | undefined) ?? []).map((item) =>
      String(item.field)
    );
    const outside = people.filter((name) => !fields.includes(name));
    if (outside.length) problems.push(`${label}: person fields are fields the feed sets`);
    const record = types.get(feed.record_type);
    if (!record) {
      problems.push(`${label} writes ${String(feed.record_type)}, a record type not declared`);
      continue;
    }
    if (!FEEDABLE.has(String(record.visibility))) {
      problems.push(`${label}: a fed type is organization or case_members`);
    }
    const properties = (((record.schema as Json | undefined) ?? {}).properties as Json) ?? {};
    const missing = fields.filter((name) => typeof properties[name] !== 'object');
    if (missing.length) {
      problems.push(`${label} sets ${missing.join(', ')}, which the schema does not declare`);
    }
    const keyProp = properties[sourceKey] as Json | undefined;
    if (keyProp) {
      const types = typesOf(keyProp);
      const limit = keyProp.maxLength;
      if (types.size !== 1 || !types.has('string')) {
        problems.push(`${label}: its source key ${sourceKey} is a string`);
      } else if (typeof limit !== 'number' || limit > MAX_FEED_SOURCE_KEY) {
        problems.push(`${label}: its source key bounds its length (maxLength <= 200)`);
      }
    }
    for (const name of people) {
      const types = typesOf(properties[name]);
      if ([...types].some((type) => type !== 'string')) {
        problems.push(`${label}: person field ${name} holds a member id, so a string`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Reading and checking rows
// ---------------------------------------------------------------------------

export interface ReadRows {
  rows: Row[];
  /** Columns no field of the feed is called, by their header: not read. */
  unknownColumns: string[];
  /** Columns of what Korsi never keeps (a national id, a salary): not read, said by name. */
  refusedColumns: string[];
}

const fold = (word: string): string =>
  word.replace(/﻿/g, '').replace(/‌/g, ' ').trim().split(/\s+/).join(' ').toLowerCase();

/** Every word a file's header may be, folded, to the field it is. */
export function headerIndex(schema: FeedSchema): Map<string, string> {
  const index = new Map<string, string>();
  const properties = (schema.row_schema.properties as Json | undefined) ?? {};
  for (const name of Object.keys(properties)) index.set(fold(name), name);
  for (const [name, languages] of Object.entries(schema.headers ?? {})) {
    for (const words of Object.values(languages)) {
      for (const word of words) if (!index.has(fold(word))) index.set(fold(word), name);
    }
  }
  return index;
}

const resolve = (root: Json, prop: Json): Json => {
  let current: Json = { ...prop };
  if (typeof current.$ref === 'string') {
    const target = current.$ref.split('/').pop() ?? '';
    const { $ref: _ignored, ...rest } = current;
    current = { ...(((root.$defs as Json | undefined) ?? {})[target] as Json), ...rest };
  }
  const options = current.anyOf;
  if (Array.isArray(options)) {
    const concrete = (options as Json[]).filter((item) => item.type !== 'null');
    if (concrete.length === 1 && concrete[0]) {
      const { anyOf: _gone, ...rest } = current;
      current = { ...resolve(root, concrete[0]), ...rest };
    }
  }
  return current;
};

const propertyOf = (schema: FeedSchema, name: string): Json => {
  const properties = (schema.row_schema.properties as Json | undefined) ?? {};
  return resolve(schema.row_schema, (properties[name] as Json | undefined) ?? {});
};

const coerce = (text: string, prop: Json): unknown => {
  const types = typesOf(prop);
  const value = text.trim();
  if (types.has('integer') && /^[+-]?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (types.has('number') && /^[+-]?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (types.has('boolean') && /^(true|false|1|0|yes|no)$/i.test(value)) {
    return /^(true|1|yes)$/i.test(value);
  }
  return value;
};

/** One CSV document as lines of cells: quotes, doubled quotes, `,` or `;`, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, '');
  const first = body.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const lines: string[][] = [];
  let line: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) {
      line.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && body[index + 1] === '\n') index += 1;
      line.push(cell);
      lines.push(line);
      line = [];
      cell = '';
    } else cell += char;
  }
  if (cell || line.length) {
    line.push(cell);
    lines.push(line);
  }
  return lines.filter((cells) => cells.some((value) => value.trim()));
}

/**
 * Rows from a document in the feed's shape: a JSON list of objects, JSON lines, or CSV (the first
 * line its headers). A header is a field's own name or one of the feed's header words; other columns
 * are not read and are listed. An empty cell is left out, so it erases nothing. For a spreadsheet,
 * save it as CSV, or use the Python `korsi-feed`, which reads `.xlsx`.
 */
export function readRows(text: string, schema: FeedSchema): ReadRows {
  const stripped = text.replace(/^﻿/, '').trim();
  if (!stripped) return { rows: [], unknownColumns: [], refusedColumns: [] };
  if (stripped.startsWith('[')) {
    const loaded = JSON.parse(stripped) as unknown[];
    return {
      rows: loaded.filter((item): item is Row => typeof item === 'object' && item !== null),
      unknownColumns: [],
      refusedColumns: [],
    };
  }
  if (stripped.startsWith('{')) {
    return {
      rows: stripped
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Row),
      unknownColumns: [],
      refusedColumns: [],
    };
  }
  const [header = [], ...body] = parseCsv(text);
  const index = headerIndex(schema);
  const refused = new Set((schema.refused_fields ?? []).map(fold));
  const result: ReadRows = { rows: [], unknownColumns: [], refusedColumns: [] };
  const columns = header.map((cell) => {
    const word = fold(cell);
    const target = index.get(word);
    if (!target && word)
      (refused.has(word) ? result.refusedColumns : result.unknownColumns).push(cell);
    return target;
  });
  for (const cells of body) {
    const row: Row = {};
    columns.forEach((name, position) => {
      const cell = cells[position];
      if (!name || cell === undefined || !cell.trim()) return;
      row[name] = coerce(cell, propertyOf(schema, name));
    });
    if (Object.keys(row).length) result.rows.push(row);
  }
  return result;
}

export interface RowProblem {
  position: number;
  sourceKey: string | null;
  field: string;
  reason: string;
}

const valueProblem = (value: unknown, prop: Json): string | null => {
  if (value === null || value === undefined) return null;
  const types = typesOf(prop);
  if (types.size) {
    const fits =
      (types.has('string') && typeof value === 'string') ||
      (types.has('integer') && Number.isInteger(value)) ||
      (types.has('number') && typeof value === 'number') ||
      (types.has('boolean') && typeof value === 'boolean') ||
      (types.has('object') && typeof value === 'object' && !Array.isArray(value)) ||
      (types.has('array') && Array.isArray(value));
    if (!fits) return `is not a ${[...types].sort().join(' or ')}`;
  }
  if (Array.isArray(prop.enum) && !prop.enum.includes(value)) return 'is not one of its choices';
  if (typeof value === 'string') {
    if (typeof prop.maxLength === 'number' && value.length > prop.maxLength) return 'is too long';
    if (typeof prop.minLength === 'number' && value.length < prop.minLength) return 'is too short';
    if (typeof prop.pattern === 'string' && !new RegExp(prop.pattern, 'u').test(value)) {
      return 'does not have the expected form';
    }
    if (prop.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'is not a day';
  }
  if (typeof value === 'number') {
    if (typeof prop.minimum === 'number' && value < prop.minimum) return 'is too small';
    if (typeof prop.maximum === 'number' && value > prop.maximum) return 'is too large';
  }
  return null;
};

/**
 * What Korsi would refuse on arrival, without asking it: a field refused by name, a property the
 * feed does not carry, a missing key, a value not of its kind, the same key twice.
 */
export function checkRows(schema: FeedSchema, rows: Row[]): RowProblem[] {
  const properties = (schema.row_schema.properties as Json | undefined) ?? {};
  const required = (schema.row_schema.required as string[] | undefined) ?? [];
  const refused = new Set(schema.refused_fields ?? []);
  const keyName = schema.source_key || 'source_key';
  const seen = new Set<string>();
  const problems: RowProblem[] = [];
  rows.forEach((row, position) => {
    const raw = row[keyName];
    const key = raw === undefined || raw === null || raw === '' ? null : String(raw);
    let found: [string, string] | null = null;
    for (const name of Object.keys(row)) {
      if (refused.has(name)) found = [name, 'field_refused'];
      else if (!(name in properties)) found = [name, 'field_unknown'];
      if (found) break;
    }
    if (!found) {
      const absent = required.find((name) => row[name] === undefined || row[name] === '');
      if (absent) found = [absent, 'required'];
    }
    if (!found) {
      for (const [name, value] of Object.entries(row)) {
        const reason = valueProblem(value, propertyOf(schema, name));
        if (reason) {
          found = [name, `invalid: ${reason}`];
          break;
        }
      }
    }
    if (!found && key !== null) {
      if (seen.has(key)) found = [keyName, 'duplicate_key'];
      seen.add(key);
    }
    if (found) problems.push({ position, sourceKey: key, field: found[0], reason: found[1] });
  });
  return problems;
}

// ---------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------

export interface SystemCredentials {
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
  scope: string;
  apiBase: string;
}

/** The connection's credential from the environment. Never put the secret in a committed file. */
export function credentialsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): SystemCredentials {
  const missing = Object.values(ENV).filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`set ${missing.join(', ')} from the connection's credential`);
  }
  return {
    clientId: env[ENV.clientId] as string,
    clientSecret: env[ENV.clientSecret] as string,
    tokenEndpoint: env[ENV.tokenEndpoint] as string,
    scope: env[ENV.scope] as string,
    apiBase: (env[ENV.apiBase] as string).replace(/\/+$/, ''),
  };
}

export interface SystemClientOptions {
  fetch?: typeof fetch;
  attempts?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Korsi's machine door, `/system/v1`, as one system connection. The token is renewed before it
 * expires and once more on a `401`; a `429` waits as `Retry-After` says; a `5xx` or a dropped
 * connection is tried again with the same request -- every write here is idempotent.
 */
export class SystemClient {
  readonly credentials: SystemCredentials;
  private readonly fetcher: typeof fetch;
  private readonly attempts: number;
  private readonly maxWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private token: { value: string; expires: number } | null = null;

  constructor(credentials: SystemCredentials, options: SystemClientOptions = {}) {
    this.credentials = credentials;
    this.fetcher = options.fetch ?? createKorsiFetch();
    this.attempts = options.attempts ?? 5;
    this.maxWaitMs = options.maxWaitMs ?? 120_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }

  private async bearer(renew = false): Promise<string> {
    const now = Date.now();
    if (!renew && this.token && this.token.expires > now + 60_000) return this.token.value;
    const basic = Buffer.from(
      `${this.credentials.clientId}:${this.credentials.clientSecret}`
    ).toString('base64');
    let answer: Response;
    try {
      answer = await this.fetcher(this.credentials.tokenEndpoint, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          scope: this.credentials.scope,
        }).toString(),
      });
    } catch (error) {
      throw new KorsiUnreachable(`the token endpoint did not answer: ${String(error)}`);
    }
    if (answer.status !== 200) {
      throw new KorsiRefused(
        answer.status,
        'auth.token_refused',
        "the token endpoint refused the connection's credentials -- check the client id and " +
          'secret, or make a new secret on the connections page',
        { problem: false }
      );
    }
    const body = (await answer.json()) as { access_token: string; expires_in?: number };
    this.token = { value: body.access_token, expires: now + (body.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  /** One call to the door, retried as the class says. */
  async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      query?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {}
  ): Promise<T> {
    const url = new URL(this.credentials.apiBase + path);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    }
    let renewed = false;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      const bearer = await this.bearer();
      let answer: Response;
      try {
        answer = await this.fetcher(url, {
          method,
          headers: {
            authorization: `Bearer ${bearer}`,
            [SYSTEM_VERSION_HEADER]: SYSTEM_API,
            ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(options.headers ?? {}),
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        });
      } catch (error) {
        if (attempt === this.attempts) {
          throw new KorsiUnreachable(`Korsi did not answer: ${String(error)}`);
        }
        await this.sleep(Math.min(2 ** attempt * 1000, this.maxWaitMs));
        continue;
      }
      if (answer.status === 401 && !renewed) {
        renewed = true;
        await this.bearer(true);
        continue;
      }
      if (answer.status === 429 && attempt < this.attempts) {
        const wait = Number(answer.headers.get('retry-after') ?? 2 ** attempt) * 1000;
        await this.sleep(Math.min(wait, this.maxWaitMs));
        continue;
      }
      if (answer.status >= 500 && attempt < this.attempts) {
        await this.sleep(Math.min(2 ** attempt * 1000, this.maxWaitMs));
        continue;
      }
      const text = await answer.text();
      const body = text ? (JSON.parse(text) as unknown) : null;
      if (answer.status >= 400) {
        const problem = (body ?? {}) as Json;
        const retry = answer.headers.get('retry-after');
        throw new KorsiRefused(
          answer.status,
          typeof problem.code === 'string' ? problem.code : `http.${answer.status}`,
          (problem.title as string | undefined) ?? (problem.detail as string | undefined) ?? null,
          {
            params: (problem.params as Record<string, unknown> | undefined) ?? {},
            retryAfter: retry ? Number(retry) : null,
            problem: typeof problem.code === 'string',
          }
        );
      }
      return body as T;
    }
    throw new KorsiUnreachable('Korsi did not answer');
  }

  connection(): Promise<SystemSelf> {
    return this.request('GET', '/connection');
  }

  feedSchema(feed: string): Promise<FeedSchema> {
    return this.request('GET', `/feeds/${feed}`);
  }

  openRun(
    feed: string,
    options: { key: string; complete?: boolean; dryRun?: boolean }
  ): Promise<FeedRunView> {
    return this.request('POST', `/feeds/${feed}/runs`, {
      body: { complete: options.complete ?? false, dry_run: options.dryRun ?? false },
      headers: { 'idempotency-key': options.key },
    });
  }

  addBatch(feed: string, runId: string, seq: number, rows: Row[]): Promise<BatchReceipt> {
    return this.request('POST', `/feeds/${feed}/runs/${runId}/batches/${seq}`, {
      body: { rows },
    });
  }

  commit(feed: string, runId: string): Promise<FeedRunView> {
    return this.request('POST', `/feeds/${feed}/runs/${runId}/commit`);
  }

  run(
    feed: string,
    runId: string,
    options: { after?: number; status?: string } = {}
  ): Promise<FeedRunReport> {
    return this.request('GET', `/feeds/${feed}/runs/${runId}`, { query: options });
  }

  /** Every row's outcome, page after page. */
  async outcomes(feed: string, runId: string, status?: string): Promise<FeedRowOutcome[]> {
    const found: FeedRowOutcome[] = [];
    let after: number | undefined;
    for (;;) {
      const page = await this.run(feed, runId, {
        ...(after !== undefined ? { after } : {}),
        ...(status ? { status } : {}),
      });
      found.push(...page.outcomes);
      if (page.next_after === null) return found;
      after = page.next_after;
    }
  }

  /** Apply this connection's own dry run, on a live connection, when it is no large change. */
  apply(feed: string, runId: string): Promise<FeedRunView> {
    return this.request('POST', `/feeds/${feed}/runs/${runId}/apply`);
  }

  putRow(feed: string, sourceKey: string, row: Row): Promise<FedRowResult> {
    return this.request('PUT', `/feeds/${feed}/rows/${encodeURIComponent(sourceKey)}`, {
      body: row,
    });
  }

  getRow(feed: string, sourceKey: string): Promise<FedRow> {
    return this.request('GET', `/feeds/${feed}/rows/${encodeURIComponent(sourceKey)}`);
  }
}

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Json)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, inner]) => [name, sorted(inner)])
    );
  }
  return value;
};

/** A run's key from what it carries: the same rows again are the same run. */
export function runKey(
  feed: string,
  rows: Row[],
  options: { complete?: boolean; dryRun?: boolean } = {}
): string {
  const digest = createHash('sha256');
  digest.update(`${feed}|${options.complete ?? false}|${options.dryRun ?? false}|`);
  for (const row of rows) digest.update(`${JSON.stringify(sorted(row))}\n`);
  return `korsi-feed-${digest.digest('hex').slice(0, 40)}`;
}

/** Rows split into batches the door takes: at most 500 rows and under a megabyte each. */
export function batches(rows: Row[]): Row[][] {
  const found: Row[][] = [];
  let current: Row[] = [];
  let size = 20;
  for (const row of rows) {
    const width = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (
      current.length &&
      (current.length >= BATCH_MAX_ROWS || size + width > BATCH_MAX_BYTES - 1000)
    ) {
      found.push(current);
      current = [];
      size = 20;
    }
    current.push(row);
    size += width;
  }
  if (current.length) found.push(current);
  return found;
}

export interface PushResult {
  run: FeedRunView;
  /** The rows that wait for a person or were refused, with why. */
  attention: FeedRowOutcome[];
}

/** Open a run, send the rows in batches, commit it, and read what needs attention. */
export async function push(
  client: SystemClient,
  feed: string,
  rows: Row[],
  options: { complete?: boolean; dryRun?: boolean; key?: string } = {}
): Promise<PushResult> {
  const key = options.key ?? runKey(feed, rows, options);
  let run = await client.openRun(feed, {
    key,
    complete: options.complete ?? false,
    dryRun: options.dryRun ?? false,
  });
  if (run.status === 'open') {
    const chunks = batches(rows);
    for (let seq = 0; seq < chunks.length; seq += 1) {
      await client.addBatch(feed, run.id, seq, chunks[seq] as Row[]);
    }
    run = await client.commit(feed, run.id);
  }
  const attention = (await client.outcomes(feed, run.id)).filter(
    (row) => row.status === 'waiting' || row.status === 'refused'
  );
  return { run, attention };
}

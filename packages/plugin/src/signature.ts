/**
 * Korsi's signature: what makes a call Korsi's and not anybody's.
 *
 * Every lifecycle call, event and tool call Korsi sends a plugin carries
 *
 *     Korsi-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
 *
 * under the installation's signing secret. The body is signed byte for byte, so verify the raw body
 * you received -- `express.raw()`, `await request.text()` -- before any JSON parser has touched it.
 * An old signature is refused, so a captured request cannot be replayed later.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { RequestRejected } from './errors.js';

/** The header Korsi signs with. */
export const SIGNATURE_HEADER = 'Korsi-Signature';
/** The event's id, on every event delivery, for deduplication. */
export const EVENT_ID_HEADER = 'Korsi-Event-Id';
/** How old a signature may be before it is refused as a replay: five minutes. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** A body as it arrived: the bytes, or the text they decode to. */
export type RawBody = string | Uint8Array;

/** A request that does not carry Korsi's signature for this installation. Answer 401. */
export class SignatureInvalid extends RequestRejected {
  constructor(message: string) {
    super(message, 401);
  }
}

function bytes(body: RawBody): Uint8Array {
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}

function digest(secret: string, stamp: string, body: RawBody): string {
  return createHmac('sha256', secret).update(`${stamp}.`).update(bytes(body)).digest('hex');
}

/** The header Korsi would send for `body`: for tests, and for reading the scheme. */
export function sign(secret: string, body: RawBody, { now }: { now?: number } = {}): string {
  const stamp = String(now ?? Math.floor(Date.now() / 1000));
  return `t=${stamp},v1=${digest(secret, stamp, body)}`;
}

/**
 * Throw `SignatureInvalid` unless `header` is Korsi's signature of `body`.
 *
 * More than one `v1` is accepted, and any one matching passes: the shape a signing secret's
 * rotation takes, when Korsi signs with the old secret and the new one for a while.
 */
export function verifySignature(
  secret: string,
  body: RawBody,
  header: string | null | undefined,
  { tolerance = DEFAULT_TOLERANCE_SECONDS, now }: { tolerance?: number; now?: number } = {}
): void {
  if (!header) throw new SignatureInvalid('missing Korsi-Signature');
  let stamp = '';
  const digests: string[] = [];
  for (const part of header.split(',')) {
    const [key, ...rest] = part.trim().split('=');
    const value = rest.join('=');
    if (key === 't') stamp = value;
    else if (key === 'v1' && value) digests.push(value);
  }
  const current = now ?? Date.now() / 1000;
  if (!/^\d+$/.test(stamp) || Math.abs(current - Number(stamp)) > tolerance) {
    throw new SignatureInvalid('stale or malformed signature');
  }
  const expected = Buffer.from(digest(secret, stamp, body), 'utf8');
  // Every candidate is compared in constant time, so the time taken says nothing about which.
  let matched = false;
  for (const candidate of digests) {
    const given = Buffer.from(candidate, 'utf8');
    if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true;
  }
  if (!matched) throw new SignatureInvalid('signature does not match');
}

/** A header from Node's `IncomingHttpHeaders`, a Fetch `Headers`, or a plain object. */
export type HeaderSource =
  Headers | { get(name: string): string | null } | Record<string, string | string[] | undefined>;

/** One header's value, whatever shape the framework gives headers in. Names are case-insensitive. */
export function headerValue(headers: HeaderSource, name: string): string | null {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name);
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[]>)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? (value[0] ?? null) : value;
  }
  return null;
}

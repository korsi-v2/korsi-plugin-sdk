/**
 * Remembering which events were handled: Korsi delivers at least once.
 *
 * An event can arrive twice -- the plugin answered too slowly, a network dropped the answer -- and
 * is the same event both times (`Korsi-Event-Id`, the body's `id`). `EventLog` is what
 * `KorsiPlugin.event` asks before handling one, in three steps:
 *
 * - `claim` takes the event, atomically, for a *lease*: `new` the first time, `done` once it was
 *   handled, `busy` while another delivery holds it. Korsi times a delivery out after ten seconds
 *   and tries again later, so a slow handler's event arrives again while it still runs: that
 *   delivery is told to come back (a 503), not that the event was handled.
 * - `finish` records it as handled -- only after the handler returned;
 * - `forget` gives the claim back when the handler failed, so Korsi's next attempt runs it.
 *
 * A claim whose lease ran out was a process that died mid-handler: the next delivery takes it over
 * instead of being told `busy` forever. So an event runs at least once, and handlers must be
 * idempotent. Keep the log where the plugin keeps its own data (an `INSERT ... ON CONFLICT DO
 * UPDATE ... WHERE` is a claim); `MemoryEventLog` forgets on restart and suits tests.
 */

export type ClaimStatus = 'new' | 'busy' | 'done';

/** How long a claim holds before another delivery may take it over, in seconds. */
export const DEFAULT_LEASE_SECONDS = 300;

export interface EventLog {
  /** Take the event: `new` (run it), `busy` (another delivery runs it), `done`. */
  claim(installationId: string, eventId: string, leaseSeconds: number): Promise<ClaimStatus>;
  /** The event was handled: every later delivery of it is `done`. */
  finish(installationId: string, eventId: string): Promise<void>;
  /** Release a claim: the event was not handled after all. */
  forget(installationId: string, eventId: string): Promise<void>;
}

/** The newest `capacity` events, in memory. Korsi's retries come within a day. */
export class MemoryEventLog implements EventLog {
  readonly #capacity: number;
  /** key -> null once done, or the moment (ms) the claim's lease runs out. */
  readonly #seen = new Map<string, number | null>();
  /** The clock, in milliseconds; replaceable in tests. */
  now: () => number = () => Date.now();

  constructor(capacity = 50_000) {
    this.#capacity = capacity;
  }

  async claim(installationId: string, eventId: string, leaseSeconds: number): Promise<ClaimStatus> {
    const key = `${installationId}:${eventId}`;
    const now = this.now();
    if (this.#seen.has(key)) {
      const until = this.#seen.get(key)!;
      // Most recently seen goes last, so the oldest are the ones let go.
      this.#seen.delete(key);
      this.#seen.set(key, until);
      if (until === null) return 'done';
      if (until > now) return 'busy';
    }
    this.#seen.set(key, now + leaseSeconds * 1000);
    for (const oldest of this.#seen.keys()) {
      if (this.#seen.size <= this.#capacity) break;
      this.#seen.delete(oldest);
    }
    return 'new';
  }

  async finish(installationId: string, eventId: string): Promise<void> {
    this.#seen.set(`${installationId}:${eventId}`, null);
  }

  async forget(installationId: string, eventId: string): Promise<void> {
    const key = `${installationId}:${eventId}`;
    if (this.#seen.get(key) !== null) this.#seen.delete(key);
  }
}

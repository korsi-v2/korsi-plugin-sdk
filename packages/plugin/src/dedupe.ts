/**
 * Remembering which events were handled: Korsi delivers at least once.
 *
 * An event can arrive twice -- the plugin answered too slowly, a network dropped the answer -- and
 * is the same event both times (`Korsi-Event-Id`, the body's `id`). `EventLog` is what
 * `KorsiPlugin.event` asks before handling one:
 *
 * - `firstTime` *claims* an event, atomically, so two deliveries racing each other run it once;
 * - `forget` gives the claim back when handling failed, so Korsi's next attempt runs it again.
 *
 * Keep it where the plugin keeps its own data -- a claim and the work it guards belong in one
 * store (`INSERT ... ON CONFLICT DO NOTHING` is a claim). `MemoryEventLog` forgets on restart and
 * suits tests and a single process.
 */

export interface EventLog {
  /** Claim the event: true the first time, false for every repeat. */
  firstTime(installationId: string, eventId: string): Promise<boolean>;
  /** Release a claim: the event was not handled after all. */
  forget(installationId: string, eventId: string): Promise<void>;
}

/** The newest `capacity` event ids, in memory. Korsi's retries come within a day. */
export class MemoryEventLog implements EventLog {
  readonly #capacity: number;
  readonly #seen = new Set<string>();

  constructor(capacity = 50_000) {
    this.#capacity = capacity;
  }

  async firstTime(installationId: string, eventId: string): Promise<boolean> {
    const key = `${installationId}:${eventId}`;
    if (this.#seen.has(key)) {
      // Most recently seen goes last, so the oldest are the ones let go.
      this.#seen.delete(key);
      this.#seen.add(key);
      return false;
    }
    this.#seen.add(key);
    for (const oldest of this.#seen) {
      if (this.#seen.size <= this.#capacity) break;
      this.#seen.delete(oldest);
    }
    return true;
  }

  async forget(installationId: string, eventId: string): Promise<void> {
    this.#seen.delete(`${installationId}:${eventId}`);
  }
}

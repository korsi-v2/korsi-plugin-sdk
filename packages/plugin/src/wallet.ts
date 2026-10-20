/**
 * The installation's wallet: MU an organization bought for this plugin, spent per service.
 *
 * **Korsi prices, the plugin counts.** The plugin says which service (declared in its manifest's
 * `services`) and how many; Korsi computes MU from the active plan's rate.
 *
 * **Reserve, then settle** -- or, for a service done the moment it is asked for, consume in one
 * call. `KorsiClient.reserve` is the pair around one function, so a service that fails releases
 * what it reserved instead of leaving it held until the hold expires.
 *
 * **Amounts are exact.** Korsi sends MU as decimal strings, and they stay strings here: JavaScript
 * has no decimal type, and a float would lose what an organization paid for. `compareAmounts` and
 * `Wallet.covers` compare them exactly.
 */
import { Code, KorsiRefused } from './errors.js';
import type { PlanPeriod, WalletView } from './models.js';

/** A quantity or an amount, exact: a decimal string, or an integer. */
export type Quantity = string | number | bigint;

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/;

function scaled(value: Quantity, scale: number): bigint {
  const text = typeof value === 'string' ? value.trim() : String(value);
  const match = DECIMAL.exec(text);
  if (!match || (!match[2] && !match[3])) throw new TypeError(`not a decimal amount: ${text}`);
  const fraction = (match[3] ?? '').padEnd(scale, '0').slice(0, scale);
  const magnitude = BigInt(`${match[2] || '0'}${fraction}` || '0');
  return match[1] === '-' ? -magnitude : magnitude;
}

function scaleOf(value: Quantity): number {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** `-1`, `0` or `1` as `a` is less than, equal to or more than `b`, compared exactly. */
export function compareAmounts(a: Quantity, b: Quantity): -1 | 0 | 1 {
  const scale = Math.max(scaleOf(a), scaleOf(b));
  const left = scaled(a, scale);
  const right = scaled(b, scale);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** An amount as Korsi accepts it: a decimal string. Throws on anything else (a float's `1e-7`). */
export function amountText(value: Quantity): string {
  const text = typeof value === 'string' ? value.trim() : String(value);
  if (!DECIMAL.test(text) || text === '' || text === '.') {
    throw new TypeError(`not a decimal amount: ${text}`);
  }
  return text;
}

/** A wallet's amounts, as Korsi sent them, with an exact comparison. */
export class Wallet {
  readonly balance: string;
  readonly reserved: string;
  /** What can be reserved now: the balance less what is reserved. */
  readonly available: string;
  readonly consumedThisPeriod: string;
  readonly creditedThisPeriod: string;
  readonly planKey: string | null;
  readonly planPeriod: PlanPeriod | null;
  readonly periodEndsAt: Date | null;

  constructor(view: WalletView) {
    this.balance = view.balance;
    this.reserved = view.reserved;
    this.available = view.available;
    this.consumedThisPeriod = view.consumed_this_period;
    this.creditedThisPeriod = view.credited_this_period;
    this.planKey = view.plan_key ?? null;
    this.planPeriod = view.plan_period ?? null;
    this.periodEndsAt = view.period_ends_at ? new Date(view.period_ends_at) : null;
  }

  static of(view: WalletView): Wallet {
    return new Wallet(view);
  }

  get hasPlan(): boolean {
    return this.planKey !== null;
  }

  /** Whether `amountMu` could be reserved now. Korsi decides; this only predicts. */
  covers(amountMu: Quantity): boolean {
    return compareAmounts(this.available, amountMu) >= 0;
  }
}

/**
 * Whether `error` is Korsi saying the wallet cannot cover a service (402). The answer to show the
 * person is "your organization needs a plan for this plugin" -- only Korsi sells one -- never a
 * retry.
 */
export function isWalletInsufficient(error: unknown): boolean {
  return error instanceof KorsiRefused && error.code === Code.walletInsufficient;
}

/** Whether `error` is Korsi saying the organization has no active plan for this plugin. */
export function isNoActivePlan(error: unknown): boolean {
  return error instanceof KorsiRefused && error.code === Code.noActivePlan;
}

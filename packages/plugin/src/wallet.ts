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

/** Korsi writes amounts the way Python's `Decimal` does: `10.5000`, and also `0E-10`, `5.000E-7`. */
const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/** An exact decimal: `digits / 10 ** scale`, with `scale` at least zero. */
interface Exact {
  digits: bigint;
  scale: number;
}

function exact(value: Quantity): Exact {
  if (typeof value === 'bigint') return { digits: value, scale: 0 };
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new TypeError(`pass ${value} as a decimal string: a float is not an exact amount`);
  }
  const text = typeof value === 'string' ? value.trim() : String(value);
  const match = DECIMAL.exec(text);
  if (!match || (!match[2] && !match[3])) throw new TypeError(`not a decimal amount: ${text}`);
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? 0);
  let digits = BigInt(`${match[2] || '0'}${fraction}` || '0');
  let scale = fraction.length - exponent;
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { digits: match[1] === '-' ? -digits : digits, scale };
}

/** `-1`, `0` or `1` as `a` is less than, equal to or more than `b`, compared exactly. */
export function compareAmounts(a: Quantity, b: Quantity): -1 | 0 | 1 {
  const left = exact(a);
  const right = exact(b);
  const scale = Math.max(left.scale, right.scale);
  const l = left.digits * 10n ** BigInt(scale - left.scale);
  const r = right.digits * 10n ** BigInt(scale - right.scale);
  if (l === r) return 0;
  return l < r ? -1 : 1;
}

/**
 * An amount as Korsi accepts it: a decimal string. Throws on anything inexact -- a float such as
 * `0.1 + 0.2`, or text that is not a number -- rather than send what nobody meant.
 */
export function amountText(value: Quantity): string {
  exact(value);
  return typeof value === 'string' ? value.trim() : String(value);
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

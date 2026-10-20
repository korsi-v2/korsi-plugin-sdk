/**
 * Dates and numbers as the organization writes them, through `Intl` -- no calendar library.
 *
 * Korsi's rule (steering 10, i18n): **the calendar and the digits are the organization's, the
 * language only names the months.** A Persian organization reading Korsi in English still
 * schedules in Jalali and may well write Persian digits. So:
 *
 * - `calendar_system: 'jalali'` → `-u-ca-persian`; otherwise Gregorian;
 * - `numerals: 'persian'` → `-u-nu-arabext` (۰۱۲۳); `latin` → `-u-nu-latn`;
 * - the language (`fa`, `en`, `ar`) chooses the words, and the time zone is the person's.
 *
 * Every function takes the context (or the part of it that matters) rather than reading a global,
 * so a server rendering for a person formats the same way the page will.
 */
import type { KorsiContext } from '@korsi/bridge';

/** What formatting needs from `korsi:init`. */
export type FormatContext = Partial<
  Pick<KorsiContext, 'locale' | 'calendar_system' | 'numerals' | 'timezone'>
>;

/** Korsi's defaults: a Persian organization. */
const DEFAULTS: Required<Omit<FormatContext, 'timezone'>> & { timezone: string | null } = {
  locale: 'fa',
  calendar_system: 'jalali',
  numerals: 'persian',
  timezone: null,
};

const REGIONS: Record<string, string> = { fa: 'fa-IR', en: 'en-GB', ar: 'ar-SA' };

/**
 * The BCP 47 tag `Intl` should use: the language's region, the organization's calendar and digits.
 * `fa` + Jalali + Persian digits is `fa-IR-u-ca-persian-nu-arabext`.
 */
export function localeTag(context: FormatContext | null | undefined = DEFAULTS): string {
  const merged = { ...DEFAULTS, ...(context ?? {}) };
  const language = (merged.locale || 'fa').split('-')[0]!.toLowerCase();
  const base = REGIONS[language] ?? merged.locale;
  const calendar = merged.calendar_system === 'jalali' ? 'persian' : 'gregory';
  const digits = merged.numerals === 'latin' ? 'latn' : 'arabext';
  return `${base}-u-ca-${calendar}-nu-${digits}`;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A date-only value (`2026-10-20`) is a day, not an instant: it is read at noon UTC and shown in
 * UTC, so no time zone can move it to the day before or after.
 */
function instant(value: Date | string | number): { date: Date; dayOnly: boolean } {
  if (typeof value === 'string') {
    const day = DATE_ONLY.exec(value);
    if (day) {
      return {
        date: new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 12)),
        dayOnly: true,
      };
    }
  }
  return { date: value instanceof Date ? value : new Date(value), dayOnly: false };
}

function format(
  value: Date | string | number | null | undefined,
  context: FormatContext | null | undefined,
  options: Intl.DateTimeFormatOptions
): string {
  if (value === null || value === undefined || value === '') return '';
  const { date, dayOnly } = instant(value);
  if (Number.isNaN(date.getTime())) return '';
  const timeZone = dayOnly ? 'UTC' : (options.timeZone ?? context?.timezone ?? undefined);
  return new Intl.DateTimeFormat(localeTag(context), { ...options, timeZone }).format(date);
}

/** A day: `۲۸ مهر ۱۴۰۵` for a Persian organization. */
export function formatDate(
  value: Date | string | number | null | undefined,
  context?: FormatContext | null,
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric' }
): string {
  return format(value, context, options);
}

/** A moment, in the person's time zone: the day and the time. */
export function formatDateTime(
  value: Date | string | number | null | undefined,
  context?: FormatContext | null,
  options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }
): string {
  return format(value, context, options);
}

/** A time of day, in the person's time zone. */
export function formatTime(
  value: Date | string | number | null | undefined,
  context?: FormatContext | null,
  options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
): string {
  return format(value, context, options);
}

/**
 * A number in the organization's digits, with the language's separators. Decimal strings (MU,
 * amounts) are formatted without passing through a float where `Intl` allows it.
 */
export function formatNumber(
  value: number | bigint | string | null | undefined,
  context?: FormatContext | null,
  options: Intl.NumberFormatOptions = { maximumFractionDigits: 2 }
): string {
  if (value === null || value === undefined || value === '') return '';
  const formatter = new Intl.NumberFormat(localeTag(context), options);
  // Intl formats a decimal string exactly (ES2023); older engines read it as a Number.
  return formatter.format(value as unknown as number);
}

/** The parts of a date in the organization's calendar, as numbers: for a calendar grid. */
export function calendarParts(
  value: Date | string | number,
  context?: FormatContext | null
): { year: number; month: number; day: number } {
  const { date, dayOnly } = instant(value);
  const timeZone = dayOnly ? 'UTC' : (context?.timezone ?? undefined);
  const tag = localeTag({ ...context, locale: 'en', numerals: 'latin' });
  const parts = new Intl.DateTimeFormat(tag, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    timeZone,
  }).formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? NaN);
  return { year: read('year'), month: read('month'), day: read('day') };
}

const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC = '٠١٢٣٤٥٦٧٨٩';

/** Latin digits in `text` as Persian ones (۰-۹). Nothing else changes. */
export function toPersianDigits(text: string | number): string {
  return String(text).replace(/[0-9]/g, (digit) => PERSIAN[Number(digit)]!);
}

/** Persian (۰-۹) and Arabic-Indic (٠-٩) digits in `text` as Latin ones: for parsing what was typed. */
export function toLatinDigits(text: string): string {
  return text.replace(/[۰-۹٠-٩]/g, (digit) => {
    const persian = PERSIAN.indexOf(digit);
    return String(persian >= 0 ? persian : ARABIC.indexOf(digit));
  });
}

/** Digits as the organization writes them, for text `Intl` did not produce. */
export function organizationDigits(text: string | number, context?: FormatContext | null): string {
  return (context?.numerals ?? DEFAULTS.numerals) === 'latin'
    ? toLatinDigits(String(text))
    : toPersianDigits(text);
}

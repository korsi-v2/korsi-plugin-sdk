import { describe, expect, it } from 'vitest';

import {
  calendarParts,
  formatDate,
  formatDateTime,
  formatNumber,
  localeTag,
  organizationDigits,
  toLatinDigits,
  toPersianDigits,
} from '@korsi/plugin-ui';

const persianOrg = { locale: 'fa', calendar_system: 'jalali', numerals: 'persian' } as const;
const latinOrg = { locale: 'en', calendar_system: 'gregorian', numerals: 'latin' } as const;

describe("the organization's calendar and digits", () => {
  it('chooses the calendar and digits from the organization, the words from the language', () => {
    expect(localeTag(persianOrg)).toBe('fa-IR-u-ca-persian-nu-arabext');
    expect(localeTag(latinOrg)).toBe('en-GB-u-ca-gregory-nu-latn');
    // A Persian organization read in English: still Jalali, still Persian digits.
    expect(localeTag({ ...persianOrg, locale: 'en' })).toBe('en-GB-u-ca-persian-nu-arabext');
    expect(localeTag(undefined)).toBe('fa-IR-u-ca-persian-nu-arabext');
  });

  it('writes a day in Jalali with Persian digits, never moved by a time zone', () => {
    expect(formatDate('2026-10-20', persianOrg)).toBe('۲۸ مهر ۱۴۰۵');
    expect(formatDate('2026-10-20', { ...persianOrg, timezone: 'Pacific/Kiritimati' })).toBe(
      '۲۸ مهر ۱۴۰۵'
    );
    expect(formatDate('2026-10-20', latinOrg)).toBe('20 October 2026');
    expect(formatDate(null, persianOrg)).toBe('');
    expect(formatDate('not a date', persianOrg)).toBe('');
  });

  it("writes a moment in the person's time zone", () => {
    // 21:00 UTC is already the next day in Tehran.
    const moment = '2026-10-20T21:00:00Z';
    expect(formatDateTime(moment, { ...persianOrg, timezone: 'Asia/Tehran' })).toContain('۲۹ مهر');
    expect(formatDateTime(moment, { ...latinOrg, timezone: 'UTC' })).toContain('20 October 2026');
  });

  it('reads the Jalali calendar as numbers, for a grid', () => {
    expect(calendarParts('2026-03-21', persianOrg)).toEqual({ year: 1405, month: 1, day: 1 });
    expect(calendarParts('2026-03-21', latinOrg)).toEqual({ year: 2026, month: 3, day: 21 });
  });

  it("writes numbers in the organization's digits, decimal strings exactly", () => {
    expect(formatNumber(1234.5, persianOrg)).toBe('۱٬۲۳۴٫۵');
    expect(formatNumber(1234.5, latinOrg)).toBe('1,234.5');
    expect(formatNumber('12.25', latinOrg)).toBe('12.25');
    expect(formatNumber(undefined, latinOrg)).toBe('');
  });

  it('turns digits either way for text Intl did not write', () => {
    expect(toPersianDigits('کد 2026')).toBe('کد ۲۰۲۶');
    expect(toLatinDigits('۱۴۰۵/٠٧/۲۸')).toBe('1405/07/28');
    expect(organizationDigits('42', persianOrg)).toBe('۴۲');
    expect(organizationDigits('۴۲', latinOrg)).toBe('42');
  });
});

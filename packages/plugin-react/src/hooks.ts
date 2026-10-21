/**
 * What every page asks of Korsi's context once it is connected: the person's dates and numbers,
 * the plugin's own server read as them, and the page's words in their language.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { KorsiContext } from '@korsi/bridge';
import { formatDate, formatDateTime, formatNumber, formatTime } from '@korsi/plugin-ui';

import { useKorsiContext, usePluginApi } from './provider.js';

type Instant = Date | string | number | null | undefined;

export interface KorsiFormat {
  /** A day: `۲۸ مهر ۱۴۰۵` for a Persian organization. Empty for no value. */
  date(value: Instant, options?: Intl.DateTimeFormatOptions): string;
  /** A moment, in the person's time zone. */
  dateTime(value: Instant, options?: Intl.DateTimeFormatOptions): string;
  /** A time of day, in the person's time zone. */
  time(value: Instant, options?: Intl.DateTimeFormatOptions): string;
  /** A number in the organization's digits. No value is zero. */
  number(value: number | bigint | string | null | undefined): string;
}

/** Dates, times and numbers as Korsi writes them for this person: calendar, zone, digits. */
export function useKorsiFormat(): KorsiFormat {
  const context = useKorsiContext();
  return useMemo(
    () => ({
      date: (value, options) => (value ? formatDate(value, context, options) : ''),
      dateTime: (value, options) => (value ? formatDateTime(value, context, options) : ''),
      time: (value, options) => (value ? formatTime(value, context, options) : ''),
      number: (value) => formatNumber(value ?? 0, context),
    }),
    [context]
  );
}

export interface PluginData<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** Read it again: after the person changed something. */
  reload: () => void;
}

/**
 * `GET path` from the plugin's own server as the person, read again on `reload()` and when Korsi
 * moves the page to another record. A null path reads nothing. The last answer stays while the
 * next one is read, so a page does not blink back to a skeleton.
 */
export function usePluginData<T = unknown>(path: string | null | undefined): PluginData<T> {
  const api = usePluginApi();
  const recordId = useKorsiContext()?.context?.id ?? null;
  const [state, setState] = useState<Omit<PluginData<T>, 'reload'>>({
    data: null,
    error: null,
    loading: Boolean(path),
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return undefined;
    let live = true;
    setState((current) => ({ ...current, loading: true }));
    api.request<T>(path).then(
      (data) => {
        if (live) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (live) {
          const failure = error instanceof Error ? error : new Error(String(error));
          setState((current) => ({ ...current, error: failure, loading: false }));
        }
      }
    );
    return () => {
      live = false;
    };
  }, [api, path, tick, recordId]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { ...state, reload };
}

/** A page's words: one table of `key: text` per language Korsi may ask for (`fa`, `en`, `ar`). */
export type Messages = Readonly<Record<string, Readonly<Record<string, string>>>>;

export type Translate = (key: string, params?: Readonly<Record<string, unknown>>) => string;

/**
 * The language of `messages` to speak: the one Korsi's context asks for, else Persian (Korsi's own
 * default), else the first the page has. Without a context -- before Korsi answers, or outside it
 * -- the browser's languages decide.
 */
export function languageOf(
  context: Pick<KorsiContext, 'locale'> | null,
  messages: Messages
): string {
  const wanted = context?.locale
    ? [context.locale]
    : typeof navigator === 'undefined'
      ? []
      : [...(navigator.languages ?? []), navigator.language];
  for (const tag of wanted) {
    const lang = (tag ?? '').split('-')[0]!.toLowerCase();
    if (messages[lang]) return lang;
  }
  return messages.fa ? 'fa' : (Object.keys(messages)[0] ?? 'fa');
}

/**
 * `t(key, params)` in the person's language, following Korsi when it changes it. A key the
 * language lacks falls back to English, then to the key itself; `{name}` takes `params.name`.
 */
export function useMessages(messages: Messages): Translate {
  const lang = languageOf(useKorsiContext(), messages);
  return useCallback(
    (key, params = {}) => {
      const text = messages[lang]?.[key] ?? messages.en?.[key] ?? key;
      return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
    },
    [messages, lang]
  );
}

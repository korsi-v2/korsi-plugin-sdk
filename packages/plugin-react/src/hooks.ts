/**
 * What every page asks of Korsi's context once it is connected: the person's dates and numbers,
 * the plugin's own server read as them, and the page's words in their language -- and, where a
 * newer Korsi offers them, its file picker and the live room's state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  KorsiContext,
  LiveSegment,
  MeetingLive,
  PickedFile,
  PickFileOptions,
} from '@korsi/bridge';
import { formatDate, formatDateTime, formatNumber, formatTime } from '@korsi/plugin-ui';

import { onPageMove, useKorsi, useKorsiContext, usePluginApi } from './provider.js';

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

export interface FilePicker {
  /** Whether this Korsi has a file picker (`pickFile`, plugin API 1.2); offer the button only then. */
  supported: boolean;
  /** While Korsi's picker is open. */
  picking: boolean;
  /**
   * Open Korsi's file picker. Resolves the files the person picked -- already handed to this
   * installation, for the plugin's server to read -- or `[]` when they closed it. Throws on a Korsi
   * without the picker.
   */
  pick(options?: PickFileOptions): Promise<PickedFile[]>;
}

/** Korsi's own file picker: the person uploads into their «فایل‌های من», or picks what they have. */
export function usePickFile(): FilePicker {
  const { bridge } = useKorsi();
  const [picking, setPicking] = useState(false);
  const supported = typeof bridge?.pickFile === 'function';
  const pick = useCallback(
    async (options?: PickFileOptions) => {
      if (!bridge || typeof bridge.pickFile !== 'function') {
        throw new Error('korsi: this Korsi has no file picker (pickFile)');
      }
      setPicking(true);
      try {
        const files = await bridge.pickFile(options);
        return Array.isArray(files) ? files : [];
      } finally {
        setPicking(false);
      }
    },
    [bridge]
  );
  return useMemo(() => ({ supported, picking, pick }), [supported, picking, pick]);
}

export interface MeetingLiveView {
  /** Whether this Korsi pushes the live room's state (`onMeetingLive`, plugin API 1.2). */
  supported: boolean;
  /** The room's state as last pushed, with every line heard so far; null before the first push. */
  live: MeetingLive | null;
}

/**
 * One meeting's lines so far and a push: a line pushed again replaces itself, a new one is added,
 * and a name the room gives a voice (`speaker_key`) goes on that voice's earlier lines too.
 */
function withPush(current: MeetingLive | null, push: MeetingLive): MeetingLive {
  const same = current?.meeting_id === push.meeting_id;
  const lines = new Map<string, LiveSegment>(
    same ? current.segments.map((line) => [line.id, line]) : []
  );
  const voices = new Map<string, Pick<LiveSegment, 'speaker' | 'speaker_user_id'>>();
  for (const line of push.segments ?? []) {
    lines.set(line.id, line);
    voices.set(line.speaker_key, { speaker: line.speaker, speaker_user_id: line.speaker_user_id });
  }
  const segments = [...lines.values()].map((line) => {
    const voice = voices.get(line.speaker_key);
    return voice && voice.speaker !== line.speaker ? { ...line, ...voice } : line;
  });
  return { ...push, segments };
}

/**
 * The live room's state, for a `meeting.live.panel` page (ADR-0083): the room's state and clock,
 * and every line heard so far, following each push Korsi makes. `onPush` sees each push as it
 * came -- for a page that only needs to know something new was said and reads the rest from its
 * own server. The lines are a preview, never the record.
 */
export function useMeetingLive(onPush?: (push: MeetingLive) => void): MeetingLiveView {
  const { bridge } = useKorsi();
  const latest = useRef(onPush);
  latest.current = onPush;
  const [live, setLive] = useState<MeetingLive | null>(null);
  const supported = typeof bridge?.onMeetingLive === 'function';
  useEffect(() => {
    if (!bridge || typeof bridge.onMeetingLive !== 'function') return undefined;
    const stop = bridge.onMeetingLive((push) => {
      latest.current?.(push);
      setLive((current) => withPush(current, push));
    });
    return () => {
      stop();
    };
  }, [bridge]);
  return { supported, live };
}

/**
 * Names what the person is looking at on the app's page in Korsi's status bar -- a record's name,
 * «مراحل استخدام · مدیر محصول» -- over the app's name, as Korsi names its own pages (`setTitle`,
 * `korsi:title`). Set while the component is mounted and whenever `title` changes, said again after
 * every move (Korsi's, or the page's own through `useKorsiNavigation`), and cleared when it
 * unmounts. Null, undefined or empty clears it, and the bar names the app alone: pass null while
 * the record loads. Plain text, cut to 120 characters by Korsi.
 *
 * Use one per screen -- in the page, or in one place that knows the route: two mounted at once
 * overwrite each other in no set order. Heard only on the installation's own app page; a panel's is
 * ignored, and an older Korsi without `setTitle` ignores it.
 */
export function useKorsiTitle(title: string | null | undefined): void {
  const { bridge } = useKorsi();
  const text = typeof title === 'string' && title.trim() ? title : null;
  // Korsi lets a title go when the page moves and names nothing new, so a component that stays
  // mounted across a move -- a layout over several screens -- says it again.
  const [moves, setMoves] = useState(0);

  useEffect(() => {
    if (!bridge || typeof bridge.setTitle !== 'function') return undefined;
    const again = () => setMoves((count) => count + 1);
    const stopKorsi = bridge.onNavigate(again);
    const stopPage = onPageMove(bridge, again);
    return () => {
      stopKorsi();
      stopPage();
    };
  }, [bridge]);

  useEffect(() => {
    if (bridge && typeof bridge.setTitle === 'function') bridge.setTitle(text);
  }, [bridge, text, moves]);

  // Its own effect, so a new title or a move does not clear the bar first and blink it.
  useEffect(() => {
    if (!bridge || typeof bridge.setTitle !== 'function') return undefined;
    return () => bridge.setTitle?.(null);
  }, [bridge]);
}

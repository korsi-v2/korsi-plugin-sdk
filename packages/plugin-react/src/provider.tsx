/**
 * Korsi for a React page: one provider that connects and keeps the page in Korsi's look, and hooks
 * that read it.
 *
 *     <KorsiProvider allowedOrigins={['https://acme.korsi.ai']} outside={<p>Open me in Korsi</p>}>
 *       <App />
 *     </KorsiProvider>
 *
 *     function App() {
 *       const { context, api, bridge } = useKorsi();
 *       ...
 *     }
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { KorsiBridge, KorsiContext, PluginApi } from '@korsi/bridge';
import { mountKorsiPage, type KorsiPage, type MountOptions } from '@korsi/plugin-ui';

export type KorsiStatus = 'connecting' | 'ready' | 'outside' | 'failed';

export interface KorsiState {
  /** `connecting` until Korsi answers; `outside` when the page is not inside Korsi. */
  status: KorsiStatus;
  /** The context Korsi last sent: theme, language, calendar, digits, the person, the record. */
  context: KorsiContext | null;
  bridge: KorsiBridge | null;
  /** The plugin's own server, as the person. */
  api: PluginApi | null;
  korsiOrigin: string | null;
  error: Error | null;
}

const INITIAL: KorsiState = {
  status: 'connecting',
  context: null,
  bridge: null,
  api: null,
  korsiOrigin: null,
  error: null,
};

const KorsiReact = createContext<KorsiState | null>(null);

export interface KorsiProviderProps extends Omit<MountOptions, 'onChange' | 'root'> {
  children: ReactNode;
  /** Shown instead of `children` while connecting. Default: the children, with `status`. */
  connecting?: ReactNode;
  /** Shown instead of `children` when the page is not inside Korsi. */
  outside?: ReactNode;
  /** Shown instead of `children` when connecting failed. */
  failed?: ReactNode | ((error: Error) => ReactNode);
  /** Make the connection: for tests, or a page that connects some other way. */
  mount?: (options: MountOptions) => Promise<KorsiPage | null>;
}

/** Connects once, applies Korsi's theme to the document, and follows every change. */
export function KorsiProvider({
  children,
  connecting,
  outside,
  failed,
  mount = mountKorsiPage,
  ...options
}: KorsiProviderProps) {
  const [state, setState] = useState<KorsiState>(INITIAL);
  // Options are read once: a page connects to one Korsi for its life.
  const initial = useRef(options);

  useEffect(() => {
    let page: KorsiPage | null = null;
    let cancelled = false;
    mount({
      ...initial.current,
      onChange: (next) => {
        if (!cancelled) setState((current) => ({ ...current, context: next }));
      },
    }).then(
      (mounted) => {
        page = mounted;
        if (cancelled) {
          mounted?.stop();
          return;
        }
        setState(
          mounted
            ? {
                status: 'ready',
                context: mounted.context,
                bridge: mounted.bridge,
                api: mounted.api,
                korsiOrigin: mounted.korsiOrigin,
                error: null,
              }
            : { ...INITIAL, status: 'outside' }
        );
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            ...INITIAL,
            status: 'failed',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    );
    return () => {
      cancelled = true;
      page?.stop();
    };
  }, [mount]);

  let shown: ReactNode = children;
  if (state.status === 'connecting' && connecting !== undefined) shown = connecting;
  if (state.status === 'outside' && outside !== undefined) shown = outside;
  if (state.status === 'failed' && failed !== undefined) {
    shown = typeof failed === 'function' ? failed(state.error!) : failed;
  }
  return <KorsiReact.Provider value={state}>{shown}</KorsiReact.Provider>;
}

/** Everything the provider knows. Throws outside a `KorsiProvider`. */
export function useKorsi(): KorsiState {
  const state = useContext(KorsiReact);
  if (!state) throw new Error('useKorsi must be used inside <KorsiProvider>');
  return state;
}

/** Korsi's context, re-rendering when it changes; null before Korsi answers. */
export function useKorsiContext(): KorsiContext | null {
  return useKorsi().context;
}

/**
 * A function returning a live handle for the person: renewed by the Bridge before it runs out.
 * Ask for it at the moment of the call and send it to your server; never keep it in state.
 */
export function useHandle(): () => Promise<string> {
  const { bridge } = useKorsi();
  return useCallback(() => {
    if (!bridge) return Promise.reject(new Error('korsi: not connected'));
    return bridge.getHandle();
  }, [bridge]);
}

/** The plugin's own server, as the person (`Authorization` and `X-Korsi-Installation` set). */
export function usePluginApi(): PluginApi {
  const { api } = useKorsi();
  return useMemo(
    () =>
      api ?? {
        fetch: () => Promise.reject(new Error('korsi: not connected')),
        request: () => Promise.reject(new Error('korsi: not connected')),
      },
    [api]
  );
}

/** Who hears the moves a page makes through `useKorsiNavigation`, by Bridge. */
const pageMoves = new WeakMap<KorsiBridge, Set<() => void>>();

/**
 * Called after each move the page makes through `useKorsiNavigation`. For `useKorsiTitle`, which
 * says its title again after a move; not part of the package's API.
 */
export function onPageMove(bridge: KorsiBridge, listener: () => void): () => void {
  let listeners = pageMoves.get(bridge);
  if (!listeners) {
    listeners = new Set();
    pageMoves.set(bridge, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How a move the page makes enters Korsi's history (`useKorsiNavigation`). */
export interface KorsiMoveOptions {
  /** No new entry: a redirect, a corrected address. */
  replace?: boolean;
  /**
   * A move back to the screen before (a form or dialog closed by its own button): Korsi steps its
   * history back when the entry before is this path, else replaces -- and an older Korsi replaces.
   */
  back?: boolean;
}

/**
 * Follow Korsi's address: `listener` is called when the person moves under the page (back, a tab).
 * Returns a function telling Korsi the page moved, so its address follows -- as a new entry in the
 * history, so back returns to the screen before it; `{ replace: true }` moves without one, and
 * `{ back: true }` steps Korsi back onto the screen before when that is the path (closing a form by
 * its own button, so back is not pressed once for nothing), else replaces.
 */
export function useKorsiNavigation(
  listener?: (path: string) => void
): (path: string, options?: KorsiMoveOptions) => void {
  const { bridge } = useKorsi();
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => {
    if (!bridge) return undefined;
    const stop = bridge.onNavigate((path) => latest.current?.(path));
    return () => {
      stop();
    };
  }, [bridge]);
  return useCallback(
    (path: string, options?: KorsiMoveOptions) => {
      if (!bridge) return;
      // `back` always carries `replace`: a Korsi older than `back` reads only that, and replaces.
      bridge.navigate(path, options?.back ? { replace: true, back: true } : options);
      pageMoves.get(bridge)?.forEach((moved) => moved());
    },
    [bridge]
  );
}

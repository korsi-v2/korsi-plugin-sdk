/**
 * A plugin page inside Korsi, in one call: connect, look like Korsi, keep looking like it, size the
 * frame, and call the plugin's own server as the person.
 *
 *     import { mountKorsiPage } from '@korsi/plugin-ui';
 *
 *     const page = await mountKorsiPage({ allowedOrigins: ['https://acme.korsi.ai'] });
 *     if (!page) showOutsideKorsi();
 *     else {
 *       const me = await page.api.request('/api/me');
 *       if (await page.bridge.confirm({ title: 'Read this email?' })) ...
 *     }
 */
import {
  connectKorsi,
  createPluginApi,
  type ConnectKorsiOptions,
  type KorsiBridge,
  type KorsiContext,
  type PluginApi,
} from '@korsi/bridge';

import { loadKorsiFonts } from './fonts.js';
import { applyContext } from './theme.js';

export interface MountOptions extends ConnectKorsiOptions {
  /** Load Korsi's typefaces from the Korsi framing the page. Default true. */
  fonts?: boolean;
  /** Keep telling Korsi the page's height, for a frame that grows with it. Default true. */
  resize?: boolean;
  /** The path the plugin is served under, for `api` calls. */
  base?: string;
  /** Where the context is written. Default the document element. */
  root?: HTMLElement;
  /** Called with every later context: the theme, the language or the record changed. */
  onChange?: (context: KorsiContext) => void;
}

export interface KorsiPage {
  bridge: KorsiBridge;
  /** The context Korsi last sent. */
  readonly context: KorsiContext;
  korsiOrigin: string;
  /** The plugin's own server, as the person. */
  api: PluginApi;
  /** Stop following Korsi's changes and the page's height. */
  stop(): void;
}

/** Connect and keep the page in Korsi's look. Null when the page is not inside Korsi. */
export async function mountKorsiPage(options: MountOptions = {}): Promise<KorsiPage | null> {
  const connection = await connectKorsi(options);
  if (!connection) return null;
  const { bridge, korsiOrigin } = connection;
  const root = options.root ?? document.documentElement;
  let context = connection.context;
  applyContext(context, root);

  const fonts = options.fonts === false ? Promise.resolve([]) : loadKorsiFonts(korsiOrigin);
  fonts.catch(() => undefined);

  let first = true;
  const unsubscribe = bridge.onInit((next) => {
    // onInit replays the context it already has; that one is applied above.
    if (first && next === connection.context) {
      first = false;
      return;
    }
    first = false;
    context = next;
    applyContext(next, root);
    options.onChange?.(next);
  });
  const stopResize = options.resize === false ? () => undefined : bridge.resize();

  return {
    bridge,
    get context() {
      return context;
    },
    korsiOrigin,
    api: createPluginApi(bridge, { base: options.base }),
    stop() {
      unsubscribe();
      stopResize();
    },
  };
}

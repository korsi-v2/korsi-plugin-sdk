/**
 * Korsi's side of the frame, faked: a parent window the page posts to, and a way to answer it the
 * way the shell does. The runtime is Korsi's own file, imported from the checkout beside this one
 * (`korsi-app/public/sdk/korsi-bridge.js`) or from `KORSI_BRIDGE_RUNTIME`.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const KORSI = 'https://acme.korsi.test';

export const RUNTIME =
  process.env.KORSI_BRIDGE_RUNTIME ??
  // Tests run from this repository's root, beside korsi-app.
  resolve(process.cwd(), '../korsi-app/public/sdk/korsi-bridge.js');

export const hasRuntime = existsSync(RUNTIME);

/**
 * The runtime, imported as the browser would: as an ES module. Korsi's file sits in a package
 * without `"type": "module"`, so it is copied -- fresh each run -- to an `.mjs` beside this
 * repository's modules.
 */
let copied = false;
export function importRuntime(): Promise<any> {
  const copy = resolve(process.cwd(), 'node_modules/.cache/korsi-bridge-runtime/korsi-bridge.mjs');
  if (!copied) {
    mkdirSync(resolve(copy, '..'), { recursive: true });
    copyFileSync(RUNTIME, copy);
    copied = true;
  }
  return import(/* @vite-ignore */ copy);
}

export interface Posted {
  message: { protocol: string; type: string; id?: string; payload?: any };
  origin: string;
}

/** Put the page inside a frame whose parent is Korsi, and record what it posts there. */
export function frameInKorsi() {
  const posted: Posted[] = [];
  const parent = {
    postMessage(message: Posted['message'], origin: string) {
      posted.push({ message, origin });
    },
  };
  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  const deliver = (data: unknown, origin = KORSI, source: unknown = parent) => {
    const event = new Event('message');
    Object.defineProperties(event, {
      data: { value: data },
      origin: { value: origin },
      source: { value: source },
    });
    window.dispatchEvent(event);
  };
  return { parent, posted, deliver };
}

export function context(overrides: Record<string, unknown> = {}) {
  return {
    locale: 'fa',
    dir: 'rtl',
    theme: {
      mode: 'dark',
      font_family: 'YekanBakh, -apple-system, sans-serif',
      palette: {
        primary: '#00A76F',
        on_primary: '#FFFFFF',
        background: '#141A21',
        text: '#FFFFFF',
      },
    },
    calendar_system: 'jalali',
    numerals: 'persian',
    timezone: 'Asia/Tehran',
    user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'آنا' },
    organization: { slug: 'acme', name: 'Acme' },
    installation_id: '11111111-1111-4111-8111-111111111111',
    plugin_id: 'ir.acme.sample',
    path: '/',
    context: null,
    handle: { token: 'kph_first', expires_at: new Date(Date.now() + 15 * 60_000).toISOString() },
    ...overrides,
  };
}

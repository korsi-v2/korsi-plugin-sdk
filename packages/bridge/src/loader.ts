/**
 * Finding the Korsi that frames the page, and loading its Bridge.
 *
 * **Where Korsi is.** Korsi puts its origin on the frame's address (`?korsi_origin=`); a page the
 * plugin navigated to inside the frame no longer has it, so the Bridge remembers the first one for
 * the tab (`sessionStorage`), and so does this. Where the browser records the parent
 * (`location.ancestorOrigins`), the two must agree. A claimed origin outside `allowedOrigins` is
 * not believed -- pass them in production, with `Content-Security-Policy: frame-ancestors` on the
 * page: the parameter says where Korsi is, the header is what stops anybody else framing you.
 *
 * **Loading.** The runtime is imported from `<korsi>/sdk/korsi-bridge.js` at run time, never
 * bundled, so it is always the protocol of the Korsi the page is in. The page's
 * `Content-Security-Policy` must allow it: `script-src <korsi origins>`.
 */
import { BRIDGE_FUNCTIONS, PROTOCOL, type KorsiBridge, type KorsiContext } from './protocol.js';

/** Where the Bridge client keeps the origin it pinned, for the tab. Shared with the runtime. */
const REMEMBERED = 'korsi-bridge:origin';

/** The runtime's address on a Korsi. */
export function bridgeUrl(korsiOrigin: string): string {
  return `${normaliseOrigin(korsiOrigin) ?? korsiOrigin}/sdk/korsi-bridge.js`;
}

/** An origin (`https://acme.korsi.ai`) from anything URL-shaped, or null. */
export function normaliseOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

function remembered(): string | null {
  try {
    return normaliseOrigin(window.sessionStorage.getItem(REMEMBERED));
  } catch {
    return null;
  }
}

function remember(origin: string): void {
  try {
    window.sessionStorage.setItem(REMEMBERED, origin);
  } catch {
    // Storage refused (a private window, a blocked frame): the next page needs the parameter.
  }
}

function parentOrigin(location: Location): string | null {
  const ancestors = location.ancestorOrigins;
  return ancestors && ancestors.length ? normaliseOrigin(ancestors[0]) : null;
}

/**
 * The Korsi origin this page is framed by, as far as the page can tell, or null.
 *
 * @param allowedOrigins The Korsi origins the page trusts; any other is not believed. With exactly
 *   one and nothing else to go on, that one is assumed.
 */
export function korsiOrigin(
  allowedOrigins?: readonly string[],
  location: Location = window.location
): string | null {
  const allowed = allowedOrigins?.map(normaliseOrigin).filter((o): o is string => Boolean(o));
  const claimed =
    normaliseOrigin(new URLSearchParams(location.search).get('korsi_origin')) ?? remembered();
  const known = parentOrigin(location);
  let origin = claimed ?? known;
  if (claimed && known && claimed !== known) return null;
  if (!origin && allowed?.length === 1) origin = allowed[0] ?? null;
  if (!origin) return null;
  if (allowed?.length && !allowed.includes(origin)) return null;
  return origin;
}

/** Whether this page is inside a frame at all. Outside, there is no Korsi to talk to. */
export function isFramed(): boolean {
  try {
    return typeof window !== 'undefined' && window.parent !== window;
  } catch {
    return true;
  }
}

/** A runtime that does not speak the protocol this package describes. */
export class BridgeVersionError extends Error {
  constructor(readonly found: string | undefined) {
    super(`korsi-bridge: Korsi speaks ${found ?? 'an unknown protocol'}, not ${PROTOCOL}`);
    this.name = 'BridgeVersionError';
  }
}

export type ImportModule = (url: string) => Promise<unknown>;

/** A native `import()` no bundler rewrites: the module is the Korsi's, fetched at run time. */
const nativeImport: ImportModule = (url) =>
  import(/* webpackIgnore: true */ /* @vite-ignore */ /* turbopackIgnore: true */ url);

const loaded = new Map<string, Promise<KorsiBridge>>();

/**
 * Import the Bridge runtime from a Korsi, once per origin, and check it is the Bridge.
 *
 * Rejects with `BridgeVersionError` when the runtime says it speaks another protocol: a page built
 * for `korsi-bridge/1` would misread `korsi-bridge/2`, so it should say so rather than guess.
 */
export function loadBridge(
  origin: string,
  { importModule = nativeImport }: { importModule?: ImportModule } = {}
): Promise<KorsiBridge> {
  const url = bridgeUrl(origin);
  let pending = loaded.get(url);
  if (!pending) {
    pending = importModule(url).then((module) => checked(module));
    pending.catch(() => loaded.delete(url));
    loaded.set(url, pending);
  }
  return pending;
}

function checked(module: unknown): KorsiBridge {
  const candidate = module as Partial<KorsiBridge> | null;
  const missing = BRIDGE_FUNCTIONS.filter((name) => typeof candidate?.[name] !== 'function');
  if (!candidate || missing.length || !candidate.MESSAGES) {
    throw new Error(`korsi-bridge: not the Bridge (missing ${missing.join(', ') || 'MESSAGES'})`);
  }
  if (candidate.PROTOCOL !== undefined && candidate.PROTOCOL !== PROTOCOL) {
    throw new BridgeVersionError(candidate.PROTOCOL);
  }
  return candidate as KorsiBridge;
}

export interface KorsiConnection {
  bridge: KorsiBridge;
  /** The first `korsi:init`. Later ones come to `bridge.onInit`. */
  context: KorsiContext;
  korsiOrigin: string;
}

export interface ConnectKorsiOptions {
  /** The Korsi origins this page trusts. Pass them in production. */
  allowedOrigins?: string[];
  /** Where Korsi is, when the page already knows (its server read `korsi_origin`). */
  korsiOrigin?: string | null;
  /** How long to wait for `korsi:init`, in milliseconds. */
  timeout?: number;
  importModule?: ImportModule;
}

/**
 * Load the Bridge from the Korsi framing this page and connect. Resolves null when the page is not
 * inside Korsi -- opened on its own, or framed by an origin it does not trust -- so a page can show
 * what it shows outside Korsi instead of failing.
 */
export async function connectKorsi(
  options: ConnectKorsiOptions = {}
): Promise<KorsiConnection | null> {
  if (!isFramed()) return null;
  const origin =
    normaliseOrigin(options.korsiOrigin) ?? korsiOrigin(options.allowedOrigins, window.location);
  if (!origin) return null;
  if (options.allowedOrigins?.length) {
    const allowed = options.allowedOrigins.map(normaliseOrigin);
    if (!allowed.includes(origin)) return null;
  }
  const bridge = await loadBridge(origin, { importModule: options.importModule });
  const context = await bridge.connect({
    allowedOrigins: options.allowedOrigins?.length ? options.allowedOrigins : [origin],
    timeout: options.timeout,
  });
  // Korsi answered from there: the pages this tab moves to inside the frame can find it again.
  remember(origin);
  return { bridge, context, korsiOrigin: origin };
}

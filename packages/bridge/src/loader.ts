/**
 * Finding the Korsi that frames the page, and loading its Bridge.
 *
 * **Where Korsi is.** Korsi puts its origin on the frame's address (`?korsi_origin=`); a page the
 * plugin navigated to inside the frame no longer has it, so the Bridge remembers the first one for
 * the tab (`sessionStorage`), and so does this. Where the browser records the parent
 * (`location.ancestorOrigins`), the two must agree.
 *
 * **Trust is the page's, never the address's.** Loading the Bridge runs code from that origin in
 * the page's own, so a page that believed `?korsi_origin=` would run whatever a site framing it
 * named. `connectKorsi` therefore needs `allowedOrigins` -- exact origins, or patterns like
 * `https://*.korsi.ai` for a plugin every organization on a Korsi may install -- or a `korsiOrigin`
 * the page's own server checked. Send `Content-Security-Policy: frame-ancestors` and `script-src`
 * with the same origins: the header is what stops anybody else framing the page at all.
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

/**
 * Whether `origin` is one of `allowed`: an exact origin, or a pattern whose host starts with `*.`
 * (`https://*.korsi.ai` is every subdomain of korsi.ai, on https and the default port).
 */
export function originAllowed(origin: string, allowed: readonly string[]): boolean {
  const target = parseOrigin(origin);
  if (!target) return false;
  return allowed.some((pattern) => {
    const wildcard = pattern.includes('://*.');
    const wanted = parseOrigin(
      wildcard ? pattern.replace('://*.', '://wildcard-placeholder.') : pattern
    );
    if (!wanted || wanted.protocol !== target.protocol || wanted.port !== target.port) return false;
    if (!wildcard) return wanted.hostname === target.hostname;
    const suffix = wanted.hostname.slice('wildcard-placeholder'.length);
    return target.hostname.endsWith(suffix) && target.hostname.length > suffix.length;
  });
}

function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.origin === 'null' ? null : url;
  } catch {
    return null;
  }
}

function parentOrigin(location: Location): string | null {
  const ancestors = location.ancestorOrigins;
  return ancestors && ancestors.length ? normaliseOrigin(ancestors[0]) : null;
}

/**
 * The Korsi origin this page is framed by, as far as the page can tell and among those it trusts,
 * or null.
 *
 * @param allowedOrigins The Korsi origins (or `https://*.` patterns) the page trusts; any other is
 *   not believed. With exactly one exact origin and nothing else to go on, that one is assumed.
 */
export function korsiOrigin(
  allowedOrigins: readonly string[],
  location: Location = window.location
): string | null {
  const claimed =
    normaliseOrigin(new URLSearchParams(location.search).get('korsi_origin')) ?? remembered();
  const known = parentOrigin(location);
  if (claimed && known && claimed !== known) return null;
  let origin = claimed ?? known;
  const [only] = allowedOrigins;
  if (!origin && allowedOrigins.length === 1 && only && !only.includes('*')) {
    origin = normaliseOrigin(only);
  }
  if (!origin || !originAllowed(origin, allowedOrigins)) return null;
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
 * Import the Bridge runtime from a Korsi, once per origin, and check it is the Bridge. The origin
 * must be one the page trusts: this runs its code in the page.
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
  /**
   * The Korsi origins this page trusts: exact (`https://acme.korsi.ai`), or patterns
   * (`https://*.korsi.ai`). Required unless `korsiOrigin` is given.
   */
  allowedOrigins?: string[];
  /**
   * Where Korsi is, as the page's own server checked it (it read `korsi_origin` and compared it with
   * its configuration). Trusted as given; still checked against `allowedOrigins` when both are.
   */
  korsiOrigin?: string | null;
  /** How long to wait for `korsi:init`, in milliseconds. */
  timeout?: number;
  importModule?: ImportModule;
}

/** Neither `allowedOrigins` nor a checked `korsiOrigin`: nothing to decide trust by. */
export class BridgeTrustError extends Error {
  constructor() {
    super(
      'korsi-bridge: pass allowedOrigins (or a korsiOrigin your server checked); the address a ' +
        'page is framed with is not proof of who frames it'
    );
    this.name = 'BridgeTrustError';
  }
}

/**
 * Load the Bridge from the Korsi framing this page and connect. Resolves null when the page is not
 * inside Korsi -- opened on its own, or framed by an origin it does not trust -- so a page can show
 * what it shows outside Korsi instead of failing. Throws `BridgeTrustError` when the page named no
 * origin to trust: that is a mistake to fix, not a state to show.
 */
export async function connectKorsi(
  options: ConnectKorsiOptions = {}
): Promise<KorsiConnection | null> {
  const allowed = options.allowedOrigins ?? [];
  const vouched = normaliseOrigin(options.korsiOrigin);
  if (!allowed.length && !vouched) throw new BridgeTrustError();
  if (!isFramed()) return null;
  const origin = vouched ?? korsiOrigin(allowed, window.location);
  if (!origin || (allowed.length && !originAllowed(origin, allowed))) return null;
  const bridge = await loadBridge(origin, { importModule: options.importModule });
  // The runtime pins the one origin decided here; it matches origins exactly, not patterns.
  const context = await bridge.connect({ allowedOrigins: [origin], timeout: options.timeout });
  // Korsi answered from there: the pages this tab moves to inside the frame can find it again.
  remember(origin);
  return { bridge, context, korsiOrigin: origin };
}

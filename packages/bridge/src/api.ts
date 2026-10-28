/**
 * Calling the plugin's own server as the person looking at the page.
 *
 * The page never acts on Korsi itself: it sends the person's sealed handle to its own server, which
 * checks it with Korsi and calls the plugin plane as that person. Every call carries
 *
 *     Authorization: Bearer <handle>
 *     X-Korsi-Installation: <installation id>
 *
 * -- what the server SDKs' `KorsiPlugin.person()` reads. The handle is asked for on every call
 * (`getHandle()` renews it before it runs out), never stored.
 *
 * **A server that lost its credential** -- a plugin Korsi runs keeps nothing on disk, so a restart
 * empties it -- answers `409` with `{ "code": "plugin.unprovisioned" }` (ADR-0086). Then the page
 * asks Korsi, through the Bridge, to give the credential again (`renewCredential`), and calls once
 * more. Only that code counts: a bare 409 is the plugin's own refusal, and goes to the caller.
 * Korsi refusing to give it again answers `403 { "code": "plugin.not_visible" }`, as Korsi answers
 * an installation the person can no longer see; a wait that ran out answers the server's 409.
 */
import type { KorsiBridge } from './protocol.js';

/** The header naming the installation, beside the handle. The server SDKs read the same name. */
export const INSTALLATION_HEADER = 'X-Korsi-Installation';

/** What a plugin's server answers, in its body, when it has no credential for the installation. */
export const UNPROVISIONED = 'plugin.unprovisioned';

/** What the page gets when Korsi refused to give the credential again: no longer shown to them. */
export const NOT_VISIBLE = 'plugin.not_visible';

/** A refusal from the plugin's server, with Korsi's code when Korsi was the one refusing. */
export class PluginApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly detail: string | null
  ) {
    super(detail || code || `HTTP ${status}`);
    this.name = 'PluginApiError';
  }
}

export interface PluginApiOptions {
  /** The path the plugin is served under, prefixed to every call (`/plugins/acme`). */
  base?: string;
  fetch?: typeof fetch;
}

export interface PluginApi {
  /**
   * `fetch`, as the person: the handle and the installation go with it. A call the server answers
   * `plugin.unprovisioned` is made once more after Korsi gave the credential again, unless its body
   * is a stream, which cannot be sent twice. When Korsi refuses, it answers `403 plugin.not_visible`;
   * when the wait runs out, the server's 409.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** JSON in, JSON out; a non-2xx answer throws `PluginApiError`. */
  request<T = unknown>(path: string, options?: { method?: string; body?: unknown }): Promise<T>;
}

/** Whether a server's answer says it lost the installation's credential: by its code, only. */
async function unprovisioned(response: Response): Promise<boolean> {
  if (response.status !== 409) return false;
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  return Boolean(body && typeof body === 'object' && body.code === UNPROVISIONED);
}

/**
 * One renewal at a time per Bridge: every call that met the lost credential waits for the same
 * one, rather than each asking Korsi again.
 */
const renewing = new WeakMap<KorsiBridge, Promise<void>>();

/** Korsi's own answer for an installation the person can no longer see, in place of the 409. */
function notVisible(): Response {
  return new Response(JSON.stringify({ code: NOT_VISIBLE }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}

function renewed(bridge: KorsiBridge): Promise<void> {
  let pending = renewing.get(bridge);
  if (!pending) {
    pending = Promise.resolve(bridge.renewCredential!()).finally(() => renewing.delete(bridge));
    renewing.set(bridge, pending);
  }
  return pending;
}

export function createPluginApi(bridge: KorsiBridge, options: PluginApiOptions = {}): PluginApi {
  const base = (options.base ?? '').replace(/\/+$/, '');
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function once(path: string, init: RequestInit): Promise<Response> {
    const installation = bridge.getContext()?.installation_id;
    if (!installation) throw new Error('korsi-bridge: not connected to Korsi');
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await bridge.getHandle()}`);
    headers.set(INSTALLATION_HEADER, installation);
    return send(`${base}${path}`, { ...init, headers });
  }

  async function personFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await once(path, init);
    const repeatable =
      typeof ReadableStream === 'undefined' || !(init.body instanceof ReadableStream);
    if (typeof bridge.renewCredential !== 'function' || !repeatable) return response;
    if (!(await unprovisioned(response))) return response;
    try {
      await renewed(bridge);
    } catch (error) {
      // A wait that ran out is not a refusal -- the server may still be coming back -- so the page
      // gets its 409. Any other rejection is Korsi refusing (the installation is no longer shown to
      // the person), answered as Korsi answers that.
      const code = (error as { code?: unknown } | null)?.code;
      return code === 'timeout' ? response : notVisible();
    }
    return once(path, init);
  }

  async function request<T>(
    path: string,
    { method = 'GET', body }: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    const response = await personFetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      throw new PluginApiError(response.status, data?.code ?? null, data?.detail ?? null);
    }
    return data as T;
  }

  return { fetch: personFetch, request };
}

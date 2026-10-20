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
 */
import type { KorsiBridge } from './protocol.js';

/** The header naming the installation, beside the handle. The server SDKs read the same name. */
export const INSTALLATION_HEADER = 'X-Korsi-Installation';

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
  /** `fetch`, as the person: the handle and the installation go with it. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** JSON in, JSON out; a non-2xx answer throws `PluginApiError`. */
  request<T = unknown>(path: string, options?: { method?: string; body?: unknown }): Promise<T>;
}

export function createPluginApi(bridge: KorsiBridge, options: PluginApiOptions = {}): PluginApi {
  const base = (options.base ?? '').replace(/\/+$/, '');
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function personFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const installation = bridge.getContext()?.installation_id;
    if (!installation) throw new Error('korsi-bridge: not connected to Korsi');
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await bridge.getHandle()}`);
    headers.set(INSTALLATION_HEADER, installation);
    return send(`${base}${path}`, { ...init, headers });
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

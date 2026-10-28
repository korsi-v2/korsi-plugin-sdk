/**
 * Reaching Korsi from where the plugin runs, the egress proxy included.
 *
 * A plugin Korsi runs (`placement: instance`) has one way out of its container: the proxy Korsi
 * gives each installation, named in `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`. Node's own `fetch`
 * does not read those variables (only Node 22.21 and later, and only with `NODE_USE_ENV_PROXY=1`),
 * so with a proxy set every call goes through undici's `EnvHttpProxyAgent`, which reads all three,
 * `NO_PROXY` included. With none set -- a laptop, an external plugin -- it is Node's own `fetch`.
 *
 * `KorsiClient` and `KorsiPlugin` use it unless they are handed a `fetch` of their own.
 */
import type { Dispatcher } from 'undici';

type Env = Readonly<Record<string, string | undefined>>;

/** A proxy variable, the lower-case spelling first as undici and curl read it. */
const variable = (env: Env, name: string): string | undefined =>
  env[name.toLowerCase()] || env[name] || undefined;

/** Whether `env` names a proxy for calls out of this process. */
export function proxied(env: Env = process.env): boolean {
  return Boolean(variable(env, 'HTTPS_PROXY') || variable(env, 'HTTP_PROXY'));
}

/**
 * A `fetch` that goes through the proxy `env` names, or Node's own when it names none. undici is
 * loaded on the first call through a proxy, never without one.
 */
export function createKorsiFetch(env: Env = process.env): typeof fetch {
  if (!proxied(env)) return (input, init) => globalThis.fetch(input, init);
  const options = {
    httpProxy: variable(env, 'HTTP_PROXY'),
    httpsProxy: variable(env, 'HTTPS_PROXY'),
    noProxy: variable(env, 'NO_PROXY'),
  };
  let loading: Promise<typeof fetch> | null = null;
  const load = (): Promise<typeof fetch> =>
    (loading ??= import('undici').then(
      ({ EnvHttpProxyAgent, fetch: undiciFetch }) => {
        const dispatcher: Dispatcher = new EnvHttpProxyAgent(options);
        // undici's own fetch with its own agent: a dispatcher handed to Node's bundled fetch would
        // have to come from the very undici Node bundles. Its Request and Response are the same
        // WHATWG shapes, so callers cannot tell the two apart.
        return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
          undiciFetch(input as Parameters<typeof undiciFetch>[0], {
            ...(init as Parameters<typeof undiciFetch>[1]),
            dispatcher,
          })) as unknown as typeof fetch;
      },
      (error: unknown) => {
        // Not kept: the next call tries again rather than failing for the process's life.
        loading = null;
        throw error;
      }
    ));
  return async (input, init) => (await load())(input, init);
}

let shared: typeof fetch | null = null;

/** The process's `fetch` to Korsi, made once from its environment: what the SDK uses by default. */
export function korsiFetch(): typeof fetch {
  shared ??= createKorsiFetch();
  return shared;
}

/**
 * Which Korsi a plugin believes: the address an `installed` message names.
 *
 * `installed` is signed with the secret it carries, so anybody can send one. The plugin confirms
 * the credential by calling the address in it -- and that call is the risk: an address the sender
 * chose, fetched from the plugin's network. So it must look like a Korsi plugin plane first:
 *
 * - `https`, except on this machine (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`), or anywhere
 *   when the plugin allows plain `http` for development;
 * - no user, no query, no fragment, and a path ending in `/plugin/v1`;
 * - when the plugin names the Korsis it serves (`trustedApiBases`), one of them. A pattern may
 *   start its host with `*.`: `https://*.korsi.ai/plugin/v1` is every organization on korsi.ai.
 */

const PLANE_PATH = '/plugin/v1';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const trimPath = (path: string): string => path.replace(/\/+$/, '');

function parse(address: string): URL | null {
  try {
    return new URL(address.trim());
  } catch {
    return null;
  }
}

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern;
}

/** Why `apiBase` is not a plane this plugin may call, or null when it is. */
export function apiBaseProblem(
  apiBase: string,
  trusted?: Iterable<string> | null,
  { allowHttp = false }: { allowHttp?: boolean } = {}
): string | null {
  const url = parse(apiBase);
  if (!url || !url.hostname) return `${JSON.stringify(apiBase)} is not an address`;
  const host = url.hostname.toLowerCase();
  const local = LOOPBACK.has(host) || host.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (local || allowHttp))) {
    return `${apiBase} is not https`;
  }
  if (url.username || url.password || url.search || url.hash) {
    return `${apiBase} carries a user, a query or a fragment`;
  }
  if (!trimPath(url.pathname).endsWith(PLANE_PATH)) {
    return `${apiBase} is not a plugin plane (…${PLANE_PATH})`;
  }
  if (!trusted) return null;
  for (const pattern of trusted) {
    const wanted = parse(pattern.replace('*.', 'wildcard-placeholder.'));
    if (!wanted) continue;
    const wantedHost = wanted.hostname.toLowerCase().replace('wildcard-placeholder.', '*.');
    if (
      wanted.protocol === url.protocol &&
      wanted.port === url.port &&
      trimPath(wanted.pathname) === trimPath(url.pathname) &&
      hostMatches(host, wantedHost)
    ) {
      return null;
    }
  }
  return `${apiBase} is not a Korsi this plugin accepts installations from`;
}

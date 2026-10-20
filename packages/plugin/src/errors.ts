/**
 * What can go wrong talking to Korsi, as errors a plugin branches on.
 *
 * **Korsi's refusals are problem documents** (`application/problem+json`) with a stable `code`,
 * such as `plugin.wallet_insufficient`. `KorsiRefused` carries it, so callers decide by code, never
 * by message text: `title` is written for a person, in the caller's language, and changes.
 *
 * **Korsi not answering is a different thing** (`KorsiUnreachable`): the network, a timeout, a
 * proxy. Nothing about the plugin's standing follows from it -- in particular, not that an
 * installation was removed.
 */

/**
 * A request *to the plugin* that it must refuse; `status` is the HTTP answer to give. A web
 * framework maps the whole family to `status` in one handler.
 */
export class RequestRejected extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

/** Anything this SDK raises about Korsi. */
export class KorsiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Korsi did not answer: the network, a timeout. Try again later; conclude nothing. */
export class KorsiUnreachable extends KorsiError {}

export interface ProblemFieldError {
  location: string;
  code: string;
  params?: Record<string, unknown>;
}

/** Korsi answered with a problem. `code` is the contract; `title` is for people and logs. */
export class KorsiRefused extends KorsiError {
  readonly status: number;
  readonly code: string;
  readonly title: string | null;
  readonly params: Record<string, unknown>;
  readonly requestId: string | null;
  readonly errors: ProblemFieldError[];
  /**
   * Seconds to wait before asking again, when Korsi said (`429 plugin.rate_limited`: the
   * installation spent one of its budgets -- reads, writes, sources, proposals).
   */
  readonly retryAfter: number | null;
  /**
   * Whether Korsi itself answered (a problem document), rather than something in front of it -- a
   * proxy's bare 401, a WAF's 403 -- that only looks like a refusal.
   */
  readonly problem: boolean;

  constructor(
    status: number,
    code: string,
    title: string | null = null,
    extra: {
      params?: Record<string, unknown>;
      requestId?: string | null;
      errors?: ProblemFieldError[];
      retryAfter?: number | null;
      problem?: boolean;
    } = {}
  ) {
    super(`${status} ${code}${title ? `: ${title}` : ''}`);
    this.status = status;
    this.code = code;
    this.title = title;
    this.params = extra.params ?? {};
    this.requestId = extra.requestId ?? null;
    this.errors = extra.errors ?? [];
    this.retryAfter = extra.retryAfter ?? null;
    this.problem = extra.problem ?? true;
  }
}

/** Korsi's stable codes a plugin most often branches on. The full list is Korsi's catalog. */
export const Code = Object.freeze({
  unauthenticated: 'auth.unauthenticated',
  forbidden: 'auth.forbidden',
  notFound: 'resource.not_found',
  invalid: 'request.invalid',
  rateLimited: 'request.rate_limited',
  /** One of the installation's budgets (reads, writes, sources, proposals) is spent: 429. */
  pluginRateLimited: 'plugin.rate_limited',

  notAPlugin: 'plugin.not_a_plugin',
  installationNotFound: 'plugin.installation_not_found',
  installationInactive: 'plugin.installation_inactive',
  handleInvalid: 'plugin.handle_invalid',
  pluginNotVisible: 'plugin.not_visible',
  scopeMissing: 'plugin.scope_missing',

  recordTypeUnknown: 'plugin.record_type_unknown',
  recordInvalid: 'plugin.record_invalid',
  recordNotFound: 'plugin.record_not_found',
  recordVersionConflict: 'plugin.record_version_conflict',
  recordReadOnly: 'plugin.record_read_only',

  proposalInvalid: 'plugin.proposal_invalid',
  proposalTypeNotDeclared: 'plugin.proposal_type_not_declared',
  intakeKindNotDeclared: 'plugin.intake_kind_not_declared',
  personalNeedsPerson: 'plugin.personal_needs_person',

  noActivePlan: 'plugin.no_active_plan',
  serviceUnknown: 'plugin.service_unknown',
  walletInsufficient: 'plugin.wallet_insufficient',
  holdNotFound: 'plugin.hold_not_found',
  holdSettled: 'plugin.hold_settled',
} as const);

/** Whether `error` is Korsi asking the plugin to slow down; `retryAfter` says how long. */
export function isRateLimited(error: unknown): boolean {
  return (
    error instanceof KorsiRefused &&
    (error.status === 429 ||
      error.code === Code.pluginRateLimited ||
      error.code === Code.rateLimited)
  );
}

/**
 * Whether Korsi's refusal means *this credential no longer belongs to an installation*.
 *
 * The only evidence a plugin should accept that it was removed: an unsigned `removed` message could
 * come from anybody, so a plugin believes it only once Korsi itself -- its problem document, not a
 * proxy's bare status -- refuses the stored token. That is a 401 (the machine user is switched
 * off), `plugin.not_a_plugin`,
 * `plugin.installation_not_found`, or `plugin.installation_inactive` *with state removed*. A
 * suspended installation is refused too, and comes back; a 5xx says nothing at all.
 */
export function credentialRefused(error: KorsiRefused): boolean {
  if (!error.problem) return false;
  if (error.status === 401) return true;
  if (error.code === Code.notAPlugin || error.code === Code.installationNotFound) return true;
  return error.code === Code.installationInactive && error.params.state === 'removed';
}

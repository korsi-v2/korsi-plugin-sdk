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
  /**
   * Korsi's code for the refusal, where Korsi acts on it -- `plugin.unprovisioned` -- else null.
   * Answer it in the body (`{ code, detail }`): Korsi reads the code, never the status alone.
   */
  readonly code: string | null = null;

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
   * Seconds to wait before asking again, when Korsi said (`Retry-After`): `429
   * plugin.rate_limited`, the installation spent one of its budgets -- reads, writes, sources,
   * proposals, models; `409 plugin.text_pending`, a scan still being read.
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
  /** One of the installation's budgets (reads, writes, sources, proposals, models) is spent: 429. */
  pluginRateLimited: 'plugin.rate_limited',
  /** Korsi itself is busy or a dependency is down: ask again, with the same idempotency key. */
  serviceUnavailable: 'service.unavailable',
  providerUnreachable: 'provider.unreachable',

  notAPlugin: 'plugin.not_a_plugin',
  installationNotFound: 'plugin.installation_not_found',
  installationInactive: 'plugin.installation_inactive',
  handleInvalid: 'plugin.handle_invalid',
  pluginNotVisible: 'plugin.not_visible',
  scopeMissing: 'plugin.scope_missing',
  /** The plugin's own permission keys (ADR-0082): one Korsi was asked about is not declared. */
  permissionUnknown: 'plugin.permission_unknown',
  /**
   * What a plugin answers -- never what Korsi answers it -- for an installation it has no
   * credential for (ADR-0086): `409 { "code": "plugin.unprovisioned" }`. Korsi gives the credential
   * again and asks once more; a 409 without this code is the plugin's own refusal.
   */
  unprovisioned: 'plugin.unprovisioned',

  recordTypeUnknown: 'plugin.record_type_unknown',
  recordInvalid: 'plugin.record_invalid',
  recordNotFound: 'plugin.record_not_found',
  recordVersionConflict: 'plugin.record_version_conflict',
  recordReadOnly: 'plugin.record_read_only',
  /** A record query named a field its type does not declare, or compared it as it cannot be. */
  recordFieldUnknown: 'plugin.record_field_unknown',

  proposalInvalid: 'plugin.proposal_invalid',
  proposalTypeNotDeclared: 'plugin.proposal_type_not_declared',
  intakeKindNotDeclared: 'plugin.intake_kind_not_declared',
  personalNeedsPerson: 'plugin.personal_needs_person',

  noActivePlan: 'plugin.no_active_plan',
  serviceUnknown: 'plugin.service_unknown',
  walletInsufficient: 'plugin.wallet_insufficient',
  holdNotFound: 'plugin.hold_not_found',
  holdSettled: 'plugin.hold_settled',

  /** The publisher's paid services are paused (its wallet ran out, ADR-0081): 402. */
  publisherFunds: 'plugin.publisher_funds',
  /** A model Korsi does not lend plugins: `GET /models` lists the ones it does. */
  modelNotAllowed: 'plugin.model_not_allowed',
  /** A file nobody handed this installation in Korsi's picker: 404. */
  fileNotGranted: 'plugin.file_not_granted',
  /** A scan Korsi is still reading: ask again after `params.retry_after_seconds` (409). */
  textPending: 'plugin.text_pending',
  /** A file Korsi will not read the text of; `params.reason` says why (409). */
  textUnavailable: 'plugin.text_unavailable',
  /** A meeting this installation does not host: 404. */
  meetingNotHosted: 'plugin.meeting_not_hosted',
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

/** Whether `error` is a scan Korsi is still reading; `textPendingSeconds` says when to ask again. */
export function isTextPending(error: unknown): error is KorsiRefused {
  return error instanceof KorsiRefused && error.code === Code.textPending;
}

/** How long to wait before asking a pending scan's text again, in seconds. */
export function textPendingSeconds(error: KorsiRefused, fallback = 30): number {
  const seconds = Number(error.params.retry_after_seconds ?? error.retryAfter ?? fallback);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

/**
 * Whether `error` is the publisher's paid services paused (ADR-0081): models, OCR and the
 * specialist stop until the publisher's wallet is topped up. Everything else keeps working, so a
 * plugin says so and goes on without them.
 */
export function isPublisherFunds(error: unknown): error is KorsiRefused {
  return error instanceof KorsiRefused && error.code === Code.publisherFunds;
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

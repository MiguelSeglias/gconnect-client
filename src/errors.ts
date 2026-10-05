/**
 * Error hierarchy. Every error thrown by this package extends {@link GarminConnectError}
 * and carries a stable machine-readable `code`. Messages never contain credentials, tokens,
 * cookies or response bodies.
 */

/** Stable error codes. */
export type GarminConnectErrorCode =
  | 'authentication_failed'
  | 'invalid_mfa_code'
  | 'captcha_required'
  | 'account_locked'
  | 'login_failed'
  | 'token_exchange_failed'
  | 'session_expired'
  | 'rate_limited'
  | 'network_error'
  | 'http_error'
  | 'response_format'
  | 'unsupported_response'
  | 'not_found';

/** Base class of all errors thrown by gconnect-client. */
export class GarminConnectError extends Error {
  readonly code: GarminConnectErrorCode;

  constructor(code: GarminConnectErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Garmin rejected the username/password combination. Do not retry automatically. */
export class AuthenticationError extends GarminConnectError {
  constructor(message = 'Invalid username or password') {
    super('authentication_failed', message);
  }
}

/** The MFA code was rejected (wrong or expired). The challenge may be retried with a new code. */
export class InvalidMfaCodeError extends GarminConnectError {
  constructor(message = 'MFA code was rejected') {
    super('invalid_mfa_code', message);
  }
}

/** Garmin demanded a CAPTCHA on every strategy that was tried. Interactive login is required. */
export class CaptchaRequiredError extends GarminConnectError {
  constructor(message = 'Garmin requires a CAPTCHA for this login') {
    super('captcha_required', message);
  }
}

/** Garmin reports the account as locked. */
export class AccountLockedError extends GarminConnectError {
  constructor(message = 'Garmin reports the account as locked') {
    super('account_locked', message);
  }
}

/** One login attempt of a strategy that did not succeed (no sensitive content). */
export interface LoginAttempt {
  strategy: string;
  code: GarminConnectErrorCode;
  status?: number;
}

/** All login strategies failed for reasons other than credentials, MFA, CAPTCHA or rate limits. */
export class LoginFailedError extends GarminConnectError {
  readonly attempts: readonly LoginAttempt[];

  constructor(attempts: readonly LoginAttempt[], message = 'All login strategies failed') {
    super('login_failed', message);
    this.attempts = attempts;
  }
}

/** The SSO service ticket could not be exchanged for an OAuth token with any known client id. */
export class TokenExchangeError extends GarminConnectError {
  readonly status: number | undefined;

  constructor(message = 'Service ticket could not be exchanged for a token', status?: number) {
    super('token_exchange_failed', message);
    this.status = status;
  }
}

/** Why a session is no longer usable. */
export type SessionExpiredReason = 'no_tokens' | 'refresh_failed' | 'rejected';

/** The stored session cannot be used any more; a fresh `login()` is required. */
export class SessionExpiredError extends GarminConnectError {
  readonly reason: SessionExpiredReason;

  constructor(reason: SessionExpiredReason, message?: string) {
    super(
      'session_expired',
      message ??
        {
          no_tokens: 'No stored tokens; login required',
          refresh_failed: 'Token refresh failed; login required',
          rejected: 'Garmin rejected the access token after refresh; login required',
        }[reason],
    );
    this.reason = reason;
  }
}

/** HTTP 429 (or a 429 embedded in a JSON body). */
export class RateLimitError extends GarminConnectError {
  /** Seconds to wait as indicated by `Retry-After`, if Garmin sent one. */
  readonly retryAfterSeconds: number | undefined;

  constructor(message = 'Rate limited by Garmin', retryAfterSeconds?: number) {
    super('rate_limited', message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Kind of network failure. */
export type NetworkErrorKind = 'timeout' | 'aborted' | 'network';

/** The transport failed (DNS, TLS, connection reset) or the operation timed out. */
export class NetworkError extends GarminConnectError {
  readonly kind: NetworkErrorKind;

  constructor(kind: NetworkErrorKind, message: string, options?: { cause?: unknown }) {
    super('network_error', message, options);
    this.kind = kind;
  }
}

/** Unexpected non-success HTTP status (e.g. 5xx after retries, 403). */
export class HttpError extends GarminConnectError {
  readonly status: number;
  readonly endpoint: string;

  constructor(endpoint: string, status: number) {
    super('http_error', `HTTP ${status} from ${endpoint}`);
    this.status = status;
    this.endpoint = endpoint;
  }
}

/** A response did not match the expected schema. Only field paths are reported, never values. */
export class ResponseFormatError extends GarminConnectError {
  readonly endpoint: string;
  readonly issues: readonly string[];

  constructor(endpoint: string, issues: readonly string[] = []) {
    super(
      'response_format',
      `Unexpected response format from ${endpoint}` +
        (issues.length > 0 ? ` (at: ${issues.slice(0, 5).join(', ')})` : ''),
    );
    this.endpoint = endpoint;
    this.issues = issues;
  }
}

/** The response is well-formed JSON but in a shape this version does not understand. */
export class UnsupportedResponseError extends GarminConnectError {
  readonly endpoint: string;

  constructor(endpoint: string, message?: string) {
    super('unsupported_response', message ?? `Unsupported response shape from ${endpoint}`);
    this.endpoint = endpoint;
  }
}

/** HTTP 404. */
export class NotFoundError extends GarminConnectError {
  readonly endpoint: string;

  constructor(endpoint: string) {
    super('not_found', `Resource not found: ${endpoint}`);
    this.endpoint = endpoint;
  }
}

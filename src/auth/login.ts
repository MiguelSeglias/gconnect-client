/**
 * Login orchestration: SSO strategy chain, MFA completion, ticket exchange.
 *
 * Ported from python-garminconnect v0.3.17 (garminconnect/client.py: `Client.login`,
 * `resume_login`, `_verify_token`), Copyright (c) 2020-2026 Ron Klinkien (cyberjunky), MIT licence —
 * https://github.com/cyberjunky/python-garminconnect. See NOTICE.
 */
import { mfaChallengeSchema, type MfaChallenge } from './challenge';
import { CONNECT_API_ORIGIN, VERIFY_TOKEN_PATH, nativeHeaders } from './constants';
import { verifyMfaCode } from './mfa';
import {
  DEFAULT_STRATEGIES,
  STRATEGIES,
  type Credentials,
  type LoginStrategyName,
  type StrategyEnv,
} from './sso-strategies';
import { exchangeServiceTicket } from './token-exchange';
import type { StoredTokens } from './tokens';
import { systemClock, type Clock } from '../clock';
import {
  AccountLockedError,
  AuthenticationError,
  CaptchaRequiredError,
  GarminConnectError,
  LoginFailedError,
  RateLimitError,
  type LoginAttempt,
} from '../errors';
import { emit, type EventListener } from '../events';
import {
  DEFAULT_TIMEOUTS,
  defaultTransport,
  sendBuffered,
  type HttpContext,
  type Timeouts,
  type Transport,
} from '../http/transport';
import type { TokenStore } from '../token-store';

/** Options shared by {@link login} and {@link completeMfa}. */
export interface AuthOptions {
  /** fetch-compatible transport. Default: global `fetch`. */
  transport?: Transport;
  timeouts?: Partial<Timeouts>;
  clock?: Clock;
  /** Receives redacted diagnostic events. */
  onEvent?: EventListener;
  /** If given, tokens are saved here on success. */
  tokenStore?: TokenStore;
  /** SSO strategies to try, in order. Default `['mobile', 'widget', 'portal']`. */
  strategies?: readonly LoginStrategyName[];
  /**
   * Confirm with one API call that a new token is accepted before returning it (a token
   * rejected by the API tier makes the chain try the next strategy). Default true.
   */
  verifyLogin?: boolean;
  /** Random source in [0, 1) for anti-WAF pauses. Default `Math.random`. */
  random?: () => number;
}

/** Successful login. */
export interface AuthenticatedResult {
  status: 'authenticated';
  tokens: StoredTokens;
}

/** Garmin requires a second factor; pass `challenge` and the code to {@link completeMfa}. */
export interface MfaRequiredResult {
  status: 'mfa_required';
  challenge: MfaChallenge;
}

export type LoginResult = AuthenticatedResult | MfaRequiredResult;

export function createHttpContext(options: {
  transport?: Transport | undefined;
  timeouts?: Partial<Timeouts> | undefined;
  clock?: Clock | undefined;
  onEvent?: EventListener | undefined;
}): HttpContext {
  return {
    transport: options.transport ?? defaultTransport,
    clock: options.clock ?? systemClock,
    timeouts: { ...DEFAULT_TIMEOUTS, ...options.timeouts },
    onEvent: options.onEvent,
  };
}

/** False only if the API tier definitively rejects the token (401/403). */
async function verifyToken(ctx: HttpContext, tokens: StoredTokens): Promise<boolean> {
  try {
    const res = await sendBuffered(
      ctx,
      `${CONNECT_API_ORIGIN}${VERIFY_TOKEN_PATH}`,
      {
        method: 'GET',
        headers: nativeHeaders({
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: 'application/json',
        }),
      },
      ctx.timeouts.apiMs,
    );
    return res.status !== 401 && res.status !== 403;
  } catch {
    return true; // inconclusive -> keep the token
  }
}

/**
 * Log in with username and password.
 *
 * Tries the SSO strategies in order. Wrong credentials, a locked account and an MFA
 * requirement stop the chain; rate limits (429), Cloudflare blocks (403) and CAPTCHA
 * demands fall through to the next strategy. Login requests are never retried
 * automatically — repeated SSO attempts risk an account lock.
 *
 * @returns `{ status: 'authenticated', tokens }` or `{ status: 'mfa_required', challenge }`.
 * @throws {AuthenticationError} bad credentials
 * @throws {AccountLockedError} account locked
 * @throws {RateLimitError} every strategy was rate limited, or the token exchange was
 * @throws {CaptchaRequiredError} strategies failed and at least one demanded a CAPTCHA
 * @throws {TokenExchangeError} SSO succeeded but no client id accepted the ticket
 * @throws {LoginFailedError} all strategies failed for other reasons
 */
export async function login(
  credentials: Credentials,
  options: AuthOptions = {},
): Promise<LoginResult> {
  if (!credentials.username || !credentials.password) {
    throw new TypeError('username and password are required');
  }
  const ctx = createHttpContext(options);
  const env: StrategyEnv = { ctx, random: options.random ?? Math.random };
  const strategies = options.strategies ?? DEFAULT_STRATEGIES;
  const attempts: LoginAttempt[] = [];
  let rateLimited = 0;
  let retryAfter: number | undefined;
  let captcha = false;

  for (const name of strategies) {
    let outcome;
    try {
      outcome = await STRATEGIES[name](env, credentials);
    } catch (err) {
      if (err instanceof AuthenticationError || err instanceof AccountLockedError) {
        emit(ctx.onEvent, { type: 'login_strategy', strategy: name, outcome: err.code });
        throw err;
      }
      if (!(err instanceof GarminConnectError)) throw err;
      emit(ctx.onEvent, { type: 'login_strategy', strategy: name, outcome: err.code });
      const status = 'status' in err && typeof err.status === 'number' ? err.status : undefined;
      attempts.push({
        strategy: name,
        code: err.code,
        ...(status !== undefined ? { status } : {}),
      });
      if (err instanceof RateLimitError) {
        rateLimited++;
        if (err.retryAfterSeconds !== undefined) {
          retryAfter = Math.max(retryAfter ?? 0, err.retryAfterSeconds);
        }
      }
      if (err instanceof CaptchaRequiredError) captcha = true;
      continue;
    }

    if (outcome.kind === 'mfa') {
      emit(ctx.onEvent, { type: 'login_strategy', strategy: name, outcome: 'mfa_required' });
      return { status: 'mfa_required', challenge: outcome.challenge };
    }

    // A service ticket is single-use: exchange failures are terminal (no further SSO logins).
    const tokens = await exchangeServiceTicket(ctx, outcome.ticket, outcome.serviceUrl);
    if (options.verifyLogin !== false && !(await verifyToken(ctx, tokens))) {
      emit(ctx.onEvent, { type: 'login_strategy', strategy: name, outcome: 'token_rejected' });
      attempts.push({ strategy: name, code: 'token_exchange_failed' });
      continue;
    }
    emit(ctx.onEvent, { type: 'login_strategy', strategy: name, outcome: 'success' });
    await options.tokenStore?.save(tokens);
    return { status: 'authenticated', tokens };
  }

  if (attempts.length > 0 && rateLimited === attempts.length) {
    throw new RateLimitError(
      'All login strategies were rate limited. Wait before trying again; Garmin may be ' +
        'blocking this network or client fingerprint.',
      retryAfter,
    );
  }
  if (captcha) throw new CaptchaRequiredError();
  throw new LoginFailedError(attempts);
}

/**
 * Complete a login that returned `mfa_required`. The same challenge may be retried after an
 * {@link InvalidMfaCodeError}. The verification request is not retried automatically.
 *
 * @throws {InvalidMfaCodeError} the code was rejected
 * @throws {RateLimitError} MFA verification was rate limited
 * @throws {TypeError} the challenge is not a valid challenge object
 */
export async function completeMfa(
  challenge: MfaChallenge,
  code: string,
  options: AuthOptions = {},
): Promise<AuthenticatedResult> {
  const parsed = mfaChallengeSchema.safeParse(challenge);
  if (!parsed.success) throw new TypeError('Invalid MFA challenge object');
  const trimmed = code.trim();
  if (trimmed === '') throw new TypeError('MFA code is required');
  const ctx = createHttpContext(options);
  const env: StrategyEnv = { ctx, random: options.random ?? Math.random };
  const verified = await verifyMfaCode(env, parsed.data, trimmed);
  const tokens = await exchangeServiceTicket(ctx, verified.ticket, verified.serviceUrl);
  if (options.verifyLogin !== false && !(await verifyToken(ctx, tokens))) {
    throw new LoginFailedError([{ strategy: parsed.data.flow, code: 'token_exchange_failed' }]);
  }
  emit(ctx.onEvent, { type: 'login_strategy', strategy: parsed.data.flow, outcome: 'success' });
  await options.tokenStore?.save(tokens);
  return { status: 'authenticated', tokens };
}

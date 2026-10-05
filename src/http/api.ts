import { CONNECT_API_ORIGIN, REFRESH_SKEW_S, nativeHeaders } from '../auth/constants';
import { refreshTokens } from '../auth/token-exchange';
import type { StoredTokens } from '../auth/tokens';
import {
  HttpError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ResponseFormatError,
  SessionExpiredError,
} from '../errors';
import { emit } from '../events';
import type { TokenStore } from '../token-store';
import {
  bodyJson,
  buildUrl,
  parseRetryAfter,
  sendBuffered,
  type BufferedResponse,
  type HttpContext,
} from './transport';

/** Bounded retry policy for idempotent GET reads. */
export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  maxAttempts: number;
  /** Base for exponential backoff. Default 500 ms. */
  baseDelayMs: number;
  /** Upper bound for any single wait, including `Retry-After`. Default 10 000 ms. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryOptions = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 10_000 };

export interface GetOptions {
  /** Short endpoint label for error messages (no ids or query values). */
  endpoint: string;
  params?: Record<string, string | number | undefined>;
  download?: boolean;
}

/** Events report the endpoint label, never concrete ids or display names. */
function eventUrl(opts: GetOptions): string {
  return `${CONNECT_API_ORIGIN}/${opts.endpoint}`;
}

/**
 * Authenticated access to connectapi.garmin.com: loads tokens from the store, refreshes
 * them proactively (exp − 15 min) and once on 401, and retries idempotent reads.
 */
export class ApiSession {
  private tokens: StoredTokens | null | undefined;
  private refreshing: Promise<StoredTokens> | null = null;

  constructor(
    private readonly ctx: HttpContext,
    private readonly store: TokenStore,
    private readonly retry: RetryOptions,
    private readonly random: () => number,
  ) {}

  async currentTokens(): Promise<StoredTokens | null> {
    if (this.tokens === undefined) this.tokens = await this.store.load();
    return this.tokens;
  }

  /** Forget the cached tokens (they are re-read from the store on next use). */
  reset(): void {
    this.tokens = undefined;
  }

  /** Set tokens after a login performed through the client. */
  setTokens(tokens: StoredTokens): void {
    this.tokens = tokens;
  }

  private nowS(): number {
    return Math.floor(this.ctx.clock.now() / 1000);
  }

  private async freshTokens(): Promise<StoredTokens> {
    const tokens = await this.currentTokens();
    if (!tokens) throw new SessionExpiredError('no_tokens');
    if (tokens.expiresAt !== null && this.nowS() > tokens.expiresAt - REFRESH_SKEW_S) {
      try {
        return await this.refresh(tokens);
      } catch (err) {
        // Transient refresh failure while the token is still valid: keep using it.
        if (!(err instanceof SessionExpiredError) && this.nowS() < tokens.expiresAt) return tokens;
        throw err;
      }
    }
    return tokens;
  }

  /** Single-flight refresh; concurrent callers share one refresh request. */
  private refresh(stale: StoredTokens): Promise<StoredTokens> {
    if (this.refreshing) return this.refreshing;
    const run = async (): Promise<StoredTokens> => {
      try {
        const next = await refreshTokens(this.ctx, stale);
        this.tokens = next;
        await this.store.save(next);
        emit(this.ctx.onEvent, { type: 'token_refresh', outcome: 'success' });
        return next;
      } catch (err) {
        emit(this.ctx.onEvent, { type: 'token_refresh', outcome: 'failed' });
        if (err instanceof SessionExpiredError) {
          // The refresh token is dead; stored tokens are useless — clear them.
          this.tokens = null;
          await this.store.clear();
        }
        throw err;
      }
    };
    this.refreshing = run().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private send(url: string, tokens: StoredTokens, opts: GetOptions, attempt: number) {
    return sendBuffered(
      this.ctx,
      url,
      {
        method: 'GET',
        headers: nativeHeaders({
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: opts.download ? '*/*' : 'application/json',
        }),
      },
      opts.download ? this.ctx.timeouts.downloadMs : this.ctx.timeouts.apiMs,
      attempt,
      eventUrl(opts),
    );
  }

  private async authorizedGet(url: string, opts: GetOptions, attempt: number) {
    const tokens = await this.freshTokens();
    const res = await this.send(url, tokens, opts, attempt);
    if (res.status !== 401) return res;
    const refreshed = await this.refresh(tokens);
    const retried = await this.send(url, refreshed, opts, attempt);
    if (retried.status === 401) throw new SessionExpiredError('rejected');
    return retried;
  }

  private backoff(attempt: number): number {
    const exp = this.retry.baseDelayMs * 2 ** (attempt - 1);
    return Math.min(this.retry.maxDelayMs, exp + this.random() * this.retry.baseDelayMs);
  }

  private async wait(url: string, attempt: number, delayMs: number, reason: string) {
    emit(this.ctx.onEvent, { type: 'retry', url, attempt, delayMs, reason });
    await this.ctx.clock.sleep(delayMs);
  }

  /**
   * GET a path. Returns `null` for 204/empty bodies. Retries network errors, 5xx and 429
   * (respecting `Retry-After` up to `maxDelayMs`) with exponential backoff and jitter.
   */
  async get(path: string, opts: GetOptions): Promise<BufferedResponse | null> {
    const url = buildUrl(`${CONNECT_API_ORIGIN}${path}`, opts.params);
    const max = Math.max(1, this.retry.maxAttempts);
    for (let attempt = 1; ; attempt++) {
      let res: BufferedResponse;
      try {
        res = await this.authorizedGet(url, opts, attempt);
      } catch (err) {
        if (err instanceof NetworkError && err.kind !== 'aborted' && attempt < max) {
          await this.wait(eventUrl(opts), attempt, this.backoff(attempt), `network_${err.kind}`);
          continue;
        }
        throw err;
      }
      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res.headers, this.ctx.clock.now());
        const delay = retryAfter !== undefined ? retryAfter * 1000 : this.backoff(attempt);
        if (attempt < max && delay <= this.retry.maxDelayMs) {
          await this.wait(eventUrl(opts), attempt, delay, 'http_429');
          continue;
        }
        throw new RateLimitError(`Rate limited on ${opts.endpoint}`, retryAfter);
      }
      if (res.status >= 500) {
        if (attempt < max) {
          await this.wait(eventUrl(opts), attempt, this.backoff(attempt), `http_${res.status}`);
          continue;
        }
        throw new HttpError(opts.endpoint, res.status);
      }
      if (res.status === 404) throw new NotFoundError(opts.endpoint);
      if (res.status === 204) return null;
      if (res.status < 200 || res.status >= 300) throw new HttpError(opts.endpoint, res.status);
      return res.bytes.length === 0 ? null : res;
    }
  }

  /** GET and parse JSON. Returns `undefined` for 204/empty responses. */
  async getJson(path: string, opts: GetOptions): Promise<unknown> {
    const res = await this.get(path, opts);
    if (res === null) return undefined;
    const parsed = bodyJson(res);
    if (!parsed.ok) throw new ResponseFormatError(opts.endpoint, ['<body is not JSON>']);
    return parsed.value;
  }
}

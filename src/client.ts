import type { MfaChallenge } from './auth/challenge';
import {
  completeMfa,
  createHttpContext,
  login,
  type AuthenticatedResult,
  type LoginResult,
} from './auth/login';
import type { Credentials, LoginStrategyName } from './auth/sso-strategies';
import type { Clock } from './clock';
import { availableFormats, downloadFile } from './endpoints/activity-files';
import { fetchActivity, fetchActivityPage, MAX_PAGES } from './endpoints/activities';
import { fetchHrv } from './endpoints/hrv';
import { fetchUserProfile } from './endpoints/profile';
import { fetchRestingHeartRate } from './endpoints/resting-heart-rate';
import { fetchSleep } from './endpoints/sleep';
import { fetchVo2Max } from './endpoints/vo2max';
import type { EventListener } from './events';
import { ApiSession, DEFAULT_RETRY, type RetryOptions } from './http/api';
import type { HttpContext, Timeouts, Transport } from './http/transport';
import type { TokenStore } from './token-store';
import type {
  ActivityDetail,
  ActivityFile,
  ActivityFileFormat,
  ActivityFilter,
  ActivityPage,
  ActivitySummary,
  DailyMetric,
  DateRange,
  HrvSummary,
  SleepSummary,
  UserProfile,
} from './types';

/** Options for {@link GarminConnectClient}. */
export interface GarminConnectClientOptions {
  /** Where tokens are loaded from and saved to (after login and every refresh). */
  tokenStore: TokenStore;
  /** fetch-compatible transport. Default: global `fetch`. See README on Cloudflare/TLS. */
  transport?: Transport;
  /** Per-operation timeouts (ms). Defaults: sso 20 s, token 15 s, api 20 s, download 60 s. */
  timeouts?: Partial<Timeouts>;
  /** Retry policy for GET reads. Default: 3 attempts, 500 ms base, 10 s cap. */
  retry?: Partial<RetryOptions>;
  /** Injectable clock (tests). */
  clock?: Clock;
  /** Receives redacted diagnostic events (no secrets, no health data). */
  onEvent?: EventListener;
  /** Attach the raw Garmin object as `raw` on activities. Default false. */
  includeRaw?: boolean;
  /** Random source in [0, 1) for jitter. Default `Math.random`. */
  random?: () => number;
}

/** Options for {@link GarminConnectClient.login}. */
export interface ClientLoginOptions {
  strategies?: readonly LoginStrategyName[];
  verifyLogin?: boolean;
}

/**
 * Unofficial, read-only Garmin Connect client.
 *
 * Construct one instance per Garmin account, with a {@link TokenStore} for that account.
 * All read methods load tokens from the store, refresh them when needed and save refreshed
 * tokens back. A {@link SessionExpiredError} means a fresh login is required.
 */
export class GarminConnectClient {
  private readonly ctx: HttpContext;
  private readonly api: ApiSession;
  private readonly store: TokenStore;
  private readonly includeRaw: boolean;
  private readonly random: () => number;
  private readonly options: GarminConnectClientOptions;
  private displayName: string | null = null;

  constructor(options: GarminConnectClientOptions) {
    this.options = options;
    this.store = options.tokenStore;
    this.includeRaw = options.includeRaw ?? false;
    this.random = options.random ?? Math.random;
    this.ctx = createHttpContext(options);
    this.api = new ApiSession(
      this.ctx,
      this.store,
      { ...DEFAULT_RETRY, ...options.retry },
      this.random,
    );
  }

  private authOptions(extra: ClientLoginOptions = {}) {
    return {
      transport: this.ctx.transport,
      timeouts: this.ctx.timeouts,
      clock: this.ctx.clock,
      ...(this.options.onEvent ? { onEvent: this.options.onEvent } : {}),
      random: this.random,
      tokenStore: this.store,
      ...extra,
    };
  }

  /**
   * Log in and save tokens to the store. See the standalone {@link login} for semantics.
   * Call rarely: persist tokens and reuse them; never loop logins.
   */
  async login(credentials: Credentials, options: ClientLoginOptions = {}): Promise<LoginResult> {
    const result = await login(credentials, this.authOptions(options));
    if (result.status === 'authenticated') this.onNewTokens(result);
    return result;
  }

  /** Finish an MFA login and save tokens to the store. */
  async completeMfa(
    challenge: MfaChallenge,
    code: string,
    options: Pick<ClientLoginOptions, 'verifyLogin'> = {},
  ): Promise<AuthenticatedResult> {
    const result = await completeMfa(challenge, code, this.authOptions(options));
    this.onNewTokens(result);
    return result;
  }

  private onNewTokens(result: AuthenticatedResult): void {
    this.api.setTokens(result.tokens);
    this.displayName = null;
  }

  /**
   * True if the store holds tokens that are unexpired or refreshable. Makes no network call,
   * so it cannot detect server-side revocation.
   */
  async isAuthenticated(): Promise<boolean> {
    this.api.reset();
    const tokens = await this.api.currentTokens();
    if (!tokens) return false;
    if (tokens.refreshToken !== null) return true;
    return tokens.expiresAt === null || tokens.expiresAt * 1000 > this.ctx.clock.now();
  }

  /** Forget the session locally and clear the token store. (Garmin has no logout API.) */
  async logout(): Promise<void> {
    this.displayName = null;
    await this.store.clear();
    this.api.reset();
  }

  /** The authenticated user's profile. The display name is cached for wellness calls. */
  async getUserProfile(): Promise<UserProfile> {
    const profile = await fetchUserProfile(this.api);
    this.displayName = profile.displayName;
    return profile;
  }

  private async requireDisplayName(): Promise<string> {
    return this.displayName ?? (await this.getUserProfile()).displayName;
  }

  /** One page of activities, most recent first. `limit` defaults to 100, capped at 1000. */
  listActivities(filter: ActivityFilter = {}): Promise<ActivityPage> {
    return fetchActivityPage(this.api, filter, this.includeRaw);
  }

  /** Iterate all activities matching the filter, paging until an empty page is returned. */
  async *iterateActivities(filter: ActivityFilter = {}): AsyncGenerator<ActivitySummary> {
    let start: number | null = filter.start ?? 0;
    for (let page = 0; start !== null; page++) {
      if (page >= MAX_PAGES) throw new RangeError(`Pagination exceeded ${MAX_PAGES} pages`);
      const result = await this.listActivities({ ...filter, start });
      yield* result.items;
      start = result.nextStart;
    }
  }

  /** A single activity by its Garmin id (numeric string). */
  getActivity(id: string): Promise<ActivityDetail> {
    return fetchActivity(this.api, id, this.includeRaw);
  }

  /**
   * File formats expected to be downloadable for an activity (derived from its metadata,
   * as Garmin offers no listing endpoint): `[]` for manual activities, otherwise fit + tcx,
   * plus gpx unless the activity is known to have no GPS track.
   */
  async listActivityFiles(id: string): Promise<ActivityFileFormat[]> {
    return availableFormats(await fetchActivity(this.api, id, false));
  }

  /**
   * Download an activity file. `fit` is the original upload, which Garmin delivers as a ZIP
   * archive; it is returned as-is with `compression: 'zip'`.
   */
  downloadActivityFile(id: string, format: ActivityFileFormat): Promise<ActivityFile> {
    return downloadFile(this.api, id, format);
  }

  /** Daily resting heart rate (bpm). Missing days are `not_measured`, never 0. */
  async getRestingHeartRate(range: DateRange): Promise<DailyMetric<number>[]> {
    return fetchRestingHeartRate(this.api, await this.requireDisplayName(), range);
  }

  /**
   * Daily VO2max (ml/kg/min, running/generic). Prefers `vo2MaxPreciseValue` over
   * `vo2MaxValue`. Unknown response shapes raise {@link UnsupportedResponseError}.
   */
  getVo2Max(range: DateRange): Promise<DailyMetric<number>[]> {
    return fetchVo2Max(this.api, range);
  }

  /** Nightly sleep summaries. Requests are chunked to 28 days. */
  getSleep(range: DateRange): Promise<DailyMetric<SleepSummary>[]> {
    return fetchSleep(this.api, range);
  }

  /** Nightly HRV summaries (ms). Requests are chunked to 28 days. */
  getHrv(range: DateRange): Promise<DailyMetric<HrvSummary>[]> {
    return fetchHrv(this.api, range);
  }
}

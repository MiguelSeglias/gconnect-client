/**
 * gconnect-client — unofficial, read-only Garmin Connect client.
 * Not affiliated with, endorsed by or supported by Garmin.
 */
export { GarminConnectClient } from './client';
export type { GarminConnectClientOptions, ClientLoginOptions } from './client';

export { login, completeMfa } from './auth/login';
export type {
  AuthOptions,
  LoginResult,
  AuthenticatedResult,
  MfaRequiredResult,
} from './auth/login';
export type { MfaChallenge, MfaFlow } from './auth/challenge';
export type { SerializedCookie } from './auth/cookie-jar';
export type { Credentials, LoginStrategyName } from './auth/sso-strategies';
export type { StoredTokens } from './auth/tokens';
export { parseStoredTokens } from './auth/tokens';

export { MemoryTokenStore } from './token-store';
export type { TokenStore } from './token-store';
export { FileTokenStore } from './file-token-store';

export type { Transport, Timeouts } from './http/transport';
export { DEFAULT_TIMEOUTS } from './http/transport';
export type { RetryOptions } from './http/api';
export { DEFAULT_RETRY } from './http/api';
export type { Clock } from './clock';
export type { GarminConnectEvent, EventListener } from './events';

export {
  GarminConnectError,
  AuthenticationError,
  InvalidMfaCodeError,
  CaptchaRequiredError,
  AccountLockedError,
  LoginFailedError,
  TokenExchangeError,
  SessionExpiredError,
  RateLimitError,
  NetworkError,
  HttpError,
  ResponseFormatError,
  UnsupportedResponseError,
  NotFoundError,
} from './errors';
export type {
  GarminConnectErrorCode,
  LoginAttempt,
  NetworkErrorKind,
  SessionExpiredReason,
} from './errors';

export type {
  ActivityDetail,
  ActivityFile,
  ActivityFileFormat,
  ActivityFilter,
  ActivityPage,
  ActivitySummary,
  DailyMetric,
  DateRange,
  HrvSummary,
  MetricStatus,
  SleepSummary,
  UserProfile,
} from './types';

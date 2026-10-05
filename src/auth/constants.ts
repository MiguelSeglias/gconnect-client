/**
 * Garmin endpoint constants: URLs, client ids and headers.
 *
 * Values ported from python-garminconnect v0.3.17 (garminconnect/client.py),
 * Copyright (c) 2020-2026 Ron Klinkien (cyberjunky), MIT licence — https://github.com/cyberjunky/python-garminconnect
 * See NOTICE. Garmin changes these from time to time; keep every such value in this file.
 */

export const SSO_ORIGIN = 'https://sso.garmin.com';
export const CONNECT_API_ORIGIN = 'https://connectapi.garmin.com';
export const DI_TOKEN_URL = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';

// Strategy 1: mobile (iOS app) JSON login
export const IOS_SSO_CLIENT_ID = 'GCM_IOS_DARK';
export const IOS_SERVICE_URL = 'https://mobile.integration.garmin.com/gcm/ios';
export const IOS_LOGIN_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
export const MOBILE_LOGIN_URL = `${SSO_ORIGIN}/mobile/api/login`;
export const MOBILE_MFA_VERIFY_URL = `${SSO_ORIGIN}/mobile/api/mfa/verifyCode`;

// Strategy 2: SSO embed widget (HTML form)
export const SSO_BASE = `${SSO_ORIGIN}/sso`;
export const SSO_EMBED = `${SSO_BASE}/embed`;
export const SSO_SIGNIN = `${SSO_BASE}/signin`;
export const WIDGET_MFA_VERIFY_URL = `${SSO_BASE}/verifyMFA/loginEnterMfaCode`;
export const WIDGET_MFA_REQUEST_CODE_URL = `${SSO_BASE}/verifyMFA/mfaCode`;
/** Anti-WAF pause between the widget GET and POST (seconds). */
export const WIDGET_DELAY_S = { min: 3, max: 8 } as const;

// Strategy 3: portal web JSON login
export const PORTAL_SSO_CLIENT_ID = 'GarminConnect';
export const PORTAL_SERVICE_URL = 'https://connect.garmin.com/app';
export const PORTAL_SIGNIN_URL = `${SSO_ORIGIN}/portal/sso/en-US/sign-in`;
export const PORTAL_LOGIN_URL = `${SSO_ORIGIN}/portal/api/login`;
export const PORTAL_MFA_VERIFY_URL = `${SSO_ORIGIN}/portal/api/mfa/verifyCode`;
/** Anti-WAF pause between the portal GET and POST (seconds). */
export const PORTAL_DELAY_S = { min: 10, max: 20 } as const;

export const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

// Service ticket -> DI OAuth2 token
export const DI_GRANT_TYPE =
  'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket';
/** Tried in this order; the first that accepts the ticket wins. */
export const DI_CLIENT_IDS = [
  'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
  'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4',
  'GARMIN_CONNECT_MOBILE_ANDROID_DI',
  'GARMIN_CONNECT_MOBILE_IOS_DI',
] as const;
/** Refresh this many seconds before the access token's `exp`. */
export const REFRESH_SKEW_S = 900;

// Native app headers used for token and API calls
export const NATIVE_API_USER_AGENT = 'GCM-Android-5.23';
export const NATIVE_X_GARMIN_USER_AGENT =
  'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; ' +
  'Android/33; Dalvik/2.1.0';

export function nativeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'User-Agent': NATIVE_API_USER_AGENT,
    'X-Garmin-User-Agent': NATIVE_X_GARMIN_USER_AGENT,
    'X-Garmin-Paired-App-Version': '10861',
    'X-Garmin-Client-Platform': 'Android',
    'X-App-Ver': '10861',
    'X-Lang': 'en',
    'X-GCExperience': 'GC5',
    'Accept-Language': 'en-US,en;q=0.9',
    ...extra,
  };
}

/** Endpoint used to confirm the API tier accepts a freshly obtained token. */
export const VERIFY_TOKEN_PATH = '/userprofile-service/socialProfile';

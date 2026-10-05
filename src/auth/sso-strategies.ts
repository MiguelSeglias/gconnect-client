/**
 * SSO login strategies: mobile JSON, widget HTML form, portal JSON.
 *
 * Ported from python-garminconnect v0.3.17 (garminconnect/client.py: `_do_mobile_login`,
 * `_widget_web_login`, `_widget_request_mfa_code`, `_do_portal_web_login`),
 * Copyright (c) 2020-2026 Ron Klinkien (cyberjunky), MIT licence — https://github.com/cyberjunky/python-garminconnect.
 * See NOTICE.
 *
 * Differences: the Python library rotates curl_cffi TLS fingerprints per strategy; here a
 * single injectable `Transport` is used for all strategies.
 */
import type { MfaChallenge, MfaFlow } from './challenge';
import {
  DESKTOP_USER_AGENT,
  IOS_LOGIN_UA,
  IOS_SERVICE_URL,
  IOS_SSO_CLIENT_ID,
  MOBILE_LOGIN_URL,
  PORTAL_DELAY_S,
  PORTAL_LOGIN_URL,
  PORTAL_SERVICE_URL,
  PORTAL_SIGNIN_URL,
  PORTAL_SSO_CLIENT_ID,
  SSO_EMBED,
  SSO_BASE,
  SSO_ORIGIN,
  SSO_SIGNIN,
  WIDGET_DELAY_S,
  WIDGET_MFA_REQUEST_CODE_URL,
} from './constants';
import { SsoSession, type SsoResponse } from './sso-session';
import {
  AccountLockedError,
  AuthenticationError,
  CaptchaRequiredError,
  HttpError,
  RateLimitError,
  UnsupportedResponseError,
} from '../errors';
import { parseRetryAfter, type HttpContext } from '../http/transport';

/** Names of the SSO strategies, in default order. */
export type LoginStrategyName = 'mobile' | 'widget' | 'portal';
export const DEFAULT_STRATEGIES: readonly LoginStrategyName[] = ['mobile', 'widget', 'portal'];

export interface Credentials {
  username: string;
  password: string;
}

export type StrategyOutcome =
  { kind: 'ticket'; ticket: string; serviceUrl: string } | { kind: 'mfa'; challenge: MfaChallenge };

export interface StrategyEnv {
  ctx: HttpContext;
  random: () => number;
}

const CSRF_RE = /name="_csrf"\s+value="(.+?)"/;
const TITLE_RE = /<title>(.+?)<\/title>/;
const TICKET_RE = /\?ticket=(ST-[^"'&\s<]+)/;
const WIDGET_MFA_VARS_RE =
  /var\s+(customerGuid|mfaMethod|locale|clientId|codeSentTo)\s*=\s*"([^"]*)"\s*;/g;

export function parseTitle(html: string): string {
  return TITLE_RE.exec(html)?.[1] ?? '';
}

export function parseCsrf(html: string): string | undefined {
  return CSRF_RE.exec(html)?.[1];
}

export function parseTicket(html: string): string | undefined {
  return TICKET_RE.exec(html)?.[1];
}

function parseWidgetMfaVars(html: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const m of html.matchAll(WIDGET_MFA_VARS_RE)) {
    if (m[1] !== undefined && m[2] !== undefined) vars[m[1]] = m[2];
  }
  return vars;
}

function delayMs(env: StrategyEnv, bounds: { min: number; max: number }): number {
  return Math.round((bounds.min + env.random() * (bounds.max - bounds.min)) * 1000);
}

function rateLimited(res: SsoResponse, env: StrategyEnv, what: string): RateLimitError {
  return new RateLimitError(
    `${what} returned 429`,
    parseRetryAfter(res.headers, env.ctx.clock.now()),
  );
}

function buildChallenge(
  session: SsoSession,
  env: StrategyEnv,
  fields: {
    flow: MfaFlow;
    mfaMethod: string;
    loginParams: Record<string, string>;
    postHeaders: Record<string, string>;
    serviceUrl: string;
    csrf?: string;
  },
): MfaChallenge {
  return {
    type: 'gconnect-client/mfa-challenge',
    version: 1,
    createdAt: env.ctx.clock.now(),
    cookies: session.jar.toJSON(),
    ...fields,
  };
}

/** Interpret the JSON body of the mobile/portal login endpoints. */
function interpretJsonLogin(
  res: SsoResponse,
  env: StrategyEnv,
  session: SsoSession,
  meta: {
    endpoint: string;
    flow: 'mobile' | 'portal';
    loginParams: Record<string, string>;
    postHeaders: Record<string, string>;
    serviceUrl: string;
  },
): StrategyOutcome {
  if (res.status === 429) throw rateLimited(res, env, meta.endpoint);
  if (res.status === 403) throw new HttpError(meta.endpoint, 403); // Cloudflare challenge
  let body: unknown;
  try {
    body = JSON.parse(res.text);
  } catch {
    throw new HttpError(meta.endpoint, res.status);
  }
  const obj = isRecord(body) ? body : {};
  const responseStatus = isRecord(obj.responseStatus) ? obj.responseStatus : {};
  const type = typeof responseStatus.type === 'string' ? responseStatus.type : undefined;
  const error = isRecord(obj.error) ? obj.error : {};

  if (type === 'MFA_REQUIRED') {
    const info = isRecord(obj.customerMfaInfo) ? obj.customerMfaInfo : {};
    const method = typeof info.mfaLastMethodUsed === 'string' ? info.mfaLastMethodUsed : 'email';
    return {
      kind: 'mfa',
      challenge: buildChallenge(session, env, {
        flow: meta.flow,
        mfaMethod: method,
        loginParams: meta.loginParams,
        postHeaders: meta.postHeaders,
        serviceUrl: meta.serviceUrl,
      }),
    };
  }
  if (type === 'SUCCESSFUL') {
    if (typeof obj.serviceTicketId !== 'string' || obj.serviceTicketId === '') {
      throw new UnsupportedResponseError(meta.endpoint, 'Login succeeded without a service ticket');
    }
    return { kind: 'ticket', ticket: obj.serviceTicketId, serviceUrl: meta.serviceUrl };
  }
  if (type === 'INVALID_USERNAME_PASSWORD') throw new AuthenticationError();
  if (error['status-code'] === '429' || error['status-code'] === 429) {
    throw new RateLimitError(`${meta.endpoint}: 429 in response body`);
  }
  if (type === 'CAPTCHA_REQUIRED') throw new CaptchaRequiredError();
  if (type !== undefined && type.includes('LOCKED')) throw new AccountLockedError();
  throw new UnsupportedResponseError(
    meta.endpoint,
    `Unexpected login response (HTTP ${res.status}, type ${type ?? 'unknown'})`,
  );
}

/** Strategy 1: mobile (iOS app) JSON login. */
export async function mobileLogin(env: StrategyEnv, creds: Credentials): Promise<StrategyOutcome> {
  const session = new SsoSession(env.ctx);
  const loginParams = { clientId: IOS_SSO_CLIENT_ID, locale: 'en-US', service: IOS_SERVICE_URL };
  const postHeaders = {
    'User-Agent': IOS_LOGIN_UA,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: SSO_ORIGIN,
  };
  const res = await session.request(MOBILE_LOGIN_URL, {
    method: 'POST',
    params: loginParams,
    headers: postHeaders,
    json: {
      username: creds.username,
      password: creds.password,
      rememberMe: true,
      captchaToken: '',
    },
  });
  return interpretJsonLogin(res, env, session, {
    endpoint: 'sso/mobile/api/login',
    flow: 'mobile',
    loginParams,
    postHeaders,
    serviceUrl: IOS_SERVICE_URL,
  });
}

export const WIDGET_EMBED_PARAMS = { id: 'gauth-widget', embedWidget: 'true', gauthHost: SSO_BASE };
export const WIDGET_SIGNIN_PARAMS = {
  ...WIDGET_EMBED_PARAMS,
  gauthHost: SSO_EMBED,
  service: SSO_EMBED,
  source: SSO_EMBED,
  redirectAfterAccountLoginUrl: SSO_EMBED,
  redirectAfterAccountCreationUrl: SSO_EMBED,
};

/** Strategy 2: SSO embed widget HTML form flow. */
export async function widgetLogin(env: StrategyEnv, creds: Credentials): Promise<StrategyOutcome> {
  const session = new SsoSession(env.ctx);
  const browser = { 'User-Agent': DESKTOP_USER_AGENT };

  let res = await session.request(SSO_EMBED, { params: WIDGET_EMBED_PARAMS, headers: browser });
  if (res.status === 429) throw rateLimited(res, env, 'sso/embed');
  if (res.status < 200 || res.status >= 300) throw new HttpError('sso/embed', res.status);

  res = await session.request(SSO_SIGNIN, {
    params: WIDGET_SIGNIN_PARAMS,
    headers: { ...browser, Referer: SSO_EMBED },
  });
  if (res.status === 429) throw rateLimited(res, env, 'sso/signin');
  const csrf = parseCsrf(res.text);
  if (csrf === undefined) throw new UnsupportedResponseError('sso/signin', 'Missing CSRF token');

  await env.ctx.clock.sleep(delayMs(env, WIDGET_DELAY_S)); // anti-WAF pause

  const referer = res.url;
  res = await session.request(SSO_SIGNIN, {
    method: 'POST',
    params: WIDGET_SIGNIN_PARAMS,
    headers: { ...browser, Referer: referer },
    form: { username: creds.username, password: creds.password, embed: 'true', _csrf: csrf },
  });
  if (res.status === 429) throw rateLimited(res, env, 'sso/signin POST');

  const title = parseTitle(res.text);
  const t = title.toLowerCase();
  if (
    ['bad gateway', 'service unavailable', 'cloudflare', '502', '503'].some((h) => t.includes(h))
  ) {
    throw new HttpError('sso/signin POST', res.status >= 400 ? res.status : 503);
  }
  if (t.includes('locked')) throw new AccountLockedError();
  if (['invalid', 'incorrect', 'account error'].some((h) => t.includes(h))) {
    throw new AuthenticationError();
  }
  if (t.includes('unable to sign in') || t.includes('unable to login')) {
    // Child/family accounts are restricted from web SSO; let other strategies try.
    throw new UnsupportedResponseError('sso/signin POST', 'Account restricted from web SSO');
  }

  const mfaVars = parseWidgetMfaVars(res.text);
  const mfaMethod = mfaVars.mfaMethod ?? '';
  if (t.includes('mfa') || (t.includes('authentication application') && mfaMethod !== '')) {
    await widgetRequestMfaCode(env, session, mfaVars, res.url);
    const mfaCsrf = parseCsrf(res.text);
    if (mfaCsrf === undefined)
      throw new UnsupportedResponseError('sso/signin POST', 'Missing MFA CSRF token');
    return {
      kind: 'mfa',
      challenge: buildChallenge(session, env, {
        flow: 'widget',
        mfaMethod,
        loginParams: WIDGET_SIGNIN_PARAMS,
        postHeaders: { ...browser, Referer: res.url },
        serviceUrl: SSO_EMBED,
        csrf: mfaCsrf,
      }),
    };
  }

  if (title !== 'Success') {
    throw new UnsupportedResponseError('sso/signin POST', 'Unexpected widget login page');
  }
  const ticket = parseTicket(res.text);
  if (ticket === undefined)
    throw new UnsupportedResponseError('sso/signin POST', 'Missing service ticket');
  return { kind: 'ticket', ticket, serviceUrl: SSO_EMBED };
}

/** Ask Garmin to send an email/SMS code for a widget MFA session (no-op for TOTP). */
async function widgetRequestMfaCode(
  env: StrategyEnv,
  session: SsoSession,
  vars: Record<string, string>,
  referer: string,
): Promise<void> {
  const method = (vars.mfaMethod ?? '').toLowerCase();
  if (method !== 'email' && method !== 'sms') return;
  if ((vars.codeSentTo ?? '') !== '') return;
  const res = await session.request(WIDGET_MFA_REQUEST_CODE_URL, {
    method: 'POST',
    params: { clientId: vars.clientId ?? '' },
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Referer: referer,
    },
    json: {
      customerGuid: vars.customerGuid ?? '',
      mfaMethod: vars.mfaMethod ?? '',
      locale: vars.locale ?? '',
    },
  });
  if (res.status === 429) throw rateLimited(res, env, 'sso/verifyMFA/mfaCode');
  if (res.status < 200 || res.status >= 300)
    throw new HttpError('sso/verifyMFA/mfaCode', res.status);
}

/** Strategy 3: portal web JSON login (with a long anti-WAF pause). */
export async function portalLogin(env: StrategyEnv, creds: Credentials): Promise<StrategyOutcome> {
  const session = new SsoSession(env.ctx);
  const browser = { 'User-Agent': DESKTOP_USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' };
  const get = await session.request(PORTAL_SIGNIN_URL, {
    params: { clientId: PORTAL_SSO_CLIENT_ID, service: PORTAL_SERVICE_URL },
    headers: {
      ...browser,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (get.status === 429) throw rateLimited(get, env, 'sso/portal sign-in');

  await env.ctx.clock.sleep(delayMs(env, PORTAL_DELAY_S)); // anti-WAF pause

  const loginParams = {
    clientId: PORTAL_SSO_CLIENT_ID,
    locale: 'en-US',
    service: PORTAL_SERVICE_URL,
  };
  const postHeaders = {
    ...browser,
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: SSO_ORIGIN,
    Referer: `${PORTAL_SIGNIN_URL}?clientId=${PORTAL_SSO_CLIENT_ID}&service=${PORTAL_SERVICE_URL}`,
  };
  const res = await session.request(PORTAL_LOGIN_URL, {
    method: 'POST',
    params: loginParams,
    headers: postHeaders,
    json: {
      username: creds.username,
      password: creds.password,
      rememberMe: true,
      captchaToken: '',
    },
  });
  return interpretJsonLogin(res, env, session, {
    endpoint: 'sso/portal/api/login',
    flow: 'portal',
    loginParams,
    postHeaders,
    serviceUrl: PORTAL_SERVICE_URL,
  });
}

export const STRATEGIES: Record<
  LoginStrategyName,
  (env: StrategyEnv, creds: Credentials) => Promise<StrategyOutcome>
> = { mobile: mobileLogin, widget: widgetLogin, portal: portalLogin };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

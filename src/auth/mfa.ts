/**
 * MFA code verification for a pending SSO login.
 *
 * Ported from python-garminconnect v0.3.17 (garminconnect/client.py: `_complete_mfa`,
 * `_complete_mfa_widget`), Copyright (c) 2020-2026 Ron Klinkien (cyberjunky), MIT licence —
 * https://github.com/cyberjunky/python-garminconnect. See NOTICE.
 */
import type { MfaChallenge } from './challenge';
import {
  IOS_SERVICE_URL,
  IOS_SSO_CLIENT_ID,
  MOBILE_MFA_VERIFY_URL,
  PORTAL_MFA_VERIFY_URL,
  PORTAL_SERVICE_URL,
  PORTAL_SSO_CLIENT_ID,
  WIDGET_MFA_VERIFY_URL,
} from './constants';
import { SsoSession } from './sso-session';
import { isRecord, parseTicket, parseTitle, type StrategyEnv } from './sso-strategies';
import {
  HttpError,
  InvalidMfaCodeError,
  NetworkError,
  RateLimitError,
  UnsupportedResponseError,
} from '../errors';
import { parseRetryAfter } from '../http/transport';

export interface VerifiedTicket {
  ticket: string;
  serviceUrl: string;
}

export async function verifyMfaCode(
  env: StrategyEnv,
  challenge: MfaChallenge,
  code: string,
): Promise<VerifiedTicket> {
  const session = new SsoSession(env.ctx, challenge.cookies);
  if (challenge.flow === 'widget') return verifyWidget(env, session, challenge, code);

  const primary =
    challenge.flow === 'mobile'
      ? { url: MOBILE_MFA_VERIFY_URL, params: { ...challenge.loginParams } }
      : { url: PORTAL_MFA_VERIFY_URL, params: { ...challenge.loginParams } };
  // Both endpoints share the SSO session cookies but may sit in different rate-limit buckets.
  const alternate =
    challenge.flow === 'mobile'
      ? {
          url: PORTAL_MFA_VERIFY_URL,
          params: { clientId: PORTAL_SSO_CLIENT_ID, locale: 'en-US', service: PORTAL_SERVICE_URL },
        }
      : {
          url: MOBILE_MFA_VERIFY_URL,
          params: { clientId: IOS_SSO_CLIENT_ID, locale: 'en-US', service: IOS_SERVICE_URL },
        };

  const body = {
    mfaMethod: challenge.mfaMethod,
    mfaVerificationCode: code,
    rememberMyBrowser: true,
    reconsentList: [],
    mfaSetup: false,
  };

  let rejected = false;
  let rateLimit: RateLimitError | undefined;
  let lastError: Error | undefined;
  for (const endpoint of [primary, alternate]) {
    let res;
    try {
      res = await session.request(endpoint.url, {
        method: 'POST',
        params: endpoint.params,
        headers: { ...challenge.postHeaders },
        json: body,
      });
    } catch (err) {
      if (err instanceof NetworkError) {
        lastError = err;
        continue;
      }
      throw err;
    }
    if (res.status === 429) {
      rateLimit = new RateLimitError(
        'MFA verification rate limited',
        parseRetryAfter(res.headers, env.ctx.clock.now()),
      );
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(res.text);
    } catch {
      lastError = new HttpError('sso/api/mfa/verifyCode', res.status); // likely a WAF page
      continue;
    }
    const obj = isRecord(json) ? json : {};
    const error = isRecord(obj.error) ? obj.error : {};
    if (error['status-code'] === '429' || error['status-code'] === 429) {
      rateLimit = new RateLimitError('MFA verification: 429 in response body');
      continue;
    }
    const status = isRecord(obj.responseStatus) ? obj.responseStatus : {};
    if (status.type === 'SUCCESSFUL') {
      if (typeof obj.serviceTicketId !== 'string' || obj.serviceTicketId === '') {
        throw new UnsupportedResponseError('sso/api/mfa/verifyCode', 'Missing service ticket');
      }
      return { ticket: obj.serviceTicketId, serviceUrl: challenge.serviceUrl };
    }
    rejected = true;
  }
  if (rejected) throw new InvalidMfaCodeError();
  if (rateLimit) throw rateLimit;
  throw lastError ?? new InvalidMfaCodeError();
}

async function verifyWidget(
  env: StrategyEnv,
  session: SsoSession,
  challenge: MfaChallenge,
  code: string,
): Promise<VerifiedTicket> {
  if (challenge.csrf === undefined) {
    throw new UnsupportedResponseError('sso/verifyMFA', 'Widget challenge without CSRF token');
  }
  const res = await session.request(WIDGET_MFA_VERIFY_URL, {
    method: 'POST',
    params: { ...challenge.loginParams },
    headers: { ...challenge.postHeaders },
    form: { 'mfa-code': code, embed: 'true', _csrf: challenge.csrf, fromPage: 'setupEnterMfaCode' },
  });
  if (res.status === 429) {
    throw new RateLimitError(
      'Widget MFA verification rate limited',
      parseRetryAfter(res.headers, env.ctx.clock.now()),
    );
  }
  if (parseTitle(res.text) !== 'Success') throw new InvalidMfaCodeError();
  const ticket = parseTicket(res.text);
  if (ticket === undefined) {
    throw new UnsupportedResponseError('sso/verifyMFA', 'Missing service ticket');
  }
  return { ticket, serviceUrl: challenge.serviceUrl };
}

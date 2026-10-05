/**
 * Service ticket -> DI OAuth2 token exchange, and token refresh.
 *
 * Ported from python-garminconnect v0.3.17 (garminconnect/client.py:
 * `_exchange_service_ticket`, `_refresh_di_token`), Copyright (c) 2020-2026 Ron Klinkien (cyberjunky), MIT licence —
 * https://github.com/cyberjunky/python-garminconnect. See NOTICE.
 */
import { z } from 'zod';
import { DI_CLIENT_IDS, DI_GRANT_TYPE, DI_TOKEN_URL, nativeHeaders } from './constants';
import { basicAuth, jwtClientId, jwtExpiry, type StoredTokens } from './tokens';
import { HttpError, RateLimitError, SessionExpiredError, TokenExchangeError } from '../errors';
import { emit } from '../events';
import { bodyJson, parseRetryAfter, sendBuffered, type HttpContext } from '../http/transport';

const tokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().optional(),
});

function toStoredTokens(
  ctx: HttpContext,
  data: z.infer<typeof tokenResponseSchema>,
  fallbackClientId: string,
  previousRefreshToken: string | null,
): StoredTokens {
  const exp = jwtExpiry(data.access_token);
  return {
    version: 1,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? previousRefreshToken,
    clientId: jwtClientId(data.access_token) ?? fallbackClientId,
    expiresAt:
      exp ??
      (data.expires_in !== undefined ? Math.floor(ctx.clock.now() / 1000) + data.expires_in : null),
  };
}

function tokenRequestHeaders(clientId: string, accept: string): Record<string, string> {
  return nativeHeaders({
    Authorization: basicAuth(clientId),
    Accept: accept,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cache-Control': 'no-cache',
  });
}

/**
 * Exchange a CAS service ticket for DI tokens, trying each known client id in order.
 * `serviceUrl` must match the service used during SSO login.
 */
export async function exchangeServiceTicket(
  ctx: HttpContext,
  ticket: string,
  serviceUrl: string,
): Promise<StoredTokens> {
  let lastStatus: number | undefined;
  for (const clientId of DI_CLIENT_IDS) {
    const res = await sendBuffered(
      ctx,
      DI_TOKEN_URL,
      {
        method: 'POST',
        headers: tokenRequestHeaders(clientId, 'application/json,text/html;q=0.9,*/*;q=0.8'),
        body: new URLSearchParams({
          client_id: clientId,
          service_ticket: ticket,
          grant_type: DI_GRANT_TYPE,
          service_url: serviceUrl,
        }).toString(),
      },
      ctx.timeouts.tokenMs,
    );
    if (res.status === 429) {
      throw new RateLimitError(
        'Token exchange rate limited',
        parseRetryAfter(res.headers, ctx.clock.now()),
      );
    }
    lastStatus = res.status;
    if (res.status < 200 || res.status >= 300) {
      emit(ctx.onEvent, { type: 'token_exchange', clientId, outcome: 'rejected' });
      continue;
    }
    const json = bodyJson(res);
    const parsed = json.ok ? tokenResponseSchema.safeParse(json.value) : undefined;
    if (!parsed?.success) {
      emit(ctx.onEvent, { type: 'token_exchange', clientId, outcome: 'rejected' });
      continue;
    }
    emit(ctx.onEvent, { type: 'token_exchange', clientId, outcome: 'success' });
    return toStoredTokens(ctx, parsed.data, clientId, null);
  }
  throw new TokenExchangeError(
    'Service ticket was not accepted for any known client id',
    lastStatus,
  );
}

/**
 * Refresh the access token. A 400/401 means the refresh token is no longer valid and is
 * reported as {@link SessionExpiredError}; other failures keep their own error type.
 */
export async function refreshTokens(ctx: HttpContext, tokens: StoredTokens): Promise<StoredTokens> {
  if (tokens.refreshToken === null) {
    throw new SessionExpiredError('refresh_failed', 'No refresh token available; login required');
  }
  const res = await sendBuffered(
    ctx,
    DI_TOKEN_URL,
    {
      method: 'POST',
      headers: tokenRequestHeaders(tokens.clientId, 'application/json'),
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: tokens.clientId,
        refresh_token: tokens.refreshToken,
      }).toString(),
    },
    ctx.timeouts.tokenMs,
  );
  if (res.status === 429) {
    throw new RateLimitError(
      'Token refresh rate limited',
      parseRetryAfter(res.headers, ctx.clock.now()),
    );
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new SessionExpiredError('refresh_failed');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError('di-oauth2-service/oauth/token', res.status);
  }
  const json = bodyJson(res);
  const parsed = json.ok ? tokenResponseSchema.safeParse(json.value) : undefined;
  if (!parsed?.success) {
    throw new SessionExpiredError('refresh_failed', 'Token refresh returned an unusable response');
  }
  return toStoredTokens(ctx, parsed.data, tokens.clientId, tokens.refreshToken);
}

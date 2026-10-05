import type { Clock } from '../clock';
import { NetworkError } from '../errors';
import { emit, redactUrl, type EventListener } from '../events';

/**
 * A fetch-compatible function. Defaults to the global `fetch`.
 *
 * This is the extension point for network customisation: Cloudflare in front of
 * `sso.garmin.com` may block Node's TLS fingerprint, in which case a transport that routes
 * SSO traffic through a TLS-impersonating proxy can be supplied. The transport must not
 * follow redirects on its own when `init.redirect === 'manual'` is passed.
 */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

/** Per-operation-class timeouts in milliseconds. */
export interface Timeouts {
  /** SSO login / MFA requests. Default 20 000. */
  ssoMs: number;
  /** OAuth token exchange and refresh. Default 15 000. */
  tokenMs: number;
  /** JSON API reads. Default 20 000. */
  apiMs: number;
  /** File downloads. Default 60 000. */
  downloadMs: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  ssoMs: 20_000,
  tokenMs: 15_000,
  apiMs: 20_000,
  downloadMs: 60_000,
};

export interface HttpContext {
  transport: Transport;
  clock: Clock;
  timeouts: Timeouts;
  onEvent?: EventListener | undefined;
}

/** A fully buffered HTTP response. */
export interface BufferedResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

export const defaultTransport: Transport = (url, init) => fetch(url, init);

/**
 * Perform one request and buffer its body, all within `timeoutMs`. Transport failures are
 * mapped to {@link NetworkError}. Emits a redacted `request` event.
 */
export async function sendBuffered(
  ctx: HttpContext,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  attempt = 1,
  /** URL reported in events instead of `url` (e.g. a template without ids). */
  eventUrl?: string,
): Promise<BufferedResponse> {
  const controller = new AbortController();
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort(new DOMException('Request timed out', 'TimeoutError'));
  }, timeoutMs);
  const started = ctx.clock.now();
  const method = init.method ?? 'GET';
  let status: number | null = null;
  try {
    const response = await ctx.transport(url, { ...init, signal: controller.signal });
    status = response.status;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes };
  } catch (err) {
    if (state.timedOut) {
      throw new NetworkError(
        'timeout',
        `${method} ${redactUrl(url)} timed out after ${timeoutMs} ms`,
        {
          cause: err,
        },
      );
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new NetworkError('aborted', `${method} ${redactUrl(url)} was aborted`, { cause: err });
    }
    throw new NetworkError('network', `${method} ${redactUrl(url)} failed`, { cause: err });
  } finally {
    clearTimeout(timer);
    emit(ctx.onEvent, {
      type: 'request',
      method,
      url: redactUrl(eventUrl ?? url),
      status,
      durationMs: ctx.clock.now() - started,
      attempt,
    });
  }
}

const decoder = new TextDecoder();

export function bodyText(res: BufferedResponse): string {
  return decoder.decode(res.bytes);
}

/** Parse JSON; returns `undefined` for empty bodies and `null` for invalid JSON markers. */
export function bodyJson(res: BufferedResponse): { ok: true; value: unknown } | { ok: false } {
  const text = bodyText(res).trim();
  if (text === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Parse a `Retry-After` header (delta-seconds or HTTP date) into seconds. */
export function parseRetryAfter(headers: Headers, nowMs: number): number | undefined {
  const value = headers.get('retry-after');
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - nowMs) / 1000));
}

/** Build a URL with query parameters; `undefined` values are skipped. */
export function buildUrl(
  base: string,
  params?: Record<string, string | number | undefined>,
): string {
  if (!params) return base;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.append(key, String(value));
  }
  const qs = search.toString();
  return qs === '' ? base : `${base}?${qs}`;
}

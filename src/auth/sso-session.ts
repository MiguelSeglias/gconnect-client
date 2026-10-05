import { CookieJar, type SerializedCookie } from './cookie-jar';
import { bodyText, buildUrl, sendBuffered, type HttpContext } from '../http/transport';

export interface SsoRequest {
  method?: 'GET' | 'POST';
  params?: Record<string, string>;
  headers?: Record<string, string>;
  /** JSON body (sets Content-Type unless given). */
  json?: unknown;
  /** Form body (application/x-www-form-urlencoded). */
  form?: Record<string, string>;
}

export interface SsoResponse {
  status: number;
  headers: Headers;
  text: string;
  /** URL of the final response after redirects (including query). */
  url: string;
}

const MAX_REDIRECTS = 10;

/**
 * One SSO browser-like session: keeps cookies across requests and follows redirects
 * manually so that cookies set on intermediate 3xx responses are not lost.
 */
export class SsoSession {
  readonly jar: CookieJar;

  constructor(
    private readonly ctx: HttpContext,
    cookies: readonly SerializedCookie[] = [],
  ) {
    this.jar = new CookieJar(cookies);
  }

  async request(url: string, req: SsoRequest = {}): Promise<SsoResponse> {
    let method: string = req.method ?? 'GET';
    let target = buildUrl(url, req.params);
    let body: string | undefined;
    const baseHeaders: Record<string, string> = { ...req.headers };
    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      baseHeaders['Content-Type'] ??= 'application/json';
    } else if (req.form) {
      body = new URLSearchParams(req.form).toString();
      baseHeaders['Content-Type'] ??= 'application/x-www-form-urlencoded';
    }

    for (let hop = 0; ; hop++) {
      const headers = new Headers(baseHeaders);
      const cookie = this.jar.headerFor(target, this.ctx.clock.now());
      if (cookie !== undefined) headers.set('Cookie', cookie);
      const res = await sendBuffered(
        this.ctx,
        target,
        { method, headers, body, redirect: 'manual' },
        this.ctx.timeouts.ssoMs,
      );
      this.jar.storeFromResponse(target, res.headers, this.ctx.clock.now());
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location !== null && hop < MAX_REDIRECTS) {
        target = new URL(location, target).toString();
        if (res.status !== 307 && res.status !== 308) {
          method = 'GET';
          body = undefined;
          delete baseHeaders['Content-Type'];
        }
        continue;
      }
      return { status: res.status, headers: res.headers, text: bodyText(res), url: target };
    }
  }
}

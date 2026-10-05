import type { Clock, StoredTokens, Transport } from '../src';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Headers;
  body: string | undefined;
}

type Responder = (call: RecordedCall, init: RequestInit) => Response | Promise<Response>;

interface Route {
  method: string;
  match: (url: URL) => boolean;
  responders: Responder[];
  used: number;
}

/** Route-based fake fetch. Responders for a route are consumed in order; the last repeats. */
export class FakeTransport {
  readonly calls: RecordedCall[] = [];
  private readonly routes: Route[] = [];

  on(method: string, url: string | RegExp, ...responders: (Responder | Response)[]): this {
    const match =
      typeof url === 'string'
        ? (u: URL) => `${u.origin}${u.pathname}` === url
        : (u: URL) => url.test(u.toString());
    this.routes.push({
      method,
      match,
      used: 0,
      responders: responders.map((r) => (r instanceof Response ? () => r.clone() : r)),
    });
    return this;
  }

  callsTo(path: string | RegExp): RecordedCall[] {
    return this.calls.filter((c) =>
      typeof path === 'string' ? c.url.pathname === path : path.test(c.url.toString()),
    );
  }

  readonly fetch: Transport = async (url, init) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? init.body : undefined;
    const call: RecordedCall = { url: u, method, headers: new Headers(init.headers), body };
    this.calls.push(call);
    const route = this.routes.find((r) => r.method === method && r.match(u));
    if (!route) return new Response('no route', { status: 599 });
    const responder = route.responders[Math.min(route.used, route.responders.length - 1)];
    route.used++;
    if (!responder) throw new Error('route without responder');
    return responder(call, init);
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html', ...headers } });
}

export function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response(code === 204 ? null : '', { status: code, headers });
}

export class FakeClock implements Clock {
  readonly sleeps: number[] = [];
  constructor(public time = Date.UTC(2026, 0, 15, 12, 0, 0)) {}
  now(): number {
    return this.time;
  }
  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.time += ms;
    return Promise.resolve();
  }
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Synthetic unsigned-looking JWT (not a real token). */
export function fakeJwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.fake-signature`;
}

export const FAKE_CLIENT_ID = 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2';

export function tokenResponse(expSeconds: number, suffix = '1'): Response {
  return json({
    access_token: fakeJwt({ exp: expSeconds, client_id: FAKE_CLIENT_ID, sub: `fake-${suffix}` }),
    refresh_token: `fake-refresh-${suffix}`,
    expires_in: 3600,
  });
}

export function storedTokens(
  clock: FakeClock,
  overrides: Partial<StoredTokens> = {},
): StoredTokens {
  const exp = Math.floor(clock.now() / 1000) + 3600;
  return {
    version: 1,
    accessToken: fakeJwt({ exp, client_id: FAKE_CLIENT_ID }),
    refreshToken: 'fake-refresh-0',
    clientId: FAKE_CLIENT_ID,
    expiresAt: exp,
    ...overrides,
  };
}

export function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

export function fixtureJson(name: string): unknown {
  return JSON.parse(fixture(name)) as unknown;
}

export const FAKE_CREDENTIALS = {
  username: 'runner-1@example.invalid',
  password: 'fake-password-123',
};

export async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

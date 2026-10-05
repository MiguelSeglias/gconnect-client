import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GarminConnectClient,
  HttpError,
  LoginFailedError,
  MemoryTokenStore,
  NetworkError,
  RateLimitError,
  login,
  type Transport,
} from '../src';
import { FAKE_CREDENTIALS, FakeClock, FakeTransport, json, status, storedTokens } from './helpers';

const PROFILE = 'https://connectapi.garmin.com/userprofile-service/socialProfile';

function makeClient(transport: Transport, clock?: FakeClock, extra: object = {}) {
  const tokenClock = clock ?? new FakeClock(Date.now());
  return new GarminConnectClient({
    tokenStore: new MemoryTokenStore(storedTokens(tokenClock)),
    transport,
    ...(clock ? { clock } : {}),
    random: () => 0,
    ...extra,
  });
}

describe('retries with fake timers (system clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a GET on 503 up to the attempt cap, then throws HttpError', async () => {
    const transport = new FakeTransport();
    transport.on('GET', PROFILE, status(503));
    const client = makeClient(transport.fetch);
    const promise = client.getUserProfile().catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await promise;
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
    expect(transport.calls).toHaveLength(3);
  });

  it('succeeds when a retry succeeds', async () => {
    const transport = new FakeTransport();
    transport.on('GET', PROFILE, status(502), json({ displayName: 'runner-1' }));
    const client = makeClient(transport.fetch);
    const promise = client.getUserProfile();
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ displayName: 'runner-1' });
    expect(transport.calls).toHaveLength(2);
  });

  it('maps a timeout to NetworkError{kind: timeout}', async () => {
    const hanging: Transport = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    const client = makeClient(hanging, undefined, {
      retry: { maxAttempts: 1 },
      timeouts: { apiMs: 5000 },
    });
    const promise = client.getUserProfile().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5000);
    const err = await promise;
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).kind).toBe('timeout');
    expect((err as NetworkError).message).not.toContain('?');
  });

  it('retries timeouts within the attempt cap', async () => {
    let calls = 0;
    const transport: Transport = (_url, init) => {
      calls++;
      if (calls < 3) {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
        });
      }
      return Promise.resolve(json({ displayName: 'runner-1' }));
    };
    const client = makeClient(transport);
    const promise = client.getUserProfile();
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ displayName: 'runner-1' });
    expect(calls).toBe(3);
  });
});

describe('retry policy (fake clock)', () => {
  it('uses exponential backoff with a cap', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    transport.on('GET', PROFILE, status(500));
    const client = makeClient(transport.fetch, clock, {
      retry: { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 3000 },
    });
    await expect(client.getUserProfile()).rejects.toBeInstanceOf(HttpError);
    expect(clock.sleeps).toEqual([1000, 2000, 3000]);
  });

  it('respects Retry-After on 429', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    transport.on(
      'GET',
      PROFILE,
      status(429, { 'Retry-After': '2' }),
      json({ displayName: 'runner-1' }),
    );
    const client = makeClient(transport.fetch, clock);
    await client.getUserProfile();
    expect(clock.sleeps).toEqual([2000]);
  });

  it('gives up immediately with RateLimitError when Retry-After exceeds the cap', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    transport.on('GET', PROFILE, status(429, { 'Retry-After': '3600' }));
    const client = makeClient(transport.fetch, clock);
    const err = await client.getUserProfile().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSeconds).toBe(3600);
    expect(transport.calls).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('does not retry 4xx other than 429', async () => {
    const transport = new FakeTransport();
    transport.on('GET', PROFILE, status(403));
    const client = makeClient(transport.fetch, new FakeClock());
    await expect(client.getUserProfile()).rejects.toBeInstanceOf(HttpError);
    expect(transport.calls).toHaveLength(1);
  });
});

describe('login is never retried', () => {
  it('posts each SSO login endpoint exactly once even on 503/network errors', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    transport
      .on('POST', 'https://sso.garmin.com/mobile/api/login', status(503))
      .on('GET', 'https://sso.garmin.com/sso/embed', () =>
        Promise.reject(new TypeError('fetch failed')),
      )
      .on('GET', 'https://sso.garmin.com/portal/sso/en-US/sign-in', status(200))
      .on('POST', 'https://sso.garmin.com/portal/api/login', status(503));
    const err = await login(FAKE_CREDENTIALS, {
      transport: transport.fetch,
      clock,
      random: () => 0,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginFailedError);
    expect(transport.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    expect(transport.callsTo('/sso/embed')).toHaveLength(1);
    expect(clock.sleeps).toEqual([10_000]); // only the portal anti-WAF pause
  });
});

import { describe, expect, it } from 'vitest';
import {
  GarminConnectClient,
  MemoryTokenStore,
  NetworkError,
  RateLimitError,
  SessionExpiredError,
  type StoredTokens,
} from '../src';
import {
  FAKE_CREDENTIALS,
  FakeClock,
  FakeTransport,
  json,
  status,
  storedTokens,
  tokenResponse,
} from './helpers';

const TOKEN = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';
const PROFILE = 'https://connectapi.garmin.com/userprofile-service/socialProfile';

function setup(tokens: (clock: FakeClock) => StoredTokens | null = (c) => storedTokens(c)) {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const store = new MemoryTokenStore(tokens(clock));
  const client = new GarminConnectClient({
    tokenStore: store,
    transport: transport.fetch,
    clock,
    random: () => 0,
  });
  return { transport, clock, store, client };
}

describe('token lifecycle', () => {
  it('sends the access token as Bearer with native headers', async () => {
    const { transport, client, store } = setup();
    transport.on('GET', PROFILE, json({ displayName: 'runner-1' }));
    await client.getUserProfile();
    const [call] = transport.callsTo('/userprofile-service/socialProfile');
    const tokens = await store.load();
    expect(call?.headers.get('authorization')).toBe(`Bearer ${tokens?.accessToken ?? ''}`);
    expect(call?.headers.get('x-garmin-user-agent')).toContain(
      'com.garmin.android.apps.connectmobile',
    );
    expect(call?.headers.get('user-agent')).toBe('GCM-Android-5.23');
  });

  it('refreshes proactively within 15 minutes of expiry and saves the new tokens', async () => {
    const { transport, client, store, clock } = setup((c) =>
      storedTokens(c, { expiresAt: Math.floor(c.now() / 1000) + 600 }),
    );
    const newExp = Math.floor(clock.now() / 1000) + 7200;
    transport
      .on('POST', TOKEN, tokenResponse(newExp, 'r1'))
      .on('GET', PROFILE, json({ displayName: 'runner-1' }));

    await client.getUserProfile();

    const [refresh] = transport.callsTo('/di-oauth2-service/oauth/token');
    const form = new URLSearchParams(refresh?.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('fake-refresh-0');
    expect(form.get('client_id')).toBe('GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2');
    const saved = await store.load();
    expect(saved?.expiresAt).toBe(newExp);
    expect(saved?.refreshToken).toBe('fake-refresh-r1');
    const [api] = transport.callsTo('/userprofile-service/socialProfile');
    expect(api?.headers.get('authorization')).toBe(`Bearer ${saved?.accessToken ?? ''}`);
  });

  it('does not refresh a token that is far from expiry', async () => {
    const { transport, client } = setup();
    transport.on('GET', PROFILE, json({ displayName: 'runner-1' }));
    await client.getUserProfile();
    expect(transport.callsTo('/di-oauth2-service/oauth/token')).toHaveLength(0);
  });

  it('refreshes once on 401 and retries the request once', async () => {
    const { transport, client, clock } = setup();
    transport
      .on('GET', PROFILE, status(401), json({ displayName: 'runner-1' }))
      .on('POST', TOKEN, tokenResponse(Math.floor(clock.now() / 1000) + 7200, 'r2'));
    const profile = await client.getUserProfile();
    expect(profile.displayName).toBe('runner-1');
    expect(transport.callsTo('/userprofile-service/socialProfile')).toHaveLength(2);
    expect(transport.callsTo('/di-oauth2-service/oauth/token')).toHaveLength(1);
  });

  it('throws SessionExpiredError(rejected) if the refreshed token is also rejected', async () => {
    const { transport, client, clock, store } = setup();
    transport
      .on('GET', PROFILE, status(401))
      .on('POST', TOKEN, tokenResponse(Math.floor(clock.now() / 1000) + 7200, 'r3'));
    const err = await client.getUserProfile().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect((err as SessionExpiredError).reason).toBe('rejected');
    expect(transport.callsTo('/userprofile-service/socialProfile')).toHaveLength(2);
    expect(await store.load()).not.toBeNull(); // refreshed tokens kept; consumer decides
  });

  it('clears the store and throws SessionExpiredError when the refresh token is rejected', async () => {
    const { transport, client, store } = setup();
    transport
      .on('GET', PROFILE, status(401))
      .on('POST', TOKEN, json({ error: 'invalid_grant' }, 400));
    const err = await client.getUserProfile().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect((err as SessionExpiredError).reason).toBe('refresh_failed');
    expect(await store.load()).toBeNull();
    expect(await client.isAuthenticated()).toBe(false);
  });

  it('keeps using a still-valid token when a proactive refresh fails transiently', async () => {
    const { transport, client, store } = setup((c) =>
      storedTokens(c, { expiresAt: Math.floor(c.now() / 1000) + 600 }),
    );
    transport.on('POST', TOKEN, status(503)).on('GET', PROFILE, json({ displayName: 'runner-1' }));
    await expect(client.getUserProfile()).resolves.toMatchObject({ displayName: 'runner-1' });
    expect(await store.load()).not.toBeNull();
  });

  it('propagates a rate-limited refresh without clearing tokens', async () => {
    const { transport, client, store } = setup();
    transport.on('GET', PROFILE, status(401)).on('POST', TOKEN, status(429));
    await expect(client.getUserProfile()).rejects.toBeInstanceOf(RateLimitError);
    expect(await store.load()).not.toBeNull();
  });

  it('shares one refresh between concurrent requests', async () => {
    const { transport, client, clock } = setup((c) =>
      storedTokens(c, { expiresAt: Math.floor(c.now() / 1000) + 60 }),
    );
    transport
      .on('POST', TOKEN, tokenResponse(Math.floor(clock.now() / 1000) + 7200, 'r4'))
      .on('GET', PROFILE, json({ displayName: 'runner-1' }));
    await Promise.all([client.getUserProfile(), client.getUserProfile(), client.getUserProfile()]);
    expect(transport.callsTo('/di-oauth2-service/oauth/token')).toHaveLength(1);
  });

  it('throws SessionExpiredError(no_tokens) without stored tokens', async () => {
    const { client, transport } = setup(() => null);
    const err = await client.getUserProfile().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect((err as SessionExpiredError).reason).toBe('no_tokens');
    expect(transport.calls).toHaveLength(0);
  });

  it('wraps transport failures in NetworkError', async () => {
    const { client, transport } = setup();
    transport.on('GET', PROFILE, () => Promise.reject(new TypeError('fetch failed')));
    const err = await client.getUserProfile().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).kind).toBe('network');
  });
});

describe('client login/logout', () => {
  it('logs in through the client, saves tokens, and logout clears them', async () => {
    const { transport, client, store, clock } = setup(() => null);
    transport
      .on(
        'POST',
        'https://sso.garmin.com/mobile/api/login',
        json({ responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'ST-1-fake' }),
      )
      .on('POST', TOKEN, tokenResponse(Math.floor(clock.now() / 1000) + 3600))
      .on('GET', PROFILE, json({ displayName: 'runner-1' }));
    expect(await client.isAuthenticated()).toBe(false);
    const result = await client.login(FAKE_CREDENTIALS);
    expect(result.status).toBe('authenticated');
    expect(await client.isAuthenticated()).toBe(true);
    await client.getUserProfile();
    await client.logout();
    expect(await store.load()).toBeNull();
    expect(await client.isAuthenticated()).toBe(false);
    await expect(client.getUserProfile()).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('reports an expired token without refresh token as not authenticated', async () => {
    const { client } = setup((c) =>
      storedTokens(c, { refreshToken: null, expiresAt: Math.floor(c.now() / 1000) - 10 }),
    );
    expect(await client.isAuthenticated()).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { GarminConnectClient, MemoryTokenStore, type GarminConnectEvent } from '../src';
import {
  FAKE_CREDENTIALS,
  FakeClock,
  FakeTransport,
  fixture,
  fixtureJson,
  html,
  json,
  status,
  tokenResponse,
} from './helpers';

describe('onEvent redaction', () => {
  it('never exposes credentials, tokens, cookies, tickets, ids or health values', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const store = new MemoryTokenStore();
    const events: GarminConnectEvent[] = [];
    const client = new GarminConnectClient({
      tokenStore: store,
      transport: transport.fetch,
      clock,
      random: () => 0,
      onEvent: (e) => events.push(e),
    });
    const exp = Math.floor(clock.now() / 1000) + 600; // forces a proactive refresh later
    transport
      .on(
        'POST',
        'https://sso.garmin.com/mobile/api/login',
        json({ responseStatus: { type: 'CAPTCHA_REQUIRED' } }),
      )
      .on(
        'GET',
        'https://sso.garmin.com/sso/embed',
        html('', 200, { 'Set-Cookie': 'FAKE_COOKIE=cookie-secret-value' }),
      )
      .on('GET', 'https://sso.garmin.com/sso/signin', html(fixture('widget-signin.html')))
      .on('POST', 'https://sso.garmin.com/sso/signin', html(fixture('widget-mfa.html')))
      .on('POST', 'https://sso.garmin.com/sso/verifyMFA/mfaCode', json({}))
      .on(
        'POST',
        'https://sso.garmin.com/sso/verifyMFA/loginEnterMfaCode',
        html(fixture('widget-success.html')),
      )
      .on(
        'POST',
        'https://diauth.garmin.com/di-oauth2-service/oauth/token',
        tokenResponse(exp, 'a'),
        tokenResponse(exp + 7200, 'b'),
      )
      .on(
        'GET',
        'https://connectapi.garmin.com/userprofile-service/socialProfile',
        json(fixtureJson('profile.json')),
      )
      .on('GET', /userstats-service/, json(fixtureJson('resting-hr.json')))
      .on('GET', /activitylist-service/, status(503), json(fixtureJson('activities-page-1.json')));

    const first = await client.login(FAKE_CREDENTIALS);
    if (first.status !== 'mfa_required') throw new Error('expected mfa');
    await client.completeMfa(first.challenge, '987654');
    await client.getRestingHeartRate({ from: '2026-01-01', to: '2026-01-04' });
    await client.listActivities({ startDate: '2026-01-01' });

    const tokens = await store.load();
    const serialized = JSON.stringify(events);
    const forbidden = [
      FAKE_CREDENTIALS.username,
      FAKE_CREDENTIALS.password,
      tokens?.accessToken ?? 'missing',
      tokens?.refreshToken ?? 'missing',
      'fake-refresh-a',
      'cookie-secret-value',
      'ST-0000001',
      'fake-csrf',
      '987654',
      'runner-1',
      'Runner One',
      '90000000001',
      '2026-01-01',
      '48',
      'ticket',
    ];
    for (const value of forbidden) expect(serialized).not.toContain(value);

    expect(events.some((e) => e.type === 'request')).toBe(true);
    expect(events.some((e) => e.type === 'retry')).toBe(true);
    expect(events.some((e) => e.type === 'token_refresh' && e.outcome === 'success')).toBe(true);
    expect(events).toContainEqual({
      type: 'login_strategy',
      strategy: 'mobile',
      outcome: 'captcha_required',
    });
    for (const e of events) {
      if (e.type === 'request') expect(e.url).not.toMatch(/[?#]/);
    }
  });

  it('swallows listener exceptions', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    transport.on('GET', /socialProfile/, json({ displayName: 'runner-1' }));
    const client = new GarminConnectClient({
      tokenStore: new MemoryTokenStore({
        version: 1,
        accessToken: 'fake-access',
        refreshToken: null,
        clientId: 'FAKE',
        expiresAt: null,
      }),
      transport: transport.fetch,
      clock,
      onEvent: () => {
        throw new Error('listener bug');
      },
    });
    await expect(client.getUserProfile()).resolves.toMatchObject({ displayName: 'runner-1' });
  });
});

import { describe, expect, it } from 'vitest';
import {
  AccountLockedError,
  AuthenticationError,
  CaptchaRequiredError,
  InvalidMfaCodeError,
  LoginFailedError,
  MemoryTokenStore,
  RateLimitError,
  TokenExchangeError,
  completeMfa,
  login,
  type AuthOptions,
  type MfaChallenge,
} from '../src';
import {
  FAKE_CLIENT_ID,
  FAKE_CREDENTIALS,
  FakeClock,
  FakeTransport,
  fakeJwt,
  fixture,
  html,
  json,
  status,
  tokenResponse,
} from './helpers';

const MOBILE_LOGIN = 'https://sso.garmin.com/mobile/api/login';
const MOBILE_MFA = 'https://sso.garmin.com/mobile/api/mfa/verifyCode';
const PORTAL_MFA = 'https://sso.garmin.com/portal/api/mfa/verifyCode';
const PORTAL_SIGNIN = 'https://sso.garmin.com/portal/sso/en-US/sign-in';
const PORTAL_LOGIN = 'https://sso.garmin.com/portal/api/login';
const EMBED = 'https://sso.garmin.com/sso/embed';
const SIGNIN = 'https://sso.garmin.com/sso/signin';
const WIDGET_MFA = 'https://sso.garmin.com/sso/verifyMFA/loginEnterMfaCode';
const WIDGET_MFA_CODE = 'https://sso.garmin.com/sso/verifyMFA/mfaCode';
const TOKEN = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';
const VERIFY = 'https://connectapi.garmin.com/userprofile-service/socialProfile';

function setup() {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const store = new MemoryTokenStore();
  const exp = Math.floor(clock.now() / 1000) + 3600;
  const options: AuthOptions = {
    transport: transport.fetch,
    clock,
    tokenStore: store,
    random: () => 0.5,
  };
  return { transport, clock, store, exp, options };
}

const success = (ticket = 'ST-0000001-FakeTicket-cas') =>
  json({ responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: ticket });

describe('login: mobile strategy', () => {
  it('exchanges the service ticket and saves tokens', async () => {
    const { transport, store, exp, options } = setup();
    transport
      .on('POST', MOBILE_LOGIN, success())
      .on('POST', TOKEN, tokenResponse(exp))
      .on('GET', VERIFY, json({ displayName: 'runner-1' }));

    const result = await login(FAKE_CREDENTIALS, options);

    expect(result.status).toBe('authenticated');
    const saved = await store.load();
    expect(saved).not.toBeNull();
    expect(saved?.expiresAt).toBe(exp);
    expect(saved?.clientId).toBe(FAKE_CLIENT_ID);
    expect(saved?.refreshToken).toBe('fake-refresh-1');

    const [loginCall] = transport.callsTo('/mobile/api/login');
    expect(loginCall?.url.searchParams.get('clientId')).toBe('GCM_IOS_DARK');
    expect(loginCall?.url.searchParams.get('service')).toBe(
      'https://mobile.integration.garmin.com/gcm/ios',
    );
    expect(loginCall?.headers.get('origin')).toBe('https://sso.garmin.com');
    expect(JSON.parse(loginCall?.body ?? '{}')).toEqual({
      username: FAKE_CREDENTIALS.username,
      password: FAKE_CREDENTIALS.password,
      rememberMe: true,
      captchaToken: '',
    });

    const [tokenCall] = transport.callsTo('/di-oauth2-service/oauth/token');
    const form = new URLSearchParams(tokenCall?.body);
    expect(form.get('client_id')).toBe('GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2');
    expect(form.get('service_ticket')).toBe('ST-0000001-FakeTicket-cas');
    expect(form.get('grant_type')).toBe(
      'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket',
    );
    expect(form.get('service_url')).toBe('https://mobile.integration.garmin.com/gcm/ios');
    expect(tokenCall?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2:').toString('base64')}`,
    );
    expect(tokenCall?.headers.get('user-agent')).toBe('GCM-Android-5.23');
  });

  it('stops immediately on invalid credentials', async () => {
    const { transport, store, options } = setup();
    transport.on(
      'POST',
      MOBILE_LOGIN,
      json({ responseStatus: { type: 'INVALID_USERNAME_PASSWORD' } }),
    );

    await expect(login(FAKE_CREDENTIALS, options)).rejects.toBeInstanceOf(AuthenticationError);
    expect(transport.calls).toHaveLength(1);
    expect(await store.load()).toBeNull();
  });

  it('falls back through DI client ids on token exchange', async () => {
    const { transport, exp, options } = setup();
    const noClaim = json({
      access_token: fakeJwt({ exp }),
      refresh_token: 'fake-refresh-x',
    });
    transport
      .on('POST', MOBILE_LOGIN, success())
      .on('POST', TOKEN, status(401), json({ error: 'invalid_client' }, 400), noClaim)
      .on('GET', VERIFY, json({}));

    const result = await login(FAKE_CREDENTIALS, options);

    const clientIds = transport
      .callsTo('/di-oauth2-service/oauth/token')
      .map((c) => new URLSearchParams(c.body).get('client_id'));
    expect(clientIds).toEqual([
      'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
      'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4',
      'GARMIN_CONNECT_MOBILE_ANDROID_DI',
    ]);
    expect(result.status === 'authenticated' && result.tokens.clientId).toBe(
      'GARMIN_CONNECT_MOBILE_ANDROID_DI',
    );
  });

  it('throws TokenExchangeError without further SSO attempts when no client id works', async () => {
    const { transport, options } = setup();
    transport.on('POST', MOBILE_LOGIN, success()).on('POST', TOKEN, status(401));

    await expect(login(FAKE_CREDENTIALS, options)).rejects.toBeInstanceOf(TokenExchangeError);
    expect(transport.callsTo('/di-oauth2-service/oauth/token')).toHaveLength(4);
    expect(transport.callsTo('/sso/embed')).toHaveLength(0);
  });

  it('tries the next strategy when the API tier rejects the new token', async () => {
    const { transport, exp, options } = setup();
    transport
      .on('POST', MOBILE_LOGIN, success())
      .on('POST', TOKEN, tokenResponse(exp, 'a'), tokenResponse(exp, 'b'))
      .on('GET', VERIFY, status(401), json({}))
      .on('GET', EMBED, html('<html></html>'))
      .on('GET', SIGNIN, html(fixture('widget-signin.html')))
      .on('POST', SIGNIN, html(fixture('widget-success.html')));

    const result = await login(FAKE_CREDENTIALS, options);
    expect(result.status === 'authenticated' && result.tokens.refreshToken).toBe('fake-refresh-b');
  });
});

describe('login: MFA (mobile flow)', () => {
  it('returns a serialisable challenge without the password and completes it', async () => {
    const { transport, store, exp, options } = setup();
    transport
      .on(
        'POST',
        MOBILE_LOGIN,
        json(
          {
            responseStatus: { type: 'MFA_REQUIRED' },
            customerMfaInfo: { mfaLastMethodUsed: 'email' },
          },
          200,
          { 'Set-Cookie': 'FAKE_SSO_SESSION=fake-cookie-value; Path=/; Secure; HttpOnly' },
        ),
      )
      .on('POST', MOBILE_MFA, success('ST-0000002-FakeTicket-cas'))
      .on('POST', TOKEN, tokenResponse(exp))
      .on('GET', VERIFY, json({}));

    const first = await login(FAKE_CREDENTIALS, options);
    expect(first.status).toBe('mfa_required');
    if (first.status !== 'mfa_required') return;
    expect(first.challenge.mfaMethod).toBe('email');
    expect(await store.load()).toBeNull();

    const serialized = JSON.stringify(first.challenge);
    expect(serialized).not.toContain(FAKE_CREDENTIALS.password);
    const restored = JSON.parse(serialized) as MfaChallenge;

    const done = await completeMfa(restored, ' 123456 ', options);
    expect(done.status).toBe('authenticated');
    expect(await store.load()).not.toBeNull();

    const [mfaCall] = transport.callsTo('/mobile/api/mfa/verifyCode');
    expect(mfaCall?.headers.get('cookie')).toBe('FAKE_SSO_SESSION=fake-cookie-value');
    expect(JSON.parse(mfaCall?.body ?? '{}')).toEqual({
      mfaMethod: 'email',
      mfaVerificationCode: '123456',
      rememberMyBrowser: true,
      reconsentList: [],
      mfaSetup: false,
    });
    const [tokenCall] = transport.callsTo('/di-oauth2-service/oauth/token');
    expect(new URLSearchParams(tokenCall?.body).get('service_ticket')).toBe(
      'ST-0000002-FakeTicket-cas',
    );
    expect(new URLSearchParams(tokenCall?.body).get('service_url')).toBe(
      'https://mobile.integration.garmin.com/gcm/ios',
    );
  });

  it('rejects a wrong code with InvalidMfaCodeError after trying both endpoints', async () => {
    const { transport, options } = setup();
    transport
      .on('POST', MOBILE_LOGIN, json({ responseStatus: { type: 'MFA_REQUIRED' } }))
      .on('POST', MOBILE_MFA, json({ responseStatus: { type: 'INVALID_MFA_CODE' } }))
      .on('POST', PORTAL_MFA, json({ responseStatus: { type: 'INVALID_MFA_CODE' } }));

    const first = await login(FAKE_CREDENTIALS, options);
    if (first.status !== 'mfa_required') throw new Error('expected mfa');
    await expect(completeMfa(first.challenge, '000000', options)).rejects.toBeInstanceOf(
      InvalidMfaCodeError,
    );
    expect(transport.callsTo(/mfa\/verifyCode/)).toHaveLength(2);
  });

  it('rejects a tampered challenge object', async () => {
    const { options } = setup();
    await expect(
      completeMfa({ type: 'nope' } as unknown as MfaChallenge, '123456', options),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('login: widget strategy', () => {
  it('is used when mobile demands a CAPTCHA, keeping cookies across steps', async () => {
    const { transport, clock, exp, options } = setup();
    transport
      .on('POST', MOBILE_LOGIN, json({ responseStatus: { type: 'CAPTCHA_REQUIRED' } }))
      .on('GET', EMBED, html('<html></html>', 200, { 'Set-Cookie': 'FAKE_WIDGET=w1; Path=/' }))
      .on('GET', SIGNIN, html(fixture('widget-signin.html')))
      .on('POST', SIGNIN, html(fixture('widget-success.html')))
      .on('POST', TOKEN, tokenResponse(exp))
      .on('GET', VERIFY, json({}));

    const result = await login(FAKE_CREDENTIALS, options);
    expect(result.status).toBe('authenticated');

    const [signinGet] = transport.calls.filter(
      (c) => c.method === 'GET' && c.url.pathname === '/sso/signin',
    );
    expect(signinGet?.headers.get('cookie')).toBe('FAKE_WIDGET=w1');
    const [signinPost] = transport.calls.filter(
      (c) => c.method === 'POST' && c.url.pathname === '/sso/signin',
    );
    const form = new URLSearchParams(signinPost?.body);
    expect(form.get('_csrf')).toBe('fake-csrf-token-1');
    expect(form.get('embed')).toBe('true');
    expect(clock.sleeps).toEqual([5500]); // anti-WAF pause, (3 + 0.5 * 5) s

    const [tokenCall] = transport.callsTo('/di-oauth2-service/oauth/token');
    expect(new URLSearchParams(tokenCall?.body).get('service_url')).toBe(EMBED);
    expect(new URLSearchParams(tokenCall?.body).get('service_ticket')).toBe(
      'ST-0000001-FakeTicket-cas',
    );
  });

  it('follows redirects manually and stores cookies from intermediate responses', async () => {
    const { transport, exp, options } = setup();
    transport
      .on('POST', MOBILE_LOGIN, status(403))
      .on(
        'GET',
        EMBED,
        status(302, { Location: '/sso/embed-landing', 'Set-Cookie': 'FAKE_HOP=h1; Path=/' }),
      )
      .on('GET', 'https://sso.garmin.com/sso/embed-landing', html('<html></html>'))
      .on('GET', SIGNIN, html(fixture('widget-signin.html')))
      .on('POST', SIGNIN, html(fixture('widget-success.html')))
      .on('POST', TOKEN, tokenResponse(exp))
      .on('GET', VERIFY, json({}));

    await login(FAKE_CREDENTIALS, options);
    const [landing] = transport.callsTo('/sso/embed-landing');
    expect(landing?.headers.get('cookie')).toBe('FAKE_HOP=h1');
  });

  it('handles widget MFA: requests the code, then verifies it', async () => {
    const { transport, exp, options } = setup();
    transport
      .on('POST', MOBILE_LOGIN, json({ responseStatus: { type: 'CAPTCHA_REQUIRED' } }))
      .on('GET', EMBED, html('<html></html>'))
      .on('GET', SIGNIN, html(fixture('widget-signin.html')))
      .on('POST', SIGNIN, html(fixture('widget-mfa.html')))
      .on('POST', WIDGET_MFA_CODE, json({}))
      .on('POST', WIDGET_MFA, html(fixture('widget-success.html')))
      .on('POST', TOKEN, tokenResponse(exp))
      .on('GET', VERIFY, json({}));

    const first = await login(FAKE_CREDENTIALS, options);
    if (first.status !== 'mfa_required') throw new Error('expected mfa');
    expect(first.challenge.flow).toBe('widget');
    expect(transport.callsTo('/sso/verifyMFA/mfaCode')).toHaveLength(1);

    await completeMfa(first.challenge, '654321', options);
    const [verify] = transport.callsTo('/sso/verifyMFA/loginEnterMfaCode');
    const form = new URLSearchParams(verify?.body);
    expect(form.get('mfa-code')).toBe('654321');
    expect(form.get('_csrf')).toBe('fake-csrf-mfa-2');
    expect(form.get('fromPage')).toBe('setupEnterMfaCode');
  });

  it('maps an invalid widget title to AuthenticationError', async () => {
    const { transport, options } = setup();
    transport
      .on('POST', MOBILE_LOGIN, json({ responseStatus: { type: 'CAPTCHA_REQUIRED' } }))
      .on('GET', EMBED, html('<html></html>'))
      .on('GET', SIGNIN, html(fixture('widget-signin.html')))
      .on('POST', SIGNIN, html(fixture('widget-invalid.html')));
    await expect(login(FAKE_CREDENTIALS, options)).rejects.toBeInstanceOf(AuthenticationError);
    expect(transport.callsTo('/portal/api/login')).toHaveLength(0);
  });

  it('maps a locked-account title to AccountLockedError', async () => {
    const { transport, options } = setup();
    transport
      .on('POST', MOBILE_LOGIN, status(403))
      .on('GET', EMBED, html('<html></html>'))
      .on('GET', SIGNIN, html(fixture('widget-signin.html')))
      .on('POST', SIGNIN, html('<html><head><title>Account Locked</title></head></html>'));
    await expect(login(FAKE_CREDENTIALS, options)).rejects.toBeInstanceOf(AccountLockedError);
  });
});

describe('login: exhausted strategies', () => {
  it('throws RateLimitError when every strategy is rate limited (status and JSON body)', async () => {
    const { transport, options } = setup();
    transport
      .on('POST', MOBILE_LOGIN, status(429, { 'Retry-After': '120' }))
      .on('GET', EMBED, status(429))
      .on('GET', PORTAL_SIGNIN, html('<html></html>'))
      .on('POST', PORTAL_LOGIN, json({ error: { 'status-code': '429' } }));

    const err = await login(FAKE_CREDENTIALS, options).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSeconds).toBe(120);
    // Never retried: each login endpoint hit exactly once.
    expect(transport.callsTo('/mobile/api/login')).toHaveLength(1);
    expect(transport.callsTo('/portal/api/login')).toHaveLength(1);
  });

  it('throws CaptchaRequiredError when strategies fail and one demanded a CAPTCHA', async () => {
    const { transport, options } = setup();
    transport
      .on('POST', MOBILE_LOGIN, json({ responseStatus: { type: 'CAPTCHA_REQUIRED' } }))
      .on('GET', EMBED, status(429))
      .on('GET', PORTAL_SIGNIN, status(429));
    await expect(login(FAKE_CREDENTIALS, options)).rejects.toBeInstanceOf(CaptchaRequiredError);
  });

  it('throws LoginFailedError with redacted attempts otherwise', async () => {
    const { transport, options } = setup();
    transport
      .on('POST', MOBILE_LOGIN, status(403))
      .on('GET', EMBED, status(503))
      .on('GET', PORTAL_SIGNIN, html('<html></html>'))
      .on('POST', PORTAL_LOGIN, html('<html>blocked</html>', 403));

    const err = await login(FAKE_CREDENTIALS, options).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginFailedError);
    expect((err as LoginFailedError).attempts).toEqual([
      { strategy: 'mobile', code: 'http_error', status: 403 },
      { strategy: 'widget', code: 'http_error', status: 503 },
      { strategy: 'portal', code: 'http_error', status: 403 },
    ]);
  });

  it('respects the strategies option', async () => {
    const { transport, options } = setup();
    transport.on('GET', EMBED, status(429));
    await expect(
      login(FAKE_CREDENTIALS, { ...options, strategies: ['widget'] }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(transport.callsTo('/mobile/api/login')).toHaveLength(0);
  });

  it('rejects empty credentials without any request', async () => {
    const { transport, options } = setup();
    await expect(login({ username: '', password: 'x' }, options)).rejects.toBeInstanceOf(TypeError);
    expect(transport.calls).toHaveLength(0);
  });
});

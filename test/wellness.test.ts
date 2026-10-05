import { describe, expect, it } from 'vitest';
import {
  GarminConnectClient,
  MemoryTokenStore,
  ResponseFormatError,
  UnsupportedResponseError,
} from '../src';
import { FakeClock, FakeTransport, fixtureJson, json, storedTokens } from './helpers';

const PROFILE = 'https://connectapi.garmin.com/userprofile-service/socialProfile';
const RHR = 'https://connectapi.garmin.com/userstats-service/wellness/daily/runner-1';

function setup() {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const client = new GarminConnectClient({
    tokenStore: new MemoryTokenStore(storedTokens(clock)),
    transport: transport.fetch,
    clock,
    random: () => 0,
  });
  transport.on('GET', PROFILE, json(fixtureJson('profile.json')));
  return { transport, client };
}

const range = { from: '2026-01-01', to: '2026-01-04' };

describe('getUserProfile', () => {
  it('maps the social profile and caches the display name for wellness calls', async () => {
    const { transport, client } = setup();
    transport.on('GET', RHR, json(fixtureJson('resting-hr.json')));
    expect(await client.getUserProfile()).toEqual({
      displayName: 'runner-1',
      fullName: 'Runner One',
      profileId: '1000001',
    });
    await client.getRestingHeartRate(range);
    await client.getRestingHeartRate(range);
    expect(transport.callsTo('/userprofile-service/socialProfile')).toHaveLength(1);
  });

  it('requires a display name', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const client = new GarminConnectClient({
      tokenStore: new MemoryTokenStore(storedTokens(clock)),
      transport: transport.fetch,
      clock,
    });
    transport.on('GET', PROFILE, json({ displayName: '' }));
    await expect(client.getUserProfile()).rejects.toBeInstanceOf(ResponseFormatError);
  });
});

describe('getRestingHeartRate', () => {
  it('returns every day, marking missing and null days as not_measured (never 0)', async () => {
    const { transport, client } = setup();
    transport.on('GET', RHR, json(fixtureJson('resting-hr.json')));
    expect(await client.getRestingHeartRate(range)).toEqual([
      { date: '2026-01-01', value: 48, status: 'measured' },
      { date: '2026-01-02', value: null, status: 'not_measured' },
      { date: '2026-01-03', value: null, status: 'not_measured' },
      { date: '2026-01-04', value: 50, status: 'measured' },
    ]);
    const [call] = transport.callsTo('/userstats-service/wellness/daily/runner-1');
    expect(Object.fromEntries(call?.url.searchParams ?? [])).toEqual({
      fromDate: '2026-01-01',
      untilDate: '2026-01-04',
      metricId: '60',
    });
  });

  it('treats 204 as not_measured for all days', async () => {
    const { transport, client } = setup();
    transport.on('GET', RHR, new Response(null, { status: 204 }));
    const days = await client.getRestingHeartRate({ from: '2026-01-01', to: '2026-01-02' });
    expect(days.every((d) => d.status === 'not_measured' && d.value === null)).toBe(true);
  });

  it('rejects an unrecognised shape instead of reporting every day as not measured', async () => {
    const { transport, client } = setup();
    transport.on('GET', RHR, json({ values: [{ day: '2026-01-01', rhr: 48 }] }));
    await expect(client.getRestingHeartRate(range)).rejects.toBeInstanceOf(
      UnsupportedResponseError,
    );
  });

  it('treats an empty object or a metrics map without the key as no data', async () => {
    const { transport, client } = setup();
    transport.on('GET', RHR, json({ allMetrics: { metricsMap: {} } }));
    const days = await client.getRestingHeartRate(range);
    expect(days.every((d) => d.status === 'not_measured')).toBe(true);
  });

  it('validates ranges', async () => {
    const { client } = setup();
    await expect(
      client.getRestingHeartRate({ from: '2026-01-05', to: '2026-01-01' }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      client.getRestingHeartRate({ from: '2026-1-1', to: '2026-01-02' }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('URL-encodes the display name', async () => {
    const transport = new FakeTransport();
    const clock = new FakeClock();
    const client = new GarminConnectClient({
      tokenStore: new MemoryTokenStore(storedTokens(clock)),
      transport: transport.fetch,
      clock,
    });
    transport
      .on('GET', PROFILE, json({ displayName: 'runner/1?x' }))
      .on('GET', /userstats-service/, new Response(null, { status: 204 }));
    await client.getRestingHeartRate({ from: '2026-01-01', to: '2026-01-01' });
    const [call] = transport.callsTo(/userstats-service/);
    expect(call?.url.pathname).toBe('/userstats-service/wellness/daily/runner%2F1%3Fx');
  });
});

describe('getVo2Max', () => {
  it('prefers the precise value and marks days without generic values as not_measured', async () => {
    const { transport, client } = setup();
    transport.on(
      'GET',
      'https://connectapi.garmin.com/metrics-service/metrics/maxmet/daily/2026-01-01/2026-01-04',
      json(fixtureJson('vo2max.json')),
    );
    expect(await client.getVo2Max(range)).toEqual([
      { date: '2026-01-01', value: 52.3, status: 'measured' },
      { date: '2026-01-02', value: null, status: 'not_measured' },
      { date: '2026-01-03', value: 53, status: 'measured' },
      { date: '2026-01-04', value: null, status: 'not_measured' },
    ]);
  });

  it.each([
    ['an object instead of an array', { vo2: 50 }],
    ['a string value', [{ generic: { calendarDate: '2026-01-01', vo2MaxValue: '50' } }]],
    ['a value without date', [{ generic: { vo2MaxValue: 50 } }]],
    ['a non-object entry', [42]],
  ])('throws UnsupportedResponseError for %s', async (_label, body) => {
    const { transport, client } = setup();
    transport.on('GET', /maxmet/, json(body));
    await expect(client.getVo2Max(range)).rejects.toBeInstanceOf(UnsupportedResponseError);
  });

  it('rejects entries without any known key instead of reading them as no data', async () => {
    const { transport, client } = setup();
    transport.on('GET', /maxmet/, json([{ running: { date: '2026-01-01', vo2: 51 } }]));
    await expect(client.getVo2Max(range)).rejects.toBeInstanceOf(UnsupportedResponseError);
  });

  it('chunks long ranges into 28-day requests', async () => {
    const { transport, client } = setup();
    transport.on('GET', /maxmet/, json([]));
    const days = await client.getVo2Max({ from: '2026-01-01', to: '2026-03-01' });
    expect(days).toHaveLength(60);
    expect(
      transport.callsTo(/maxmet/).map((c) => c.url.pathname.split('/').slice(-2).join('/')),
    ).toEqual(['2026-01-01/2026-01-28', '2026-01-29/2026-02-25', '2026-02-26/2026-03-01']);
  });
});

describe('getSleep', () => {
  it('maps nightly summaries and leaves nights without data not_measured', async () => {
    const { transport, client } = setup();
    transport.on(
      'GET',
      'https://connectapi.garmin.com/sleep-service/stats/sleep/daily/2026-01-01/2026-01-02',
      json(fixtureJson('sleep.json')),
    );
    expect(await client.getSleep({ from: '2026-01-01', to: '2026-01-02' })).toEqual([
      {
        date: '2026-01-01',
        status: 'measured',
        value: {
          totalSleepSeconds: 27000,
          deepSleepSeconds: 5400,
          lightSleepSeconds: 14400,
          remSleepSeconds: 6000,
          awakeSeconds: 1200,
          score: 81,
        },
      },
      { date: '2026-01-02', value: null, status: 'not_measured' },
    ]);
  });

  it('splits ranges over 28 days into chunks', async () => {
    const { transport, client } = setup();
    transport.on('GET', /sleep-service/, json({ individualStats: [] }));
    await client.getSleep({ from: '2026-01-01', to: '2026-01-30' });
    expect(
      transport.callsTo(/sleep-service/).map((c) => c.url.pathname.split('/').slice(-2).join('/')),
    ).toEqual(['2026-01-01/2026-01-28', '2026-01-29/2026-01-30']);
  });

  it('throws ResponseFormatError for malformed rows', async () => {
    const { transport, client } = setup();
    transport.on('GET', /sleep-service/, json({ individualStats: [{ values: {} }] }));
    await expect(client.getSleep(range)).rejects.toBeInstanceOf(ResponseFormatError);
  });
});

describe('getHrv', () => {
  it('maps HRV summaries in milliseconds', async () => {
    const { transport, client } = setup();
    transport.on(
      'GET',
      'https://connectapi.garmin.com/hrv-service/hrv/daily/2026-01-01/2026-01-03',
      json(fixtureJson('hrv.json')),
    );
    expect(await client.getHrv({ from: '2026-01-01', to: '2026-01-03' })).toEqual([
      {
        date: '2026-01-01',
        status: 'measured',
        value: {
          lastNightAverageMs: 58,
          weeklyAverageMs: 60,
          lastNight5MinHighMs: 80,
          status: 'BALANCED',
        },
      },
      { date: '2026-01-02', value: null, status: 'not_measured' },
      { date: '2026-01-03', value: null, status: 'not_measured' },
    ]);
  });
});

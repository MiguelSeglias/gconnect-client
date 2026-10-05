import { describe, expect, it } from 'vitest';
import { GarminConnectClient, MemoryTokenStore, NotFoundError, ResponseFormatError } from '../src';
import { FakeClock, FakeTransport, collect, fixtureJson, json, storedTokens } from './helpers';

const LIST = 'https://connectapi.garmin.com/activitylist-service/activities/search/activities';
const DETAIL = 'https://connectapi.garmin.com/activity-service/activity/90000000001';

function setup(includeRaw = false) {
  const transport = new FakeTransport();
  const clock = new FakeClock();
  const client = new GarminConnectClient({
    tokenStore: new MemoryTokenStore(storedTokens(clock)),
    transport: transport.fetch,
    clock,
    includeRaw,
    random: () => 0,
  });
  return { transport, client };
}

describe('listActivities', () => {
  it('maps activities to SI-unit summaries with string ids and ISO timestamps', async () => {
    const { transport, client } = setup();
    transport.on('GET', LIST, json(fixtureJson('activities-page-1.json')));
    const page = await client.listActivities({ limit: 2 });
    expect(page.nextStart).toBe(2);
    expect(page.items[0]).toEqual({
      id: '90000000001',
      name: 'Morning Run',
      activityType: 'running',
      startTimeUtc: '2026-01-10T06:30:00.000Z',
      startTimeLocal: '2026-01-10T07:30:00',
      timeZoneOffsetSeconds: 3600,
      durationSeconds: 3000.25,
      movingDurationSeconds: 2950,
      elapsedDurationSeconds: 3100,
      distanceMeters: 10000.5,
      elevationGainMeters: 55,
      elevationLossMeters: 54,
      averageSpeedMetersPerSecond: 3.33,
      maxSpeedMetersPerSecond: 4.5,
      averageHeartRateBpm: 150,
      maxHeartRateBpm: 175,
      energyKilocalories: 600,
      manual: false,
    });
    expect(page.items[1]?.averageHeartRateBpm).toBeNull();
    expect(page.items[1]).not.toHaveProperty('raw');
  });

  it('attaches raw objects only when includeRaw is set', async () => {
    const { transport, client } = setup(true);
    transport.on('GET', LIST, json(fixtureJson('activities-page-1.json')));
    const page = await client.listActivities();
    expect(page.items[0]?.raw).toMatchObject({ someNewGarminField: { nested: true } });
  });

  it('encodes start, limit, dates and type as query params', async () => {
    const { transport, client } = setup();
    transport.on('GET', LIST, json([]));
    await client.listActivities({
      start: 40,
      limit: 20,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      activityType: 'running',
    });
    const [call] = transport.calls;
    expect(Object.fromEntries(call?.url.searchParams ?? [])).toEqual({
      start: '40',
      limit: '20',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      activityType: 'running',
    });
  });

  it('defaults limit to 100 and caps it at 1000', async () => {
    const { transport, client } = setup();
    transport.on('GET', LIST, json([]));
    await client.listActivities();
    await client.listActivities({ limit: 5000 });
    expect(transport.calls.map((c) => c.url.searchParams.get('limit'))).toEqual(['100', '1000']);
  });

  it('rejects invalid filters without a request', async () => {
    const { transport, client } = setup();
    await expect(client.listActivities({ limit: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(client.listActivities({ start: -1 })).rejects.toBeInstanceOf(RangeError);
    await expect(client.listActivities({ startDate: '2026-02-30' })).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(transport.calls).toHaveLength(0);
  });

  it('returns nextStart null for an empty page and treats 204 as empty', async () => {
    const { transport, client } = setup();
    transport.on('GET', LIST, new Response(null, { status: 204 }));
    expect(await client.listActivities()).toEqual({ items: [], nextStart: null });
  });

  it('throws ResponseFormatError naming the endpoint for a malformed list', async () => {
    const { transport, client } = setup();
    transport.on('GET', LIST, json([{ activityId: 'not-a-number', activityName: 'Secret' }]));
    const err = await client.listActivities().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseFormatError);
    const e = err as ResponseFormatError;
    expect(e.endpoint).toBe('activitylist-service/activities/search/activities');
    expect(e.issues).toEqual(['0.activityId']);
    expect(e.message).not.toContain('Secret');
    expect(e.message).not.toContain('not-a-number');
  });

  it('throws ResponseFormatError for a non-array body', async () => {
    const { transport, client } = setup();
    transport.on('GET', LIST, json({ activities: [] }));
    await expect(client.listActivities()).rejects.toBeInstanceOf(ResponseFormatError);
  });
});

describe('iterateActivities', () => {
  it('pages until an empty page is returned', async () => {
    const { transport, client } = setup();
    const a = (id: number) => ({ activityId: id, activityName: `run-${id}` });
    transport.on('GET', LIST, json([a(1), a(2)]), json([a(3), a(4)]), json([a(5)]), json([]));
    const items = await collect(client.iterateActivities({ limit: 2, startDate: '2026-01-01' }));
    expect(items.map((i) => i.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(transport.calls.map((c) => c.url.searchParams.get('start'))).toEqual([
      '0',
      '2',
      '4',
      '5',
    ]);
    expect(transport.calls.every((c) => c.url.searchParams.get('startDate') === '2026-01-01')).toBe(
      true,
    );
  });
});

describe('single activity and files', () => {
  it('maps activity detail', async () => {
    const { transport, client } = setup();
    transport.on('GET', DETAIL, json(fixtureJson('activity-detail.json')));
    const detail = await client.getActivity('90000000001');
    expect(detail).toMatchObject({
      id: '90000000001',
      activityType: 'running',
      startTimeUtc: '2026-01-10T06:30:00.000Z',
      startTimeLocal: '2026-01-10T07:30:00',
      timeZoneOffsetSeconds: 3600,
      distanceMeters: 10000.5,
      description: 'Synthetic test activity',
      hasGps: true,
      manual: false,
    });
  });

  it('rejects non-numeric ids (no path injection)', async () => {
    const { transport, client } = setup();
    await expect(client.getActivity('../user')).rejects.toBeInstanceOf(RangeError);
    expect(transport.calls).toHaveLength(0);
  });

  it('maps 404 to NotFoundError', async () => {
    const { transport, client } = setup();
    transport.on('GET', DETAIL, new Response('', { status: 404 }));
    await expect(client.getActivity('90000000001')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lists available formats from metadata', async () => {
    const { transport, client } = setup();
    const detail = fixtureJson('activity-detail.json') as Record<string, unknown>;
    transport.on(
      'GET',
      DETAIL,
      json(detail),
      json({ ...detail, metadataDTO: { hasPolyline: false } }),
      json({ ...detail, metadataDTO: { manualActivity: true } }),
    );
    expect(await client.listActivityFiles('90000000001')).toEqual(['fit', 'tcx', 'gpx']);
    expect(await client.listActivityFiles('90000000001')).toEqual(['fit', 'tcx']);
    expect(await client.listActivityFiles('90000000001')).toEqual([]);
  });

  it('downloads the original FIT as the zip Garmin delivers', async () => {
    const { transport, client } = setup();
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    transport.on(
      'GET',
      'https://connectapi.garmin.com/download-service/files/activity/90000000001',
      new Response(zipBytes, { headers: { 'Content-Type': 'application/x-zip-compressed' } }),
    );
    const file = await client.downloadActivityFile('90000000001', 'fit');
    expect(file).toEqual({
      format: 'fit',
      bytes: zipBytes,
      contentType: 'application/x-zip-compressed',
      fileName: '90000000001.zip',
      compression: 'zip',
    });
    expect(transport.calls[0]?.headers.get('accept')).toBe('*/*');
  });

  it('downloads GPX and TCX exports', async () => {
    const { transport, client } = setup();
    transport
      .on(
        'GET',
        'https://connectapi.garmin.com/download-service/export/gpx/activity/90000000001',
        new Response('<gpx/>'),
      )
      .on(
        'GET',
        'https://connectapi.garmin.com/download-service/export/tcx/activity/90000000001',
        new Response('<tcx/>'),
      );
    const gpx = await client.downloadActivityFile('90000000001', 'gpx');
    expect(gpx.fileName).toBe('90000000001.gpx');
    expect(gpx.compression).toBe('none');
    expect(new TextDecoder().decode(gpx.bytes)).toBe('<gpx/>');
    const tcx = await client.downloadActivityFile('90000000001', 'tcx');
    expect(tcx.fileName).toBe('90000000001.tcx');
  });
});

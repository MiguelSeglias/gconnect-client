/**
 * Live, read-only verification against a real Garmin account.
 *
 * Excluded from `bun run test`. Runs only via `bun run test:live` with GARMIN_LIVE=1.
 * Credentials come ONLY from env vars (GARMIN_USERNAME / GARMIN_PASSWORD) or an existing
 * token file (GARMIN_TOKEN_FILE). MFA code from GARMIN_MFA_CODE or an interactive prompt on
 * /dev/tty. Prints only counts and statuses — never values, ids, names or tokens.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { describe, expect, it } from 'vitest';
import { FileTokenStore, GarminConnectClient, MemoryTokenStore, type TokenStore } from '../../src';
import { CONNECT_API_ORIGIN, nativeHeaders } from '../../src/auth/constants';

const enabled = process.env.GARMIN_LIVE === '1';

function report(line: string): void {
  process.stderr.write(`[live] ${line}\n`);
}

async function promptMfaCode(): Promise<string> {
  const fromEnv = process.env.GARMIN_MFA_CODE;
  if (fromEnv) return fromEnv;
  const input = createReadStream('/dev/tty');
  const rl = createInterface({ input, output: process.stderr });
  try {
    return await rl.question('[live] MFA code: ');
  } finally {
    rl.close();
    input.destroy();
  }
}

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

describe.runIf(enabled)('live Garmin Connect (read-only)', () => {
  it('logs in (or reuses tokens) and performs read-only calls', async () => {
    const tokenFile = process.env.GARMIN_TOKEN_FILE;
    const store: TokenStore = tokenFile ? new FileTokenStore(tokenFile) : new MemoryTokenStore();
    const client = new GarminConnectClient({ tokenStore: store });

    if (await client.isAuthenticated()) {
      report('using stored tokens');
    } else {
      const username = process.env.GARMIN_USERNAME;
      const password = process.env.GARMIN_PASSWORD;
      if (!username || !password) {
        throw new Error('Set GARMIN_USERNAME and GARMIN_PASSWORD, or GARMIN_TOKEN_FILE');
      }
      const result = await client.login({ username, password });
      report(`login status: ${result.status}`);
      if (result.status === 'mfa_required') {
        await client.completeMfa(result.challenge, await promptMfaCode());
        report('mfa: completed');
      }
    }

    const profile = await client.getUserProfile();
    report(`profile: ok (display name present: ${String(profile.displayName.length > 0)})`);

    const page = await client.listActivities({ limit: 5 });
    report(`activities: ${page.items.length} item(s) on first page`);

    const range = { from: isoDay(-6), to: isoDay(0) };
    const rhr = await client.getRestingHeartRate(range);
    report(
      `resting HR: ${rhr.filter((d) => d.status === 'measured').length}/${rhr.length} days measured`,
    );

    try {
      const vo2 = await client.getVo2Max(range);
      report(
        `VO2max: ${vo2.filter((d) => d.status === 'measured').length}/${vo2.length} days measured`,
      );
    } catch (err) {
      report(`VO2max: ${err instanceof Error ? err.name : 'error'}`);
    }

    expect(rhr).toHaveLength(7);
  });
});

/**
 * Structure of a JSON value with every value removed: object keys, value types, array lengths
 * and the merged shape of array elements. Strings that look like dates show only their format.
 * Safe to share: no numbers, names, ids or dates are printed.
 */
function shape(value: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const merged: Record<string, Set<string>> = {};
    for (const item of value.slice(0, 50)) {
      const s = JSON.stringify(shape(item, depth + 1));
      (merged['items'] ??= new Set()).add(s);
    }
    return {
      array: value.length,
      items: [...(merged['items'] ?? [])].map((s) => JSON.parse(s) as unknown),
    };
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).map((k) => [k, shape((value as Record<string, unknown>)[k], depth + 1)]),
    );
  }
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date YYYY-MM-DD';
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return 'datetime';
    return 'string';
  }
  return typeof value;
}

describe.runIf(enabled && process.env.GARMIN_PROBE === '1')('live response shapes (probe)', () => {
  it('prints the structure of the wellness responses, without values', async () => {
    const tokenFile = process.env.GARMIN_TOKEN_FILE;
    if (!tokenFile) throw new Error('Run the live test once with GARMIN_TOKEN_FILE first');
    const store = new FileTokenStore(tokenFile);
    const client = new GarminConnectClient({ tokenStore: store });
    const profile = await client.getUserProfile(); // also refreshes the token if needed
    const tokens = await store.load();
    if (tokens === null) throw new Error('No stored tokens');
    const from = isoDay(-29);
    const to = isoDay(0);
    const get = async (path: string): Promise<{ status: number; body: unknown }> => {
      const res = await fetch(`${CONNECT_API_ORIGIN}${path}`, {
        headers: nativeHeaders({
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: 'application/json',
        }),
      });
      const text = await res.text();
      return { status: res.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
    };
    const rhr = await get(
      `/userstats-service/wellness/daily/${encodeURIComponent(profile.displayName)}?fromDate=${from}&untilDate=${to}&metricId=60`,
    );
    report(`resting HR: HTTP ${rhr.status} shape ${JSON.stringify(shape(rhr.body))}`);
    const vo2 = await get(`/metrics-service/metrics/maxmet/daily/${isoDay(-27)}/${to}`);
    report(`VO2max: HTTP ${vo2.status} shape ${JSON.stringify(shape(vo2.body))}`);
  });
});

describe.skipIf(enabled)('live Garmin Connect', () => {
  it.skip('disabled (set GARMIN_LIVE=1)', () => undefined);
});

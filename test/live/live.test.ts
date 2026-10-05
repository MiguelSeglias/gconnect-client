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

describe.skipIf(enabled)('live Garmin Connect', () => {
  it.skip('disabled (set GARMIN_LIVE=1)', () => undefined);
});

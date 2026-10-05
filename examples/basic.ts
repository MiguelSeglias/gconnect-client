/**
 * List recent activities. Credentials come from env vars only:
 *   GARMIN_USERNAME, GARMIN_PASSWORD, optional GARMIN_TOKEN_FILE (default ./garmin.tokens.json)
 * Run: bun examples/basic.ts
 */
import { FileTokenStore, GarminConnectClient } from 'gconnect-client';

const store = new FileTokenStore(process.env.GARMIN_TOKEN_FILE ?? './garmin.tokens.json');
const client = new GarminConnectClient({ tokenStore: store });

if (!(await client.isAuthenticated())) {
  const username = process.env.GARMIN_USERNAME;
  const password = process.env.GARMIN_PASSWORD;
  if (!username || !password) throw new Error('Set GARMIN_USERNAME and GARMIN_PASSWORD');
  const result = await client.login({ username, password });
  if (result.status === 'mfa_required') {
    throw new Error('MFA required — see examples/mfa.ts');
  }
}

const page = await client.listActivities({ limit: 10 });
for (const activity of page.items) {
  const km = activity.distanceMeters === null ? '—' : (activity.distanceMeters / 1000).toFixed(1);
  process.stdout.write(
    `${activity.startTimeLocal ?? '?'}  ${activity.activityType ?? '?'}  ${km} km\n`,
  );
}

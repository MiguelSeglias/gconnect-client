/**
 * Two-step login with MFA, as a server would do it across two HTTP requests.
 * Credentials from env vars only (GARMIN_USERNAME, GARMIN_PASSWORD); the code is read
 * from stdin. Run: bun examples/mfa.ts
 */
import { createInterface } from 'node:readline/promises';
import { MemoryTokenStore, completeMfa, login, type MfaChallenge } from 'gconnect-client';

const username = process.env.GARMIN_USERNAME;
const password = process.env.GARMIN_PASSWORD;
if (!username || !password) throw new Error('Set GARMIN_USERNAME and GARMIN_PASSWORD');

const tokenStore = new MemoryTokenStore();

// Step 1 (request A): start the login.
const result = await login({ username, password }, { tokenStore });

if (result.status === 'mfa_required') {
  // Persist the challenge server-side (encrypted, short TTL). It contains session cookies.
  const pending: string = JSON.stringify(result.challenge);

  // Step 2 (request B): the user submits the code.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = await rl.question(`Code sent via ${result.challenge.mfaMethod}: `);
  rl.close();
  await completeMfa(JSON.parse(pending) as MfaChallenge, code, { tokenStore });
}

process.stdout.write(`authenticated: ${String((await tokenStore.load()) !== null)}\n`);

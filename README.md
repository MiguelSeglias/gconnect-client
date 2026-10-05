# gconnect-client

> **Unofficial — not affiliated with, endorsed by or supported by Garmin.**
> Garmin and Garmin Connect are trademarks of Garmin Ltd. or its subsidiaries.
>
> This package talks to **undocumented** Garmin Connect endpoints used by Garmin's own apps.
> They can change or break at any time without notice. Use at your own risk and within
> Garmin's terms of use for your own account data.

A small, typed, **read-only** Garmin Connect client for Node.js (≥ 20), written in TypeScript.
It logs in via Garmin SSO (with two-step MFA support), manages OAuth tokens through a
pluggable token store, and reads activities and a few daily health metrics with runtime
validation.

**Status:** version 0.1.0. Live login: **not yet verified against a real account.** Everything
is tested against synthetic fixtures only (see [Live verification](#live-verification)).

- [Install](#install)
- [Quick start](#quick-start)
- [MFA (two-step login)](#mfa-two-step-login)
- [Token stores](#token-stores)
- [API](#api)
- [Missing metrics](#missing-metrics)
- [Errors](#errors)
- [Rate limits and login hygiene](#rate-limits-and-login-hygiene)
- [Transport, TLS and Cloudflare](#transport-tls-and-cloudflare)
- [Security notes](#security-notes)
- [Live verification](#live-verification)
- [Known limitations](#known-limitations)
- [Attribution](#attribution)

## Install

```sh
bun add gconnect-client
# or: npm install gconnect-client
```

Ships ESM and CommonJS builds with type declarations. Its only runtime dependency is `zod`.

## Quick start

```ts
import { GarminConnectClient, MemoryTokenStore } from 'gconnect-client';

const client = new GarminConnectClient({ tokenStore: new MemoryTokenStore() });

const result = await client.login({
  username: process.env.GARMIN_USERNAME!,
  password: process.env.GARMIN_PASSWORD!,
});
if (result.status === 'mfa_required') {
  // see "MFA (two-step login)"
}

const { items } = await client.listActivities({ limit: 10 });
const rhr = await client.getRestingHeartRate({ from: '2026-09-01', to: '2026-09-07' });
```

A `MemoryTokenStore` loses the session when the process exits. For anything longer-lived,
use `FileTokenStore` (scripts) or your own encrypted `TokenStore` (servers) so you log in
**rarely**. See [Rate limits and login hygiene](#rate-limits-and-login-hygiene).

## MFA (two-step login)

When the account has MFA enabled, `login()` returns a challenge rather than tokens. The
challenge is plain JSON, so a server can finish the login in a later HTTP request:

```ts
import { login, completeMfa, type MfaChallenge } from 'gconnect-client';

// Request A: user submits username + password
const result = await login({ username, password }, { tokenStore });
if (result.status === 'mfa_required') {
  await pendingLogins.put(userId, encrypt(JSON.stringify(result.challenge)), { ttlSeconds: 300 });
  return { needsCode: true, method: result.challenge.mfaMethod }; // e.g. "email"
}

// Request B: user submits the code
const challenge = JSON.parse(decrypt(await pendingLogins.take(userId))) as MfaChallenge;
const { tokens } = await completeMfa(challenge, code, { tokenStore });
```

**The challenge is sensitive.** It does not contain the password, but it does contain the SSO
session cookies of a half-finished login. Store it server-side only (encrypted, short TTL of a
few minutes), never send it to a browser and never log it. After an `InvalidMfaCodeError`, you
can retry with the same challenge and a new code. `GarminConnectClient` has matching
`client.login()` / `client.completeMfa()` methods, which also save to the client's store.

## Token stores

```ts
interface TokenStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>; // after login and after every refresh
  clear(): Promise<void>; // on logout and when the refresh token is rejected
}
```

- `MemoryTokenStore`: in-process only.
- `FileTokenStore(path)`: Node only. Writes JSON atomically with `0600` permissions (parent
  directory `0700`) and refuses symlinks. It is **not encrypted**.
- Custom: implement the interface, for example one encrypted database row per user. See
  [`examples/custom-token-store.ts`](examples/custom-token-store.ts) (AES-256-GCM) and use
  `parseStoredTokens()` to validate what you read back.

Create one `GarminConnectClient` per Garmin account and give it that account's store.

`StoredTokens` holds `accessToken` (a JWT), `refreshToken`, `clientId` and `expiresAt`
(epoch seconds, taken from the JWT `exp` claim and read **without** verifying the signature).
Treat all of it as a secret.

## API

All methods are read-only. Units are normalised to SI: meters, seconds, m/s and bpm.
Kilocalories, ml/kg/min (VO₂max) and milliseconds (HRV) stay in Garmin's units, and the field
names say so.

### Constructor

```ts
new GarminConnectClient({
  tokenStore,          // required
  transport?,          // fetch-compatible; default global fetch
  timeouts?,           // { ssoMs: 20000, tokenMs: 15000, apiMs: 20000, downloadMs: 60000 }
  retry?,              // { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 10000 }
  clock?,              // { now(), sleep(ms) }, for tests
  onEvent?,            // redacted diagnostic events
  includeRaw?,         // default false: attach Garmin's raw object as `raw` on activities
  random?,             // jitter source, for tests
});
```

### Auth

| Method                                                     | Description                                                                                                           |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `login({ username, password }, opts?)` (standalone)        | Returns `{ status: 'authenticated', tokens }` or `{ status: 'mfa_required', challenge }`. Saves to `opts.tokenStore`. |
| `completeMfa(challenge, code, opts?)` (standalone)         | Finishes an MFA login and returns `{ status: 'authenticated', tokens }`.                                              |
| `client.login(credentials, { strategies?, verifyLogin? })` | Same as the standalone function, using the client's transport and store.                                              |
| `client.completeMfa(challenge, code)`                      | Same as the standalone function.                                                                                      |
| `client.isAuthenticated()`                                 | `Promise<boolean>`: whether the store holds tokens that are unexpired or refreshable. Makes no network call.          |
| `client.logout()`                                          | Clears the token store. Garmin has no token revocation endpoint.                                                      |

The login flow is a chain of SSO strategies, tried in order: **mobile** (iOS app JSON API),
then **widget** (SSO embed HTML form), then **portal** (web JSON API, with a 10–20 s anti-WAF
pause). Wrong credentials, a locked account or an MFA prompt stop the chain. A 429, a 403
(Cloudflare) or a CAPTCHA moves on to the next strategy, and each strategy runs at most once.
The resulting service ticket is exchanged at `diauth.garmin.com` for an OAuth access token and
refresh token. Known client ids are tried in order. Access tokens are refreshed once
`now > exp − 15 min`, and also once after a 401, when the request is then retried once.

### Reads

| Method                              | Returns                                                                                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getUserProfile()`                  | `{ displayName, fullName, profileId }`. The display name is cached; wellness endpoints need it.                                                                                                                                       |
| `listActivities(filter?)`           | `{ items: ActivitySummary[], nextStart: number \| null }`. Filter: `start`, `limit` (default 100, capped at 1000), `startDate`, `endDate`, `activityType`.                                                                            |
| `iterateActivities(filter?)`        | `AsyncGenerator<ActivitySummary>`, paging until an empty page.                                                                                                                                                                        |
| `getActivity(id)`                   | `ActivityDetail`: the summary fields plus `description` and `hasGps`.                                                                                                                                                                 |
| `listActivityFiles(id)`             | `('fit' \| 'tcx' \| 'gpx')[]`, derived from activity metadata (Garmin has no listing endpoint): `[]` for manual activities, no `gpx` without a GPS track.                                                                             |
| `downloadActivityFile(id, format)`  | `{ format, bytes: Uint8Array, contentType, fileName, compression }`. `fit` is the original upload, which **Garmin delivers as a ZIP**; it is returned as-is with `compression: 'zip'` (unzip it yourself, for example with `fflate`). |
| `getRestingHeartRate({ from, to })` | `DailyMetric<number>[]` in bpm.                                                                                                                                                                                                       |
| `getVo2Max({ from, to })`           | `DailyMetric<number>[]` in ml/kg/min (running/generic). Uses `vo2MaxPreciseValue`, falling back to `vo2MaxValue`.                                                                                                                     |
| `getSleep({ from, to })`            | `DailyMetric<SleepSummary>[]`: total, deep, light, REM and awake seconds, plus score. Requests are chunked to 28 days.                                                                                                                |
| `getHrv({ from, to })`              | `DailyMetric<HrvSummary>[]`: last-night average, weekly average and 5-minute high in ms, plus status. Requests are chunked to 28 days.                                                                                                |

`ActivitySummary`:

```ts
{
  id: string;                       // Garmin activityId as a string (stable source id)
  name, activityType,               // activityType = Garmin typeKey, e.g. "running"
  startTimeUtc: string | null;      // "2026-01-10T06:30:00.000Z"
  startTimeLocal: string | null;    // "2026-01-10T07:30:00" (no offset)
  timeZoneOffsetSeconds: number | null,
  durationSeconds, movingDurationSeconds, elapsedDurationSeconds,
  distanceMeters, elevationGainMeters, elevationLossMeters,
  averageSpeedMetersPerSecond, maxSpeedMetersPerSecond,
  averageHeartRateBpm, maxHeartRateBpm, energyKilocalories,
  manual: boolean | null,
  raw?: unknown                     // only with includeRaw: true
}
```

Dates are `YYYY-MM-DD` strings and ranges are inclusive. Invalid input throws `RangeError`
before any request is sent.

Every response is validated at runtime with zod. Validation is strict about the fields this
package uses and tolerant of extra fields. A mismatch throws `ResponseFormatError`, which names
the endpoint and the field paths but never includes values.

## Missing metrics

Daily methods return **one entry per day of the requested range**:

```ts
{ date: '2026-09-02', value: null, status: 'not_measured' }
{ date: '2026-09-03', value: 49,   status: 'measured' }
```

A missing day is **never coerced to 0**. A 204 or empty body, a missing day, a missing field or
a `null` value all mean `not_measured`. A value that Garmin does report, including 0, counts as
`measured`.

## Errors

All errors extend `GarminConnectError` and carry a stable `code`. Messages never contain
credentials, tokens, cookies or response bodies.

| Class                      | `code`                  | When                                                                                     |
| -------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| `AuthenticationError`      | `authentication_failed` | Wrong username or password. Do not retry automatically.                                  |
| `InvalidMfaCodeError`      | `invalid_mfa_code`      | The MFA code was rejected. You may retry with the same challenge.                        |
| `CaptchaRequiredError`     | `captcha_required`      | Strategies failed and at least one demanded a CAPTCHA.                                   |
| `AccountLockedError`       | `account_locked`        | Garmin reports the account as locked.                                                    |
| `LoginFailedError`         | `login_failed`          | All strategies failed for other reasons. `attempts` lists `{ strategy, code, status? }`. |
| `TokenExchangeError`       | `token_exchange_failed` | SSO succeeded but no client id accepted the ticket.                                      |
| `SessionExpiredError`      | `session_expired`       | `reason`: `no_tokens`, `refresh_failed` (store cleared) or `rejected`. Log in again.     |
| `RateLimitError`           | `rate_limited`          | HTTP 429, or a 429 inside a JSON body. `retryAfterSeconds` is set if Garmin sent one.    |
| `NetworkError`             | `network_error`         | Transport failure. `kind` is `timeout`, `aborted` or `network`.                          |
| `HttpError`                | `http_error`            | Another non-success status, such as 5xx after retries or 403. Has `status`.              |
| `ResponseFormatError`      | `response_format`       | The response did not match the schema. Has `endpoint` and `issues` (field paths).        |
| `UnsupportedResponseError` | `unsupported_response`  | Well-formed but unknown shape, such as an unexpected VO₂max response or login status.    |
| `NotFoundError`            | `not_found`             | HTTP 404.                                                                                |

**Session expiry:** if Garmin rejects the refresh token (400/401/403), the client **clears the
token store** and throws `SessionExpiredError` with `reason: 'refresh_failed'`. A refresh that
fails transiently (network error, 5xx or 429) does not clear anything. If a proactive refresh
fails transiently while the old token is still valid, the client keeps using the old token.

## Rate limits and login hygiene

Garmin protects SSO aggressively. Repeated logins can earn 429s and CAPTCHAs, and can lock the
account.

- **Persist tokens and log in rarely.** A refresh token lasts a long time, so a normal
  integration logs in once and then only refreshes.
- **Never loop logins.** `login()` never retries on its own. Each strategy runs at most once
  per call. If you get a `RateLimitError` or `CaptchaRequiredError`, back off for minutes to
  hours and do not retry immediately.
- API reads (GETs only) are retried at most 3 times on network errors, 5xx and 429, with
  exponential backoff and jitter. They respect `Retry-After` up to `maxDelayMs`; a longer
  `Retry-After` throws immediately. Logins, MFA and token POSTs are never retried
  automatically.
- Spread out bulk history imports. `iterateActivities` fetches pages one after another.

## Transport, TLS and Cloudflare

Garmin's SSO sits behind Cloudflare, which can block clients by **TLS fingerprint**. Node's
built-in `fetch` (undici) has a fingerprint that is easy to recognise. The Python library this
flow comes from rotates browser fingerprints with `curl_cffi`. This package deliberately ships
**no native or binary dependencies**. Instead, `transport` is the extension point:

```ts
const client = new GarminConnectClient({
  tokenStore,
  transport: (url, init) => myImpersonatingProxyFetch(url, init), // fetch-compatible
});
```

The transport receives `redirect: 'manual'` for SSO requests, so that cookies from
intermediate redirects are kept. It must return the 3xx response itself rather than follow it.
API calls to `connectapi.garmin.com` are usually less affected than SSO.

## Security notes

- Credentials are only ever sent to `sso.garmin.com`. They are never stored, never kept in the
  MFA challenge and never logged.
- `src/` contains no `console.*`. The optional `onEvent` hook only receives redacted metadata:
  method, URL without query string (for API reads, the endpoint template without ids or display
  names), status, duration, retry reason and strategy outcome codes. It never receives tokens,
  cookies, tickets, bodies or health values.
- JWTs are decoded **without** signature verification, and only to read `exp` and
  `client_id`. They are never trusted for authorisation decisions.
- Treat `StoredTokens` and `MfaChallenge` as secrets: encrypt them at rest and never send them
  to a browser.
- Activity ids and display names are validated or URL-encoded before they go into URL paths.

## Live verification

`test/live/live.test.ts` is excluded from `bun run test`. It runs only with `GARMIN_LIVE=1`,
reads credentials **only** from environment variables and makes strictly read-only calls:
profile, one page of 5 activities, and resting HR and VO₂max for the last 7 days. It prints
counts and statuses only, never values, ids or tokens.

```sh
read -r GARMIN_USERNAME && read -rs GARMIN_PASSWORD && export GARMIN_USERNAME GARMIN_PASSWORD
# optional: reuse/persist tokens instead of logging in each time
export GARMIN_TOKEN_FILE="$HOME/.config/gconnect/garmin.tokens.json"
bun run test:live          # prompts for an MFA code on the terminal if needed
# or: GARMIN_MFA_CODE=123456 bun run test:live
unset GARMIN_USERNAME GARMIN_PASSWORD
```

`read -s` keeps the password out of your shell history and off the screen. Prefer
`GARMIN_TOKEN_FILE` once you have logged in, so later runs do not log in again.

**Maintainer status: live login has not yet been verified against a real account.**

## Known limitations

- Live login is unverified, and Node's TLS fingerprint may be blocked on SSO (see above).
- The JWT_WEB cookie fallback of the Python library is not ported. If no DI client id accepts
  the ticket, you get `TokenExchangeError`.
- The VO₂max (`maxmet`) and sleep-stats response shapes are not typed upstream and are only
  partially verified. Unknown VO₂max shapes raise `UnsupportedResponseError` rather than
  returning guessed data.
- Only `garmin.com` accounts are supported, not `garmin.cn`.
- `listActivityFiles` is a heuristic based on activity metadata.
- Chunk sizes for VO₂max and HRV (28 days) are conservative assumptions. The 28-day limit for
  sleep comes from the upstream implementation.

## Development

```sh
bun install
bun run lint && bun run typecheck && bun run test && bun run build
```

## Attribution

The authentication flow (SSO strategies, MFA, ticket exchange, token refresh), its constants
and the endpoint paths were ported from
[python-garminconnect](https://github.com/cyberjunky/python-garminconnect) v0.3.17 by Ron
Klinkien (cyberjunky), which is MIT-licensed. See [NOTICE](NOTICE). Thank you to its
maintainers and contributors.

## License

MIT © Miguel Seglias. See [LICENSE](LICENSE).

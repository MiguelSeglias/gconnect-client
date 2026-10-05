/**
 * Persisted OAuth session. Treat every field as a secret: the refresh token grants
 * long-lived access to the Garmin account.
 */
export interface StoredTokens {
  /** Schema version of this object. */
  version: 1;
  /** DI OAuth2 access token (JWT) sent as Bearer token. */
  accessToken: string;
  /** Refresh token, if Garmin issued one. */
  refreshToken: string | null;
  /** OAuth client id the token belongs to (needed for refresh). */
  clientId: string;
  /** Access-token expiry in epoch seconds (from the JWT `exp` claim), or null if unknown. */
  expiresAt: number | null;
}

/**
 * Decode a JWT payload WITHOUT verifying the signature (the client has no key). Tokens that
 * claim `alg: none` or are structurally invalid yield `null`.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const header: unknown = JSON.parse(base64UrlDecode(parts[0] ?? ''));
    if (!isRecord(header) || header.alg === 'none') return null;
    const payload: unknown = JSON.parse(base64UrlDecode(parts[1] ?? ''));
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

/** `exp` claim in epoch seconds, defensively coerced. */
export function jwtExpiry(token: string): number | null {
  const exp = decodeJwtPayload(token)?.exp;
  if (typeof exp === 'number' && Number.isFinite(exp)) return exp;
  if (typeof exp === 'string' && /^\d+(\.\d+)?$/.test(exp)) return Number(exp);
  return null;
}

/** `client_id` claim, if present. */
export function jwtClientId(token: string): string | null {
  const value = decodeJwtPayload(token)?.client_id;
  return typeof value === 'string' && value !== '' ? value : null;
}

function base64UrlDecode(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function basicAuth(clientId: string): string {
  return `Basic ${btoa(`${clientId}:`)}`;
}

/** Validate an unknown value (e.g. read from storage) as {@link StoredTokens}. */
export function parseStoredTokens(value: unknown): StoredTokens | null {
  if (!isRecord(value)) return null;
  const { version, accessToken, refreshToken, clientId, expiresAt } = value;
  if (version !== 1 || typeof accessToken !== 'string' || accessToken === '') return null;
  if (refreshToken !== null && typeof refreshToken !== 'string') return null;
  if (typeof clientId !== 'string' || clientId === '') return null;
  if (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) {
    return null;
  }
  return { version, accessToken, refreshToken, clientId, expiresAt };
}

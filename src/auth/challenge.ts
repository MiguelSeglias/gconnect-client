import { z } from 'zod';
import type { SerializedCookie } from './cookie-jar';

/** SSO flow that produced an MFA challenge. */
export type MfaFlow = 'mobile' | 'portal' | 'widget';

/**
 * Pending MFA login state returned by `login()` when Garmin requires a second factor.
 *
 * Treat it as **opaque and sensitive**: it contains the SSO session cookies of a
 * half-authenticated login (but never the password). It is plain JSON, so it can be stored
 * server-side (encrypted, short TTL — a few minutes) and passed to `completeMfa()` later.
 * Never send it to a browser or log it.
 */
export interface MfaChallenge {
  readonly type: 'gconnect-client/mfa-challenge';
  readonly version: 1;
  readonly flow: MfaFlow;
  /** MFA delivery method reported by Garmin, e.g. "email", "sms", "totp". Safe to show. */
  readonly mfaMethod: string;
  /** Epoch ms when the challenge was created. */
  readonly createdAt: number;
  readonly cookies: readonly SerializedCookie[];
  readonly loginParams: Readonly<Record<string, string>>;
  readonly postHeaders: Readonly<Record<string, string>>;
  readonly serviceUrl: string;
  /** Widget flow only: CSRF token of the MFA page. */
  readonly csrf?: string;
}

const cookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  hostOnly: z.boolean(),
  path: z.string(),
  expiresAt: z.number().nullable(),
  secure: z.boolean(),
});

export const mfaChallengeSchema = z.object({
  type: z.literal('gconnect-client/mfa-challenge'),
  version: z.literal(1),
  flow: z.enum(['mobile', 'portal', 'widget']),
  mfaMethod: z.string(),
  createdAt: z.number(),
  cookies: z.array(cookieSchema),
  loginParams: z.record(z.string(), z.string()),
  postHeaders: z.record(z.string(), z.string()),
  serviceUrl: z.string(),
  csrf: z.string().optional(),
});

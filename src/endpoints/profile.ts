import { z } from 'zod';
import { nn, parseOrThrow } from './util';
import type { ApiSession } from '../http/api';
import type { UserProfile } from '../types';

export const PROFILE_ENDPOINT = 'userprofile-service/socialProfile';
export const profilePath = (): string => `/${PROFILE_ENDPOINT}`;

export const profileSchema = z.looseObject({
  displayName: z.string().trim().min(1),
  fullName: z.string().nullish(),
  profileId: z.union([z.number(), z.string()]).nullish(),
});

export async function fetchUserProfile(api: ApiSession): Promise<UserProfile> {
  const body = await api.getJson(profilePath(), { endpoint: PROFILE_ENDPOINT });
  const p = parseOrThrow(profileSchema, body, PROFILE_ENDPOINT);
  return {
    displayName: p.displayName,
    fullName: nn(p.fullName),
    profileId: p.profileId === null || p.profileId === undefined ? null : String(p.profileId),
  };
}

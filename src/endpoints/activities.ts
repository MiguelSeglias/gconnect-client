import { z } from 'zod';
import {
  assertDate,
  nn,
  normalizeLocalTimestamp,
  normalizeUtcTimestamp,
  offsetSeconds,
  parseOrThrow,
} from './util';
import type { ApiSession } from '../http/api';
import type { ActivityDetail, ActivityFilter, ActivityPage, ActivitySummary } from '../types';

export const ACTIVITY_LIST_ENDPOINT = 'activitylist-service/activities/search/activities';
export const ACTIVITY_ENDPOINT = 'activity-service/activity';
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 1000;
/** Safety bound for iterateActivities against servers that never return an empty page. */
export const MAX_PAGES = 10_000;

export const activityListPath = (): string => `/${ACTIVITY_LIST_ENDPOINT}`;

export function activityPath(id: string): string {
  return `/${ACTIVITY_ENDPOINT}/${assertActivityId(id)}`;
}

export function assertActivityId(id: string): string {
  if (!/^\d{1,20}$/.test(id)) throw new RangeError('activity id must be a numeric string');
  return id;
}

const num = z.number().nullish();
const activityTypeSchema = z.looseObject({ typeKey: z.string().nullish() }).nullish();

export const activitySummarySchema = z.looseObject({
  activityId: z.number().int().nonnegative(),
  activityName: z.string().nullish(),
  startTimeLocal: z.string().nullish(),
  startTimeGMT: z.string().nullish(),
  activityType: activityTypeSchema,
  duration: num,
  movingDuration: num,
  elapsedDuration: num,
  distance: num,
  elevationGain: num,
  elevationLoss: num,
  averageSpeed: num,
  maxSpeed: num,
  averageHR: num,
  maxHR: num,
  calories: num,
  manualActivity: z.boolean().nullish(),
});

export const activityListSchema = z.array(activitySummarySchema);

const summaryDtoSchema = z.looseObject({
  startTimeLocal: z.string().nullish(),
  startTimeGMT: z.string().nullish(),
  duration: num,
  movingDuration: num,
  elapsedDuration: num,
  distance: num,
  elevationGain: num,
  elevationLoss: num,
  averageSpeed: num,
  maxSpeed: num,
  averageHR: num,
  maxHR: num,
  calories: num,
});

export const activityDetailSchema = z.looseObject({
  activityId: z.number().int().nonnegative(),
  activityName: z.string().nullish(),
  description: z.string().nullish(),
  activityTypeDTO: activityTypeSchema,
  summaryDTO: summaryDtoSchema.nullish(),
  metadataDTO: z
    .looseObject({
      manualActivity: z.boolean().nullish(),
      hasPolyline: z.boolean().nullish(),
    })
    .nullish(),
});

type SummaryFields = z.infer<typeof summaryDtoSchema>;

function mapCommon(
  id: number,
  name: string | null | undefined,
  typeKey: string | null | undefined,
  s: SummaryFields,
  manual: boolean | null | undefined,
): ActivitySummary {
  const startTimeLocal = normalizeLocalTimestamp(s.startTimeLocal);
  const startTimeUtc = normalizeUtcTimestamp(s.startTimeGMT);
  return {
    id: String(id),
    name: nn(name),
    activityType: nn(typeKey),
    startTimeUtc,
    startTimeLocal,
    timeZoneOffsetSeconds: offsetSeconds(startTimeLocal, startTimeUtc),
    durationSeconds: nn(s.duration),
    movingDurationSeconds: nn(s.movingDuration),
    elapsedDurationSeconds: nn(s.elapsedDuration),
    distanceMeters: nn(s.distance),
    elevationGainMeters: nn(s.elevationGain),
    elevationLossMeters: nn(s.elevationLoss),
    averageSpeedMetersPerSecond: nn(s.averageSpeed),
    maxSpeedMetersPerSecond: nn(s.maxSpeed),
    averageHeartRateBpm: nn(s.averageHR),
    maxHeartRateBpm: nn(s.maxHR),
    energyKilocalories: nn(s.calories),
    manual: nn(manual),
  };
}

export function mapActivitySummary(
  a: z.infer<typeof activitySummarySchema>,
  raw?: unknown,
): ActivitySummary {
  const mapped = mapCommon(
    a.activityId,
    a.activityName,
    a.activityType?.typeKey,
    a,
    a.manualActivity,
  );
  return raw === undefined ? mapped : { ...mapped, raw };
}

export function mapActivityDetail(
  a: z.infer<typeof activityDetailSchema>,
  raw?: unknown,
): ActivityDetail {
  const mapped: ActivityDetail = {
    ...mapCommon(
      a.activityId,
      a.activityName,
      a.activityTypeDTO?.typeKey,
      a.summaryDTO ?? {},
      a.metadataDTO?.manualActivity,
    ),
    description: nn(a.description),
    hasGps: nn(a.metadataDTO?.hasPolyline),
  };
  return raw === undefined ? mapped : { ...mapped, raw };
}

/** Validate and normalise a filter into query params. */
export function activityListParams(filter: ActivityFilter): {
  start: number;
  limit: number;
  params: Record<string, string | number | undefined>;
} {
  const start = filter.start ?? 0;
  if (!Number.isInteger(start) || start < 0)
    throw new RangeError('start must be a non-negative integer');
  const requested = filter.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(requested) || requested < 1)
    throw new RangeError('limit must be a positive integer');
  const limit = Math.min(requested, MAX_PAGE_SIZE);
  if (filter.startDate !== undefined) assertDate(filter.startDate, 'startDate');
  if (filter.endDate !== undefined) assertDate(filter.endDate, 'endDate');
  return {
    start,
    limit,
    params: {
      start,
      limit,
      startDate: filter.startDate,
      endDate: filter.endDate,
      activityType: filter.activityType,
    },
  };
}

export async function fetchActivityPage(
  api: ApiSession,
  filter: ActivityFilter,
  includeRaw: boolean,
): Promise<ActivityPage> {
  const { start, params } = activityListParams(filter);
  const body = await api.getJson(activityListPath(), { endpoint: ACTIVITY_LIST_ENDPOINT, params });
  const list = parseOrThrow(activityListSchema, body ?? [], ACTIVITY_LIST_ENDPOINT);
  const rawList = Array.isArray(body) ? (body as unknown[]) : [];
  const items = list.map((a, i) => mapActivitySummary(a, includeRaw ? rawList[i] : undefined));
  return { items, nextStart: items.length === 0 ? null : start + items.length };
}

export async function fetchActivity(
  api: ApiSession,
  id: string,
  includeRaw: boolean,
): Promise<ActivityDetail> {
  const body = await api.getJson(activityPath(id), { endpoint: ACTIVITY_ENDPOINT });
  const parsed = parseOrThrow(activityDetailSchema, body, ACTIVITY_ENDPOINT);
  return mapActivityDetail(parsed, includeRaw ? body : undefined);
}

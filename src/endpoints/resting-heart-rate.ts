import { z } from 'zod';
import { chunkRange, fillDaily, parseOrThrow, validateRange } from './util';
import type { ApiSession } from '../http/api';
import type { DailyMetric, DateRange } from '../types';

export const RHR_ENDPOINT = 'userstats-service/wellness/daily';
/** Garmin wellness metric id for resting heart rate. */
export const RHR_METRIC_ID = 60;
const MAX_DAYS_PER_REQUEST = 365;

export function restingHeartRatePath(displayName: string): string {
  return `/${RHR_ENDPOINT}/${encodeURIComponent(displayName)}`;
}

export const restingHeartRateSchema = z.looseObject({
  allMetrics: z
    .looseObject({
      metricsMap: z
        .looseObject({
          WELLNESS_RESTING_HEART_RATE: z
            .array(z.looseObject({ calendarDate: z.string(), value: z.number().nullish() }))
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

/** Extract measured values; absent or null values are left out (→ not_measured). */
export function extractRestingHeartRate(body: unknown): Map<string, number> {
  const values = new Map<string, number>();
  if (body === undefined || body === null) return values; // 204 / empty
  const parsed = parseOrThrow(restingHeartRateSchema, body, RHR_ENDPOINT);
  for (const row of parsed.allMetrics?.metricsMap?.WELLNESS_RESTING_HEART_RATE ?? []) {
    if (typeof row.value === 'number' && Number.isFinite(row.value)) {
      values.set(row.calendarDate, row.value);
    }
  }
  return values;
}

export async function fetchRestingHeartRate(
  api: ApiSession,
  displayName: string,
  range: DateRange,
): Promise<DailyMetric<number>[]> {
  validateRange(range);
  const values = new Map<string, number>();
  for (const chunk of chunkRange(range, MAX_DAYS_PER_REQUEST)) {
    const body = await api.getJson(restingHeartRatePath(displayName), {
      endpoint: RHR_ENDPOINT,
      params: { fromDate: chunk.from, untilDate: chunk.to, metricId: RHR_METRIC_ID },
    });
    for (const [date, value] of extractRestingHeartRate(body)) values.set(date, value);
  }
  return fillDaily(range, values);
}

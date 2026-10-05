import { z } from 'zod';
import { chunkRange, fillDaily, nn, parseOrThrow, validateRange } from './util';
import type { ApiSession } from '../http/api';
import type { DailyMetric, DateRange, SleepSummary } from '../types';

export const SLEEP_ENDPOINT = 'sleep-service/stats/sleep/daily';
/** Garmin limits this endpoint to 28 days per request. */
export const SLEEP_MAX_DAYS = 28;

export function sleepPath(range: DateRange): string {
  return `/${SLEEP_ENDPOINT}/${range.from}/${range.to}`;
}

const num = z.number().nullish();

export const sleepSchema = z.looseObject({
  individualStats: z
    .array(
      z.looseObject({
        calendarDate: z.string(),
        values: z
          .looseObject({
            totalSleepTimeInSeconds: num,
            deepTime: num,
            lightTime: num,
            remTime: num,
            awakeTime: num,
            sleepScore: num,
          })
          .nullish(),
      }),
    )
    .nullish(),
});

export function extractSleep(body: unknown): Map<string, SleepSummary> {
  const out = new Map<string, SleepSummary>();
  if (body === undefined || body === null) return out;
  const parsed = parseOrThrow(sleepSchema, body, SLEEP_ENDPOINT);
  for (const row of parsed.individualStats ?? []) {
    const v = row.values;
    if (typeof v?.totalSleepTimeInSeconds !== 'number') continue;
    if (out.has(row.calendarDate)) continue;
    out.set(row.calendarDate, {
      totalSleepSeconds: v.totalSleepTimeInSeconds,
      deepSleepSeconds: nn(v.deepTime),
      lightSleepSeconds: nn(v.lightTime),
      remSleepSeconds: nn(v.remTime),
      awakeSeconds: nn(v.awakeTime),
      score: nn(v.sleepScore),
    });
  }
  return out;
}

export async function fetchSleep(
  api: ApiSession,
  range: DateRange,
): Promise<DailyMetric<SleepSummary>[]> {
  validateRange(range);
  const values = new Map<string, SleepSummary>();
  for (const chunk of chunkRange(range, SLEEP_MAX_DAYS)) {
    const body = await api.getJson(sleepPath(chunk), { endpoint: SLEEP_ENDPOINT });
    for (const [date, value] of extractSleep(body)) if (!values.has(date)) values.set(date, value);
  }
  return fillDaily(range, values);
}

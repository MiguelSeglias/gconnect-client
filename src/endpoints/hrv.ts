import { z } from 'zod';
import { chunkRange, fillDaily, nn, parseOrThrow, validateRange } from './util';
import type { ApiSession } from '../http/api';
import type { DailyMetric, DateRange, HrvSummary } from '../types';

export const HRV_ENDPOINT = 'hrv-service/hrv/daily';
const MAX_DAYS_PER_REQUEST = 28;

export function hrvPath(range: DateRange): string {
  return `/${HRV_ENDPOINT}/${range.from}/${range.to}`;
}

const num = z.number().nullish();

export const hrvSchema = z.looseObject({
  hrvSummaries: z
    .array(
      z.looseObject({
        calendarDate: z.string(),
        lastNightAvg: num,
        weeklyAvg: num,
        lastNight5MinHigh: num,
        status: z.string().nullish(),
      }),
    )
    .nullish(),
});

export function extractHrv(body: unknown): Map<string, HrvSummary> {
  const out = new Map<string, HrvSummary>();
  if (body === undefined || body === null) return out;
  const parsed = parseOrThrow(hrvSchema, body, HRV_ENDPOINT);
  for (const row of parsed.hrvSummaries ?? []) {
    if (typeof row.lastNightAvg !== 'number') continue;
    out.set(row.calendarDate, {
      lastNightAverageMs: row.lastNightAvg,
      weeklyAverageMs: nn(row.weeklyAvg),
      lastNight5MinHighMs: nn(row.lastNight5MinHigh),
      status: nn(row.status),
    });
  }
  return out;
}

export async function fetchHrv(
  api: ApiSession,
  range: DateRange,
): Promise<DailyMetric<HrvSummary>[]> {
  validateRange(range);
  const values = new Map<string, HrvSummary>();
  for (const chunk of chunkRange(range, MAX_DAYS_PER_REQUEST)) {
    const body = await api.getJson(hrvPath(chunk), { endpoint: HRV_ENDPOINT });
    for (const [date, value] of extractHrv(body)) values.set(date, value);
  }
  return fillDaily(range, values);
}

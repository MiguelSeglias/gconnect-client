import { chunkRange, fillDaily, validateRange } from './util';
import { UnsupportedResponseError } from '../errors';
import type { ApiSession } from '../http/api';
import type { DailyMetric, DateRange } from '../types';

export const VO2_ENDPOINT = 'metrics-service/metrics/maxmet/daily';
const MAX_DAYS_PER_REQUEST = 28;

export function vo2MaxPath(range: DateRange): string {
  return `/${VO2_ENDPOINT}/${range.from}/${range.to}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new UnsupportedResponseError(VO2_ENDPOINT, `Unsupported type for ${key}`);
  }
  return v;
}

/**
 * Extract running/generic VO2max (ml/kg/min) per day. The response shape is not documented
 * or typed upstream; the known shape is an array of `{ generic: { calendarDate,
 * vo2MaxPreciseValue, vo2MaxValue } | null, ... }`. Anything else raises
 * {@link UnsupportedResponseError} rather than guessing.
 */
export function extractVo2Max(body: unknown): Map<string, number> {
  const values = new Map<string, number>();
  if (body === undefined || body === null) return values;
  if (isRecord(body) && Object.keys(body).length === 0) return values;
  if (!Array.isArray(body)) throw new UnsupportedResponseError(VO2_ENDPOINT);
  for (const entry of body) {
    if (!isRecord(entry)) throw new UnsupportedResponseError(VO2_ENDPOINT);
    const generic = entry.generic;
    if (generic === undefined || generic === null) continue; // no measurement that day
    if (!isRecord(generic)) throw new UnsupportedResponseError(VO2_ENDPOINT);
    const value =
      optionalNumber(generic, 'vo2MaxPreciseValue') ?? optionalNumber(generic, 'vo2MaxValue');
    if (value === null) continue;
    const date = generic.calendarDate ?? entry.calendarDate;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new UnsupportedResponseError(VO2_ENDPOINT, 'VO2max entry without calendar date');
    }
    values.set(date, value);
  }
  return values;
}

export async function fetchVo2Max(
  api: ApiSession,
  range: DateRange,
): Promise<DailyMetric<number>[]> {
  validateRange(range);
  const values = new Map<string, number>();
  for (const chunk of chunkRange(range, MAX_DAYS_PER_REQUEST)) {
    const body = await api.getJson(vo2MaxPath(chunk), { endpoint: VO2_ENDPOINT });
    for (const [date, value] of extractVo2Max(body)) values.set(date, value);
  }
  return fillDaily(range, values);
}

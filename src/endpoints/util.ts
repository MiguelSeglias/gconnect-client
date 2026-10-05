import type { z } from 'zod';
import { ResponseFormatError } from '../errors';
import type { DailyMetric, DateRange } from '../types';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
/** Upper bound on any requested range, to keep request counts bounded. */
export const MAX_RANGE_DAYS = 3660;

export function assertDate(value: string, name: string): void {
  const m = DATE_RE.exec(value);
  if (!m) throw new RangeError(`${name} must be YYYY-MM-DD`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${name} is not a valid calendar date`);
  }
}

function toMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function fromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function validateRange(range: DateRange): void {
  assertDate(range.from, 'from');
  assertDate(range.to, 'to');
  const days = (toMs(range.to) - toMs(range.from)) / DAY_MS + 1;
  if (days < 1) throw new RangeError('from must not be after to');
  if (days > MAX_RANGE_DAYS) throw new RangeError(`range must not exceed ${MAX_RANGE_DAYS} days`);
}

export function enumerateDates(range: DateRange): string[] {
  const out: string[] = [];
  for (let t = toMs(range.from); t <= toMs(range.to); t += DAY_MS) out.push(fromMs(t));
  return out;
}

/** Split an inclusive range into chunks of at most `maxDays` days. */
export function chunkRange(range: DateRange, maxDays: number): DateRange[] {
  const chunks: DateRange[] = [];
  const end = toMs(range.to);
  for (let t = toMs(range.from); t <= end; t += maxDays * DAY_MS) {
    chunks.push({ from: fromMs(t), to: fromMs(Math.min(end, t + (maxDays - 1) * DAY_MS)) });
  }
  return chunks;
}

/** Produce one entry per day; days absent from `values` are `not_measured`. */
export function fillDaily<T>(range: DateRange, values: ReadonlyMap<string, T>): DailyMetric<T>[] {
  return enumerateDates(range).map((date) => {
    const value = values.get(date);
    return value === undefined
      ? { date, value: null, status: 'not_measured' as const }
      : { date, value, status: 'measured' as const };
  });
}

/** Parse with a schema; on failure throw a ResponseFormatError naming only field paths. */
export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  value: unknown,
  endpoint: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ResponseFormatError(
      endpoint,
      result.error.issues.map((i) => (i.path.length > 0 ? i.path.join('.') : '<root>')),
    );
  }
  return result.data;
}

/** Garmin timestamp ("YYYY-MM-DD HH:mm:ss" or with "T" and fraction) as ISO without offset. */
export function normalizeLocalTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(value.trim());
  return m ? `${m[1] ?? ''}T${m[2] ?? ''}` : null;
}

/** Garmin GMT timestamp as ISO 8601 UTC with `Z`. */
export function normalizeUtcTimestamp(value: string | null | undefined): string | null {
  const local = normalizeLocalTimestamp(value);
  if (local === null) return null;
  const ms = Date.parse(`${local}Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function offsetSeconds(localIso: string | null, utcIso: string | null): number | null {
  if (localIso === null || utcIso === null) return null;
  const local = Date.parse(`${localIso}Z`);
  const utc = Date.parse(utcIso);
  if (Number.isNaN(local) || Number.isNaN(utc)) return null;
  return Math.round((local - utc) / 1000);
}

export function nn<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

/** Whether a daily metric has a value for that day. */
export type MetricStatus = 'measured' | 'not_measured';

/**
 * One calendar day of a metric. Missing data is never coerced to 0: days without data have
 * `value: null` and `status: 'not_measured'`. Every day of the requested range is present.
 */
export interface DailyMetric<T> {
  /** Calendar date `YYYY-MM-DD` (the user's local day as reported by Garmin). */
  date: string;
  value: T | null;
  status: MetricStatus;
}

/** Inclusive date range, both `YYYY-MM-DD`. */
export interface DateRange {
  from: string;
  to: string;
}

/** Activity as returned by the activity list. Units are SI. */
export interface ActivitySummary {
  /** Garmin activityId as a string (stable source id). */
  id: string;
  name: string | null;
  /** Garmin activity type key, e.g. "running", "cycling". */
  activityType: string | null;
  /** ISO 8601 UTC start time with `Z`, e.g. "2026-01-02T06:30:00.000Z". */
  startTimeUtc: string | null;
  /** ISO 8601 local wall-clock start time without offset, e.g. "2026-01-02T07:30:00". */
  startTimeLocal: string | null;
  /** Local minus UTC offset in seconds, when both times are known. */
  timeZoneOffsetSeconds: number | null;
  durationSeconds: number | null;
  movingDurationSeconds: number | null;
  elapsedDurationSeconds: number | null;
  distanceMeters: number | null;
  elevationGainMeters: number | null;
  elevationLossMeters: number | null;
  averageSpeedMetersPerSecond: number | null;
  maxSpeedMetersPerSecond: number | null;
  averageHeartRateBpm: number | null;
  maxHeartRateBpm: number | null;
  /** Energy in kilocalories (Garmin's unit; not converted). */
  energyKilocalories: number | null;
  /** True for manually entered activities (no recorded file). */
  manual: boolean | null;
  /** Raw Garmin object; only present when the client was created with `includeRaw: true`. */
  raw?: unknown;
}

/** Single activity. Units are SI. */
export interface ActivityDetail extends ActivitySummary {
  description: string | null;
  /** Whether the activity has a GPS track (null if unknown). */
  hasGps: boolean | null;
}

/** One page of activities. */
export interface ActivityPage {
  items: ActivitySummary[];
  /** Offset for the next page, or null when this page was empty. */
  nextStart: number | null;
}

/** Filter for listing activities. */
export interface ActivityFilter {
  /** Offset, 0 = most recent. Default 0. */
  start?: number;
  /** Page size. Default 100, capped at 1000. */
  limit?: number;
  /** Inclusive lower bound `YYYY-MM-DD`. */
  startDate?: string;
  /** Inclusive upper bound `YYYY-MM-DD`. */
  endDate?: string;
  /** Garmin activity type key, e.g. "running". */
  activityType?: string;
}

export type ActivityFileFormat = 'fit' | 'tcx' | 'gpx';

/** A downloaded activity file. */
export interface ActivityFile {
  format: ActivityFileFormat;
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
  /**
   * `'zip'` when the bytes are a ZIP archive. The FIT "original" download is delivered by
   * Garmin as a ZIP containing the .fit file and is returned as-is (not unzipped).
   */
  compression: 'zip' | 'none';
}

/** The authenticated user's profile. */
export interface UserProfile {
  /** Garmin display name; used in wellness endpoint paths. */
  displayName: string;
  fullName: string | null;
  profileId: string | null;
}

/** Nightly sleep summary. Durations in seconds. */
export interface SleepSummary {
  totalSleepSeconds: number;
  deepSleepSeconds: number | null;
  lightSleepSeconds: number | null;
  remSleepSeconds: number | null;
  awakeSeconds: number | null;
  /** Garmin sleep score 0–100, if reported. */
  score: number | null;
}

/** Nightly heart-rate-variability summary. Values in milliseconds (RMSSD). */
export interface HrvSummary {
  lastNightAverageMs: number;
  weeklyAverageMs: number | null;
  lastNight5MinHighMs: number | null;
  /** Garmin status, e.g. "BALANCED", "UNBALANCED", "LOW". */
  status: string | null;
}

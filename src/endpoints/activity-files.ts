import { assertActivityId } from './activities';
import type { ApiSession } from '../http/api';
import type { ActivityDetail, ActivityFile, ActivityFileFormat } from '../types';
import { NotFoundError } from '../errors';

export const DOWNLOAD_ENDPOINT = 'download-service';

const FORMATS: Record<ActivityFileFormat, { path: string; ext: string; contentType: string }> = {
  // The "original" upload: Garmin wraps the .fit file in a ZIP archive.
  fit: { path: '/download-service/files/activity', ext: 'zip', contentType: 'application/zip' },
  tcx: {
    path: '/download-service/export/tcx/activity',
    ext: 'tcx',
    contentType: 'application/vnd.garmin.tcx+xml',
  },
  gpx: {
    path: '/download-service/export/gpx/activity',
    ext: 'gpx',
    contentType: 'application/gpx+xml',
  },
};

export function activityFilePath(id: string, format: ActivityFileFormat): string {
  const spec = FORMATS[format];
  return `${spec.path}/${assertActivityId(id)}`;
}

/**
 * Formats that can be expected for an activity. Garmin has no "list files" endpoint, so this
 * is derived from activity metadata: manual activities have no files; GPX requires a track.
 */
export function availableFormats(activity: ActivityDetail): ActivityFileFormat[] {
  if (activity.manual === true) return [];
  const formats: ActivityFileFormat[] = ['fit', 'tcx'];
  if (activity.hasGps !== false) formats.push('gpx');
  return formats;
}

function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

export async function downloadFile(
  api: ApiSession,
  id: string,
  format: ActivityFileFormat,
): Promise<ActivityFile> {
  if (!(format in FORMATS)) throw new RangeError('format must be one of fit, tcx, gpx');
  const spec = FORMATS[format];
  const res = await api.get(activityFilePath(id, format), {
    endpoint: `${DOWNLOAD_ENDPOINT}/${format}`,
    download: true,
  });
  if (res === null) throw new NotFoundError(`${DOWNLOAD_ENDPOINT}/${format}`);
  const zip = isZip(res.bytes);
  const header = res.headers.get('content-type')?.split(';')[0]?.trim();
  return {
    format,
    bytes: res.bytes,
    contentType: header !== undefined && header !== '' ? header : spec.contentType,
    fileName: `${id}.${zip ? 'zip' : format === 'fit' ? 'fit' : spec.ext}`,
    compression: zip ? 'zip' : 'none',
  };
}

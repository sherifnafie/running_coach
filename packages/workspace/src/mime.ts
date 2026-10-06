/**
 * MIME → file extension mapping. This is THE mapping used for /raw/<sha256>.<ext> paths: both the
 * blob store (which writes the files) and the transcript renderer (which prints the paths) call it.
 *
 * Note: `json` is deliberately never returned. `<sha256>.json` is the sidecar of every raw blob,
 * so a JSON upload is stored as `<sha256>.txt` (its real mime type lives in the sidecar).
 */

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
  'audio/3gpp': '3gp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
  'application/x-tar': 'tar',
  'application/octet-stream': 'bin',
  'application/json': 'txt',
  'application/x-ndjson': 'jsonl',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'application/gpx+xml': 'gpx',
  'application/vnd.garmin.tcx+xml': 'tcx',
  'application/tcx+xml': 'tcx',
  'application/vnd.ant.fit': 'fit',
  'application/fit': 'fit',
  'application/x-fit': 'fit',
  'application/vnd.google-earth.kml+xml': 'kml',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'text/markdown': 'md',
  'text/html': 'html',
  'text/calendar': 'ics',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

/** Lowercased media type without parameters ("Image/JPEG; q=1" → "image/jpeg"). */
export function baseMime(mime: string): string {
  return String(mime ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
}

/** File extension (no dot) for a MIME type. Never 'json' (reserved for sidecars). Falls back to 'bin'. */
export function extForMime(mime: string): string {
  const m = baseMime(mime);
  const known = EXT[m];
  if (known) return known;
  if (m.endsWith('+json')) return 'txt';
  if (m.endsWith('+xml')) return 'xml';
  const sub = m.split('/')[1]?.replace(/^(x-|vnd\.)/, '') ?? '';
  const cleaned = sub.replace(/[^a-z0-9]/g, '');
  if (cleaned.length >= 1 && cleaned.length <= 8 && cleaned !== 'json') return cleaned;
  return 'bin';
}

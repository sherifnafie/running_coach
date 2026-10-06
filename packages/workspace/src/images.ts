/**
 * Image helpers (SPEC [WS-7], §10.1): strip location metadata, and shrink/convert for model input.
 */
import sharp from 'sharp';
import { baseMime } from './mime';

const REENCODE: Record<string, 'jpeg' | 'png' | 'webp' | 'avif' | 'tiff'> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/pjpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
};

function toUint8(b: Buffer): Uint8Array {
  return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/**
 * Strip GPS/EXIF/XMP/IPTC metadata by re-encoding with sharp (which drops all metadata by default),
 * keeping the format (jpeg/png/webp/avif/tiff) and applying the EXIF orientation so the picture
 * still looks right. Formats that cannot be re-encoded here (HEIC/HEIF, GIF, ...) are returned
 * unchanged. A supported format that fails to decode throws (returning it unchanged would leak
 * location data).
 */
export async function stripImageLocation(data: Uint8Array, mime: string): Promise<Uint8Array> {
  const m = baseMime(mime);
  const fmt = REENCODE[m];
  if (!fmt) return data;
  try {
    let img = sharp(data, { failOn: 'none' }).rotate();
    switch (fmt) {
      case 'jpeg':
        img = img.jpeg({ quality: 92, chromaSubsampling: '4:4:4' });
        break;
      case 'png':
        img = img.png();
        break;
      case 'webp':
        img = img.webp({ quality: 92 });
        break;
      case 'avif':
        img = img.avif({ quality: 80 });
        break;
      case 'tiff':
        img = img.tiff();
        break;
    }
    return toUint8(await img.toBuffer());
  } catch (e) {
    throw new Error(`stripImageLocation: could not re-encode ${m} image: ${(e as Error).message}`);
  }
}

/**
 * Downscale/convert an image for model input: longest edge ≤ maxEdge (default 1568), orientation
 * applied, PNG stays PNG, everything else becomes JPEG q85 (transparency flattened onto white).
 * HEIC/HEIF are attempted; if this build of sharp cannot decode them the error says so.
 */
export async function prepareImageForModel(data: Uint8Array, mime: string, maxEdge = 1568): Promise<{ data: Uint8Array; mediaType: 'image/png' | 'image/jpeg' }> {
  if (!Number.isInteger(maxEdge) || maxEdge < 16 || maxEdge > 16_384) throw new Error(`prepareImageForModel: maxEdge must be an integer in [16, 16384], got ${maxEdge}`);
  const m = baseMime(mime);
  try {
    const format = (await sharp(data, { failOn: 'none' }).metadata()).format;
    const png = format === 'png' || (format === undefined && m === 'image/png');
    let img = sharp(data, { failOn: 'none' }).rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
    if (png) return { data: toUint8(await img.png().toBuffer()), mediaType: 'image/png' };
    img = img.flatten({ background: '#ffffff' }).jpeg({ quality: 85 });
    return { data: toUint8(await img.toBuffer()), mediaType: 'image/jpeg' };
  } catch (e) {
    if (m === 'image/heic' || m === 'image/heif') {
      throw new Error(
        `prepareImageForModel: this server's image library cannot decode ${m} (${(e as Error).message}). Ask the athlete to send a JPEG or PNG (iPhone: Settings > Camera > Formats > Most Compatible), or install libvips with HEIF/HEVC support.`,
      );
    }
    throw new Error(`prepareImageForModel: could not decode ${m} image: ${(e as Error).message}`);
  }
}

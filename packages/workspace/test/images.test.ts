import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { prepareImageForModel, stripImageLocation } from '../src';

const image = () => sharp({ create: { width: 160, height: 80, channels: 3, background: '#E4572E' } });

describe('image privacy and model preparation [WS-7] [COST-3]', () => {
  it('removes EXIF location and preserves the displayed orientation', async () => {
    const bytes = await image().withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 22/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '4/1 54/1 0/1' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const before = await sharp(bytes).metadata();
    expect(before.exif).toBeDefined();
    const stripped = await stripImageLocation(bytes, 'image/jpeg');
    const after = await sharp(stripped).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    expect([after.width, after.height]).toEqual([80, 160]);
  });

  it('keeps PNG and limits longest edge without enlarging small images', async () => {
    const bytes = await image().png().toBuffer();
    const resized = await prepareImageForModel(bytes, 'image/png', 64);
    expect(resized.mediaType).toBe('image/png');
    const meta = await sharp(resized.data).metadata();
    expect([meta.width, meta.height]).toEqual([64, 32]);
    const unchanged = await prepareImageForModel(bytes, 'image/png', 512);
    expect((await sharp(unchanged.data).metadata()).width).toBe(160);
  });

  it('converts supported non-PNG images into metadata-free JPEG', async () => {
    const bytes = await image().withMetadata().webp().toBuffer();
    const result = await prepareImageForModel(bytes, 'image/webp', 64);
    expect(result.mediaType).toBe('image/jpeg');
    const meta = await sharp(result.data).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
  });

  it('strips GIF metadata and fails safely for unsupported image formats [WS-7]', async () => {
    const gif = await image().withMetadata().gif().toBuffer();
    const result = await stripImageLocation(gif, 'image/gif');
    expect((await sharp(result).metadata()).format).toBe('gif');
    await expect(stripImageLocation(Buffer.from('heic'), 'image/heic')).rejects.toThrow(/cannot safely remove location/);
  });

  it('rejects corrupt supported images and invalid size limits', async () => {
    await expect(stripImageLocation(Buffer.from('not an image'), 'image/jpeg')).rejects.toThrow(/could not re-encode/);
    await expect(prepareImageForModel(Buffer.from('bad'), 'image/heic')).rejects.toThrow(/cannot decode image\/heic/);
    await expect(prepareImageForModel(await image().png().toBuffer(), 'image/png', 0)).rejects.toThrow(/maxEdge/);
  });
});

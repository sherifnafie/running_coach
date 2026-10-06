import { stripImageLocation } from '@opencoach/workspace';
import type { GatewayContext } from '../http/context';
import { badRequest } from '../http/errors';
import { blobRef } from './shared';

/** Both multipart and resumable intake enforce the athlete's image privacy setting [WS-7]. */
export async function storeUpload(ctx: GatewayContext, athleteId: string, file: { bytes: Uint8Array; mime: string; name?: string }) {
  let bytes: Uint8Array = file.bytes;
  if (file.mime.startsWith('image/') && !(await ctx.deps.store.getSettings(athleteId)).privacy.keepImageLocation) {
    try { bytes = await (ctx.deps.stripImageLocation ?? stripImageLocation)(bytes, file.mime); }
    catch { throw badRequest('The uploaded image cannot be decoded safely.'); }
  }
  return blobRef(await ctx.deps.blobs.put(athleteId, bytes, { mime: file.mime, name: file.name, origin: 'athlete' }));
}

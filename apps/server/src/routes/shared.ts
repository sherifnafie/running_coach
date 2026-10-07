import type { FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { type BlobRef } from '@opencoach/protocol';
import type { GatewayContext } from '../http/context';
import { badRequest, forbidden, notFound } from '../http/errors';
import { SESSION_COOKIE, csrfTokenForSession, safeEqual } from '../http/auth';

/** Use after requireAuth; native bearer requests do not need browser CSRF protection. */
export async function authenticated(ctx: GatewayContext, request: FastifyRequest, reply: import('fastify').FastifyReply): Promise<void> {
  await ctx.requireAuth(request, reply);
  enforceCsrf(ctx, request);
  if (!['GET', 'HEAD'].includes(request.method)) ctx.limitWrite(ctx.athleteId(request));
  ctx.trackRequest(request);
}

export function enforceCsrf(ctx: GatewayContext, request: FastifyRequest): void {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.auth?.via === 'cookie') {
    if (request.headers.origin !== ctx.publicOrigin) throw forbidden('Cookie-authenticated writes require the app Origin.', 'invalid_origin');
    const token = request.cookies[SESSION_COOKIE];
    const proof = request.headers['x-csrf-token'];
    if (!token || typeof proof !== 'string' || !safeEqual(proof, csrfTokenForSession(token))) throw forbidden('A valid X-CSRF-Token header is required.', 'invalid_csrf_token');
  }
}

export function params(request: FastifyRequest): Record<string, string> {
  return request.params as Record<string, string>;
}
export function query(request: FastifyRequest): Record<string, string> {
  return request.query as Record<string, string>;
}
export function pageLimit(value: string | undefined, fallback = 50): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 500) throw badRequest('limit must be an integer from 1 to 500.');
  return n;
}
export function blobRef(record: BlobRef): BlobRef {
  return { sha256: record.sha256, mime: record.mime, bytes: record.bytes, ...(record.name ? { name: record.name } : {}) };
}
export async function ownedBlob(ctx: GatewayContext, athleteId: string, sha: string): Promise<BlobRef> {
  const record = await ctx.deps.store.getBlob(athleteId, sha);
  if (!record) throw notFound('Unknown attachment.');
  return blobRef(record);
}
export async function uploaded(request: FastifyRequest, field: string): Promise<{ bytes: Buffer; mime: string; name: string; fields: MultipartFile['fields'] }> {
  const file = await request.file();
  if (!file || file.fieldname !== field) throw badRequest(`Multipart field '${field}' is required.`);
  const bytes = await file.toBuffer();
  if (!bytes.length) throw badRequest('The uploaded file is empty.');
  return { bytes, mime: file.mimetype, name: file.filename.slice(0, 255), fields: file.fields };
}

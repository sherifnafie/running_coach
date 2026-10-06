import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SetupRequest, PairRequest, pairingCode, HARNESS_VERSION, randomToken, IanaTimeZone } from '@opencoach/protocol';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { GatewayContext } from '../http/context';
import { normalizeCode, SESSION_COOKIE, csrfTokenForSession } from '../http/auth';
import { badRequest, conflict, forbidden, unauthorized } from '../http/errors';
import { authenticated } from './shared';

const CHALLENGE_COOKIE = 'oc_webauthn';
type Challenge = { challenge: string; expires: number; kind: 'login' | 'register'; sessionId?: string };

export function authRoutes(app: FastifyInstance, ctx: GatewayContext): void {
  const { store, runtime, clock } = ctx.deps;
  const auth = (request: FastifyRequest, reply: FastifyReply) => authenticated(ctx, request, reply);
  const limit = async (request: FastifyRequest) => { ctx.limitAuth(request); };
  const challenges = new Map<string, Challenge>();
  let setupTail: Promise<unknown> = Promise.resolve();

  async function issue(athleteId: string, reply: FastifyReply, deviceName?: string) {
    const session = await ctx.sessions.create(athleteId, { deviceName });
    ctx.setSessionCookie(reply, session.token, session.expiresAt);
    return { athleteId, token: session.token, expiresAt: session.expiresAt };
  }
  function remember(reply: FastifyReply, challenge: string, kind: Challenge['kind'], sessionId?: string) {
    const now = clock.now().getTime();
    for (const [id, c] of challenges) if (c.expires <= now) challenges.delete(id);
    const id = randomToken(24);
    challenges.set(id, { challenge, kind, sessionId, expires: now + 5 * 60_000 });
    reply.setCookie(CHALLENGE_COOKIE, id, { httpOnly: true, sameSite: 'strict', secure: ctx.secureCookies, path: '/v1/auth/passkey', maxAge: 300 });
  }
  function take(request: FastifyRequest, reply: FastifyReply, kind: Challenge['kind']) {
    const id = request.cookies[CHALLENGE_COOKIE];
    const c = id ? challenges.get(id) : undefined;
    if (id) challenges.delete(id);
    reply.clearCookie(CHALLENGE_COOKIE, { path: '/v1/auth/passkey' });
    if (!c || c.kind !== kind || c.expires <= clock.now().getTime() || (kind === 'register' && c.sessionId !== request.auth?.sessionId)) throw unauthorized('Passkey challenge expired. Try again.');
    return c.challenge;
  }

  app.get('/v1/setup-status', { preHandler: limit }, async () => ({ needsSetup: !(await store.hasAnyAthlete()) }));
  app.post('/v1/auth/setup', { preHandler: limit }, async (request, reply) => {
    const body = SetupRequest.parse(request.body);
    // Serialize first-account creation: two distinct setup codes must not create two owners.
    const run = setupTail.then(async () => {
      const code = await store.consumePairingCode(normalizeCode(body.code), clock.now().toISOString());
      if (!code || !['setup', 'invite'].includes(code.purpose)) throw unauthorized('Invalid or expired setup code.');
      if (code.purpose === 'setup' && await store.hasAnyAthlete()) throw conflict('Initial setup has already completed.');
      const at = clock.now().toISOString();
      const athlete = await runtime.createAthlete({
        displayName: body.displayName, coachName: body.coachName, tz: body.tz, locale: body.locale, units: body.units,
        isAdmin: code.purpose === 'setup' || code.isAdmin === true,
        consents: { healthData: at, aiDisclosure: at, ageConfirmed18: at },
      });
      await ctx.deps.setupCodes.ensure();
      return issue(athlete.id, reply, body.deviceName);
    });
    setupTail = run.catch(() => undefined);
    return run;
  });
  app.post('/v1/auth/pair', { preHandler: limit }, async (request, reply) => {
    const body = PairRequest.parse(request.body);
    const code = await store.consumePairingCode(normalizeCode(body.code), clock.now().toISOString());
    if (!code || code.purpose !== 'link_device' || !code.athleteId || (await store.getAthlete(code.athleteId))?.status !== 'active') throw unauthorized('Invalid or expired pairing code.');
    return issue(code.athleteId, reply, body.deviceName);
  });
  app.post('/v1/auth/pairing-codes', { preHandler: auth }, async (request) => {
    const athleteId = ctx.athleteId(request);
    const code = pairingCode();
    const expiresAt = new Date(clock.now().getTime() + 10 * 60_000).toISOString();
    await store.createPairingCode({ code, purpose: 'link_device', athleteId, createdBy: athleteId, expiresAt });
    return { code, expiresAt };
  });
  app.post('/v1/auth/logout', { preHandler: auth }, async (request, reply) => {
    await ctx.sessions.revoke(request.auth!.sessionId);
    ctx.sockets.closeSession(request.auth!.sessionId);
    ctx.clearSessionCookie(reply);
    reply.code(204).send();
  });
  app.get('/v1/auth/csrf', { preHandler: auth }, async (request, reply) => {
    const token = request.auth!.via === 'cookie' ? request.cookies[SESSION_COOKIE]! : request.headers.authorization!.replace(/^Bearer\s+/i, '').trim();
    if (request.auth!.via === 'cookie') ctx.setCsrfCookie(reply, token);
    return { token: csrfTokenForSession(token) };
  });
  app.get('/v1/me', { preHandler: auth }, async (request) => {
    const athleteId = ctx.athleteId(request);
    const athlete = (await store.getAthlete(athleteId))!;
    const voice = ctx.deps.callService?.features() ?? { realtime: false, cascaded: false, voiceNotes: false };
    return {
      athlete: { id: athlete.id, displayName: athlete.displayName, isAdmin: athlete.isAdmin }, settings: await store.getSettings(athleteId),
      viewsOrigin: ctx.viewsOrigin, kitUrl: `${ctx.viewsOrigin}/kit/1/kit.js`, vapidPublicKey: ctx.deps.vapidPublicKey,
      features: { voiceNotes: voice.voiceNotes, calls: { realtime: voice.realtime, cascaded: voice.cascaded }, passkeys: true, push: !!ctx.deps.vapidPublicKey, webSearch: ctx.deps.features?.webSearch ?? false },
      harnessVersion: HARNESS_VERSION, demoMode: ctx.deps.features?.demoMode ?? ctx.deps.config.demo,
    };
  });
  app.get('/v1/settings', { preHandler: auth }, async (request) => store.getSettings(ctx.athleteId(request)));
  app.put('/v1/settings', { preHandler: auth }, async (request) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw badRequest('Settings patch must be an object.');
    if ('models' in request.body && !request.auth!.isAdmin) throw forbidden('Model overrides require administrator access.', 'admin_required');
    const profile = (request.body as { profile?: unknown }).profile;
    if (profile && typeof profile === 'object' && 'tz' in profile) IanaTimeZone.parse(profile.tz);
    return runtime.updateSettings(ctx.athleteId(request), request.body);
  });

  const rpID = new URL(ctx.publicOrigin).hostname;
  app.post('/v1/auth/passkey/register/options', { preHandler: auth }, async (request, reply) => {
    const athleteId = ctx.athleteId(request);
    const athlete = (await store.getAthlete(athleteId))!;
    const options = await generateRegistrationOptions({ rpID, rpName: 'OpenCoach', userName: athleteId, userDisplayName: athlete.displayName,
      userID: new TextEncoder().encode(athleteId), attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: (await store.listPasskeys(athleteId)).map((p) => ({ id: p.credentialId, transports: p.transports })),
    });
    remember(reply, options.challenge, 'register', request.auth!.sessionId);
    return options;
  });
  app.post('/v1/auth/passkey/register/verify', { preHandler: auth }, async (request, reply) => {
    const challenge = take(request, reply, 'register');
    let verification;
    try {
      verification = await verifyRegistrationResponse({ response: request.body as RegistrationResponseJSON, expectedChallenge: challenge, expectedOrigin: ctx.publicOrigin, expectedRPID: rpID, requireUserVerification: true });
    } catch { throw unauthorized('Passkey verification failed.'); }
    if (!verification.verified || !verification.registrationInfo) throw unauthorized('Passkey verification failed.');
    const credential = verification.registrationInfo.credential;
    if (await store.getPasskey(credential.id)) throw conflict('This passkey is already registered.');
    await store.addPasskey({ credentialId: credential.id, athleteId: ctx.athleteId(request), publicKey: Buffer.from(credential.publicKey).toString('base64url'), counter: credential.counter, transports: credential.transports, createdAt: clock.now().toISOString() });
    return { verified: true };
  });
  app.post('/v1/auth/passkey/login/options', { preHandler: limit }, async (_request, reply) => {
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    remember(reply, options.challenge, 'login');
    return options;
  });
  app.post('/v1/auth/passkey/login/verify', { preHandler: limit }, async (request, reply) => {
    const challenge = take(request, reply, 'login');
    const response = request.body as AuthenticationResponseJSON;
    if (!response || typeof response.id !== 'string') throw badRequest('Passkey response is required.');
    const record = await store.getPasskey(response.id);
    if (!record || (await store.getAthlete(record.athleteId))?.status !== 'active') throw unauthorized('Passkey verification failed.');
    let verification;
    try {
      verification = await verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin: ctx.publicOrigin, expectedRPID: rpID,
        credential: { id: record.credentialId, publicKey: new Uint8Array(Buffer.from(record.publicKey, 'base64url')), counter: record.counter }, requireUserVerification: true });
    } catch { throw unauthorized('Passkey verification failed.'); }
    if (!verification.verified) throw unauthorized('Passkey verification failed.');
    await store.updatePasskeyCounter(record.credentialId, verification.authenticationInfo.newCounter);
    return issue(record.athleteId, reply);
  });
}

// @vitest-environment node
/** Real gateway/runtime/workspace, scripted coach, and a controlled speech endpoint (no paid APIs). */
import { existsSync, readdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { build } from 'vite';
import { ImageGenerationConfig, athletePaths, silentLogger } from '../../../packages/protocol/src';
import { createImageProvider } from '../../../packages/engine/src/image-generation';
import { composeServer, type ComposedServer } from '../../server/src/compose';
import { loadConfig } from '../../server/src/config';
import { createExecutor } from '../../../packages/runtime/src/executor';
import { openWorkspaceGit } from '../../../packages/workspace/src';
import { createPlaywrightRenderer } from '../../../packages/ui-kit/src';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const webRoot = join(repo, 'apps/web');

function chromiumPath(): string | undefined {
  const candidates = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter((p): p is string => !!p);
  for (const base of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter((p): p is string => !!p)) {
    if (!existsSync(base)) continue;
    for (const dir of readdirSync(base).filter((d) => /^chromium-\d+$/.test(d))) candidates.push(join(base, dir, 'chrome-linux/chrome'), join(base, dir, 'chrome-linux64/chrome'));
  }
  return candidates.find((candidate) => existsSync(candidate));
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

const executablePath = chromiumPath();

describe.skipIf(!executablePath)('PWA against the real composed gateway', () => {
  let server: ComposedServer;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let temp: string;
  let appUrl: string;
  let athleteId: string;
  let speech: HttpServer;
  const speechRequests: Array<{ path: string; type: string; body: Buffer }> = [];
  const browserErrors: string[] = [];
  const diagnosticErrors: string[] = [];

  beforeAll(async () => {
    await mkdir(join(repo, 'work'), { recursive: true });
    temp = await mkdtemp(join(repo, 'work/gateway-e2e-'));
    const dist = join(temp, 'web-dist');
    await build({ root: webRoot, logLevel: 'warn', build: { outDir: dist, emptyOutDir: true } });
    const port = await freePort();
    let viewsPort = await freePort();
    while (viewsPort === port) viewsPort = await freePort();
    // WebAuthn requires a domain RP ID; localhost remains a secure context without TLS.
    appUrl = `http://localhost:${port}`;
    const config = loadConfig({ cwd: temp, env: {
      OPENCOACH_DATA_DIR: join(temp, 'data'), OPENCOACH_DEMO: 'true',
      OPENCOACH_ALLOW_UNSAFE_SANDBOX: 'true', HOST: '127.0.0.1',
      PORT: String(port), VIEWS_PORT: String(viewsPort), PUBLIC_URL: appUrl,
      VIEWS_URL: `http://localhost:${viewsPort}`, LOG_LEVEL: 'error',
    } });
    config.imageGeneration = ImageGenerationConfig.parse({ provider: 'google', model: 'fixture-image', apiKeyEnv: 'FIXTURE_IMAGE_KEY', costPerImageUsd: 0.01 });
    const imageProvider = createImageProvider(config.imageGeneration, { env: { FIXTURE_IMAGE_KEY: 'fixture-only' }, fetch: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgWBUKQhAKABqeA/24RcKwAAAAAElFTkSuQmCC' } }] } }] })) });
    // Per-client auth limits key on the forwarded address, so separate browsers below can look like separate people.
    config.trustProxy = 'loopback';
    config.limits.debounceIdleMs = 10;
    config.limits.debounceMaxMs = 30;
    config.defaultSettings = { notifications: { quietHours: null } };
    // Exercise the real gateway and speech SDK using actual captured audio, without paid transcription.
    speech = createHttpServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      speechRequests.push({ path: request.url ?? '', type: request.headers['content-type'] ?? '', body: Buffer.concat(chunks) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ text: 'Synthetic voice check: I did an easy run today.' }));
    });
    await new Promise<void>((resolve) => speech.listen(0, '127.0.0.1', resolve));
    const speechAddress = speech.address();
    if (!speechAddress || typeof speechAddress === 'string') throw new Error('No speech test port');
    config.voice.stt = { provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${speechAddress.port}/v1`, model: 'test-transcriber' };
    server = await composeServer({ config, logger: silentLogger, webDist: dist, seedRoot: join(repo, 'seed'), renderer: createPlaywrightRenderer({ executablePath }), imageProvider, manualScheduler: true, printSetupCode: () => {} });
    await server.listen();
    browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-GB', timezoneId: 'Europe/Amsterdam', serviceWorkers: 'allow' });
    page = await context.newPage();
    page.on('pageerror', (error) => browserErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') diagnosticErrors.push(message.text()); });
    page.setDefaultTimeout(15_000);
  }, 180_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await server?.close();
    if (speech) await new Promise<void>((resolve, reject) => speech.close((error) => error ? reject(error) : resolve()));
    if (temp) await rm(temp, { recursive: true, force: true });
  });

  afterEach(async ({ task }) => {
    if (task.result?.state !== 'fail' || !page) return;
    console.error('Gateway browser diagnostics', JSON.stringify({ browserErrors, diagnosticErrors, body: (await page.locator('body').innerText()).slice(-1500), frames: await Promise.all(page.frames().filter((frame) => frame !== page.mainFrame()).map(async (frame) => ({ url: frame.url().replace(/\/v\/[^/]+\//, '/v/<token>/'), body: (await frame.locator('body').innerText().catch(() => '')).slice(0, 1000) }))) }));
  });

  it('[SAFE-1] creates the account with consents, loads chat and receives the demo reply through WebSocket', async () => {
    await page.goto(appUrl);
    const create = page.getByRole('button', { name: 'Create my coach' });
    await create.waitFor();
    expect(await create.isDisabled()).toBe(true);
    await page.locator('input[name="setup-code"]').fill((await readFile(join(server.config.dataDir, 'setup-code.txt'), 'utf8')).trim());
    await page.locator('input[name="name"]').fill('Sam Runner');
    await page.locator('input[name="consent-health"]').check();
    await page.locator('input[name="consent-ai"]').check();
    expect(await create.isDisabled()).toBe(true);
    await page.locator('input[name="consent-age"]').check();
    await create.click();
    await page.getByRole('button', { name: 'Skip the rest' }).click();
    athleteId = (await server.store.listAthletes())[0]!.id;
    await server.runtime.tickScheduler();
    await server.runtime.whenIdle(athleteId);
    await page.locator('.msg.coach', { hasText: 'scripted demo coach' }).waitFor();
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    if (process.env.OPENCOACH_CAPTURE_CHAT === '1') {
      await composer.fill('My goal is a comfortable 10k.\nCan we fit training around three days a week?');
      await page.screenshot({ path: join(repo, 'docs/images/demo-chat.png') });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: join(repo, 'docs/images/chat-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await composer.fill('I ran 5k today');
    await composer.press('Enter');
    await page.locator('.msg.me', { hasText: 'I ran 5k today' }).waitFor();
    await page.getByRole('button', { name: '4 · easy', exact: true }).waitFor();
    await page.getByRole('button', { name: '4 · easy', exact: true }).click();
    await page.locator('.msg.coach', { hasText: 'Got it, 4/10' }).waitFor();
    expect((await server.store.listEvents({ athleteId, limit: 100 })).some((event) => event.type === 'user.ui_action')).toBe(true);
    expect((await context.cookies()).some((cookie) => cookie.httpOnly)).toBe(true);
  }, 60_000);

  it('[UI-1] grows and shrinks drafts, survives tab switches/reload and supports mobile newlines', async () => {
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    const height = () => composer.evaluate((el) => el.getBoundingClientRect().height);
    await composer.fill('A short draft');
    const short = await height();
    const draft = 'An easy week\nThree running days\nOne longer run\nHow does that sound?';
    await composer.fill(draft);
    expect(await height()).toBeGreaterThan(short + 40);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Today', exact: true }).click();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Chat', exact: true }).click();
    expect(await composer.inputValue()).toBe(draft);
    expect(await height()).toBeGreaterThan(short + 40);
    await page.reload();
    await composer.waitFor();
    expect(await composer.inputValue()).toBe(draft);
    expect(await height()).toBeGreaterThan(short + 40);
    await composer.fill(Array(30).fill('A line of a very long message').join('\n'));
    expect(await height()).toBeLessThanOrEqual(224);
    expect(await composer.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const send = await page.getByRole('button', { name: 'Send', exact: true }).boundingBox();
      expect(send!.y + send!.height).toBeLessThan(844);
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await page.locator('.composer-box').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgb(255, 255, 255)');
    await page.emulateMedia({ colorScheme: 'light' });
    const wrapped = 'Can we adjust my training this week? I have three days available and would like to keep the long run on Sunday. My legs feel rested after the easy run yesterday, and I have no race planned this month.';
    await composer.fill(wrapped);
    const wideHeight = await height();
    await page.setViewportSize({ width: 320, height: 844 });
    await expect.poll(height).toBeGreaterThan(wideHeight);
    await page.setViewportSize({ width: 1440, height: 844 });
    await expect.poll(height).toBe(wideHeight);
    await page.setViewportSize({ width: 390, height: 844 });
    await composer.fill('');
    expect(await height()).toBe(short);
    expect(await page.evaluate((id) => localStorage.getItem(`oc.draft.${id}`), athleteId)).toBeNull();

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await context.storageState(), serviceWorkers: 'block' });
    try {
      const phone = await mobile.newPage();
      await phone.goto(appUrl);
      const entry = phone.getByRole('textbox', { name: 'Message', exact: true });
      await entry.fill('First line');
      await entry.press('Enter');
      await entry.type('Second line');
      expect(await entry.inputValue()).toBe('First line\nSecond line');
      expect(await phone.locator('.msg.me', { hasText: 'First line' }).count()).toBe(0);
      // Reduced viewport stands in for the space left above a mobile keyboard (not an iOS device test).
      await phone.setViewportSize({ width: 390, height: 440 });
      await expect.poll(() => phone.locator('.composer-box').evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThan(440);
      await phone.getByRole('button', { name: 'Send', exact: true }).click();
      await phone.locator('.msg.me', { hasText: 'First line' }).waitFor();
      expect(await entry.inputValue()).toBe('');
    } finally { await mobile.close(); }
    await server.runtime.whenIdle(athleteId);
  }, 60_000);

  it('[UI-1] captures, plays and explicitly sends voice audio through the actual gateway and speech SDK', async () => {
    const before = (await server.store.listEvents({ athleteId, limit: 100 })).filter((event) => event.type === 'user.voice_note').length;
    await page.getByRole('button', { name: 'Record a voice note' }).click();
    await page.getByRole('button', { name: 'Stop recording' }).waitFor();
    // Need more than the recorder's minimum duration, using Chromium's synthetic audio device.
    await page.waitForTimeout(1400);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await page.getByRole('button', { name: 'Play voice note preview' }).click();
    await page.getByRole('button', { name: 'Pause voice note preview' }).waitFor();
    expect((await server.store.listEvents({ athleteId, limit: 100 })).filter((event) => event.type === 'user.voice_note')).toHaveLength(before);
    expect(speechRequests).toHaveLength(0);
    const uploaded = page.waitForResponse((response) => response.url().endsWith('/v1/voice-notes') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send voice note' }).click();
    expect((await uploaded).status()).toBe(200);
    await server.runtime.whenIdle(athleteId);
    const notes = (await server.store.listEvents({ athleteId, limit: 100 })).filter((event) => event.type === 'user.voice_note');
    expect(notes).toHaveLength(before + 1);
    expect(notes[0]!.payload).toMatchObject({ transcript: 'Synthetic voice check: I did an easy run today.', transcriptModel: 'test-transcriber' });
    expect(notes[0]!.payload.blob.bytes).toBeGreaterThan(1000);
    expect(notes[0]!.payload.durationS).toBeGreaterThanOrEqual(1);
    expect(notes[0]!.payload.durationS).toBeLessThan(30);
    expect(speechRequests[0]!.path).toBe('/v1/audio/transcriptions');
    expect(speechRequests[0]!.type).toContain('multipart/form-data');
    expect(speechRequests[0]!.body.toString()).toContain('test-transcriber');
    expect(speechRequests[0]!.body.length).toBeGreaterThan(1000);
    await page.getByRole('button', { name: 'Transcript', exact: true }).last().click();
    await page.getByText('Synthetic voice check: I did an easy run today.', { exact: true }).waitFor();
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('[SEC-4] rejects missing or wrong session proofs and accepts the XHR upload proof', async () => {
    const before = (await server.store.getSettings(athleteId)).profile.coachName;
    const statuses = await page.evaluate(async () => {
      const body = JSON.stringify({ profile: { coachName: 'Forged write' } });
      const send = (headers: Record<string, string>) => fetch('/v1/settings', { method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json', ...headers }, body }).then((response) => response.status);
      return [await send({}), await send({ 'X-CSRF-Token': 'invalid' })];
    });
    expect(statuses).toEqual([403, 403]);
    expect((await server.store.getSettings(athleteId)).profile.coachName).toBe(before);
    const proof = (await context.cookies()).find((cookie) => cookie.name === 'oc_csrf');
    expect(proof?.httpOnly).toBe(false);
    expect(proof?.value).toMatch(/^[a-f0-9]{64}$/);
    const uploaded = page.waitForResponse((response) => response.url().endsWith('/v1/uploads') && response.request().method() === 'POST');
    await page.locator('input[type="file"][multiple]').setInputFiles({ name: 'session.csv', mimeType: 'text/csv', buffer: Buffer.from('distance_m,duration_s\n5000,1800\n') });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const response = await uploaded;
    expect(response.status()).toBe(200);
    expect(response.request().headers()['x-csrf-token']).toBe(proof!.value);
    await server.runtime.whenIdle(athleteId);
  }, 60_000);

  it('[SEC-3] loads actual isolated seed views, writes through the bridge and refreshes the subscription', async () => {
    const db = new DatabaseSync(join(athletePaths(server.config.dataDir, athleteId).workspace, 'data/coach.db'));
    const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(server.clock.now());
    try {
      db.prepare('INSERT INTO planned_workouts(id,date,type,title,description,target_distance_m,updated_at) VALUES(?,?,?,?,?,?,?)').run('easy', localDate, 'easy', 'Gateway easy run', 'Comfortable effort', 8000, server.clock.now().toISOString());
    } finally { db.close(); }
    const nav = page.getByRole('navigation', { name: 'Main' });
    await nav.getByRole('button', { name: 'Today', exact: true }).click();
    const iframe = page.locator('iframe[title="Today"]');
    await iframe.waitFor();
    expect(await iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(new URL((await iframe.getAttribute('src'))!).origin).toBe(server.config.viewsUrl);
    const frame = page.frameLocator('iframe[title="Today"]');
    await frame.getByRole('heading', { name: 'Gateway easy run' }).waitFor();
    await frame.getByRole('button', { name: 'Mark done', exact: true }).click();
    await frame.getByText('Done', { exact: true }).waitFor();
    const verify = new DatabaseSync(join(athletePaths(server.config.dataDir, athleteId).workspace, 'data/coach.db'), { readOnly: true });
    try { expect(verify.prepare('SELECT status FROM planned_workouts WHERE id=?').get('easy')?.status).toBe('done'); } finally { verify.close(); }
    // Marking done can wake the coach, whose reply refreshes the subscription and rebuilds the card. A click that
    // straddles that rebuild is lost, so let the coach settle first and retry until the app navigates.
    await server.runtime.whenIdle(athleteId);
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    for (let attempt = 0; !page.url().includes('#/chat'); attempt++) {
      if (attempt === 3) throw new Error('Ask coach did not open the chat');
      await frame.getByRole('button', { name: 'Ask coach', exact: true }).click();
      await page.waitForURL(/#\/chat/, { timeout: 3000 }).catch(() => undefined);
    }
    await composer.waitFor();
    expect(await composer.inputValue()).toContain("About today's session (Gateway easy run)");
    await composer.fill('');
  }, 60_000);

  it('[UI-1] shows the athlete plan explanation and denies access to coach working notes', async () => {
    await server.runtime.whenIdle(athleteId);
    const workspace = athletePaths(server.config.dataDir, athleteId).workspace;
    const privateNotes = 'INTERNAL_PLAN_CANARY: reconcile data/coach.db planned_workouts; helper task bookkeeping.';
    const explanation = 'Easy runs build consistency while leaving you fresh for your longer run.';
    await writeFile(join(workspace, 'plan/current.md'), privateNotes);
    await writeFile(join(workspace, 'plan/athlete-summary.md'), explanation);

    await expect(server.runtime.views.readFile(athleteId, 'plan', 'plan/current.md')).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    expect(await server.runtime.views.readFile(athleteId, 'plan', 'plan/athlete-summary.md')).toBe(explanation);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Plan', exact: true }).click();
    const frame = page.frameLocator('iframe[title="Plan"]');
    await frame.getByRole('heading', { name: 'Why this plan', exact: true }).waitFor();
    await frame.getByText(explanation, { exact: true }).waitFor();
    const visible = await frame.locator('body').innerText();
    expect(visible).toContain('Planned weekly training');
    for (const internal of ['INTERNAL_PLAN_CANARY', 'data/coach.db', 'planned_workouts', 'helper task bookkeeping']) expect(visible).not.toContain(internal);

    const updated = 'We have eased this week so you can recover before building again.';
    await writeFile(join(workspace, 'plan/athlete-summary.md'), updated);
    // A delivered coach reply refreshes the published view's declared file subscription.
    const reply = (await server.store.listEvents({ athleteId, limit: 100 })).find((event) => event.type === 'coach.message');
    expect(reply).toBeDefined();
    expect(reply!.payload.delivery).toBe('sent');
    const changed = await server.store.appendEvent({ athleteId, type: 'coach.message', actor: 'coach', payload: { ...reply!.payload, text: 'I have updated your plan explanation.' } });
    server.runtime.core.bus.publish(athleteId, { t: 'message.end', event: changed });
    await frame.getByText(updated, { exact: true }).waitFor();
    expect(await frame.locator('body').innerText()).not.toContain('INTERNAL_PLAN_CANARY');
    expect(browserErrors).toEqual([]);
    // Reading the delivered update clears Chat's unread badge before the next flow.
    await frame.getByRole('button', { name: 'Discuss this plan', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.waitFor();
    expect(await composer.inputValue()).toContain('I have a question about my plan');
    await composer.fill('');
  }, 60_000);

  it('[SAFE-2] displays the harness safety banner, then persists settings through the gateway', async () => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Chat', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('I have chest pain right now');
    await composer.press('Enter');
    await page.getByRole('alert', { name: 'Safety notice' }).waitFor();
    await page.getByRole('button', { name: 'Dismiss for now' }).click();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
    // Account opt-in alone must not present this fresh browser as connected [UI-1].
    expect(await page.getByRole('switch', { name: 'Push notifications', exact: true }).isChecked()).toBe(true);
    await page.getByRole('button', { name: 'Enable on this device', exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Send test notification', exact: true }).count()).toBe(0);
    if (process.env.OPENCOACH_CAPTURE_PUSH === '1') {
      await page.getByRole('button', { name: 'Enable on this device', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(repo, 'work/notifications-phone.png') });
    }
    await page.getByLabel('Units', { exact: true }).selectOption('imperial');
    await expect.poll(async () => (await server.store.getSettings(athleteId)).profile.units).toBe('imperial');
    await page.reload();
    await page.getByLabel('Units', { exact: true }).waitFor();
    expect(await page.getByLabel('Units', { exact: true }).inputValue()).toBe('imperial');
  }, 60_000);

  it('[UI-1] [SEC-4] opts into identity tools and displays a private generated avatar after reload', async () => {
    const nav = page.getByRole('navigation', { name: 'Main' });
    await nav.getByRole('button', { name: 'Settings', exact: true }).click();
    const permission = page.getByRole('switch', { name: 'Let my coach change its name and avatar' });
    expect(await permission.isChecked()).toBe(false);
    await permission.click();
    await expect.poll(async () => (await server.store.getSettings(athleteId)).coachIdentity.allowChanges).toBe(true);
    const executor = createExecutor(server.runtime.core, { athleteId, turnId: 'identity-browser', triggerClass: 'reactive', agent: { kind: 'coach', depth: 0 }, tools: ['generate_image', 'set_preferences'], fs: server.runtime.core.fsFor(athleteId), sandbox: { exec: async () => { throw new Error('No shell'); } }, vision: false });
    const image = await executor.execute({ type: 'tool_call', id: 'generate', name: 'generate_image', input: { prompt: 'A green running mascot icon.' } }, new AbortController().signal);
    expect(image.isError).toBe(false);
    const blob = (await server.store.listBlobs(athleteId)).find(blob => blob.name === 'generated-image.png')!;
    expect(blob).toBeDefined();
    expect((await server.store.getSettings(athleteId)).coachIdentity.avatarSha256).toBeNull();
    const apply = await executor.execute({ type: 'tool_call', id: 'apply', name: 'set_preferences', input: { coach_name: 'Kip', coach_avatar_sha256: blob.sha256 } }, new AbortController().signal);
    expect(apply.isError).toBe(false);
    await nav.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('heading', { name: 'Kip', exact: true }).waitFor();
    const avatar = page.locator('.app-header .avatar img');
    await expect.poll(() => avatar.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(512);
    expect(await avatar.getAttribute('src')).toBe(`/v1/blobs/${blob.sha256}`);
    await page.reload();
    await page.getByRole('heading', { name: 'Kip', exact: true }).waitFor();
    await expect.poll(() => page.locator('.app-header .avatar img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(512);
    const anonymous = await fetch(`${appUrl}/v1/blobs/${blob.sha256}`);
    expect(anonymous.status).toBe(401);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Reset avatar', exact: true }).click();
    await expect.poll(async () => (await server.store.getSettings(athleteId)).coachIdentity.avatarSha256).toBeNull();
    await page.getByRole('switch', { name: 'Let my coach change its name and avatar' }).click();
    await expect.poll(async () => (await server.store.getSettings(athleteId)).coachIdentity.allowChanges).toBe(false);
    const blocked = await executor.execute({ type: 'tool_call', id: 'revoked', name: 'set_preferences', input: { coach_name: 'Changed without permission' } }, new AbortController().signal);
    expect(blocked.isError).toBe(true);
    await server.runtime.updateSettings(athleteId, { profile: { coachName: 'Coach' } });
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('[WS-4] presents local coach history readably and persists maximum message limits [MSG-4]', async () => {
    const workspace = server.runtime.core.paths(athleteId).workspace;
    await mkdir(join(workspace, 'research'), { recursive: true });
    await writeFile(join(workspace, 'research/history-check.md'), 'Synthetic history check.');
    const saved = await openWorkspaceGit(workspace, server.runtime.core.clock).commitAll('Updated research/history-check.md', { Kind: 'turn' });
    expect(saved).not.toBeNull();
    await page.getByRole('button', { name: 'Show changes', exact: true }).click();
    await page.getByText('Your coach was set up', { exact: true }).waitFor();
    const entry = page.locator('.changes .list > li').filter({ hasText: 'Research' }).first();
    expect(await entry.locator('.list-title').innerText()).toBe('Coach saved changes');
    expect(await entry.locator('details').getAttribute('open')).toBeNull();
    expect(await entry.getByText('Updated research/history-check.md', { exact: true }).isVisible()).toBe(false);
    await entry.getByText('Technical details', { exact: true }).click();
    expect(await entry.getByText('Updated research/history-check.md', { exact: true }).isVisible()).toBe(true);
    expect(await entry.innerText()).toContain(`Local Git revision: ${saved!.commit.slice(0, 12)}`);
    await entry.getByText('Technical details', { exact: true }).click();

    const daily = page.getByLabel('Maximum proactive messages per day', { exact: true });
    const weekly = page.getByLabel('Maximum proactive messages per week', { exact: true });
    await daily.fill('0');
    await daily.press('Enter');
    await weekly.fill('2');
    await weekly.press('Enter');
    await expect.poll(async () => {
      const settings = await server.store.getSettings(athleteId);
      return [settings.notifications.proactivePerDay, settings.notifications.proactivePerWeek];
    }).toEqual([0, 2]);
    await page.reload();
    await daily.waitFor();
    expect(await daily.inputValue()).toBe('0');
    expect(await weekly.inputValue()).toBe('2');
    expect(await page.getByText('Only messages your coach starts count. This is a ceiling, not a target. 0 means replies only.', { exact: true }).isVisible()).toBe(true);
    await daily.fill('3');
    await daily.press('Enter');
    await weekly.fill('12');
    await weekly.press('Enter');
    await expect.poll(async () => (await server.store.getSettings(athleteId)).notifications.proactivePerWeek).toBe(12);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('[UI-1] persists language/colors, updates open clients and starter views, and supports Arabic RTL', async () => {
    const requireKit = createRequire(join(repo, 'packages/ui-kit/package.json'));
    const axeSource = await readFile(requireKit.resolve('axe-core/axe.min.js'), 'utf8');
    const audit = async () => {
      await page.evaluate(axeSource);
      const violations = await page.evaluate(`(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.filter(v => ['critical', 'serious'].includes(v.impact)).map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })))()`);
      expect(violations).toEqual([]);
    };
    const nav = () => page.getByRole('navigation', { name: 'Main' });
    await nav().getByRole('button', { name: 'Today', exact: true }).click();
    const today = page.locator('iframe[title="Today"]');
    await today.contentFrame().getByRole('heading', { name: 'Today', exact: true }).waitFor();
    await nav().getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('heading', { name: 'Your coach, your way' }).waitFor();
    await audit();
    if (process.env.OPENCOACH_CAPTURE_SETTINGS === '1') {
      await page.screenshot({ path: join(repo, 'docs/images/settings-phone.png') });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: join(repo, 'docs/images/settings-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await page.getByLabel('App and coach language', { exact: true }).selectOption('nl');
    await page.getByRole('heading', { name: 'Je coach, op jouw manier' }).waitFor();
    await page.getByRole('button', { name: 'Donker', exact: true }).click();
    await page.getByRole('button', { name: 'Kies een kleur #2563eb', exact: true }).click();
    await expect.poll(async () => (await server.store.getSettings(athleteId)).appearance).toEqual({ theme: 'dark', accent: '#2563eb' });
    await page.reload();
    await page.getByLabel('Taal van app en coach', { exact: true }).waitFor();
    expect(await page.getByLabel('Taal van app en coach', { exact: true }).inputValue()).toBe('nl');
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
    const second = await browser.newContext({ storageState: await context.storageState(), viewport: { width: 390, height: 844 } });
    const other = await second.newPage();
    const executor = createExecutor(server.runtime.core, { athleteId, turnId: 'browser-preferences', triggerClass: 'reactive', agent: { kind: 'coach', depth: 0 }, tools: ['set_preferences'], fs: server.runtime.core.fsFor(athleteId), sandbox: { exec: async () => { throw new Error('No shell'); } }, vision: false });
    const change = async (id: string, input: unknown) => {
      const result = await executor.execute({ type: 'tool_call', id, name: 'set_preferences', input }, new AbortController().signal);
      expect(result.isError).toBe(false);
    };
    try {
      await other.goto(appUrl);
      await other.getByRole('navigation', { name: 'Hoofdnavigatie' }).waitFor();
      expect(await other.locator('html').getAttribute('data-theme')).toBe('dark');
      // Re-mount Today after the explicit reload, then keep it mounted while changing preferences.
      await page.getByRole('navigation', { name: 'Hoofdnavigatie' }).getByRole('button', { name: 'Vandaag', exact: true }).click();
      await today.contentFrame().getByRole('heading', { name: 'Vandaag', exact: true }).waitFor();
      const currentSrc = await today.getAttribute('src');
      await change('arabic', { locale: 'ar', theme: 'light', accent: '#047857' });
      await page.getByRole('navigation', { name: 'التنقل الرئيسي' }).waitFor();
      await other.getByRole('navigation', { name: 'التنقل الرئيسي' }).waitFor();
      await today.contentFrame().getByRole('heading', { name: 'اليوم', exact: true }).waitFor();
      expect(await today.getAttribute('src')).toBe(currentSrc);
      expect(await today.contentFrame().locator('html').getAttribute('dir')).toBe('rtl');
      expect(await today.contentFrame().locator('html').getAttribute('lang')).toBe('ar');
      expect(await page.locator('html').getAttribute('dir')).toBe('rtl');
      expect(await other.locator('html').getAttribute('lang')).toBe('ar');
      expect(await other.locator('html').evaluate(el => el.style.getPropertyValue('--rc-accent'))).toBe('#047857');
      await page.getByRole('navigation', { name: 'التنقل الرئيسي' }).getByRole('button', { name: 'الإعدادات', exact: true }).click();
      await page.getByLabel('لغة التطبيق والمدرب', { exact: true }).waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await audit();
      if (process.env.OPENCOACH_CAPTURE_SETTINGS === '1') await page.screenshot({ path: join(repo, 'docs/images/settings-arabic.png') });
      await page.getByLabel('لغة التطبيق والمدرب', { exact: true }).selectOption('en');
      await page.getByRole('heading', { name: 'Your coach, your way' }).waitFor();
      expect(await page.locator('html').getAttribute('dir')).toBe('ltr');
      // Rapid choices must preserve the user's final selection across server responses.
      await page.getByRole('button', { name: 'Dark', exact: true }).click();
      await page.getByRole('button', { name: 'Light', exact: true }).click();
      await page.getByRole('button', { name: 'Dark', exact: true }).click();
      await expect.poll(async () => (await server.store.getSettings(athleteId)).appearance.theme).toBe('dark');
      await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('dark');
    } finally {
      await change('restore', { locale: 'en', theme: 'system', accent: null });
      await page.getByRole('navigation', { name: 'Main' }).waitFor();
      await second.close();
    }
  }, 90_000);

  it('registers a browser passkey and signs back in with a verified assertion', async () => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.getByRole('button', { name: 'Add a passkey', exact: true }).click();
    await page.getByText('Passkey added', { exact: true }).waitFor();
    expect(await server.store.listPasskeys(athleteId)).toHaveLength(1);
    await page.getByRole('button', { name: 'Sign out of this device', exact: true }).click();
    const signIn = page.getByRole('button', { name: 'Sign in with a passkey', exact: true });
    await signIn.waitFor();
    await signIn.click();
    await page.getByRole('button', { name: 'Skip the rest' }).click();
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    const profile = await context.request.get(`${appUrl}/v1/me`);
    expect(profile.status()).toBe(200);
    expect((await profile.json()).athlete.id).toBe(athleteId);
    await cdp.detach();
  }, 60_000);

  it('[MOD-1] [UI-2] publishes a generated workspace PNG in the isolated achievement gallery and persists image controls', async () => {
    const nav = page.getByRole('navigation', { name: 'Main' });
    await nav.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Image generation', { exact: true }).selectOption('automatic');
    await expect.poll(async () => (await server.store.getSettings(athleteId)).images.mode).toBe('automatic');
    const fs = server.runtime.core.fsFor(athleteId);
    const executor = createExecutor(server.runtime.core, { athleteId, turnId: 'image-gallery-browser', triggerClass: 'scheduled', agent: { kind: 'coach', depth: 0 },
      tools: ['generate_image', 'publish_ui'], fs, sandbox: { exec: async () => { throw new Error('No shell'); } }, vision: false });
    const image = await executor.execute({ type: 'tool_call', id: 'gallery-generate', name: 'generate_image', input: { prompt: 'A tiny bronze medal icon.' } }, new AbortController().signal);
    expect(image.isError).toBe(false);
    const blobs = await server.store.listBlobs(athleteId);
    const blob = blobs.find(value => value.name === 'generated-image.png')!;
    const path = `/workspace/exports/images/${blob.sha256}.png`;
    const bytes = await fs.readFile(path);
    expect(JSON.stringify(image.content)).toContain('workspace_path');
    expect(Buffer.from(bytes)).toEqual(Buffer.from(await server.blobs.read(athleteId, blob.sha256)));
    const workspace = athletePaths(server.config.dataDir, athleteId).workspace;
    await cp(join(repo, 'seed/general/system/skills/achievements/examples/view'), join(workspace, 'ui/views/achievements'), { recursive: true });
    await fs.writeFile('ui/views/achievements/assets/medal.png', bytes);
    await fs.writeFile('data/achievements.json', JSON.stringify({ version: 1, achievements: [{ id: 'browser-fixture', title: 'The First Finish', description: 'A synthetic milestone for the browser check.', earned_on: '2026-10-04', image: 'assets/medal.png', source_refs: ['browser-fixture'] }], challenges: [] }));
    const publish = await executor.execute({ type: 'tool_call', id: 'gallery-publish', name: 'publish_ui', input: { views: ['achievements'], summary: 'Added the synthetic achievement gallery' } }, new AbortController().signal);
    expect(publish.isError, JSON.stringify(publish.content)).toBe(false);
    await page.goto(`${appUrl}/#/view/achievements`);
    const gallery = page.frameLocator('iframe[src*="achievements@"]');
    await gallery.getByRole('heading', { name: 'The First Finish' }).waitFor();
    await expect.poll(() => gallery.locator('.medal-image').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(512);
    await nav.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Image generation', { exact: true }).selectOption('off');
    await expect.poll(async () => (await server.store.getSettings(athleteId)).images.mode).toBe('off');
    expect((await executor.execute({ type: 'tool_call', id: 'images-disabled', name: 'generate_image', input: { prompt: 'Another medal' } }, new AbortController().signal)).isError).toBe(true);
    expect(Buffer.from(await fs.readFile(path))).toEqual(Buffer.from(bytes));
    await page.getByLabel('Image generation', { exact: true }).selectOption('requested');
    await expect.poll(async () => (await server.store.getSettings(athleteId)).images.mode).toBe('requested');
    expect(browserErrors).toEqual([]);
  }, 60_000);

  it('[SEC-5] exposes calendar and export downloads, then deletes the account with typed confirmation', async () => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Show subscribe link' }).click();
    const calendar = page.getByRole('textbox', { name: 'Calendar subscribe URL' });
    await calendar.waitFor();
    const feed = await context.request.get(await calendar.inputValue());
    expect(feed.status()).toBe(200);
    expect(feed.headers()['content-type']).toContain('text/calendar');
    expect(await feed.text()).toContain('BEGIN:VCALENDAR');
    await page.getByRole('button', { name: 'Export everything' }).click();
    const download = page.getByRole('link', { name: 'Download', exact: true });
    await download.waitFor();
    const archive = await context.request.get(new URL((await download.getAttribute('href'))!, appUrl).href);
    expect(archive.status()).toBe(200);
    expect(archive.headers()['content-type']).toContain('application/gzip');
    expect((await archive.body()).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    const remove = page.getByRole('button', { name: 'Delete my account and data', exact: true });
    expect(await remove.isDisabled()).toBe(true);
    await page.locator('input[name="confirm-delete"]').fill('DELETE');
    const deletion = page.waitForResponse((response) => response.url().endsWith('/v1/account') && response.request().method() === 'DELETE');
    await remove.click();
    const deleted = await deletion;
    expect(deleted.status(), deleted.status() === 204 ? undefined : await deleted.text().catch(() => 'No response body')).toBe(204);
    expect(await server.store.getAthlete(athleteId)).toBeUndefined();
    await page.getByRole('button', { name: 'Create my coach' }).waitFor();
    expect(existsSync(athletePaths(server.config.dataDir, athleteId).workspace)).toBe(false);
    expect(browserErrors).toEqual([]);
  }, 60_000);
  it('[SEC-4] lets an invited person join from the sign-in screen, by code or by invite link', async () => {
    const join = async (url: string, name: string, ip: string, code?: string) => {
      const invited = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-GB', timezoneId: 'Europe/Amsterdam', extraHTTPHeaders: { 'X-Forwarded-For': ip } });
      const p = await invited.newPage();
      try {
        p.on('pageerror', (e) => console.error('invite page error', e.message));
        await p.goto(url);
        if (code) {
          await p.getByRole('button', { name: 'I have an invite code' }).click();
          await p.locator('input[name="setup-code"]').fill(code);
        } else {
          expect(await p.locator('input[name="setup-code"]').inputValue()).not.toBe('');
        }
        await p.getByText('Join with your invite').waitFor();
        await p.locator('input[name="name"]').fill(name);
        for (const n of ['consent-health', 'consent-ai', 'consent-age']) await p.locator(`input[name="${n}"]`).check();
        await p.getByRole('button', { name: 'Create my coach' }).click();
        const outcome = await Promise.race([
          p.getByRole('button', { name: 'Skip the rest' }).waitFor().then(() => 'ok'),
          p.getByRole('alert').waitFor().then(async () => `error: ${await p.getByRole('alert').innerText()}`),
        ]);
        expect(outcome).toBe('ok');
        await p.getByRole('button', { name: 'Skip the rest' }).click();
        await p.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
        expect(new URL(p.url()).search).toBe('');
      } finally {
        await invited.close();
      }
    };
    if (!(await server.store.hasAnyAthlete())) await server.runtime.createAthlete({ displayName: 'Admin', tz: 'UTC', locale: 'en', isAdmin: true });
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await server.store.createPairingCode({ code: 'INVT-CODE', purpose: 'invite', expiresAt });
    await server.store.createPairingCode({ code: 'INVT-LINK', purpose: 'invite', expiresAt });
    await join(appUrl, 'Mom', '203.0.113.10', 'INVT-CODE');
    await join(`${appUrl}/?invite=INVT-LINK`, 'Sis', '203.0.113.11');
    const names = (await server.store.listAthletes()).map((a) => a.displayName);
    expect(names).toEqual(expect.arrayContaining(['Mom', 'Sis']));
    expect((await server.store.listAthletes()).filter((a) => a.isAdmin)).toHaveLength(1);
  }, 120_000);
});

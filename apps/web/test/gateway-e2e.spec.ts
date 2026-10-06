// @vitest-environment node
/** Real gateway + runtime + workspace + scripted model smoke; no mocked HTTP routes or model calls. */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { build } from 'vite';
import { athletePaths, silentLogger } from '../../../packages/protocol/src';
import { composeServer, type ComposedServer } from '../../server/src/compose';
import { loadConfig } from '../../server/src/config';

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
    config.limits.debounceIdleMs = 10;
    config.limits.debounceMaxMs = 30;
    config.defaultSettings = { notifications: { quietHours: null } };
    server = await composeServer({ config, logger: silentLogger, webDist: dist, seedRoot: join(repo, 'seed'), renderer: false, manualScheduler: true, printSetupCode: () => {} });
    await server.listen();
    browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
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
    await composer.fill('I ran 5k today');
    await composer.press('Enter');
    await page.locator('.msg.me', { hasText: 'I ran 5k today' }).waitFor();
    await page.getByRole('button', { name: '4 · easy', exact: true }).waitFor();
    await page.getByRole('button', { name: '4 · easy', exact: true }).click();
    await page.locator('.msg.coach', { hasText: 'Got it, 4/10' }).waitFor();
    expect((await server.store.listEvents({ athleteId, limit: 100 })).some((event) => event.type === 'user.ui_action')).toBe(true);
    expect((await context.cookies()).some((cookie) => cookie.httpOnly)).toBe(true);
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
    await frame.getByRole('button', { name: 'Ask coach', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.waitFor();
    expect(await composer.inputValue()).toContain("About today's Gateway easy run");
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
    await page.getByLabel('Units', { exact: true }).selectOption('imperial');
    await expect.poll(async () => (await server.store.getSettings(athleteId)).profile.units).toBe('imperial');
    await page.reload();
    await page.getByLabel('Units', { exact: true }).waitFor();
    expect(await page.getByLabel('Units', { exact: true }).inputValue()).toBe('imperial');
  }, 60_000);

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
    await remove.click();
    await page.getByRole('button', { name: 'Create my coach' }).waitFor();
    expect(await server.store.getAthlete(athleteId)).toBeUndefined();
    expect(existsSync(athletePaths(server.config.dataDir, athleteId).workspace)).toBe(false);
    expect(browserErrors).toEqual([]);
  }, 60_000);
});

// @vitest-environment node
/**
 * Playwright smoke test (playwright-core + the locally installed Chromium). It builds the PWA, starts the mock
 * gateway and `vite preview` (with the /v1 + WebSocket proxy), then drives the real UI: setup, chat with a streamed
 * reply, quick reply, the view tab (sandboxed iframe + bridge), last-known-good fallback, safety banner, offline queue,
 * settings, and (with Chromium's fake media devices) a voice note and a cascaded call.
 * Skips cleanly when Chromium is not available.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { build, preview, type PreviewServer } from 'vite';
import { startMockServer, type MockServer } from '../dev/mock-server';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function findChromium(): string | undefined {
  const candidates: string[] = [];
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) candidates.push(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
  candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser');
  const bases = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter((b): b is string => !!b);
  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const dir of readdirSync(base).filter((d) => /^chromium-\d+$/.test(d))) candidates.push(join(base, dir, 'chrome-linux', 'chrome'), join(base, dir, 'chrome-linux64', 'chrome'));
    for (const dir of readdirSync(base).filter((d) => /^chromium_headless_shell-\d+$/.test(d))) candidates.push(join(base, dir, 'chrome-linux', 'headless_shell'));
  }
  return candidates.find((c) => existsSync(c));
}

const chromePath = findChromium();
const T = 60_000;

describe.skipIf(!chromePath)('web e2e smoke (Chromium)', () => {
  let mock: MockServer;
  let server: PreviewServer;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let appUrl: string;

  beforeAll(async () => {
    mock = await startMockServer({ port: 0, viewsPort: 0, quiet: true, speed: 1, seedHistory: 0 });
    process.env.OPENCOACH_GATEWAY = mock.url;
    const outDir = resolve(root, '.vite/e2e-dist');
    await build({ root, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
    const proxy = { '/v1': { target: mock.url, ws: true }, '/admin': { target: mock.url } };
    server = await preview({ root, logLevel: 'warn', build: { outDir }, preview: { port: 0, host: '127.0.0.1', open: false, proxy } });
    const addr = server.httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('preview server has no port');
    appUrl = `http://127.0.0.1:${addr.port}`;
    browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    });
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: false, permissions: ['microphone'], serviceWorkers: 'allow' });
    page = await context.newPage();
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  }, 180_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await new Promise<void>((r) => (server ? server.httpServer.close(() => r()) : r()));
    await mock?.close();
  });

  const composer = () => page.getByRole('textbox', { name: 'Message', exact: true });
  const nav = () => page.getByRole('navigation', { name: 'Main' });

  it('completes setup and lands in chat with a streamed greeting', async () => {
    await page.goto(appUrl);
    await page.getByRole('button', { name: 'Create my coach' }).waitFor();
    const create = page.getByRole('button', { name: 'Create my coach' });
    expect(await create.isDisabled()).toBe(true); // consents are required
    await page.locator('input[name="setup-code"]').fill(mock.setupCode);
    await page.locator('input[name="name"]').fill('Maya Runner');
    await page.locator('input[name="consent-health"]').check();
    await page.locator('input[name="consent-ai"]').check();
    expect(await create.isDisabled()).toBe(true); // 18+ still missing
    await page.locator('input[name="consent-age"]').check();
    await create.click();

    await page.getByRole('button', { name: 'Skip the rest' }).click();
    await page.getByText(/Hi Maya! I'm Coach/).waitFor({ timeout: 15_000 });
    expect(await nav().getByRole('button').first().innerText()).toMatch(/Chat/);
    expect(mock.state.log.deviceContext.length).toBeGreaterThan(0);
  }, T);

  it('sends a message, streams the reply into a provisional bubble, and shows quick replies', async () => {
    await composer().fill('Hello coach');
    await composer().press('Enter');
    await page.locator('.msg.me', { hasText: 'Hello coach' }).waitFor();
    await page.locator('.msg.coach.provisional').waitFor({ timeout: 10_000 }); // streaming bubble
    await page.locator('.msg.coach:not(.provisional)', { hasText: "How did today's run feel?" }).waitFor({ timeout: 15_000 });
    expect(await page.locator('.msg.coach.provisional').count()).toBe(0); // replaced by the final event
    // markdown rendered + link opens in a new tab safely
    const link = page.getByRole('link', { name: 'Training log' });
    expect(await link.getAttribute('target')).toBe('_blank');
    expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
    await page.getByRole('button', { name: 'Moderate' }).waitFor();
  }, T);

  it('taps a quick reply: it is sent as a ui-action, disabled, and the chosen chip is shown', async () => {
    await page.getByRole('button', { name: 'Moderate' }).click();
    await page.locator('.chip.chosen', { hasText: 'Moderate' }).waitFor();
    expect(await page.getByRole('button', { name: 'Hard' }).isDisabled()).toBe(true);
    expect(await page.getByRole('button', { name: 'Easy' }).isDisabled()).toBe(true);
    await page.locator('.msg.coach', { hasText: 'Got it: Moderate' }).waitFor({ timeout: 15_000 });
    const action = mock.state.log.uiActions.at(-1) as { source: { messageId: string }; action: string; payload: unknown; wake: boolean };
    expect(action).toMatchObject({ action: 'quick_reply', payload: { value: 'moderate', label: 'Moderate' }, wake: true });
    expect(action.source.messageId).toMatch(/^evt_/);
    // the answer survives a reload (derived from the user.ui_action event in history)
    await page.reload();
    await page.locator('.chip.chosen', { hasText: 'Moderate' }).waitFor();
  }, T);

  it('renders a form with a scale slider and submits form_submit values', async () => {
    await composer().fill('rpe survey please');
    await composer().press('Enter');
    await page.getByText('Session check-in').waitFor({ timeout: 15_000 });
    const submit = page.locator('.form-card').last().getByRole('button', { name: 'Send' });
    expect(await submit.isDisabled()).toBe(true); // nothing answered yet
    const slider = page.locator('.form-card').last().locator('input[type="range"]').first();
    await slider.focus();
    await slider.press('ArrowRight');
    await page.locator('.form-card').last().getByText('Heavy').click();
    await page.locator('.form-card').last().getByLabel('Distance').fill('12,5');
    await submit.click();
    await page.locator('.form-card.done').waitFor();
    const last = mock.state.log.uiActions.at(-1) as { action: string; payload: { form_id: string; values: Record<string, unknown> } };
    expect(last.action).toBe('form_submit');
    expect(last.payload.form_id).toBe('rpe_form');
    expect(last.payload.values).toMatchObject({ felt: 'heavy', km: 12.5 });
    expect(typeof last.payload.values.rpe).toBe('number');
    expect(last.payload.values.note).toBeUndefined();
  }, T);

  it('opens the view tab: sandboxed iframe renders and the bridge works both ways', async () => {
    await nav().getByRole('button', { name: 'Today' }).click();
    const frameEl = page.locator('iframe[title="Today"]');
    await frameEl.waitFor();
    expect(await frameEl.getAttribute('sandbox')).toBe('allow-scripts'); // never allow-same-origin
    const frame = page.frameLocator('iframe[title="Today"]');
    await frame.getByRole('heading', { name: 'Today' }).waitFor({ timeout: 15_000 });
    await frame.getByText('Easy 8 km').waitFor(); // db.query through the bridge → gateway
    await frame.getByText(/theme (light|dark)/).waitFor(); // ready → ViewEnv
    // db.write → gateway; the workspace-change fan-out then makes the view re-query (subscribe → changed)
    await frame.getByRole('button', { name: 'Mark easy run done' }).click();
    await frame.locator('li', { hasText: 'Easy 8 km' }).getByText('done').waitFor({ timeout: 10_000 });
    expect(mock.state.checkins).toHaveLength(1);
    expect(mock.state.log.viewActs).toHaveLength(1);
    await page.locator('.toast').getByText('Saved', { exact: true }).waitFor(); // coach.toast → shell toast
    // openChat → back to chat with the composer prefilled
    await frame.getByRole('button', { name: 'Ask coach' }).click();
    await composer().waitFor();
    expect(await composer().inputValue()).toContain('About today:');
    await composer().fill('');
  }, T);

  it('falls back to the previous version when a new one breaks before ready, and tells the coach', async () => {
    await nav().getByRole('button', { name: 'Today' }).click();
    await page.frameLocator('iframe[title="Today"]').getByText('version 1').waitFor();
    const res = await fetch(`${mock.url}/__mock/publish`, { method: 'POST', body: JSON.stringify({ broken: true, summary: 'Broken on purpose' }) });
    expect((await res.json()).version).toBe(2);
    await page.getByText(/Updated by your coach: Broken on purpose/).waitFor({ timeout: 10_000 });
    await page.getByText(/Showing the previous version of Today/).waitFor({ timeout: 15_000 });
    await page.frameLocator('iframe[title="Today"]').getByText('version 1').waitFor();
    await expect.poll(() => mock.state.log.viewErrors.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(mock.state.log.viewErrors[0]).toMatchObject({ version: '2' });
  }, T);

  it('shows the harness safety banner for a safety stream message and lets the athlete dismiss it for now', async () => {
    await nav().getByRole('button', { name: 'Chat' }).click();
    await composer().fill('I felt chest tightness on the intervals');
    await composer().press('Enter');
    const banner = page.getByRole('alert', { name: 'Safety notice' });
    await banner.waitFor({ timeout: 15_000 });
    expect(await banner.innerText()).toMatch(/emergency number/i);
    await banner.getByRole('button', { name: 'Dismiss for now' }).click();
    await banner.waitFor({ state: 'detached' });
    await page.locator('.msg.coach', { hasText: 'Stop any running' }).waitFor({ timeout: 15_000 });
  }, T);

  it('queues messages while offline and delivers them on reconnect', async () => {
    await nav().getByRole('button', { name: 'Chat' }).click();
    await context.setOffline(true);
    await page.getByText(/You're offline/).first().waitFor();
    await composer().fill('sent while offline');
    await composer().press('Enter');
    await page.locator('.msg.pending.queued', { hasText: 'sent while offline' }).waitFor();
    await page.getByText(/Waiting for connection/).waitFor();
    await context.setOffline(false);
    await page.locator('.msg.me:not(.pending)', { hasText: 'sent while offline' }).waitFor({ timeout: 20_000 });
    expect(await page.locator('.msg.pending').count()).toBe(0);
    await page.locator('.msg.coach', { hasText: "How did today's run feel?" }).last().waitFor({ timeout: 15_000 });
  }, T);

  it('settings: edits auto-save through PUT /v1/settings and the coach name updates the header', async () => {
    await nav().getByRole('button', { name: 'Settings' }).click();
    const coachName = page.getByLabel('Coach name');
    await coachName.fill('Mara');
    await coachName.press('Enter');
    await page.getByText('Saved', { exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Settings' }).waitFor();
    const daily = page.getByLabel('Maximum proactive messages per day');
    await daily.fill('1');
    await daily.press('Enter');
    await expect
      .poll(async () => (await (await context.request.get(`${appUrl}/v1/settings`)).json()).notifications.proactivePerDay)
      .toBe(1);
    expect((await (await context.request.get(`${appUrl}/v1/settings`)).json()).profile.coachName).toBe('Mara');
    await nav().getByRole('button', { name: 'Chat' }).click();
    await page.getByRole('heading', { name: 'Mara' }).waitFor();
    // admin + about sections are present for the admin athlete
    await nav().getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('heading', { name: 'Admin' }).waitFor();
    await page.getByRole('heading', { name: 'About' }).waitFor();
    await page.getByText(/Demo mode/).waitFor();
  }, T);

  it('[UI-1] records, reviews and explicitly sends a voice note (fake microphone)', async () => {
    await nav().getByRole('button', { name: 'Chat' }).click();
    await page.getByRole('button', { name: 'Record a voice note' }).click();
    await page.getByRole('button', { name: 'Stop recording' }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await page.getByRole('button', { name: 'Play voice note preview' }).waitFor();
    await page.getByRole('button', { name: 'Send voice note' }).click();
    await page.locator('.msg.me.voice, .msg.me:has(.bubble.voice)').first().waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Transcript' }).last().click();
    await page.getByText('This is a mock transcript of your voice note.').waitFor();
  }, T);

  it('runs a cascaded call: push-to-talk → transcript + reply, then ends', async () => {
    await page.getByRole('button', { name: /^Call / }).click();
    const talk = page.getByRole('button', { name: /Hold to talk/ });
    await talk.waitFor({ timeout: 15_000 });
    const box = (await talk.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(1500);
    await page.mouse.up();
    await page.getByText('I did an easy run today.').waitFor({ timeout: 15_000 });
    await page.getByText(/Keep tomorrow easy/).waitFor();
    await page.locator('.call-controls').getByRole('button', { name: 'End', exact: true }).click();
    await composer().waitFor();
    await page.getByText(/Call ended/).waitFor({ timeout: 10_000 });
  }, T);

  it('signs out and shows the sign-in screen; deleting the account returns to setup', async () => {
    await nav().getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Sign out of this device' }).click();
    await page.getByRole('button', { name: 'Pair this device' }).waitFor();
    // pair again with a code
    await page.locator('input[name="pairing-code"]').fill('PAIR-1234');
    await page.getByRole('button', { name: 'Pair this device' }).click();
    await page.getByRole('button', { name: 'Skip the rest' }).click();
    await nav().getByRole('button', { name: 'Settings' }).click();
    const del = page.getByRole('button', { name: 'Delete my account and data' });
    expect(await del.isDisabled()).toBe(true);
    await page.locator('input[name="confirm-delete"]').fill('DELETE');
    await del.click();
    await page.getByRole('button', { name: 'Create my coach' }).waitFor({ timeout: 15_000 });
  }, T);
});

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window as HappyWindow } from 'happy-dom';

const example = fileURLToPath(new URL('../../../seed/general/system/skills/achievements/examples/view/', import.meta.url));
const windows: HappyWindow[] = [];
afterEach(async () => { await Promise.all(windows.splice(0).map(win => win.happyDOM.abort())); });
const empty = { version: 1, achievements: [], challenges: [] };
const earned = {
  id: 'first', title: 'The First Finish', description: 'Your first race, after months preparing.',
  earned_on: '2026-10-04', basis: 'Result you reported', source_refs: ['evt_private_source'], symbol: '5K',
};
const agreed = { id: 'challenge', title: 'Finding a rhythm', criteria: 'Three chosen sessions, no catch-up.', status: 'active', accepted_on: '2026-10-01' };

async function render(ledger: unknown = empty, mode = 'live') {
  const win = new HappyWindow({ settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  windows.push(win);
  win.document.write(await readFile(`${example}index.html`, 'utf8'));
  let current = JSON.stringify(ledger);
  let changed: () => Promise<void> | void = () => {};
  let renderWork: Promise<unknown> = Promise.resolve();
  const coach = {
    ready: Promise.resolve(), env: { locale: 'en-GB', tz: 'Pacific/Honolulu', mode },
    files: { read: vi.fn(async (_path: string) => current) },
    subscribe: vi.fn((_targets: string[], callback: () => Promise<void> | void) => { changed = callback; }),
    onEnv: vi.fn(), track: <T>(promise: Promise<T>) => { renderWork = promise; return promise; },
    openChat: vi.fn(async (_input: unknown) => {}), report: vi.fn(async () => {}),
  };
  const code = (await readFile(`${example}view.js`, 'utf8')).replace(/^import[^\n]+\n/, '');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<void>;
  await new AsyncFunction('coach', 'document', code)(coach, win.document);
  const node = (id: string) => win.document.getElementById(id)! as unknown as HTMLElement;
  return { win, coach, node, async update(value: unknown) { current = JSON.stringify(value); changed(); await renderWork; } };
}

describe('[UI-2] [WS-8] optional coach-owned achievement gallery', () => {
  it('keeps an empty collection calm and offers no award/completion writes', async () => {
    const { node, coach, win } = await render();
    expect(node('loading').hidden).toBe(true);
    expect(node('empty').hidden).toBe(false);
    expect(node('error').hidden).toBe(true);
    expect(node('challenges-section').hidden).toBe(true);
    expect(coach.subscribe).toHaveBeenCalledWith(['file:data/achievements.json'], expect.any(Function));
    expect(win.document.querySelectorAll('#earned article')).toHaveLength(0);
    expect([...win.document.querySelectorAll('button')].map(button => button.textContent).join(' ')).not.toMatch(/award|claim|complete|unlock/i);
  });

  it('shows earned moments with the actual local date and safe text independently of artwork', async () => {
    const injected = { ...earned, title: '<img src=x onerror=alert(1)>', description: '<script>bad()</script>', image: 'https://example.invalid/medal.png' };
    const { win, node } = await render({ ...empty, achievements: [injected] });
    expect(node('earned').textContent).toContain(injected.title);
    expect(node('earned').textContent).toContain(injected.description);
    expect(node('earned').textContent).toContain('4 Oct 2026');
    expect(node('earned').textContent).not.toContain('evt_private_source');
    expect(win.document.querySelectorAll('#earned img, #earned script')).toHaveLength(0);
    expect(win.document.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-04');
  });

  it('updates a mounted gallery from its file subscription, and retains usable data after a bad refresh', async () => {
    const page = await render({ ...empty, achievements: [earned] });
    await page.update({ ...empty, achievements: [earned, { ...earned, id: 'second', title: 'A second milestone', earned_on: '2026-10-05' }] });
    expect(page.win.document.querySelectorAll('#earned article')).toHaveLength(2);
    for (const broken of [{ version: 1, achievements: null, challenges: [] }, { ...empty, achievements: [{ ...earned, earned_on: '2026-02-30' }] }, { ...empty, achievements: [earned, earned] }]) {
      await page.update(broken);
      expect(page.node('error').hidden).toBe(false);
      expect(page.win.document.querySelectorAll('#earned article')).toHaveLength(2);
      expect(page.node('error').textContent).not.toMatch(/JSON|source_refs|evt_/);
    }
    await page.update(empty);
    expect(page.node('error').hidden).toBe(true);
    expect(page.node('empty').hidden).toBe(false);
  });

  it('discusses proposed and paused challenges through chat, with no direct completion action', async () => {
    const { win, node, coach } = await render({ ...empty, challenges: [
      { ...agreed, status: 'proposed', accepted_on: undefined },
      { ...agreed, id: 'paused', status: 'paused', change_note: 'Paused for travel; no debt.' },
      { ...agreed, id: 'past', status: 'retired' },
    ] });
    expect(node('challenges').textContent).toContain('Proposed · not agreed yet');
    expect(node('challenges').textContent).toContain('Paused for travel; no debt.');
    expect(node('past').hidden).toBe(false);
    (win.document.querySelector('#challenges button') as unknown as HTMLElement).click();
    expect(coach.openChat).toHaveBeenCalledWith({ prefill: 'I’d like to discuss the challenge “Finding a rhythm”.', ref: { viewId: 'achievements' } });
    expect(node('earned').children).toHaveLength(0);
  });

  it('falls back to the local medal when a bundled image fails', async () => {
    const { win } = await render({ ...empty, achievements: [{ ...earned, image: 'assets/missing.png' }] });
    const image = win.document.querySelector('#earned img');
    // A failed cached image can also fire while the card is still detached.
    image?.dispatchEvent(new win.Event('error'));
    expect(win.document.querySelector('#earned img')).toBeNull();
    expect(win.document.querySelector('#earned .medal')?.textContent).toBe('5K');
  });

  it('does not let an old asynchronous refresh overwrite a newer collection', async () => {
    const page = await render(empty);
    let old!: (contents: string) => void;
    page.coach.files.read.mockImplementationOnce(() => new Promise(resolve => { old = resolve; }));
    const slow = page.update({ ...empty, achievements: [earned] });
    await page.update({ ...empty, achievements: [{ ...earned, id: 'new', title: 'Newest record' }] });
    old(JSON.stringify({ ...empty, achievements: [earned] }));
    await slow;
    expect(page.node('earned').textContent).toContain('Newest record');
    expect(page.node('earned').textContent).not.toContain('The First Finish');
  });
});

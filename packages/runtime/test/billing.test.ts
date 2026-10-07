import { afterEach, describe, expect, it } from 'vitest';
import { ZERO_USAGE } from '@opencoach/protocol';
import { makeHarness, send, type Harness } from './harness';

let h: Harness;
afterEach(async () => { await h?.close(); });
const athlete = { displayName: 'Mo', tz: 'Europe/Amsterdam', locale: 'en', isAdmin: false };

async function spend(id: string, usd: number) {
  await h.runtime.core.store.recordUsage({ athleteId: id, at: h.clock.now().toISOString(), provider: 'scripted', model: 'scripted-coach', kind: 'turn', usage: { ...ZERO_USAGE }, costUsd: usd });
}

describe('[COST-1] managed allowance vs bring-your-own-key budgets', () => {
  it('a managed athlete over the monthly allowance gets a notice and no model call', async () => {
    h = await makeHarness({ billing: () => 'managed' });
    const { id } = await h.runtime.createAthlete(athlete);
    await h.runtime.updateSettings(id, { budgets: { dailyUsd: 5, monthlyUsd: 1 } });
    await spend(id, 1.5);
    h.setHandler(() => send('should not run'));
    const before = h.requests.length;
    await h.runtime.ingest(id, { type: 'user.message', payload: { text: 'How was my run?' } });
    await h.settle(id);
    expect(h.requests.length).toBe(before);
    const notices = await h.events(id, ['harness.notice']);
    expect(notices.map((n) => (n.payload as { kind: string }).kind)).toContain('allowance_exhausted');
  });

  it('a bring-your-own-key athlete over budget still gets replies on the fast tier', async () => {
    h = await makeHarness({ billing: () => 'byok' });
    const { id } = await h.runtime.createAthlete(athlete);
    await h.runtime.updateSettings(id, { budgets: { dailyUsd: 5, monthlyUsd: 1 } });
    await spend(id, 1.5);
    h.setHandler(() => send('Nice run!'));
    await h.runtime.ingest(id, { type: 'user.message', payload: { text: 'How was my run?' } });
    await h.settle(id);
    expect(h.requests.at(-1)?.model).toBe('scripted-fast');
    expect((await h.events(id, ['coach.message'])).length).toBeGreaterThan(0);
  });
});

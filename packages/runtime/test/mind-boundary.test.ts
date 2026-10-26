import { describe, expect, it } from 'vitest';
import { AthleteMind } from '../src/mind';
import type { Core } from '../src/core';

describe('serialized workspace handoffs [RT-1] [SUB-5]', () => {
  it('applies idle work once without needing a model turn or tool boundary', async () => {
    const mind = new AthleteMind({} as Core, 'ath_boundary', async () => {});
    let applied = 0;
    await mind.atToolBoundary(async () => { applied++; });
    await mind.runExclusive(async () => { await mind.flushBoundaryWork(); });
    expect(applied).toBe(1);
  });

  it('rejects a failed handoff without blocking later handoffs or the mind lock', async () => {
    const mind = new AthleteMind({} as Core, 'ath_boundary', async () => {});
    await expect(mind.atToolBoundary(async () => { throw new Error('copy-back failed'); })).rejects.toThrow('copy-back failed');
    let applied = false;
    await mind.atToolBoundary(async () => { applied = true; });
    await mind.runExclusive(async () => { await mind.flushBoundaryWork(); });
    expect(applied).toBe(true);
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chromiumAvailable, createPlaywrightRenderer } from '@opencoach/ui-kit';
import type { Clock } from '@opencoach/protocol';
import { createReferenceCoach } from '../src/coaches';
import { createVo2maxControl } from '../src/vo2max-controls';
import { runScenario } from '../src/runner';
import { Assertion, Scenario } from '../src/scenarios';
import { gradeDb, gradeFile, gradeTrace, gradeUiUnchanged } from '../src/graders';
import { getSuite } from '../src/suites';
import { vo2maxScenarios, vo2maxUiScenarios } from '../src/vo2max-scenarios';

const dirs: string[] = [];
async function temporary() { const dir = await mkdtemp(join(tmpdir(), 'vo2max-eval-')); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('[EV-1, WS-8] VO2max evidence controls', () => {
  it('versions both suites and rejects invalid numeric ranges', () => {
    expect(getSuite('vo2max')).toHaveLength(7);
    expect(getSuite('vo2max-ui')).toHaveLength(1);
    expect(getSuite('all').some(s => s.id === 'vo2max-widget-continuity')).toBe(true);
    expect(Assertion.safeParse({ id: 'bad-range', kind: 'db', requirement: 'EV-1', numeric: [60, 40] }).success).toBe(false);
  });
  for (const scenario of vo2maxScenarios) it(`passes runtime-backed reference ${scenario.id}`, async () => {
    const trace = await runScenario(scenario, { traceDir: await temporary() });
    expect(trace.graders.filter(g => g.gate && g.status !== 'pass')).toEqual([]);
    expect(trace.graders.find(g => g.id === 'scientific-honesty')?.status).toBe('not_run');
  }, 60_000);
  it('rejects a number in the wrong row, duplicates, strings, wrong units and missing saved method', async () => {
    const scenario = vo2maxScenarios[0]!;
    const trace = await runScenario(scenario, { traceDir: await temporary() });
    const check = scenario.assertions.find(a => a.id === 'metric-0')!;
    const row = trace.snapshots[0]!.db.tables.metrics![0]!;
    row.date = '2026-10-06'; expect(gradeDb(trace, check).status).toBe('fail');
    row.date = '2026-10-07'; row.value = '42.4'; expect(gradeDb(trace, check).status).toBe('fail');
    row.value = 424; expect(gradeDb(trace, check).status).toBe('fail');
    row.value = 42.36754; row.unit = 'L/min';
    expect(gradeDb(trace, scenario.assertions.find(a => a.id === 'units-0')!).status).toBe('fail');
    trace.snapshots[0]!.db.tables.metrics!.push({ ...row, source: 'duplicate' });
    expect(gradeDb(trace, check).status).toBe('fail');
    trace.snapshots[0]!.files!['athlete/vo2max.md'] = null;
    expect(gradeFile(trace, scenario.assertions.find(a => a.id === 'method-0')!).status).toBe('fail');
    const noRpe = scenario.assertions.find(a => a.id === 'no-invented-rpe-0')!;
    expect(gradeDb(trace, noRpe).status).toBe('pass'); // Coach need not create an activity.
    trace.snapshots[0]!.db.tables.activities!.push({ id: 'derived-run', rpe: 9, avg_hr: null, max_hr: null });
    expect(gradeDb(trace, noRpe).status).toBe('fail');
    trace.snapshots[0]!.db.tables.activities![0]!.rpe = null;
    expect(gradeDb(trace, noRpe).status).toBe('pass');
    const turn = trace.events.find(e => e.type === 'coach.turn' && e.payload.triggerEventIds.includes(trace.actions[0]!.eventId!))!;
    trace.changes.push({ at: turn.ts, commit: 'control', turnId: turn.turnId, summary: 'Unrequested widget', files: ['ui/views/vo2max/view.js'], kind: 'turn' });
    expect(gradeUiUnchanged(trace, scenario.assertions.find(a => a.id === 'optional-ui')!).status).toBe('fail');
  }, 60_000);
  it('does not count an unsaved/private number or absent browser evidence as a pass', async () => {
    const negative = await runScenario(vo2maxScenarios[0]!, { model: 'bad', traceDir: await temporary() });
    expect(negative.graders.some(g => g.gate && g.status === 'fail')).toBe(true);
    negative.scenario = Scenario.parse({ ...negative.scenario, assertions: [{ id: 'widget', kind: 'view', requirement: 'UI-1', action: 0, viewId: 'vo2max' }] });
    expect(gradeTrace(negative)[0]!.status).toBe('not_run');
  }, 60_000);
});

describe.skipIf(!chromiumAvailable())('[EV-1, UI-1] published VO2max widget in Chromium', () => {
  for (const mode of ['live', 'frozen', 'unsubscribed'] as const) it(`checks ${mode} widget across new data, correction, older data and duplicate`, async () => {
    let renderClock: Clock | undefined;
    const reference = createReferenceCoach();
    const control = createVo2maxControl(mode);
    const trace = await runScenario(vo2maxUiScenarios[0]!, {
      traceDir: await temporary(), rendererFactory: clock => {
        renderClock = clock;
        expect(clock.now().toISOString()).toBe('2026-10-07T08:00:00.000Z');
        return createPlaywrightRenderer({ clock });
      }, observeViews: true,
      handler: (request, index) => control(request) ?? reference(request, index),
    });
    expect(trace.graders.filter(g => g.gate && !g.id.startsWith('widget-') && g.status !== 'pass')).toEqual([]);
    expect(trace.previewReports?.filter(report => !report.ok)).toEqual([]);
    expect(trace.viewObservations).toHaveLength(6);
    expect(trace.viewObservations!.filter(v => !v.version || !v.screenshot || v.errors.length)).toEqual([]);
    expect(new Set(trace.viewObservations!.map(v => v.mount)).size).toBe(1);
    expect(renderClock!.now().toISOString()).toBe(trace.endedAt);
    expect(trace.graders.find(g => g.id === 'widget-1')?.status).toBe('pass');
    if (mode === 'live') expect(trace.graders.filter(g => g.gate && g.status !== 'pass')).toEqual([]);
    else expect(trace.graders.find(g => g.id === 'widget-2')?.status).toBe('fail');
  }, 180_000);
});

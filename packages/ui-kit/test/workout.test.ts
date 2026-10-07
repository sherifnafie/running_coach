import { describe, expect, it } from 'vitest';
import { buildWorkoutModel, describeLoad } from '../src/browser/workout';
import { weight } from '../src/browser/format';
import { typeGlyph, typeKey, typeLabel } from '../src/browser/components/types';

describe('[UI-1] session structure model', () => {
  it('keeps endurance steps, repeats and totals as before', () => {
    const m = buildWorkoutModel({
      steps: [
        { kind: 'warmup', duration: { time_s: 900 }, target: { rpe: [2, 3] } },
        { kind: 'repeat', times: 5, steps: [{ kind: 'work', duration: { distance_m: 1000 }, target: { pace_s_km: [235, 245] } }, { kind: 'recovery', duration: { time_s: 120 } }] },
      ],
    });
    expect(m.warnings).toEqual([]);
    expect(m.totalTimeS).toBe(900 + 5 * 120);
    expect(m.totalDistanceM).toBe(5000);
    expect(m.summary).toBe('15 min warm-up · 5 × (1 km work, 2 min recovery)');
  });

  it('renders exercise steps with uniform sets, loads and effort targets', () => {
    const m = buildWorkoutModel({
      steps: [{ kind: 'exercise', name: 'Back squat', sets: 3, reps: 5, load: { kg: 100 }, target: { rpe: [7, 8] }, rest_s: 180, tempo: '3-1-1' }],
    });
    const [sq] = m.items;
    expect(sq).toMatchObject({ type: 'exercise', kindLabel: 'Back squat', duration: '3 × 5', target: '100 kg · RPE 7–8', meta: 'Rest 3 min · Tempo 3-1-1' });
    expect(m.totalSets).toBe(3);
    expect(m.summary).toBe('Back squat 3 × 5');
  });

  it('renders top sets and back-offs, percentages, AMRAP, timed sets and repeats of exercises', () => {
    const m = buildWorkoutModel({
      steps: [
        { kind: 'exercise', name: 'Bench press', sets: [{ reps: 3, load: { kg: 90 }, target: { rpe: 8 } }, { reps: 5, load: { kg: 80 }, times: 3 }] },
        { kind: 'exercise', name: 'Deadlift', sets: 2, reps: [3, 5], load: { pct_1rm: [80, 85] }, target: { rir: 2 } },
        { kind: 'repeat', times: 3, steps: [{ kind: 'exercise', name: 'Pull-up', reps: 'amrap', load: { bodyweight: true } }, { kind: 'exercise', name: 'Plank', duration: { time_s: 45 } }] },
      ],
    });
    expect(m.warnings).toEqual([]);
    const [bench, dl, rep] = m.items;
    expect(bench?.sets).toEqual([
      { scheme: '1 × 3', load: '90 kg', target: 'RPE 8' },
      { scheme: '3 × 5', load: '80 kg', target: '' },
    ]);
    expect(bench?.duration).toBe('1 × 3 + 3 × 5');
    expect(dl).toMatchObject({ duration: '2 × 3–5', target: '80–85% 1RM · 2 RIR' });
    expect(rep?.children?.map((c) => [c.kindLabel, c.duration, c.target])).toEqual([
      ['Pull-up', '1 × AMRAP', 'Bodyweight'],
      ['Plank', '1 × 45 s', ''],
    ]);
    expect(m.totalSets).toBe(4 + 2 + 3 * 2);
  });

  it('converts loads for imperial display without changing stored kilograms', () => {
    expect(describeLoad({ kg: 100 }, 'imperial', 'en-US')).toBe('220.5 lb');
    expect(describeLoad({ kg: [95, 102.5] }, 'metric', 'en-US')).toBe('95–102.5 kg');
    expect(weight(60, 'metric')).toBe('60 kg');
    expect(weight(null)).toBe('–');
  });

  it('reports malformed sets instead of guessing', () => {
    const m = buildWorkoutModel({ steps: [{ kind: 'exercise', name: 'Row', sets: ['bad', { reps: 10 }] }] });
    expect(m.warnings).toEqual(['ignored a set of "Row" that is not an object']);
    expect(m.items[0]?.duration).toBe('1 × 10');
  });
});

describe('[UI-1] session type metadata works for any sport', () => {
  it('maps known types and sports to fixed keys and labels', () => {
    expect([typeKey('tempo'), typeLabel('heavy'), typeGlyph('strength')]).toEqual(['tempo', 'Heavy', 'S']);
    expect(typeKey('Climb')).toBe('climb');
  });

  it('gives unknown types a stable hashed colour key, a humanized label and an initial', () => {
    const k = typeKey('bouldering');
    expect(k).toMatch(/^x[1-8]$/);
    expect(typeKey('Bouldering')).toBe(k);
    expect(typeLabel('open_water')).toBe('Open water');
    expect(typeGlyph('bouldering')).toBe('B');
    expect(typeKey('')).toBe('other');
  });
});

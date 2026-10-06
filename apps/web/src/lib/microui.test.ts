import { describe, expect, it } from 'vitest';
import type { MicroForm } from '@opencoach/protocol';
import {
  assembleValues,
  clampScale,
  fieldError,
  initialFormState,
  isFormSubmittable,
  isMicroUiExpired,
  setSeverity,
  summarizeSubmission,
  toggleRegion,
  type FormState,
} from './microui';

const form: MicroForm = {
  id: 'checkin',
  fields: [
    { id: 'rpe', type: 'scale', label: 'RPE', min: 1, max: 10, anchors: { '1': 'Easy', '10': 'Max' } },
    { id: 'felt', type: 'choice', label: 'Legs', options: [{ label: 'Fresh', value: 'fresh' }, { label: 'Heavy', value: 'heavy' }] },
    { id: 'did', type: 'multi_choice', label: 'Did', options: [{ label: 'Warm up', value: 'warmup' }, { label: 'Stretch', value: 'stretch' }, { label: 'Strides', value: 'strides' }] },
    { id: 'km', type: 'number', label: 'Distance', unit: 'km', min: 0, max: 100 },
    { id: 'note', type: 'text', label: 'Note', multiline: true, max_len: 10 },
    { id: 'day', type: 'date', label: 'Date' },
    { id: 'at', type: 'time', label: 'Time' },
    { id: 'pain', type: 'body_map', label: 'Where', multi: true },
  ],
};

describe('form state', () => {
  it('starts empty and not submittable', () => {
    const s = initialFormState(form);
    expect(s.rpe).toBeUndefined();
    expect(s.did).toEqual([]);
    expect(s.km).toBe('');
    expect(isFormSubmittable(form, s)).toBe(false);
    expect(assembleValues(form, s)).toEqual({});
  });
});

describe('assembleValues', () => {
  it('assembles each field type', () => {
    const s: FormState = {
      rpe: 7,
      felt: 'heavy',
      did: ['strides', 'warmup'],
      km: ' 10,5 ',
      note: '  ok  ',
      day: '2026-10-07',
      at: '06:30',
      pain: [{ region: 'left_knee', severity: 6 }, { region: 'right_calf', severity: 2 }],
    };
    expect(isFormSubmittable(form, s)).toBe(true);
    expect(assembleValues(form, s)).toEqual({
      rpe: 7,
      felt: 'heavy',
      did: ['warmup', 'strides'], // option order, not click order
      km: 10.5, // decimal comma accepted
      note: 'ok',
      day: '2026-10-07',
      at: '06:30',
      pain: [{ region: 'left_knee', severity: 6 }, { region: 'right_calf', severity: 2 }],
    });
  });

  it('omits untouched fields: only what the athlete answered is sent', () => {
    const s = { ...initialFormState(form), rpe: 3 };
    expect(assembleValues(form, s)).toEqual({ rpe: 3 });
  });

  it('drops values that are not in the field definition', () => {
    const s: FormState = { ...initialFormState(form), felt: 'bogus', did: ['warmup', 'nope'], pain: [{ region: 'left_elbow' as never, severity: 3 }, { region: 'groin', severity: 99 }] };
    expect(assembleValues(form, s)).toEqual({ did: ['warmup'], pain: [{ region: 'groin', severity: 10 }] });
  });

  it('clamps severity to 0..10 and rounds', () => {
    const s: FormState = { ...initialFormState(form), pain: [{ region: 'groin', severity: -4 }, { region: 'head', severity: 5.6 }] };
    expect((assembleValues(form, s).pain as Array<{ severity: number }>).map((p) => p.severity)).toEqual([0, 6]);
  });
});

describe('validation', () => {
  it('blocks submit on an invalid number or over-long text and explains why', () => {
    const numField = form.fields.find((f) => f.id === 'km')!;
    expect(fieldError(numField, 'abc')).toBe('Enter a number');
    expect(fieldError(numField, '-1')).toBe('At least 0');
    expect(fieldError(numField, '101')).toBe('At most 100');
    expect(fieldError(numField, '')).toBeUndefined();
    const s: FormState = { ...initialFormState(form), rpe: 5, km: '1000' };
    expect(isFormSubmittable(form, s)).toBe(false);
    expect(assembleValues(form, s)).toEqual({ rpe: 5 }); // invalid field is never sent
    const textField = form.fields.find((f) => f.id === 'note')!;
    expect(fieldError(textField, 'x'.repeat(11))).toBe('At most 10 characters');
  });
});

describe('scale', () => {
  const f = { id: 's', type: 'scale', label: 's', min: 1, max: 10 } as const;
  it('snaps to step and clamps to range', () => {
    expect(clampScale(f, 7.4)).toBe(7);
    expect(clampScale(f, 0)).toBe(1);
    expect(clampScale(f, 99)).toBe(10);
    expect(clampScale({ ...f, min: 0, max: 1, step: 0.1 }, 0.30000000000000004)).toBe(0.3);
    expect(clampScale({ ...f, min: 0, max: 100, step: 5 }, 52)).toBe(50);
  });
});

describe('body map selection', () => {
  it('single select replaces, multi toggles, severity defaults to 5 and can be set', () => {
    let v = toggleRegion([], 'left_knee', false);
    expect(v).toEqual([{ region: 'left_knee', severity: 5 }]);
    v = toggleRegion(v, 'right_knee', false);
    expect(v.map((e) => e.region)).toEqual(['right_knee']);
    let m = toggleRegion([], 'left_knee', true);
    m = toggleRegion(m, 'right_knee', true);
    m = setSeverity(m, 'right_knee', 8);
    expect(m).toEqual([{ region: 'left_knee', severity: 5 }, { region: 'right_knee', severity: 8 }]);
    expect(toggleRegion(m, 'left_knee', true).map((e) => e.region)).toEqual(['right_knee']);
  });
});

describe('expiry and summaries', () => {
  it('expires_at in the past disables the micro-UI', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    expect(isMicroUiExpired({ expires_at: '2026-10-06T11:59:59Z' }, now)).toBe(true);
    expect(isMicroUiExpired({ expires_at: '2026-10-06T12:00:01Z' }, now)).toBe(false);
    expect(isMicroUiExpired({}, now)).toBe(false);
    expect(isMicroUiExpired(undefined, now)).toBe(false);
  });

  it('summarizes a submission with labels', () => {
    const lines = summarizeSubmission(form, { rpe: 7, felt: 'heavy', km: 10, did: ['warmup'], pain: [{ region: 'left_itb', severity: 4 }] });
    expect(lines).toEqual([
      { label: 'RPE', text: '7' },
      { label: 'Legs', text: 'Heavy' },
      { label: 'Distance', text: '10 km' },
      { label: 'Did', text: 'Warm up' },
      { label: 'Where', text: 'left IT band 4/10' },
    ]);
  });
});

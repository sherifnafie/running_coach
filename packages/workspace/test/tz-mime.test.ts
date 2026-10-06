import { describe, expect, it } from 'vitest';
import { baseMime, extForMime } from '../src';
import { addDays, localDate, localDateTime, localDayRange, localHm, parseYmd, startOfLocalDay, tzOffsetMs, weekdayName } from '../src/tz';

const H = 3600_000;

describe('tz helpers', () => {
  it('computes the UTC range of local days, exact across DST', () => {
    const len = (ymd: string, tz: string) => {
      const r = localDayRange(ymd, tz);
      return (r.end - r.start) / H;
    };
    // Europe/Amsterdam: spring forward 2026-03-29 (23h), fall back 2026-10-25 (25h)
    expect(len('2026-03-28', 'Europe/Amsterdam')).toBe(24);
    expect(len('2026-03-29', 'Europe/Amsterdam')).toBe(23);
    expect(len('2026-10-25', 'Europe/Amsterdam')).toBe(25);
    expect(len('2026-10-26', 'Europe/Amsterdam')).toBe(24);
    expect(new Date(startOfLocalDay('2026-03-29', 'Europe/Amsterdam')).toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(new Date(startOfLocalDay('2026-03-30', 'Europe/Amsterdam')).toISOString()).toBe('2026-03-29T22:00:00.000Z');
    expect(new Date(startOfLocalDay('2026-10-25', 'Europe/Amsterdam')).toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(new Date(startOfLocalDay('2026-10-26', 'Europe/Amsterdam')).toISOString()).toBe('2026-10-25T23:00:00.000Z');
    // America/New_York: 2026-03-08 (23h), 2026-11-01 (25h)
    expect(len('2026-03-08', 'America/New_York')).toBe(23);
    expect(len('2026-11-01', 'America/New_York')).toBe(25);
    expect(new Date(startOfLocalDay('2026-11-01', 'America/New_York')).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    // Australia/Lord_Howe has a 30-minute DST shift
    expect(len('2026-04-05', 'Australia/Lord_Howe')).toBe(24.5);
    expect(len('2026-10-04', 'Australia/Lord_Howe')).toBe(23.5);
    // southern hemisphere, opposite season
    expect(len('2026-04-05', 'Australia/Sydney')).toBe(25);
    expect(len('2026-10-04', 'Australia/Sydney')).toBe(23);
    // fixed-offset zones
    expect(new Date(startOfLocalDay('2026-10-07', 'Asia/Kolkata')).toISOString()).toBe('2026-10-06T18:30:00.000Z');
    expect(new Date(startOfLocalDay('2026-10-07', 'Pacific/Kiritimati')).toISOString()).toBe('2026-10-06T10:00:00.000Z');
    expect(new Date(startOfLocalDay('2026-10-07', 'UTC')).toISOString()).toBe('2026-10-07T00:00:00.000Z');
  });

  it('handles local midnight that does not exist (DST gap at 00:00)', () => {
    // America/Sao_Paulo (pre-2019 rules): 2018-11-04 00:00 → 01:00
    expect(new Date(startOfLocalDay('2018-11-04', 'America/Sao_Paulo')).toISOString()).toBe('2018-11-04T03:00:00.000Z');
    expect(localHm(startOfLocalDay('2018-11-04', 'America/Sao_Paulo'), 'America/Sao_Paulo')).toBe('01:00');
    const r = localDayRange('2018-11-04', 'America/Sao_Paulo');
    expect((r.end - r.start) / H).toBe(23);
    // and the day after starts at 00:00 local again
    expect(localHm(startOfLocalDay('2018-11-05', 'America/Sao_Paulo'), 'America/Sao_Paulo')).toBe('00:00');
  });

  it('consecutive days tile the timeline without gaps or overlaps', () => {
    for (const tz of ['Europe/Amsterdam', 'America/Sao_Paulo', 'Australia/Lord_Howe', 'Asia/Tehran']) {
      let day = '2018-10-25';
      let prevEnd = localDayRange(day, tz).end;
      for (let i = 0; i < 400; i++) {
        day = addDays(day, 1);
        const r = localDayRange(day, tz);
        expect(r.start, `${tz} ${day}`).toBe(prevEnd);
        expect(r.end).toBeGreaterThan(r.start);
        prevEnd = r.end;
      }
    }
  });

  it('formats local dates and times', () => {
    const t = Date.UTC(2026, 9, 7, 4, 58);
    expect(localHm(t, 'Europe/Amsterdam')).toBe('06:58');
    expect(localDate(t, 'America/Los_Angeles')).toBe('2026-10-06');
    expect(localDateTime(t, 'Asia/Tokyo')).toBe('2026-10-07 13:58');
    expect(localHm(Date.UTC(2026, 9, 7, 0, 5), 'UTC')).toBe('00:05'); // never "24:05"
    expect(tzOffsetMs(t, 'Europe/Amsterdam')).toBe(2 * H);
    expect(localHm(t, 'Not/AZone')).toBe('04:58'); // unknown zones degrade to UTC
  });

  it('date helpers', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekdayName('2026-10-07')).toBe('Wednesday');
    expect(weekdayName('2026-10-25')).toBe('Sunday');
    expect(() => parseYmd('2026-02-30')).toThrow(/invalid local date/);
    expect(() => parseYmd('2026-2-3')).toThrow(/expected YYYY-MM-DD/);
  });
});

describe('extForMime', () => {
  it('maps common types', () => {
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('image/png')).toBe('png');
    expect(extForMime('image/webp')).toBe('webp');
    expect(extForMime('image/heic')).toBe('heic');
    expect(extForMime('audio/mp4')).toBe('m4a');
    expect(extForMime('audio/webm')).toBe('webm');
    expect(extForMime('application/pdf')).toBe('pdf');
    expect(extForMime('text/csv')).toBe('csv');
    expect(extForMime('application/gpx+xml')).toBe('gpx');
    expect(extForMime('application/vnd.ant.fit')).toBe('fit');
    expect(extForMime('application/zip')).toBe('zip');
  });

  it('is case/parameter insensitive and has safe fallbacks', () => {
    expect(extForMime('IMAGE/JPEG; charset=binary')).toBe('jpg');
    expect(extForMime('')).toBe('bin');
    expect(extForMime('garbage')).toBe('bin');
    expect(extForMime('application/x-something-very-long-and-odd')).toBe('bin');
    expect(extForMime('application/vnd.foo+xml')).toBe('xml');
    expect(extForMime('video/x-matroska')).toBe('matroska'.length <= 8 ? 'matroska' : 'bin');
    expect(baseMime(' Text/Plain ; x=1')).toBe('text/plain');
  });

  it('never returns "json" (reserved for sidecars) and always returns a path-safe extension', () => {
    for (const m of ['application/json', 'application/ld+json', 'application/vnd.api+json', 'text/json', 'application/x-json', 'application/JSON']) {
      expect(extForMime(m)).not.toBe('json');
    }
    for (const m of ['../../etc/passwd', 'a/b/c', 'image/../x', 'x/y z', 'x/\u0000', 'x/<script>']) {
      expect(extForMime(m)).toMatch(/^[a-z0-9]{1,8}$/);
    }
  });
});

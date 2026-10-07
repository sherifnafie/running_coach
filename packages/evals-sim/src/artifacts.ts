import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { chromiumExecutable } from '@opencoach/ui-kit';
import { EXTRACTION_FIELDS, type ArtifactKind, type ArtifactTruth, type TrueActivity } from './types';

export interface ScreenshotOptions {
  app?: string;
  theme?: 'light' | 'dark';
  units?: 'metric' | 'imperial';
  locale?: string;
  kind?: ArtifactKind;
  injection?: string;
  executablePath?: string;
}
const escape = (s: unknown): string => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const duration = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** Template and labels share displayed values, so invisible or rounded fields are never invented. */
export function screenshotTemplate(activity: TrueActivity, options: ScreenshotOptions = {}): { html: string; truth: ArtifactTruth } {
  const units = options.units ?? 'metric';
  const locale = options.locale ?? 'en';
  const kind = options.kind ?? 'summary';
  const multiplier = units === 'imperial' ? 1609.344 : 1000;
  const number = (n: number, digits = 0) => new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  const truth: ArtifactTruth = { artifactId: `${activity.id}-${options.app ?? 'synthetic'}-${kind}-${options.theme ?? 'light'}-${units}-${locale}`, format: 'png', kind, app: options.app ?? 'synthetic', theme: options.theme ?? 'light', units, locale, tz: activity.tz, tzVisible: false, activityId: activity.id, visible: {}, notVisible: [], approximate: [], displayed: {} };
  const rows: string[] = [];
  const row = (label: string, displayed: string) => { truth.displayed[label] = displayed; rows.push(`<div class="row"><span>${escape(label)}</span><strong>${escape(displayed)}</strong></div>`); };
  if (kind === 'summary') {
    const distance = Math.round(activity.distanceM / multiplier * 100) / 100;
    truth.visible.started_at = activity.startedAt.slice(0, 16);
    truth.visible.distance_m = distance * multiplier;
    truth.visible.duration_s = Math.round(activity.durationS);
    row('Date', activity.startedAt.slice(0, 16).replace('T', ' '));
    row('Distance', `${number(distance, 2)} ${units === 'imperial' ? 'mi' : 'km'}`);
    row('Duration', duration(activity.durationS));
    const shownPace = Math.round(activity.avgPaceSecPerKm * multiplier / 1000);
    truth.visible.avg_pace_s_km = shownPace * 1000 / multiplier;
    row('Pace', `${duration(shownPace)} /${units === 'imperial' ? 'mi' : 'km'}`);
    truth.visible.elev_gain_m = Math.round(activity.elevGainM);
    row('Elevation gain', `${number(activity.elevGainM)} m`);
    if (activity.avgHr !== null) { truth.visible.avg_hr = activity.avgHr; row('Average heart rate', `${number(activity.avgHr)} bpm`); }
    if (activity.maxHr !== null) { truth.visible.max_hr = activity.maxHr; row('Maximum heart rate', `${number(activity.maxHr)} bpm`); }
    if (activity.avgCadenceSpm !== null) { truth.visible.avg_cadence_spm = activity.avgCadenceSpm; row('Cadence', `${number(activity.avgCadenceSpm)} spm`); }
  } else if (kind === 'splits') {
    const visible = activity.splits.map(s => ({ index: s.index, distanceM: Math.round(s.distanceM), durationS: Math.round(s.durationS), paceSecPerKm: Math.round(s.paceSecPerKm), avgHr: s.avgHr }));
    truth.visible.laps = visible;
    for (const s of visible) row(`Split ${s.index}`, `${number(s.distanceM)} m · ${duration(s.durationS)} · ${duration(s.paceSecPerKm)}/km${s.avgHr === null ? '' : ` · ${s.avgHr} bpm`}`);
  } else if (activity.hrZonesS) {
    truth.visible.hr_zones = activity.hrZonesS;
    for (const [i, seconds] of activity.hrZonesS.entries()) row(`Heart rate zone ${i + 1}`, duration(seconds));
  } else row('Heart rate', 'No heart rate data recorded');
  truth.notVisible = EXTRACTION_FIELDS.filter(f => !(f in truth.visible));
  if (options.injection) truth.injection = { text: options.injection, placement: 'activity note' };
  const dark = truth.theme === 'dark';
  const html = `<!doctype html><html lang="${escape(locale)}"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:26px;font:16px system-ui;background:${dark ? '#111827' : '#f3f4f6'};color:${dark ? '#f9fafb' : '#111827'}}h1{font-size:25px;margin:22px 0}small{color:${dark ? '#a3b2c7' : '#59667b'}}.card{border-radius:18px;background:${dark ? '#1f2937' : '#fff'};padding:18px}.row{display:flex;justify-content:space-between;gap:16px;padding:15px 0;border-bottom:1px solid ${dark ? '#374151' : '#eee'}}strong{text-align:right}p{overflow-wrap:anywhere}</style><small>SYNTHETIC EVAL • ${escape(truth.app)}</small><h1>${escape(activity.title)}</h1><div class="card">${rows.join('')}</div>${options.injection ? `<p>${escape(options.injection)}</p>` : ''}<p><small>Consent-free synthetic activity, generated from simulator ground truth.</small></p></html>`;
  return { html, truth };
}

export async function renderScreenshot(activity: TrueActivity, outDir: string, options: ScreenshotOptions = {}, browser?: Browser): Promise<{ path: string; truth: ArtifactTruth }> {
  const ownBrowser = !browser;
  const instance = browser ?? await chromium.launch({ headless: true, executablePath: chromiumExecutable(options.executablePath), args: ['--no-sandbox'] });
  const page = await instance.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  try {
    await page.route('**/*', route => route.abort());
    const { html, truth } = screenshotTemplate(activity, options);
    await page.setContent(html);
    await mkdir(outDir, { recursive: true });
    const path = join(outDir, `${truth.artifactId}.png`);
    await page.screenshot({ path, fullPage: true });
    await writeFile(join(outDir, `${truth.artifactId}.truth.json`), JSON.stringify(truth, null, 2));
    return { path, truth };
  } finally {
    await page.close();
    if (ownBrowser) await instance.close();
  }
}

/** Real XML GPX 1.1 with synthetic GPS points, timestamps and Garmin heart-rate extensions. */
export function generateGpx(activity: TrueActivity, injection?: string): { bytes: Uint8Array; truth: ArtifactTruth } {
  if (!activity.route?.length) throw new Error('GPX requires route ground truth');
  const points = activity.route.map(p => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><ele>${p.eleM}</ele><time>${new Date(new Date(activity.startedAt).getTime() + p.tS * 1000).toISOString()}</time>${p.hr === null ? '' : `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${p.hr}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>`}</trkpt>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="OpenCoach synthetic eval" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><trk><name>${escape(activity.title)}</name>${injection ? `<desc>${escape(injection)}</desc>` : ''}<trkseg>${points}</trkseg></trk></gpx>`;
  // Distance/elevation/pace are observable derivations from trackpoints, not invented summary
  // fields. Use the rounded coordinates actually emitted to XML, with standard haversine distance.
  let distance = 0;
  let elevation = 0;
  const rad = (n: number) => n * Math.PI / 180;
  for (let i = 1; i < activity.route.length; i++) {
    const a = activity.route[i - 1]!; const b = activity.route[i]!;
    const lat1 = Number(a.lat.toFixed(7)); const lat2 = Number(b.lat.toFixed(7));
    const deltaLat = rad(lat2 - lat1); const deltaLon = rad(Number(b.lon.toFixed(7)) - Number(a.lon.toFixed(7)));
    const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(deltaLon / 2) ** 2;
    distance += 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    elevation += Math.max(0, b.eleM - a.eleM);
  }
  const elapsed = activity.route.at(-1)!.tS - activity.route[0]!.tS;
  const visible: ArtifactTruth['visible'] = { started_at: new Date(activity.startedAt).toISOString(), duration_s: elapsed, distance_m: distance, elev_gain_m: elevation, avg_pace_s_km: elapsed / distance * 1000 };
  if (activity.hrSeries?.length) { visible.avg_hr = activity.hrSeries.reduce((a, p) => a + p.hr, 0) / activity.hrSeries.length; visible.max_hr = Math.max(...activity.hrSeries.map(p => p.hr)); }
  const truth: ArtifactTruth = { artifactId: `${activity.id}-gpx`, format: 'gpx', app: 'synthetic', units: 'metric', locale: 'en', tz: activity.tz, tzVisible: true, activityId: activity.id, visible, notVisible: EXTRACTION_FIELDS.filter(f => !(f in visible)), approximate: ['distance_m', 'avg_pace_s_km', 'elev_gain_m'], displayed: {}, ...(injection ? { injection: { text: injection, placement: 'track description' } } : {}) };
  return { bytes: new TextEncoder().encode(xml), truth };
}

/** Produce a reproducible ≥200 image corpus without copying real fitness-app screenshots (ING-1). */
export async function generateCorpus(activities: TrueActivity[], outDir: string, options: { count?: number; executablePath?: string } = {}): Promise<ArtifactTruth[]> {
  if (!activities.length) throw new Error('Corpus requires ground-truth activities');
  const count = options.count ?? 200;
  if (!Number.isInteger(count) || count < 1) throw new Error('Invalid corpus size');
  const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable(options.executablePath), args: ['--no-sandbox'] });
  const labels: ArtifactTruth[] = [];
  try {
    const apps = ['samsung_health', 'garmin', 'apple', 'strava', 'coros', 'polar', 'nrc'];
    const locales = ['en', 'de', 'nl', 'fr'];
    for (let i = 0; i < count; i++) {
      const activity = { ...activities[i % activities.length]!, id: `${activities[i % activities.length]!.id}-corpus-${i}` };
      const { truth } = await renderScreenshot(activity, outDir, { app: apps[i % apps.length], locale: locales[Math.floor(i / 7) % locales.length], theme: i % 2 ? 'dark' : 'light', units: Math.floor(i / 2) % 2 ? 'imperial' : 'metric', kind: (['summary', 'splits', 'hr_graph'] as const)[Math.floor(i / 4) % 3] }, browser);
      labels.push(truth);
    }
    await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ source: 'synthetic', count, labels }, null, 2));
    return labels;
  } finally { await browser.close(); }
}

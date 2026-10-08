import { describe, expect, it } from 'vitest';
import { ServerConfig, VirtualClock } from '@opencoach/protocol';
import { formatWeather } from '@opencoach/tools';
import { createOpenMeteoWeather } from '../src/weather';

const forecastBody = {
  latitude: 40.0,
  longitude: -105.3,
  timezone: 'America/Denver',
  current: { time: '2026-10-08T07:00', temperature_2m: 4.2, apparent_temperature: 1.1, relative_humidity_2m: 70, dew_point_2m: -0.6, precipitation: 0, weather_code: 3, wind_speed_10m: 12, wind_direction_10m: 270, wind_gusts_10m: 25 },
  hourly: {
    time: ['2026-10-08T07:00', '2026-10-08T08:00'],
    temperature_2m: [4.2, 6], apparent_temperature: [1.1, 3], precipitation_probability: [10, 40], precipitation: [0, 0.2],
    weather_code: [3, 61], wind_speed_10m: [12, 14], wind_gusts_10m: [25, 28], relative_humidity_2m: [70, 75], uv_index: [0, 1],
  },
  daily: {
    time: ['2026-10-08'], weather_code: [61], temperature_2m_max: [14], temperature_2m_min: [2], apparent_temperature_max: [12], apparent_temperature_min: [-1],
    precipitation_sum: [1.4], precipitation_probability_max: [60], wind_speed_10m_max: [20], wind_gusts_10m_max: [40], uv_index_max: [4],
    sunrise: ['2026-10-08T07:05'], sunset: ['2026-10-08T18:40'],
  },
};

function fakeFetch(opts: { airFails?: boolean } = {}) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/search')) {
      return { ok: true, status: 200, json: async () => ({ results: [
        { name: 'Boulder', latitude: 42.1, longitude: -71.0, admin1: 'Massachusetts', country: 'United States', country_code: 'US' },
        { name: 'Boulder', latitude: 40.01499, longitude: -105.27055, admin1: 'Colorado', country: 'United States', country_code: 'US' },
      ] }) };
    }
    if (u.pathname.endsWith('/air-quality')) {
      if (opts.airFails) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ current: { european_aqi: 20, us_aqi: 35, pm2_5: 4.1, pm10: 8 } }) };
    }
    return { ok: true, status: 200, json: async () => forecastBody };
  };
  return { fetch, urls };
}

const config = ServerConfig.parse({}).weather;

describe('weather (Open-Meteo adapter)', () => {
  it('geocodes a town with a region hint, coarsens coordinates and asks for the athlete units', async () => {
    const { fetch, urls } = fakeFetch();
    const weather = createOpenMeteoWeather({ config, clock: new VirtualClock(new Date('2026-10-08T13:00:00Z')), fetch });
    const r = await weather.forecast({ place: 'Boulder, Colorado', days: 1, hours: 2, units: 'imperial' });
    expect(r.place).toBe('Boulder, Colorado, United States');
    const forecastUrl = new URL(urls.find((u) => u.includes('/forecast'))!);
    // Only the town-level position leaves the server: 40.01499, -105.27055 → 40, -105.3.
    expect(forecastUrl.searchParams.get('latitude')).toBe('40');
    expect(forecastUrl.searchParams.get('longitude')).toBe('-105.3');
    expect(forecastUrl.searchParams.get('temperature_unit')).toBe('fahrenheit');
    expect(forecastUrl.searchParams.get('wind_speed_unit')).toBe('mph');
    expect(r.units).toEqual({ temperature: '°F', wind: 'mph', precipitation: 'in' });
    expect(r.hours).toHaveLength(2);
    expect(r.hours[1]).toMatchObject({ condition: 'light rain', precipitationProbability: 40 });
    expect(r.days[0]).toMatchObject({ date: '2026-10-08', min: 2, max: 14, uvIndexMax: 4 });
    expect(r.airQuality).toEqual({ europeanAqi: 20, usAqi: 35, pm25: 4.1, pm10: 8 });
  });

  it('caches by place and time through the clock, and keeps the forecast when air quality fails', async () => {
    const { fetch, urls } = fakeFetch({ airFails: true });
    const clock = new VirtualClock(new Date('2026-10-08T13:00:00Z'));
    const weather = createOpenMeteoWeather({ config, clock, fetch });
    const first = await weather.forecast({ latitude: 40.01, longitude: -105.27, days: 1, hours: 1, units: 'metric' });
    expect(first.airQuality).toBeUndefined();
    await weather.forecast({ latitude: 40.01, longitude: -105.27, days: 1, hours: 1, units: 'metric' });
    expect(urls.filter((u) => u.includes('/forecast'))).toHaveLength(1);
    await clock.advanceBy(21 * 60_000);
    await weather.forecast({ latitude: 40.01, longitude: -105.27, days: 1, hours: 1, units: 'metric' });
    expect(urls.filter((u) => u.includes('/forecast'))).toHaveLength(2);
  });

  it('says plainly when a place is not found', async () => {
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    const weather = createOpenMeteoWeather({ config, clock: new VirtualClock(new Date()), fetch });
    await expect(weather.forecast({ place: 'Nowhereville', days: 1, hours: 0, units: 'metric' })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('formats a compact report with units and local times', async () => {
    const { fetch } = fakeFetch();
    const weather = createOpenMeteoWeather({ config, clock: new VirtualClock(new Date()), fetch });
    const text = formatWeather(await weather.forecast({ place: 'Boulder, Colorado', days: 1, hours: 2, units: 'metric' }));
    expect(text).toContain('Now (07:00): overcast, 4°C (feels 1°C), wind 12 km/h from W, gusts 25 km/h, humidity 70%, dew point -1°C');
    expect(text).toContain('- 08:00 light rain, 6°C (feels 3°C), rain 40% 0.2 mm');
    expect(text).toContain('- Thu 2026-10-08: light rain, 2°C to 14°C, rain 60% 1.4 mm');
    expect(text).toContain('European AQI 20');
  });
});

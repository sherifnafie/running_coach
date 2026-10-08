import type { Clock, ServerConfig, WeatherDay, WeatherHour, WeatherPort, WeatherQuery, WeatherReport } from '@opencoach/protocol';
import { ToolError } from '@opencoach/protocol';

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface OpenMeteoOptions {
  config: ServerConfig['weather'];
  clock: Clock;
  fetch?: FetchLike;
}

/** Forecasts stay fresh for this long; places are geocoded once a day. */
const FORECAST_TTL_MS = 20 * 60_000;
const PLACE_TTL_MS = 24 * 3600_000;
const MAX_CACHE = 200;

/**
 * Open-Meteo forecast, air quality and geocoding (no key). Privacy: only a town name or coordinates rounded to 0.1°
 * (about 10 km) ever leave the server, never the athlete's identity.
 */
export function createOpenMeteoWeather(opts: OpenMeteoOptions): WeatherPort {
  const { config, clock } = opts;
  const fetchImpl: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const places = new Map<string, { at: number; value: { name: string; latitude: number; longitude: number } }>();
  const forecasts = new Map<string, { at: number; value: WeatherReport }>();

  async function getJson(url: string): Promise<Record<string, unknown>> {
    let res;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(config.timeoutMs), headers: { accept: 'application/json' } });
    } catch (e) {
      throw new ToolError('TIMEOUT', `The weather service could not be reached (${(e as Error).message}).`);
    }
    if (!res.ok) throw new ToolError('INTERNAL', `The weather service answered HTTP ${res.status}.`);
    return (await res.json()) as Record<string, unknown>;
  }

  function remember<T>(map: Map<string, { at: number; value: T }>, key: string, value: T): T {
    if (map.size >= MAX_CACHE) map.delete(map.keys().next().value as string);
    map.set(key, { at: clock.now().getTime(), value });
    return value;
  }

  async function geocode(place: string) {
    const key = place.trim().toLowerCase();
    const hit = places.get(key);
    if (hit && clock.now().getTime() - hit.at < PLACE_TTL_MS) return hit.value;
    // "Boulder, Colorado" → search the town, prefer a result whose region or country matches the rest.
    const [town, ...rest] = place.split(',').map((s) => s.trim()).filter(Boolean);
    const url = `${config.geocodingUrl}?${new URLSearchParams({ name: town ?? place, count: '10', language: 'en', format: 'json' })}`;
    const data = await getJson(url);
    const results = (data.results as Array<Record<string, unknown>> | undefined) ?? [];
    if (!results.length) throw new ToolError('ENOENT', `No place called "${place}" was found. Try a nearby town or add the country.`);
    const hint = rest.join(' ').toLowerCase();
    const match = (hint && results.find((r) => [r.admin1, r.country, r.country_code].some((v) => typeof v === 'string' && hint.includes(v.toLowerCase())))) || results[0]!;
    const name = [match.name, match.admin1, match.country].filter((v) => typeof v === 'string' && v).join(', ');
    return remember(places, key, { name, latitude: Number(match.latitude), longitude: Number(match.longitude) });
  }

  return {
    async forecast(q: WeatherQuery): Promise<WeatherReport> {
      const located = q.place ? await geocode(q.place) : { name: `${q.latitude}, ${q.longitude}`, latitude: q.latitude!, longitude: q.longitude! };
      const lat = Math.round(located.latitude * 10) / 10;
      const lon = Math.round(located.longitude * 10) / 10;
      const key = `${lat},${lon},${q.days},${q.hours},${q.units}`;
      const hit = forecasts.get(key);
      if (hit && clock.now().getTime() - hit.at < FORECAST_TTL_MS) return { ...hit.value, place: located.name };

      const imperial = q.units === 'imperial';
      const base = { latitude: String(lat), longitude: String(lon), timezone: 'auto' };
      const params = new URLSearchParams({
        ...base,
        current: 'temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
        hourly: 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m,dew_point_2m,uv_index',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,uv_index_max,sunrise,sunset',
        forecast_days: String(q.days),
        forecast_hours: String(Math.max(1, q.hours)),
        ...(imperial ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' } : {}),
      });
      const [data, air] = await Promise.all([
        getJson(`${config.forecastUrl}?${params}`),
        // Air quality is a bonus: a failure there must not lose the forecast.
        getJson(`${config.airQualityUrl}?${new URLSearchParams({ ...base, current: 'european_aqi,us_aqi,pm2_5,pm10' })}`).catch(() => undefined),
      ]);
      const report = parseForecast(data, air, q, located.name);
      return remember(forecasts, key, report);
    },
  };
}

type Series = Record<string, Array<number | string | null> | undefined>;
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? NaN));
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseForecast(data: Record<string, unknown>, air: Record<string, unknown> | undefined, q: WeatherQuery, place: string): WeatherReport {
  const current = (data.current ?? {}) as Record<string, unknown>;
  const hourly = (data.hourly ?? {}) as Series;
  const daily = (data.daily ?? {}) as Series;
  const at = (s: Series, field: string, i: number) => s[field]?.[i];
  const hours: WeatherHour[] = (hourly.time ?? []).slice(0, q.hours).map((time, i) => ({
    time: String(time),
    temperature: num(at(hourly, 'temperature_2m', i)),
    feelsLike: num(at(hourly, 'apparent_temperature', i)),
    precipitationProbability: numOrNull(at(hourly, 'precipitation_probability', i)),
    precipitation: num(at(hourly, 'precipitation', i)),
    condition: describeCode(num(at(hourly, 'weather_code', i))),
    wind: num(at(hourly, 'wind_speed_10m', i)),
    gusts: num(at(hourly, 'wind_gusts_10m', i)),
    humidity: numOrNull(at(hourly, 'relative_humidity_2m', i)),
    dewPoint: numOrNull(at(hourly, 'dew_point_2m', i)),
    uvIndex: numOrNull(at(hourly, 'uv_index', i)),
  }));
  const days: WeatherDay[] = (daily.time ?? []).map((date, i) => ({
    date: String(date),
    condition: describeCode(num(at(daily, 'weather_code', i))),
    min: num(at(daily, 'temperature_2m_min', i)),
    max: num(at(daily, 'temperature_2m_max', i)),
    feelsLikeMin: numOrNull(at(daily, 'apparent_temperature_min', i)),
    feelsLikeMax: numOrNull(at(daily, 'apparent_temperature_max', i)),
    precipitation: num(at(daily, 'precipitation_sum', i)),
    precipitationProbability: numOrNull(at(daily, 'precipitation_probability_max', i)),
    windMax: num(at(daily, 'wind_speed_10m_max', i)),
    gustsMax: num(at(daily, 'wind_gusts_10m_max', i)),
    uvIndexMax: numOrNull(at(daily, 'uv_index_max', i)),
    sunrise: String(at(daily, 'sunrise', i) ?? ''),
    sunset: String(at(daily, 'sunset', i) ?? ''),
  }));
  const aq = (air?.current ?? undefined) as Record<string, unknown> | undefined;
  const imperial = q.units === 'imperial';
  return {
    place,
    latitude: num(data.latitude),
    longitude: num(data.longitude),
    timezone: String(data.timezone ?? 'UTC'),
    units: { temperature: imperial ? '°F' : '°C', wind: imperial ? 'mph' : 'km/h', precipitation: imperial ? 'in' : 'mm' },
    current: {
      time: String(current.time ?? ''),
      temperature: num(current.temperature_2m),
      feelsLike: num(current.apparent_temperature),
      precipitation: num(current.precipitation),
      condition: describeCode(num(current.weather_code)),
      wind: num(current.wind_speed_10m),
      gusts: num(current.wind_gusts_10m),
      windDirection: num(current.wind_direction_10m),
      humidity: numOrNull(current.relative_humidity_2m),
      dewPoint: numOrNull(current.dew_point_2m),
    },
    hours,
    days,
    ...(aq ? { airQuality: { europeanAqi: numOrNull(aq.european_aqi), usAqi: numOrNull(aq.us_aqi), pm25: numOrNull(aq.pm2_5), pm10: numOrNull(aq.pm10) } } : {}),
    source: 'Open-Meteo',
  };
}

/** WMO weather interpretation codes, as Open-Meteo reports them. */
export function describeCode(code: number): string {
  if (code === 0) return 'clear';
  if (code === 1) return 'mainly clear';
  if (code === 2) return 'partly cloudy';
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return code >= 56 ? 'freezing drizzle' : 'drizzle';
  if (code >= 61 && code <= 67) return code >= 66 ? 'freezing rain' : code === 65 ? 'heavy rain' : code === 61 ? 'light rain' : 'rain';
  if (code >= 71 && code <= 77) return code === 75 ? 'heavy snow' : code === 77 ? 'snow grains' : 'snow';
  if (code >= 80 && code <= 82) return code === 82 ? 'violent showers' : 'rain showers';
  if (code === 85 || code === 86) return 'snow showers';
  if (code === 95) return 'thunderstorm';
  if (code === 96 || code === 99) return 'thunderstorm with hail';
  return 'unknown';
}

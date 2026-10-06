import { clock } from './clock';
import { health } from './endpoints';

/** Android shell contract (SPEC §10.5, §14); workout records remain raw evidence. */
export interface HealthConnectPlugin {
  availability(): Promise<{ status: 'available' | 'not_installed' | 'update_required' }>;
  requestPermissions(): Promise<{ granted: boolean }>;
  readWorkouts(range: { from: string; to: string }): Promise<{ sessions: unknown[] }>;
}

export type HealthConnectRange = [string, string];

export function getHealthConnectPlugin(): HealthConnectPlugin | undefined {
  if (typeof window === 'undefined') return undefined;
  const plugin = (window as Window & { Capacitor?: { Plugins?: { HealthConnect?: Partial<HealthConnectPlugin> } } })
    .Capacitor?.Plugins?.HealthConnect;
  if (!plugin || typeof plugin.availability !== 'function' || typeof plugin.requestPermissions !== 'function' || typeof plugin.readWorkouts !== 'function') {
    return undefined;
  }
  return plugin as HealthConnectPlugin;
}

export async function isHealthConnectAvailable(plugin = getHealthConnectPlugin()): Promise<boolean> {
  return !!plugin && (await plugin.availability())?.status === 'available';
}

/** End at the injected current instant, rather than a device-dependent local day boundary (P11). */
export function defaultHealthConnectRange(days = 30): HealthConnectRange {
  const to = clock.now();
  return [new Date(to.getTime() - days * 86_400_000).toISOString(), to.toISOString()];
}

export async function syncHealthConnect(
  range: HealthConnectRange = defaultHealthConnectRange(),
  plugin = getHealthConnectPlugin(),
): Promise<number> {
  const from = Date.parse(range[0]);
  const to = Date.parse(range[1]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new Error('Choose a valid workout date range with the start before the end.');
  }
  const normalized: HealthConnectRange = [new Date(from).toISOString(), new Date(to).toISOString()];
  if (!plugin || !(await isHealthConnectAvailable(plugin))) {
    throw new Error('Health Connect is not available on this device.');
  }
  const permission = await plugin.requestPermissions();
  if (permission?.granted !== true) {
    throw new Error('Allow Health Connect access to import your workouts.');
  }
  const result = await plugin.readWorkouts({ from: normalized[0], to: normalized[1] });
  if (!Array.isArray(result?.sessions)) {
    throw new Error('Health Connect returned an invalid workout list. Try again.');
  }
  await health.sync({ source: 'health_connect', range: normalized, workouts: result.sessions });
  return result.sessions.length;
}

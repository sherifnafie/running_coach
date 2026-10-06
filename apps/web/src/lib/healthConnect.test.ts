import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SystemClock, VirtualClock } from '@opencoach/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthConnectSection } from '../screens/settings/HealthConnectSection';
import { ApiRequestError } from './api';
import { setClock } from './clock';
import { defaultHealthConnectRange, getHealthConnectPlugin, isHealthConnectAvailable, syncHealthConnect, type HealthConnectPlugin, type HealthConnectRange } from './healthConnect';

const NOW = '2026-10-06T12:34:56.000Z';
const RANGE: HealthConnectRange = ['2026-09-06T12:34:56.000Z', NOW];
const WORKOUTS = [{ id: 'session-1', sourceApp: 'com.sec.android.app.shealth', exerciseType: 56, distanceM: 8000, heartRate: [{ t: NOW, bpm: 142 }], extraNativeField: { preserve: true } }];

function mockPlugin() {
  const plugin = {
    availability: vi.fn<HealthConnectPlugin['availability']>().mockResolvedValue({ status: 'available' }),
    requestPermissions: vi.fn<HealthConnectPlugin['requestPermissions']>().mockResolvedValue({ granted: true }),
    readWorkouts: vi.fn<HealthConnectPlugin['readWorkouts']>().mockResolvedValue({ sessions: WORKOUTS }),
  };
  vi.stubGlobal('Capacitor', { Plugins: { HealthConnect: plugin } });
  return plugin;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  setClock(new VirtualClock(NOW));
  vi.stubGlobal('Capacitor', undefined);
  fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  document.cookie = 'oc_csrf=; Path=/; Max-Age=0';
  setClock(new SystemClock());
  vi.unstubAllGlobals();
});

describe('Health Connect native bridge (SPEC §10.5, §14)', () => {
  it('is unavailable in a browser without the registered native plugin', async () => {
    expect(getHealthConnectPlugin()).toBeUndefined();
    expect(await isHealthConnectAvailable()).toBe(false);
    await expect(syncHealthConnect(RANGE)).rejects.toThrow('not available');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores an incomplete plugin instead of attempting native calls', () => {
    vi.stubGlobal('Capacitor', { Plugins: { HealthConnect: { availability: vi.fn() } } });
    expect(getHealthConnectPlugin()).toBeUndefined();
  });

  it.each(['not_installed', 'update_required'] as const)('does not request permission or read when the SDK is %s', async (status) => {
    const plugin = mockPlugin();
    plugin.availability.mockResolvedValue({ status });
    expect(await isHealthConnectAvailable()).toBe(false);
    await expect(syncHealthConnect(RANGE)).rejects.toThrow('not available');
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
    expect(plugin.readWorkouts).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the injected clock for the default 30-day range (P11)', () => {
    expect(defaultHealthConnectRange()).toEqual(RANGE);
    expect(defaultHealthConnectRange(7)).toEqual(['2026-09-29T12:34:56.000Z', NOW]);
  });

  it('requests permission, reads the UTC-normalized range, then posts untouched sessions with cookie auth', async () => {
    const plugin = mockPlugin();
    const csrfToken = 'a1'.repeat(32);
    document.cookie = `oc_csrf=${csrfToken}; Path=/`;
    const input: HealthConnectRange = ['2026-09-06T14:34:56+02:00', '2026-10-06T14:34:56+02:00'];
    expect(await syncHealthConnect(input)).toBe(1);
    expect(plugin.requestPermissions).toHaveBeenCalledTimes(1);
    expect(plugin.readWorkouts).toHaveBeenCalledWith({ from: RANGE[0], to: RANGE[1] });
    expect(plugin.requestPermissions.mock.invocationCallOrder[0]).toBeLessThan(plugin.readWorkouts.mock.invocationCallOrder[0]!);
    expect(plugin.readWorkouts.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]!);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/v1/sync/health', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: expect.objectContaining({ 'content-type': 'application/json', 'X-CSRF-Token': csrfToken }),
      body: JSON.stringify({ source: 'health_connect', range: RANGE, workouts: WORKOUTS }),
    }));
    expect(input).toEqual(['2026-09-06T14:34:56+02:00', '2026-10-06T14:34:56+02:00']);
  });

  it('does not read or upload after permission is refused', async () => {
    const plugin = mockPlugin();
    plugin.requestPermissions.mockResolvedValue({ granted: false });
    await expect(syncHealthConnect(RANGE)).rejects.toThrow('Allow Health Connect access');
    expect(plugin.readWorkouts).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['availability', 'requestPermissions', 'readWorkouts'] as const)('propagates %s failures without uploading', async (method) => {
    const plugin = mockPlugin();
    const error = new Error('Native Health Connect failure');
    plugin[method].mockRejectedValueOnce(error);
    await expect(syncHealthConnect(RANGE)).rejects.toBe(error);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed native response without uploading', async () => {
    const plugin = mockPlugin();
    plugin.readWorkouts.mockResolvedValue({ sessions: undefined } as unknown as { sessions: unknown[] });
    await expect(syncHealthConnect(RANGE)).rejects.toThrow('invalid workout list');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates gateway rejection instead of reporting a successful import', async () => {
    mockPlugin();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'sync_failed', message: 'Could not store this sync.' } }), { status: 503 }));
    await expect(syncHealthConnect(RANGE)).rejects.toEqual(expect.objectContaining<ApiRequestError>({
      name: 'ApiRequestError', status: 503, code: 'sync_failed', message: 'Could not store this sync.',
    }));
  });

  it.each<HealthConnectRange>([['invalid', NOW], [NOW, 'invalid'], [NOW, RANGE[0]], [NOW, NOW]])('rejects invalid range %s → %s before native access', async (from, to) => {
    const plugin = mockPlugin();
    await expect(syncHealthConnect([from, to])).rejects.toThrow('valid workout date range');
    expect(plugin.availability).not.toHaveBeenCalled();
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
    expect(plugin.readWorkouts).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Health Connect settings section (SPEC §14)', () => {
  it('stays hidden in the PWA without the plugin', () => {
    const { container } = render(createElement(HealthConnectSection));
    expect(container.innerHTML).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['not_installed', 'update_required'] as const)('stays hidden when native availability is %s', async (status) => {
    const plugin = mockPlugin();
    plugin.availability.mockResolvedValue({ status });
    const { container } = render(createElement(HealthConnectSection));
    await waitFor(() => expect(plugin.availability).toHaveBeenCalledTimes(1));
    expect(container.innerHTML).toBe('');
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
  });

  it('imports only on an explicit tap and reports the count after the upload completes', async () => {
    const plugin = mockPlugin();
    let resolveUpload!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveUpload = resolve; }));
    render(createElement(HealthConnectSection));
    const button = await screen.findByRole('button', { name: 'Import workouts' });
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Import period'), { target: { value: '7' } });
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Import period') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();
    expect(plugin.readWorkouts).toHaveBeenCalledWith({ from: '2026-09-29T12:34:56.000Z', to: NOW });
    resolveUpload(new Response('{}', { status: 200 }));
    expect((await screen.findByRole('status')).textContent).toBe('1 workout sent to your coach.');
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows permission errors and allows an explicit retry', async () => {
    const plugin = mockPlugin();
    plugin.requestPermissions.mockResolvedValueOnce({ granted: false });
    render(createElement(HealthConnectSection));
    const button = await screen.findByRole('button', { name: 'Import workouts' });
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toContain('Allow Health Connect access');
    expect(plugin.readWorkouts).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect((await screen.findByRole('status')).textContent).toBe('1 workout sent to your coach.');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

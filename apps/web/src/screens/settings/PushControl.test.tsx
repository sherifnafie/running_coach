import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@opencoach/protocol';
import { patchApp } from '../../lib/appState';
import { enablePush, pushDeviceState, testPush } from '../../lib/push';
import { SaveContext } from './Controls';
import { PushControl } from './PushControl';

vi.mock('../../lib/controller', () => ({ toast: vi.fn() }));
vi.mock('../../lib/push', () => ({ pushDeviceState: vi.fn(), enablePush: vi.fn(), disablePush: vi.fn(), testPush: vi.fn() }));
const commit = vi.fn(async () => true);
beforeEach(() => {
  vi.clearAllMocks();
  patchApp({ me: { athlete: { id: 'a', displayName: 'Athlete', isAdmin: false }, settings: defaultSettings(),
    viewsOrigin: 'https://views.test', kitUrl: '/kit', features: { push: true, passkeys: true, voiceNotes: false, calls: { realtime: false, cascaded: false }, webSearch: false }, harnessVersion: 'test', demoMode: true } });
});
afterEach(cleanup);

describe('notification settings [UI-1]', () => {
  it('shows that the device is disconnected even when account notifications are enabled', async () => {
    vi.mocked(pushDeviceState).mockResolvedValue('unsubscribed');
    vi.mocked(enablePush).mockResolvedValue({ ok: true });
    render(<SaveContext.Provider value={{ commit }}><PushControl /></SaveContext.Provider>);
    await screen.findByText('This device is not connected to notifications.');
    expect(screen.queryByRole('button', { name: 'Send test notification' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Enable on this device' }));
    await waitFor(() => expect(commit).toHaveBeenCalledWith({ notifications: { push: true } }));
  });
  it('sends a real server test and distinguishes acceptance from phone receipt', async () => {
    vi.mocked(pushDeviceState).mockResolvedValue('ready');
    vi.mocked(testPush).mockResolvedValue(undefined);
    render(<SaveContext.Provider value={{ commit }}><PushControl /></SaveContext.Provider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Send test notification' }));
    await waitFor(() => expect(testPush).toHaveBeenCalledOnce());
    expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('accepted by the push service'));
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type MeResponse } from '@opencoach/protocol';
import { patchApp } from '../../lib/appState';
import { sendText, sendVoiceNote } from '../../lib/controller';
import { startRecording, type ActiveRecorder } from '../../lib/recorder';
import { startDictation, type DictationHandlers } from '../../lib/dictation';
import { Composer } from './Composer';

vi.mock('../../lib/controller', () => ({ sendText: vi.fn(), sendFiles: vi.fn(), sendTyping: vi.fn(), sendVoiceNote: vi.fn(), consumePrefill: vi.fn(), toast: vi.fn() }));
vi.mock('../../lib/recorder', async (original) => ({ ...await original<typeof import('../../lib/recorder')>(), startRecording: vi.fn() }));
vi.mock('../../lib/dictation', async (original) => ({ ...await original<typeof import('../../lib/dictation')>(), startDictation: vi.fn() }));

function me(id = 'athlete-a', voiceNotes = true, dictation = false): MeResponse {
  return { athlete: { id, displayName: 'Test runner', isAdmin: false }, settings: defaultSettings(), viewsOrigin: 'https://views.test', kitUrl: 'https://views.test/kit', features: { voiceNotes, calls: { realtime: false, cascaded: false }, passkeys: false, push: false, webSearch: false, dictation }, harnessVersion: 'test', demoMode: true };
}
function recorder(): ActiveRecorder {
  return { stream: {} as MediaStream, cancel: vi.fn(), level: () => 0.4, stop: vi.fn().mockResolvedValue({ blob: new Blob(['test audio']), mime: 'audio/webm', durationMs: 1600 }) };
}
const mic = () => screen.getByRole('button', { name: 'Record a voice note' });
const message = () => screen.getByRole('textbox', { name: 'Message' });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  patchApp({ me: me(), online: true, composerPrefill: undefined });
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test-preview'), revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('[UI-1] chat composer', () => {
  it('retains a per-athlete draft across remounts, and clears it only on send', async () => {
    const first = render(<Composer />);
    fireEvent.change(message(), { target: { value: 'An unsent question' } });
    expect(localStorage.getItem('oc.draft.athlete-a')).toBe('An unsent question');
    first.unmount();
    const second = render(<Composer />);
    expect((message() as HTMLTextAreaElement).value).toBe('An unsent question');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sendText).toHaveBeenCalledWith('An unsent question');
    expect(localStorage.getItem('oc.draft.athlete-a')).toBeNull();
    second.unmount();
    patchApp({ me: me('athlete-b') });
    render(<Composer />);
    expect((message() as HTMLTextAreaElement).value).toBe('');
  });

  it('does not send while entering a newline or composing an IME character', () => {
    render(<Composer />);
    fireEvent.change(message(), { target: { value: 'Hello' } });
    fireEvent.keyDown(message(), { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(message(), { key: 'Enter', isComposing: true });
    expect(sendText).not.toHaveBeenCalled();
    fireEvent.keyDown(message(), { key: 'Enter' });
    expect(sendText).toHaveBeenCalledWith('Hello');
  });

  it('keeps mobile Enter as a newline and allows explicit Ctrl+Enter sending', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    render(<Composer />);
    fireEvent.change(message(), { target: { value: 'Mobile draft' } });
    fireEvent.keyDown(message(), { key: 'Enter' });
    expect(sendText).not.toHaveBeenCalled();
    fireEvent.keyDown(message(), { key: 'Enter', ctrlKey: true });
    expect(sendText).toHaveBeenCalledWith('Mobile draft');
  });

  it('explains unavailable speech service without acquiring the microphone', () => {
    patchApp({ me: me('athlete-a', false) });
    render(<Composer />);
    fireEvent.click(mic());
    expect(screen.getByText(/Voice notes aren’t set up/)).toBeTruthy();
    expect(startRecording).not.toHaveBeenCalled();
  });

  it('requires review and explicit send after a recording, keeping the typed draft', async () => {
    const active = recorder();
    vi.mocked(startRecording).mockResolvedValue(active);
    render(<Composer />);
    fireEvent.change(message(), { target: { value: 'Keep this draft' } });
    fireEvent.click(mic());
    fireEvent.click(await screen.findByRole('button', { name: 'Stop recording' }));
    await screen.findByRole('button', { name: 'Play voice note preview' });
    expect(sendVoiceNote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send voice note' }));
    expect(sendVoiceNote).toHaveBeenCalledOnce();
    expect((message() as HTMLTextAreaElement).value).toBe('Keep this draft');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-preview');
  });

  it('discards a preview without sending', async () => {
    vi.mocked(startRecording).mockResolvedValue(recorder());
    render(<Composer />);
    fireEvent.click(mic());
    fireEvent.click(await screen.findByRole('button', { name: 'Stop recording' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(sendVoiceNote).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-preview');
  });

  it('cancels a late microphone grant after the permission prompt was dismissed', async () => {
    let grant!: (active: ActiveRecorder) => void;
    vi.mocked(startRecording).mockReturnValue(new Promise((resolve) => { grant = resolve; }));
    render(<Composer />);
    fireEvent.click(mic());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const active = recorder();
    await act(async () => grant(active));
    expect(active.cancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Stop recording' })).toBeNull();
    expect(sendVoiceNote).not.toHaveBeenCalled();
  });

  it('stops capture when leaving chat and recovers after denied permission', async () => {
    vi.mocked(startRecording).mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    const view = render(<Composer />);
    fireEvent.click(mic());
    await screen.findByText(/Microphone access is blocked/);
    const active = recorder();
    vi.mocked(startRecording).mockResolvedValueOnce(active);
    fireEvent.click(mic());
    await screen.findByRole('button', { name: 'Stop recording' });
    view.rerender(<Composer visible={false} />);
    await waitFor(() => expect(active.cancel).toHaveBeenCalledOnce());
    expect(sendVoiceNote).not.toHaveBeenCalled();
  });

  it('dictates live into the draft: text streams in, done keeps it editable, cancel restores the draft', async () => {
    patchApp({ me: me('athlete-a', true, true) });
    let handlers: DictationHandlers | undefined;
    const finish = vi.fn(async () => 'heavy but fine');
    const cancel = vi.fn();
    vi.mocked(startDictation).mockImplementation(async (h) => { handlers = h; return { info: {} as never, finish, cancel }; });
    render(<Composer />);
    fireEvent.change(message(), { target: { value: 'Squats felt' } });
    expect(screen.queryByRole('button', { name: 'Record a voice note' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dictate' })); });
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Done dictating' })).toHaveProperty('disabled', true);
    act(() => { handlers!.onLive(); handlers!.onText('heavy but'); });
    expect((message() as HTMLTextAreaElement).value).toBe('Squats felt heavy but');
    expect(message()).toHaveProperty('readOnly', true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done dictating' })); });
    await waitFor(() => expect((message() as HTMLTextAreaElement).value).toBe('Squats felt heavy but fine'));
    expect(message()).toHaveProperty('readOnly', false);
    expect(sendText).not.toHaveBeenCalled(); // never sends on its own

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dictate' })); });
    act(() => { handlers!.onLive(); handlers!.onText('oops'); });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel dictation' }));
    expect(cancel).toHaveBeenCalled();
    expect((message() as HTMLTextAreaElement).value).toBe('Squats felt heavy but fine');
    // Voice notes stay available from the attachment menu.
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    expect(screen.getByRole('menuitem', { name: 'Record a voice note' })).toBeTruthy();
  });
});

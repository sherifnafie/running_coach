import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { Icon } from '../../components/Icon';
import { useTick } from '../../components/Atoms';
import { appStore } from '../../lib/appState';
import { clock } from '../../lib/clock';
import { consumePrefill, sendFiles, sendText, sendTyping, sendVoiceNote, toast } from '../../lib/controller';
import { formatBytes, formatDuration } from '../../lib/format';
import { describeMicError, startRecording, type ActiveRecorder } from '../../lib/recorder';
import { useStore } from '../../lib/store';

export const ACCEPT = 'image/*,.fit,.gpx,.tcx,.csv,.zip,.pdf,.json';
const ACCEPTED_EXT = /\.(fit|gpx|tcx|csv|zip|pdf|json)$/i;
const MIN_RECORDING_MS = 600;
const CANCEL_DRAG_PX = 90;

export function isAcceptedFile(f: File): boolean {
  return f.type.startsWith('image/') || ACCEPTED_EXT.test(f.name);
}

interface Tray {
  file: File;
  preview?: string;
}

export function Composer({ onFiles }: { onFiles?: (add: (files: File[]) => void) => void }) {
  const prefill = useStore(appStore, (s) => s.composerPrefill);
  const online = useStore(appStore, (s) => s.online);
  const [text, setText] = useState('');
  const [tray, setTray] = useState<Tray[]>([]);
  const [menu, setMenu] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  // autosize
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 168)}px`;
  }, [text]);

  // openChat({prefill}) from a view
  useEffect(() => {
    if (!prefill) return;
    setText((t) => (t ? `${t}\n${prefill.text}` : prefill.text));
    consumePrefill();
    taRef.current?.focus();
  }, [prefill]);

  const addFiles = useCallback((files: File[]) => {
    const ok = files.filter(isAcceptedFile);
    if (ok.length < files.length) toast('Some files were skipped. You can send images, .fit, .gpx, .tcx, .csv, .zip, .pdf and .json files.', 'error');
    if (ok.length === 0) return;
    setTray((t) => [...t, ...ok.map((file) => ({ file, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined }))].slice(0, 20));
  }, []);
  useEffect(() => onFiles?.(addFiles), [onFiles, addFiles]);
  const trayRef = useRef(tray);
  trayRef.current = tray;
  useEffect(() => () => trayRef.current.forEach((t) => t.preview && URL.revokeObjectURL(t.preview)), []);

  const removeFile = (i: number) =>
    setTray((t) => {
      const gone = t[i];
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return t.filter((_, j) => j !== i);
    });

  const canSend = text.trim().length > 0 || tray.length > 0;
  const send = () => {
    if (!canSend) return;
    const files = tray.map((t) => t.file);
    const caption = text;
    tray.forEach((t) => t.preview && URL.revokeObjectURL(t.preview)); // the controller makes its own previews
    setText('');
    setTray([]);
    if (files.length > 0) void sendFiles(files, caption);
    else void sendText(caption);
    taRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    // Enter sends on desktop (fine pointer); on touch keyboards Enter is a newline.
    if (window.matchMedia?.('(pointer: fine)').matches) {
      e.preventDefault();
      send();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const voice = useVoiceRecorder();

  return (
    <div className="composer" role="group" aria-label="Message composer">
      {!online && <p className="composer-offline">You're offline. Messages will send when you reconnect.</p>}
      {tray.length > 0 && (
        <ul className="tray" aria-label="Attachments to send">
          {tray.map((t, i) => (
            <li key={`${t.file.name}-${i}`}>
              {t.preview ? <img src={t.preview} alt="" /> : <Icon name="file" />}
              <span className="tray-name">
                {t.file.name} <small>{formatBytes(t.file.size)}</small>
              </span>
              <button type="button" className="icon-btn small" aria-label={`Remove ${t.file.name}`} onClick={() => removeFile(i)}>
                <Icon name="x" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {voice.state !== 'idle' ? (
        <RecordingBar state={voice.state} startedAt={voice.startedAt} level={voice.level} />
      ) : (
        <div className="composer-row">
          <div className="attach">
            <button type="button" className="icon-btn" aria-label="Attach" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              <Icon name="paperclip" />
            </button>
            {menu && (
              <div className="menu up" role="menu" onKeyDown={(e) => e.key === 'Escape' && setMenu(false)}>
                <button
                  type="button"
                  role="menuitem"
                  autoFocus
                  onClick={() => {
                    setMenu(false);
                    fileRef.current?.click();
                  }}
                >
                  <Icon name="image" size={18} /> Photo or file
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    cameraRef.current?.click();
                  }}
                >
                  <Icon name="camera" size={18} /> Camera
                </button>
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              hidden
              multiple
              accept={ACCEPT}
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
            <input
              ref={cameraRef}
              type="file"
              hidden
              accept="image/*"
              capture="environment"
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
          </div>
          <textarea
            ref={taRef}
            value={text}
            rows={1}
            placeholder="Message your coach"
            aria-label="Message"
            enterKeyHint="send"
            onChange={(e) => {
              setText(e.target.value);
              if (e.target.value) sendTyping();
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {canSend ? (
            <button type="button" className="icon-btn send" aria-label="Send" onClick={send}>
              <Icon name="send" />
            </button>
          ) : (
            <button type="button" className="icon-btn mic" aria-label="Hold to record a voice note" {...voice.handlers}>
              <Icon name="mic" />
            </button>
          )}
        </div>
      )}
      {voice.hint && (
        <p className="composer-hint" role="status">
          {voice.hint}
        </p>
      )}
    </div>
  );
}

function RecordingBar({ state, startedAt, level }: { state: 'recording' | 'cancel'; startedAt: number; level: number }) {
  useTick(200);
  return (
    <div className={`recording-bar${state === 'cancel' ? ' cancel' : ''}`} role="status" aria-live="polite">
      <span className="rec-dot" aria-hidden="true" style={{ transform: `scale(${1 + level * 2})` }} />
      <span className="rec-time">{formatDuration(clock.nowMs() - startedAt)}</span>
      <span className="rec-hint">{state === 'cancel' ? 'Release to cancel' : '‹ Slide to cancel · release to send'}</span>
    </div>
  );
}

/** Hold-to-record voice note: pointer hold (with slide-left to cancel) or Space/Enter to start and stop. */
function useVoiceRecorder() {
  const [state, setState] = useState<'idle' | 'recording' | 'cancel'>('idle');
  const [startedAt, setStartedAt] = useState(0);
  const [level, setLevel] = useState(0);
  const [hint, setHint] = useState<string | undefined>();
  const rec = useRef<ActiveRecorder | null>(null);
  const holding = useRef(false);
  const startX = useRef(0);
  const cancelled = useRef(false);
  const starting = useRef(false);
  const usingKeyboard = useRef(false);
  const meter = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const showHint = (h: string) => {
    setHint(h);
    setTimeout(() => setHint(undefined), 3500);
  };

  const finish = useCallback(async (send: boolean) => {
    const r = rec.current;
    rec.current = null;
    if (meter.current) clearInterval(meter.current);
    setState('idle');
    setLevel(0);
    if (!r) return;
    if (!send) {
      r.cancel();
      return;
    }
    try {
      const audio = await r.stop();
      if (audio.durationMs < MIN_RECORDING_MS) {
        showHint('Hold the microphone button while you speak.');
        return;
      }
      void sendVoiceNote(audio);
    } catch (e) {
      showHint(describeMicError(e));
    }
  }, []);

  const begin = useCallback(async () => {
    if (rec.current || starting.current) return;
    starting.current = true;
    cancelled.current = false;
    try {
      const r = await startRecording();
      rec.current = r;
      setStartedAt(clock.nowMs());
      setState('recording');
      meter.current = setInterval(() => setLevel(r.level()), 120);
      // The button was released while the permission prompt / device start was pending.
      if (!holding.current && !usingKeyboard.current) void finish(false);
    } catch (e) {
      showHint(describeMicError(e));
    } finally {
      starting.current = false;
    }
  }, [finish]);

  useEffect(
    () => () => {
      if (meter.current) clearInterval(meter.current);
      rec.current?.cancel();
    },
    [],
  );

  const handlers = {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      holding.current = true;
      usingKeyboard.current = false;
      startX.current = e.clientX;
      void begin();
    },
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
      if (!holding.current) return;
      const cancel = startX.current - e.clientX > CANCEL_DRAG_PX;
      cancelled.current = cancel;
      setState((s) => (s === 'idle' ? s : cancel ? 'cancel' : 'recording'));
    },
    onPointerUp: () => {
      if (!holding.current) return;
      holding.current = false;
      void finish(!cancelled.current);
    },
    onPointerCancel: () => {
      holding.current = false;
      void finish(false);
    },
    onContextMenu: (e: { preventDefault(): void }) => e.preventDefault(),
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      if (e.repeat) return;
      usingKeyboard.current = true;
      if (rec.current) void finish(true);
      else void begin();
    },
  };

  return { state, startedAt, level, hint, handlers };
}

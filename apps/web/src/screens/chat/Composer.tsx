import { t, useI18n } from '../../lib/i18n';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Icon } from '../../components/Icon';
import { appStore } from '../../lib/appState';
import { consumePrefill, sendFiles, sendText, sendTyping, toast } from '../../lib/controller';
import { formatBytes } from '../../lib/format';
import { lsGet, lsRemove, lsSet } from '../../lib/storage';
import { useStore } from '../../lib/store';
import { useVoiceRecorder, VoiceComposer } from './VoiceComposer';

export const ACCEPT = 'image/*,.fit,.gpx,.tcx,.csv,.zip,.pdf,.json';
const ACCEPTED_EXT = /\.(fit|gpx|tcx|csv|zip|pdf|json)$/i;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function isAcceptedFile(f: File): boolean {
  return f.type.startsWith('image/') || ACCEPTED_EXT.test(f.name);
}

export function Composer({ onFiles, visible = true }: { onFiles?: (add: (files: File[]) => void) => void; visible?: boolean }) {
  const t = useI18n();
  const prefill = useStore(appStore, (s) => s.composerPrefill);
  const online = useStore(appStore, (s) => s.online);
  const athleteId = useStore(appStore, (s) => s.me?.athlete.id);
  const voiceAvailable = useStore(appStore, (s) => !!s.me?.features.voiceNotes);
  const draftKey = athleteId ? `oc.draft.${athleteId}` : undefined;
  const [text, setText] = useState(() => draftKey ? lsGet(draftKey) ?? '' : '');
  const [tray, setTray] = useState<Array<{ file: File; id: number }>>([]);
  const [menu, setMenu] = useState(false);
  const [hint, setHint] = useState<string>();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const attachRef = useRef<HTMLDivElement>(null);
  const attachButton = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileId = useRef(0);
  const voice = useVoiceRecorder(visible);

  useEffect(() => {
    if (!draftKey) return;
    if (text) lsSet(draftKey, text);
    else lsRemove(draftKey);
  }, [draftKey, text]);

  // Re-measure after typing, wrapping/rotation, a hidden tab returning, and voice review closing.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta || !visible) return;
    let width = -1;
    const resize = () => {
      if (!ta.offsetWidth) return;
      width = ta.offsetWidth;
      ta.style.height = '0px';
      const min = parseFloat(getComputedStyle(ta).minHeight) || 52;
      const max = Math.max(min, Math.min(224, (window.visualViewport?.height ?? window.innerHeight) * 0.35));
      const needed = ta.scrollHeight;
      ta.style.height = `${Math.max(min, Math.min(needed, max))}px`;
      ta.style.overflowY = needed > max ? 'auto' : 'hidden';
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (ta.offsetWidth !== width) resize();
    });
    observer?.observe(ta);
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
    };
  }, [text, visible, voice.phase]);

  useEffect(() => {
    if (!prefill) return;
    setText((t) => (t ? `${t}\n${prefill.text}` : prefill.text));
    consumePrefill();
    if (visible) taRef.current?.focus();
  }, [prefill, visible]);

  const addFiles = useCallback((files: File[]) => {
    const valid = files.filter((file) => isAcceptedFile(file) && file.size <= MAX_FILE_BYTES);
    if (valid.length < files.length) toast('Send photos, FIT, GPX, TCX, CSV, ZIP, PDF or JSON files, up to 25 MB each.', 'error');
    const additions = valid.map((file) => ({ file, id: fileId.current++ }));
    setTray((current) => [...current, ...additions].slice(0, MAX_FILES));
  }, []);
  useEffect(() => onFiles?.(addFiles), [onFiles, addFiles]);

  useEffect(() => {
    if (!menu) return;
    const dismiss = (e: globalThis.PointerEvent) => {
      if (!attachRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const escape = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { setMenu(false); attachButton.current?.focus(); }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [menu]);

  const canSend = text.trim().length > 0 || tray.length > 0;
  const send = () => {
    if (!canSend) return;
    const files = tray.map((t) => t.file);
    const caption = text;
    setText('');
    if (draftKey) lsRemove(draftKey);
    setTray([]);
    setMenu(false);
    if (files.length) void sendFiles(files, caption);
    else void sendText(caption);
    taRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if ((e.ctrlKey || e.metaKey) || window.matchMedia?.('(pointer: fine)').matches) {
      e.preventDefault();
      send();
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (files.length) { e.preventDefault(); addFiles(files); }
  };
  const record = () => {
    setMenu(false);
    if (!voiceAvailable) {
      setHint('Voice notes aren’t set up on this server yet. You can still dictate using the microphone on your phone’s keyboard.');
    } else if (!online) {
      setHint('Reconnect to record a voice note. You can keep typing while offline.');
    } else {
      setHint(undefined);
      void voice.begin();
    }
  };
  const feedback = voice.error ?? hint;

  return (
    <div className="composer" role="group" aria-label={t("Message composer")}>
      {!online && <p className="composer-offline"><Icon name="wifi-off" size={14} /> {t("Your message will send when you’re back online.")}</p>}
      <div className="composer-box">
        {voice.phase !== 'idle' ? <VoiceComposer voice={voice} online={online} /> : <>
          {tray.length > 0 && (
            <ul className="tray" aria-label={t("Attachments to send")}>
              {tray.map(({ file, id }) => (
                <li key={id}>
                  <AttachmentPreview file={file} />
                  <span className="tray-name">{file.name}<small>{formatBytes(file.size)}</small></span>
                  <button type="button" className="icon-btn small" aria-label={`Remove ${file.name}`} onClick={() => setTray((t) => t.filter((item) => item.id !== id))}>
                    <Icon name="x" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea ref={taRef} value={text} rows={1} placeholder={t("Message your coach…")} aria-label={t("Message")}
            enterKeyHint="enter" spellCheck autoCapitalize="sentences"
            onChange={(e) => { setText(e.target.value); if (e.target.value) sendTyping(); }} onKeyDown={onKeyDown} onPaste={onPaste} />
          <div className="composer-toolbar">
            <div className="attach" ref={attachRef}>
              <button ref={attachButton} type="button" className="icon-btn attach-btn" aria-label={t("Attach")} title={t("Add photos or files")} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
                <Icon name="plus" />
              </button>
              {menu && <div className="menu up" role="menu" aria-label={t("Add an attachment")}>
                <button type="button" role="menuitem" autoFocus onClick={() => { setMenu(false); fileRef.current?.click(); }}><Icon name="paperclip" size={19} /> {t("Photos & files")}</button>
                <button type="button" role="menuitem" onClick={() => { setMenu(false); cameraRef.current?.click(); }}><Icon name="camera" size={19} /> {t("Take a photo")}</button>
              </div>}
            </div>
            <span className="composer-key-hint">{t("Enter to send")}<span aria-hidden="true">·</span> {t("Shift + Enter for a new line")}</span>
            <div className="composer-actions">
              <button type="button" className="icon-btn mic" aria-label={t("Record a voice note")} title={voiceAvailable ? t("Record a voice note") : t("Voice notes aren’t configured")} onClick={record}><Icon name="mic" size={21} /></button>
              <button type="button" className="icon-btn send" aria-label={t("Send")} title={t("Send message")} disabled={!canSend} onClick={send}><Icon name="arrow-up" size={23} /></button>
            </div>
          </div>
        </>}
      </div>
      <input ref={fileRef} type="file" hidden multiple accept={ACCEPT} onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
      <input ref={cameraRef} type="file" hidden accept="image/*" capture="environment" onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
      {feedback && <div className="composer-hint" role="status"><span>{feedback}</span><button type="button" className="icon-btn small" aria-label={t("Dismiss message")} onClick={() => { setHint(undefined); voice.clearError(); }}><Icon name="x" size={16} /></button></div>}
    </div>
  );
}

function AttachmentPreview({ file }: { file: File }) {
  const t = useI18n();
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    const preview = URL.createObjectURL(file);
    setUrl(preview);
    return () => URL.revokeObjectURL(preview);
  }, [file]);
  return url ? <img src={url} alt="" /> : <span className="tray-file-icon"><Icon name="file" size={24} /></span>;
}

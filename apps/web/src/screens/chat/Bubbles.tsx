import { useI18n } from '../../lib/i18n';
import { memo, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { Attachment, BlobRef, EventEnvelope } from '@opencoach/protocol';
import { AudioPlayer, ImageThumb, Markdown } from '../../components/Atoms';
import { Icon } from '../../components/Icon';
import { MicroUiBlock } from '../../components/MicroUi';
import { ViewFrame } from '../../components/ViewFrame';
import { appStore } from '../../lib/appState';
import type { AnswerView, PendingMessage, Provisional } from '../../lib/chatModel';
import { discardPending, react, retryPending } from '../../lib/controller';
import { chat } from '../../lib/endpoints';
import { basename, formatBytes, formatDuration, formatTime } from '../../lib/format';
import { createStore, useStore } from '../../lib/store';

export interface BubbleCtx {
  tz?: string;
  locale?: string;
}

function isImage(b: BlobRef): boolean {
  return b.mime.startsWith('image/');
}

export function FileCard({ blob, name }: { blob: BlobRef; name?: string }) {
  const label = name ?? blob.name ?? `file-${blob.sha256.slice(0, 8)}`;
  return (
    <a className="file-card" href={chat.blobUrl(blob.sha256)} download={label} target="_blank" rel="noopener noreferrer">
      <Icon name="file" />
      <span className="file-meta">
        <span className="file-name">{label}</span>
        <span className="file-size">{formatBytes(blob.bytes)}</span>
      </span>
    </a>
  );
}

export function BlobView({ blob, label }: { blob: BlobRef; label?: string }) {
  const t = useI18n();
  if (isImage(blob)) return <ImageThumb src={chat.blobUrl(blob.sha256)} alt={label ?? blob.name ?? t("Photo")} />;
  if (blob.mime.startsWith('audio/')) return <AudioPlayer src={chat.blobUrl(blob.sha256)} label={label ?? t("Audio")} />;
  return <FileCard blob={blob} name={label} />;
}

function Gallery({ blobs }: { blobs: BlobRef[] }) {
  const images = blobs.filter(isImage);
  const others = blobs.filter((b) => !isImage(b));
  return (
    <>
      {images.length > 0 && (
        <div className={`gallery n${Math.min(images.length, 4)}`}>
          {images.map((b) => (
            <BlobView key={b.sha256} blob={b} />
          ))}
        </div>
      )}
      {others.map((b) => (
        <BlobView key={b.sha256} blob={b} />
      ))}
    </>
  );
}

// ---- message actions ------------------------------------------------------------------------------------------

/** One message at a time shows its actions; tapping a message (or its options button) selects it. */
const selection = createStore<string | undefined>(undefined);

/** Taps on these keep their own meaning (links, players, images, cards) instead of selecting the message. */
const INTERACTIVE = 'a, button, input, textarea, select, label, audio, video, iframe, img, summary, .view-card';

function useMessageSelection(id: string) {
  const selected = useStore(selection, (s) => s === id);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selected) return;
    // A tap anywhere outside this message hides the actions (another message selects itself). This listens for
    // click, not pointerdown: hiding the row moves the bottom-anchored list, which would make that tap miss.
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) selection.setState((s) => (s === id ? undefined : s));
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && selection.setState(undefined);
    document.addEventListener('click', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('click', away);
      document.removeEventListener('keydown', esc);
    };
  }, [selected, id]);
  const toggle = () => selection.setState((s) => (s === id ? undefined : id));
  const onBubbleClick = (e: ReactMouseEvent) => {
    if ((e.target as Element).closest(INTERACTIVE)) return;
    if (window.getSelection()?.toString()) return; // the athlete is selecting text, not tapping
    toggle();
  };
  return { selected, ref, toggle, onBubbleClick };
}

function MessageActions({ text, messageId, reaction }: { text?: string; messageId?: string; reaction?: string }) {
  const t = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="msg-actions" role="toolbar" aria-label={t('Message actions')}>
      {text && (
        <button
          type="button"
          className={`icon-btn small${copied ? ' done' : ''}`}
          aria-label={t(copied ? 'Copied' : 'Copy text')}
          title={t(copied ? 'Copied' : 'Copy text')}
          onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined)}
        >
          <Icon name={copied ? 'check' : 'copy'} size={18} />
        </button>
      )}
      {messageId && (
        <>
          <button type="button" className={`icon-btn small${reaction === '👍' ? ' on' : ''}`} aria-label={t('Helpful')} title={t('Helpful')} aria-pressed={reaction === '👍'} onClick={() => void react(messageId, '👍')}>
            <Icon name="thumbup" size={18} />
          </button>
          <button type="button" className={`icon-btn small${reaction === '👎' ? ' on' : ''}`} aria-label={t('Not helpful')} title={t('Not helpful')} aria-pressed={reaction === '👎'} onClick={() => void react(messageId, '👎')}>
            <Icon name="thumbdown" size={18} />
          </button>
        </>
      )}
      <span className="sr-only" aria-live="polite">{copied ? t('Copied') : ''}</span>
    </div>
  );
}

function Time({ iso, ctx }: { iso: string; ctx: BubbleCtx }) {
  return (
    <time className="bubble-time" dateTime={iso}>
      {formatTime(iso, ctx.tz, ctx.locale)}
    </time>
  );
}

// ---- athlete ----------------------------------------------------------------------------------------------

export const AthleteMessage = memo(function AthleteMessage({ event, ctx }: { event: EventEnvelope<'user.message'>; ctx: BubbleCtx }) {
  const { text, attachments } = event.payload;
  const sel = useMessageSelection(event.id);
  return (
    <div className={`msg me${sel.selected ? ' selected' : ''}`} ref={sel.ref}>
      <div className="bubble" onClick={text ? sel.onBubbleClick : undefined}>
        {attachments.length > 0 && <Gallery blobs={attachments} />}
        {text && <p className="plain">{text}</p>}
      </div>
      {sel.selected ? (
        <div className="msg-foot">
          <MessageActions text={text} />
          <Time iso={event.ts} ctx={ctx} />
        </div>
      ) : (
        <Time iso={event.ts} ctx={ctx} />
      )}
    </div>
  );
});

export const AthleteUpload = memo(function AthleteUpload({ event, ctx }: { event: EventEnvelope<'user.upload'>; ctx: BubbleCtx }) {
  const { blobs, caption } = event.payload;
  const sel = useMessageSelection(event.id);
  return (
    <div className={`msg me${sel.selected ? ' selected' : ''}`} ref={sel.ref}>
      <div className="bubble" onClick={caption ? sel.onBubbleClick : undefined}>
        <Gallery blobs={blobs} />
        {caption && <p className="plain">{caption}</p>}
      </div>
      {sel.selected ? (
        <div className="msg-foot">
          <MessageActions text={caption} />
          <Time iso={event.ts} ctx={ctx} />
        </div>
      ) : (
        <Time iso={event.ts} ctx={ctx} />
      )}
    </div>
  );
});

export const AthleteVoiceNote = memo(function AthleteVoiceNote({ event, ctx }: { event: EventEnvelope<'user.voice_note'>; ctx: BubbleCtx }) {
  const { blob, durationS, transcript } = event.payload;
  const [open, setOpen] = useState(false);
  const t = useI18n();
  const sel = useMessageSelection(event.id);
  return (
    <div className={`msg me${sel.selected ? ' selected' : ''}`} ref={sel.ref}>
      <div className="bubble voice" onClick={transcript ? sel.onBubbleClick : undefined}>
        <AudioPlayer src={chat.blobUrl(blob.sha256)} durationMs={durationS * 1000} />
        {transcript && (
          <>
            <button type="button" className="btn link small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? t("Hide transcript") : t("Transcript")}
            </button>
            {open && <p className="plain transcript">{transcript}</p>}
          </>
        )}
      </div>
      {sel.selected ? (
        <div className="msg-foot">
          <MessageActions text={transcript} />
          <Time iso={event.ts} ctx={ctx} />
        </div>
      ) : (
        <Time iso={event.ts} ctx={ctx} />
      )}
    </div>
  );
});

export const PendingBubble = memo(function PendingBubble({ item }: { item: PendingMessage }) {
  const failed = item.status === 'failed';
  const t = useI18n();
  return (
    <div className={`msg me pending ${item.status}`}>
      <div className="bubble">
        {item.attachments.length > 0 && (
          <div className={`gallery n${Math.min(item.attachments.filter((a) => a.previewUrl).length, 4)}`}>
            {item.attachments.map((a, i) =>
              a.previewUrl ? (
                <img key={i} src={a.previewUrl} alt={a.name} className="pending-img" />
              ) : (
                <div key={i} className="file-card">
                  <Icon name="file" />
                  <span className="file-meta">
                    <span className="file-name">{a.name}</span>
                    <span className="file-size">{formatBytes(a.bytes)}</span>
                  </span>
                </div>
              ),
            )}
          </div>
        )}
        {item.voice && (
          <div className="audio-player">
            {item.voice.previewUrl ? <audio controls src={item.voice.previewUrl} preload="metadata" /> : <span>{t("Voice note")}</span>}
            <span className="audio-time">{formatDuration(item.voice.durationMs)}</span>
          </div>
        )}
        {item.text && <p className="plain">{item.text}</p>}
        {item.progress !== undefined && item.status === 'sending' && (
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)} aria-label={t("Uploading")}>
            <span style={{ width: `${Math.round(item.progress * 100)}%` }} />
          </div>
        )}
      </div>
      <div className="pending-status" role={failed ? 'alert' : 'status'}>
        {item.status === 'sending' && <span>{t("Sending…")}</span>}
        {item.status === 'queued' && <span>{t("Waiting for connection. It will send automatically.")}</span>}
        {failed && (
          <>
            <span>{t("Not sent")}{item.error ? `: ${item.error}` : ''}</span>
            <button type="button" className="btn link small" onClick={() => void retryPending(item.clientId)}>
              {t("Retry")}</button>
            <button type="button" className="btn link small" onClick={() => discardPending(item.clientId)}>
              {t("Discard")}</button>
          </>
        )}
      </div>
    </div>
  );
});

// ---- coach ---------------------------------------------------------------------------------------------------

function CoachAttachment({ a }: { a: Attachment }) {
  const t = useI18n();
  const views = useStore(appStore, (s) => s.app?.views);
  if (a.kind === 'blob') return <BlobView blob={a.blob} />;
  if (a.kind === 'file') return <BlobView blob={a.blob} label={basename(a.path)} />;
  const view = views?.find((v) => v.manifest.id === a.viewId);
  if (!view) {
    return (
      <div className="file-card muted">
        <Icon name="alert" /> <span>{t("This card is no longer available.")}</span>
      </div>
    );
  }
  return (
    <div className="view-card">
      <ViewFrame view={view} params={a.params ?? {}} active mode="card" />
    </div>
  );
}

export const CoachMessage = memo(function CoachMessage({
  event,
  answer,
  reaction,
  ctx,
}: {
  event: EventEnvelope<'coach.message'>;
  answer?: AnswerView;
  reaction?: string;
  ctx: BubbleCtx;
}) {
  const p = event.payload;
  const sel = useMessageSelection(event.id);
  const t = useI18n();
  return (
    <div className={`msg coach${sel.selected ? ' selected' : ''}`} data-unread-id={p.messageId} ref={sel.ref}>
      <div className="bubble-row">
        <div className="bubble" onClick={sel.onBubbleClick}>
          {p.text && <Markdown text={p.text} />}
          {p.voiceNote && <AudioPlayer src={chat.blobUrl(p.voiceNote.sha256)} label="Voice reply" />}
          {p.attachments.map((a, i) => (
            <CoachAttachment key={i} a={a} />
          ))}
          {reaction && (
            <span className="reaction-badge" aria-label={`You reacted ${reaction === '👍' ? 'thumbs up' : reaction === '👎' ? 'thumbs down' : reaction}`}>
              {reaction}
            </span>
          )}
        </div>
        {/* Keyboard and mouse users get a visible way in; on touch, tapping the message does the same. */}
        <button type="button" className="icon-btn small more-btn" aria-label={t("Message options")} aria-expanded={sel.selected} onClick={sel.toggle}>
          <Icon name="more" size={18} />
        </button>
      </div>
      {p.ui && <MicroUiBlock messageId={p.messageId} ui={p.ui} answer={answer} />}
      {sel.selected ? (
        <div className="msg-foot">
          <MessageActions text={p.text} messageId={p.messageId} reaction={reaction} />
          <Time iso={event.ts} ctx={ctx} />
        </div>
      ) : (
        <Time iso={event.ts} ctx={ctx} />
      )}
    </div>
  );
});

export const ProvisionalBubble = memo(function ProvisionalBubble({ item }: { item: Provisional }) {
  const t = useI18n();
  return (
    <div className="msg coach provisional" aria-busy="true">
      <div className="bubble">{item.text ? <Markdown text={item.text} /> : <span className="typing-dots" aria-label={t("Coach is writing")}><i /><i /><i /></span>}</div>
    </div>
  );
});

export function ViewUpdateMessage({ title, summary, onOpen }: { title: string; summary: string; onOpen: () => void }) {
  const t = useI18n();
  return <button type="button" className="chat-view-update" onClick={onOpen}>
    <span className="view-update-icon" aria-hidden="true"><Icon name="check" size={16} /></span>
    <span className="view-update-copy"><strong>{t(title)} <span className="view-update-tag">{t('Updated')}</span></strong>
      {summary && <span className="view-update-summary">{summary}</span>}
    </span><Icon name="chevron" size={16} />
  </button>;
}

export function SystemLine({ text, onOpen }: { text: string; onOpen?: () => void }) {
  const t = useI18n();
  return (
    <div className="system-line" role="note">
      <span>{text}</span>
      {onOpen && (
        <button type="button" className="btn link small" onClick={onOpen}>
          {t("Open")}</button>
      )}
    </div>
  );
}

import { t, useI18n } from '../../lib/i18n';
import { memo, useState } from 'react';
import type { Attachment, BlobRef, EventEnvelope } from '@opencoach/protocol';
import { AudioPlayer, ImageThumb, Markdown, useLongPress } from '../../components/Atoms';
import { Icon } from '../../components/Icon';
import { MicroUiBlock } from '../../components/MicroUi';
import { ViewFrame } from '../../components/ViewFrame';
import { appStore } from '../../lib/appState';
import type { AnswerView, PendingMessage, Provisional } from '../../lib/chatModel';
import { discardPending, react, retryPending } from '../../lib/controller';
import { chat } from '../../lib/endpoints';
import { basename, formatBytes, formatDuration, formatTime } from '../../lib/format';
import { useStore } from '../../lib/store';

export interface BubbleCtx {
  tz?: string;
  locale?: string;
}

function isImage(b: BlobRef): boolean {
  return b.mime.startsWith('image/');
}

export function FileCard({ blob, name }: { blob: BlobRef; name?: string }) {
  const t = useI18n();
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
  const t = useI18n();
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

function Time({ iso, ctx }: { iso: string; ctx: BubbleCtx }) {
  const t = useI18n();
  return (
    <time className="bubble-time" dateTime={iso}>
      {formatTime(iso, ctx.tz, ctx.locale)}
    </time>
  );
}

// ---- athlete ----------------------------------------------------------------------------------------------

export const AthleteMessage = memo(function AthleteMessage({ event, ctx }: { event: EventEnvelope<'user.message'>; ctx: BubbleCtx }) {
  const { text, attachments } = event.payload;
  return (
    <div className="msg me">
      <div className="bubble">
        {attachments.length > 0 && <Gallery blobs={attachments} />}
        {text && <p className="plain">{text}</p>}
      </div>
      <Time iso={event.ts} ctx={ctx} />
    </div>
  );
});

export const AthleteUpload = memo(function AthleteUpload({ event, ctx }: { event: EventEnvelope<'user.upload'>; ctx: BubbleCtx }) {
  const { blobs, caption } = event.payload;
  return (
    <div className="msg me">
      <div className="bubble">
        <Gallery blobs={blobs} />
        {caption && <p className="plain">{caption}</p>}
      </div>
      <Time iso={event.ts} ctx={ctx} />
    </div>
  );
});

export const AthleteVoiceNote = memo(function AthleteVoiceNote({ event, ctx }: { event: EventEnvelope<'user.voice_note'>; ctx: BubbleCtx }) {
  const { blob, durationS, transcript } = event.payload;
  const [open, setOpen] = useState(false);
  return (
    <div className="msg me">
      <div className="bubble voice">
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
      <Time iso={event.ts} ctx={ctx} />
    </div>
  );
});

export const PendingBubble = memo(function PendingBubble({ item }: { item: PendingMessage }) {
  const failed = item.status === 'failed';
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
  const [menu, setMenu] = useState(false);
  const press = useLongPress(() => setMenu(true));
  return (
    <div className="msg coach" data-unread-id={p.messageId}>
      <div className="bubble-row">
        <div className="bubble" {...press}>
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
        <button type="button" className="icon-btn small more-btn" aria-label={t("Message options")} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
          <Icon name="more" size={18} />
        </button>
        {menu && <MessageMenu messageId={p.messageId} text={p.text} reaction={reaction} onClose={() => setMenu(false)} />}
      </div>
      {p.ui && <MicroUiBlock messageId={p.messageId} ui={p.ui} answer={answer} />}
      <Time iso={event.ts} ctx={ctx} />
    </div>
  );
});

function MessageMenu({ messageId, text, reaction, onClose }: { messageId: string; text: string; reaction?: string; onClose: () => void }) {
  const t = useI18n();
  return (
    <div className="menu" role="menu" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <button
        type="button"
        role="menuitem"
        className={reaction === '👍' ? 'on' : ''}
        onClick={() => {
          void react(messageId, '👍');
          onClose();
        }}
        autoFocus
      >
        <Icon name="thumbup" size={18} /> {t("Helpful")}</button>
      <button
        type="button"
        role="menuitem"
        className={reaction === '👎' ? 'on' : ''}
        onClick={() => {
          void react(messageId, '👎');
          onClose();
        }}
      >
        <Icon name="thumbdown" size={18} /> {t("Not helpful")}</button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          void navigator.clipboard?.writeText(text).catch(() => undefined);
          onClose();
        }}
      >
        <Icon name="copy" size={18} /> {t("Copy text")}</button>
      <button type="button" role="menuitem" className="menu-close" onClick={onClose}>
        {t("Close")}</button>
    </div>
  );
}

export const ProvisionalBubble = memo(function ProvisionalBubble({ item }: { item: Provisional }) {
  return (
    <div className="msg coach provisional" aria-busy="true">
      <div className="bubble">{item.text ? <Markdown text={item.text} /> : <span className="typing-dots" aria-label={t("Coach is writing")}><i /><i /><i /></span>}</div>
    </div>
  );
});

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

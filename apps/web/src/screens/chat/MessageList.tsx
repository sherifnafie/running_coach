import { useI18n } from '../../lib/i18n';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Spinner } from '../../components/Atoms';
import { appStore } from '../../lib/appState';
import { buildTimeline, type TimelineItem } from '../../lib/chatModel';
import { loadOlder, markRead } from '../../lib/controller';
import { formatDayLabel, localDayKey } from '../../lib/format';
import { navigate } from '../../lib/router';
import { useStore } from '../../lib/store';
import { AthleteMessage, AthleteUpload, AthleteVoiceNote, CoachMessage, PendingBubble, ProvisionalBubble, SystemLine, ViewUpdateMessage } from './Bubbles';

const INITIAL_WINDOW = 80;
const WINDOW_STEP = 40;
const STICK_PX = 90;

/**
 * Message list: "virtualized enough" (renders only the newest N items and grows the window / fetches older pages as
 * the athlete scrolls up), keeps the view pinned to the bottom for live messages, preserves position when older
 * messages are prepended, groups by local day, and marks visible coach messages as read.
 */
export function MessageList({ dropActive, visible = true }: { dropActive?: boolean; visible?: boolean }) {
  const t = useI18n();
  const chat = useStore(appStore, (s) => s.chat);
  const views = useStore(appStore, (s) => s.app?.views);
  const profile = useStore(appStore, (s) => s.me?.settings.profile);
  const tz = profile?.tz;
  const locale = profile?.locale;

  const viewTitle = useCallback((id: string) => views?.find((v) => v.manifest.id === id)?.manifest.title, [views]);
  const timeline = useMemo(
    () => buildTimeline(chat, { viewTitle }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chat.events, chat.provisional, chat.pending, chat.localAnswers, chat.notices, viewTitle],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState(INITIAL_WINDOW);
  const [jump, setJump] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const atBottom = useRef(true);
  const prev = useRef<{ first?: string; last?: string; height: number }>({ height: 0 });

  const items = timeline.length > limit ? timeline.slice(-limit) : timeline;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = items[0]?.key;
    const last = items[items.length - 1];
    const p = prev.current;
    if (p.first && first !== p.first && items.some((i) => i.key === p.first)) {
      // Older items were prepended: keep what the athlete was looking at.
      el.scrollTop += el.scrollHeight - p.height;
    } else if (last && last.key !== p.last) {
      const mine = last.kind === 'pending' || last.kind === 'user.message' || last.kind === 'user.upload' || last.kind === 'user.voice_note';
      if (atBottom.current || mine || !p.last) {
        el.scrollTop = el.scrollHeight;
        atBottom.current = true;
      } else setJump(true);
    }
    prev.current = { first, last: last?.key, height: el.scrollHeight };
  }, [items]);

  // Content grows without new keys (streaming text, images loading): stay pinned.
  useEffect(() => {
    const inner = innerRef.current;
    const el = scrollRef.current;
    if (!inner || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
      prev.current.height = el.scrollHeight;
    });
    ro.observe(inner);
    ro.observe(el); // Composer/keyboard resizing also changes how much conversation is visible.
    return () => ro.disconnect();
  }, []);

  // The chat stays mounted (hidden) while another tab is open: restore the position when it comes back.
  const savedTop = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !visible) return;
    el.scrollTop = atBottom.current ? el.scrollHeight : savedTop.current;
  }, [visible]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || !visible || el.clientHeight === 0) return;
    savedTop.current = el.scrollTop;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    if (atBottom.current) setJump(false);
    if (el.scrollTop < 320) {
      if (limit < timeline.length) setLimit((l) => l + WINDOW_STEP);
      else if (chat.hasMore && !loadingOlder) fetchOlder();
    }
  };

  const fetchOlder = () => {
    setLoadingOlder(true);
    void loadOlder().finally(() => setLoadingOlder(false));
  };

  // Mark coach messages read once they are on screen.
  const observer = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    observer.current = new IntersectionObserver(
      (entries) => {
        if (document.visibilityState !== 'visible') return;
        const ids = entries.filter((e) => e.isIntersecting).map((e) => (e.target as HTMLElement).dataset.unreadId!);
        if (ids.length) markRead(ids);
      },
      { root, threshold: 0.6 },
    );
    return () => observer.current?.disconnect();
  }, []);
  useEffect(() => {
    const obs = observer.current;
    const root = scrollRef.current;
    if (!obs || !root) return;
    root.querySelectorAll('[data-unread-id]').forEach((n) => obs.observe(n));
  });

  const ctx = useMemo(() => ({ tz, locale }), [tz, locale]);
  let lastDay = '';

  return (
    <div className={`chat-scroll${dropActive ? ' drop' : ''}`} ref={scrollRef} onScroll={onScroll} role="log" aria-label={t("Conversation")} aria-relevant="additions">
      <div className="chat-inner" ref={innerRef}>
        {!chat.initialLoaded && items.length === 0 && (
          <div className="chat-empty">
            <Spinner label="Loading messages" />
          </div>
        )}
        {chat.initialLoaded && timeline.length === 0 && (
          <div className="chat-empty">
            <p>
              <strong>{t("Say hello to your coach.")}</strong>
            </p>
            <p>{t("Tell them what you're training for, your goals, or just how today went.")}</p>
          </div>
        )}
        {(chat.hasMore || limit < timeline.length) && (
          <div className="load-older">
            <button type="button" className="btn link small" onClick={() => (limit < timeline.length ? setLimit((l) => l + WINDOW_STEP) : fetchOlder())} disabled={loadingOlder}>
              {loadingOlder ? 'Loading…' : t("Show earlier messages")}
            </button>
          </div>
        )}
        {items.map((item) => {
          const day = item.ts ? localDayKey(item.ts, tz) : lastDay;
          const sep = day && day !== lastDay;
          if (day) lastDay = day;
          return (
            <Fragment key={item.key}>
              {sep && (
                <div className="day-sep" role="separator">
                  <span>{formatDayLabel(item.ts, tz, locale)}</span>
                </div>
              )}
              {renderItem(item, ctx, chat.reactions)}
            </Fragment>
          );
        })}
      </div>
      {jump && (
        <button
          type="button"
          className="jump-pill"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            setJump(false);
          }}
        >
          {t("New messages")}</button>
      )}
    </div>
  );
}

function renderItem(item: TimelineItem, ctx: { tz?: string; locale?: string }, reactions: Record<string, string>) {
  switch (item.kind) {
    case 'user.message':
      return <AthleteMessage event={item.event} ctx={ctx} />;
    case 'user.upload':
      return <AthleteUpload event={item.event} ctx={ctx} />;
    case 'user.voice_note':
      return <AthleteVoiceNote event={item.event} ctx={ctx} />;
    case 'coach.message':
      return <CoachMessage event={item.event} answer={item.answer} reaction={reactions[item.event.payload.messageId]} ctx={ctx} />;
    case 'provisional':
      return <ProvisionalBubble item={item.item} />;
    case 'pending':
      return <PendingBubble item={item.item} />;
    case 'system':
      if (item.viewUpdate && item.viewId) return <ViewUpdateMessage title={item.viewUpdate.title} summary={item.viewUpdate.summary} onOpen={() => navigate({ name: 'view', viewId: item.viewId!, params: {} })} />;
      return <SystemLine text={item.text} onOpen={item.viewId ? () => navigate({ name: 'view', viewId: item.viewId!, params: {} }) : undefined} />;
  }
}

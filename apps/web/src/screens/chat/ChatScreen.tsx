import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { appStore } from '../../lib/appState';
import { ackLatest, setChatVisible } from '../../lib/controller';
import { useStore } from '../../lib/store';
import { Composer } from './Composer';
import { MessageList } from './MessageList';

/** Chat: the escape hatch that never breaks (SPEC P9). Always reachable, independent of coach-authored views. */
export function ChatScreen({ visible }: { visible: boolean }) {
  const lastEventId = useStore(appStore, (s) => s.chat.lastEventId);
  const athleteId = useStore(appStore, (s) => s.me?.athlete.id);
  const [drop, setDrop] = useState(false);
  const addFilesRef = useRef<((files: File[]) => void) | null>(null);
  const bindAdd = useCallback((add: (files: File[]) => void) => {
    addFilesRef.current = add;
  }, []);

  useEffect(() => {
    setChatVisible(visible);
    return () => setChatVisible(false);
  }, [visible]);
  useEffect(() => {
    if (visible) ackLatest();
  }, [lastEventId, visible]);

  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      setDrop(true);
    }
  };
  return (
    <div
      className="chat"
      onDragOver={onDragOver}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrop(false);
        addFilesRef.current?.([...e.dataTransfer.files]);
      }}
    >
      <MessageList dropActive={drop} visible={visible} />
      <Composer key={athleteId} onFiles={bindAdd} visible={visible} />
    </div>
  );
}

import type { StreamMessage } from '@opencoach/protocol';

/**
 * Workspace-change fan-out for views (bridge `subscribe`). The simple approach from the brief: any stream event
 * that can change what a view reads (a coach turn, a direct write, a published view, a coach message) notifies
 * every subscribed view; each BridgeHost debounces (300 ms).
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export function onWorkspaceChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function emitWorkspaceChange(): void {
  for (const l of [...listeners]) l();
}

const TRIGGER_EVENT_TYPES = new Set(['coach.turn', 'user.ui_write', 'coach.ui_published']);

/** Does this stream message mean "data views read may have changed"? */
export function isWorkspaceChange(m: StreamMessage): boolean {
  switch (m.t) {
    case 'event':
      return TRIGGER_EVENT_TYPES.has(m.event.type);
    case 'ui.published':
    case 'message.end':
      return true;
    default:
      return false;
  }
}

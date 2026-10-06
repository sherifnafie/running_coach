import type { AppInfo, MeResponse, PresenceState } from '@opencoach/protocol';
import { initialChatState, type ChatState } from './chatModel';
import type { SafetyBannerData } from './safety';
import { createStore } from './store';
import type { StreamStatus } from './stream';

export type BootPhase = 'loading' | 'needs-setup' | 'signed-out' | 'ready' | 'unreachable';
export type ThemePref = 'system' | 'light' | 'dark';

export interface Toast {
  id: string;
  text: string;
  kind: 'info' | 'success' | 'error';
}

export interface UpdatedMarker {
  version: string;
  summary: string;
}

export interface AppState {
  boot: BootPhase;
  bootError?: string;
  me?: MeResponse;
  app?: AppInfo;
  /** `app` came from the offline cache and has not been refreshed yet. */
  appFromCache: boolean;
  online: boolean;
  ws: StreamStatus;
  presence: PresenceState;
  progress?: { label: string; turnId: string };
  safety: SafetyBannerData | null;
  safetyDismissed: string[];
  /** "Updated by your coach" markers, cleared when the athlete dismisses or opens the view. */
  updated: Record<string, UpdatedMarker>;
  toasts: Toast[];
  chat: ChatState;
  /** Coach messages that arrived while the chat was not on screen. */
  unseen: number;
  composerPrefill?: { text: string; nonce: number };
  queued: number;
  /** Show the optional post-sign-in steps (install, notifications, passkey). */
  onboarding: boolean;
  theme: ThemePref;
}

export const appStore = createStore<AppState>({
  boot: 'loading',
  appFromCache: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  ws: 'closed',
  presence: 'idle',
  safety: null,
  safetyDismissed: [],
  updated: {},
  toasts: [],
  chat: initialChatState,
  unseen: 0,
  queued: 0,
  onboarding: false,
  theme: 'system',
});

export function patchApp(patch: Partial<AppState>): void {
  appStore.setState((s) => ({ ...s, ...patch }));
}

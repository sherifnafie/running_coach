import type {
  AppInfo,
  AthleteSettings,
  AuthResponse,
  CallSessionInfo,
  CascadedUtteranceResponse,
  ChangeEntry,
  EventsPage,
  MeResponse,
  PairRequest,
  PostEventResponse,
  SetupRequest,
  UiVersionRecord,
} from '@opencoach/protocol';
import type { BlobRef } from '@opencoach/protocol';
import { api, upload, type RequestOptions } from './api';

/** Typed gateway client (SPEC Appendix C §C.5). Paths are same-origin. */

// ---- auth ----------------------------------------------------------------------------------
const NOAUTH: RequestOptions = { noAuthRedirect: true };

export const auth = {
  setupStatus: () => api.get<{ needsSetup: boolean }>('/v1/setup-status', NOAUTH),
  setup: (req: SetupRequest) => api.post<AuthResponse>('/v1/auth/setup', req, NOAUTH),
  pair: (req: PairRequest) => api.post<AuthResponse>('/v1/auth/pair', req, NOAUTH),
  pairingCode: () => api.post<{ code: string; expiresAt: string }>('/v1/auth/pairing-codes'),
  logout: () => api.post<void>('/v1/auth/logout', {}, NOAUTH),
  passkeyRegisterOptions: () => api.post<unknown>('/v1/auth/passkey/register/options'),
  passkeyRegisterVerify: (response: unknown) => api.post<unknown>('/v1/auth/passkey/register/verify', response),
  passkeyLoginOptions: () => api.post<unknown>('/v1/auth/passkey/login/options', {}, NOAUTH),
  passkeyLoginVerify: (response: unknown) => api.post<AuthResponse>('/v1/auth/passkey/login/verify', response, NOAUTH),
};

export const me = {
  get: (opts?: RequestOptions) => api.get<MeResponse>('/v1/me', opts),
};

export const settingsApi = {
  get: async (): Promise<AthleteSettings> => unwrap<AthleteSettings>(await api.get('/v1/settings'), 'settings'),
  /** Partial patch; the server deep-merges (mergeSettings) and returns the full settings. */
  put: async (patch: unknown): Promise<AthleteSettings> => unwrap<AthleteSettings>(await api.put('/v1/settings', patch), 'settings'),
  calendarUrl: () => api.get<{ url: string }>('/v1/settings/calendar-url'),
};

/** Accept both `{settings: {...}}` and a bare object. */
function unwrap<T>(res: unknown, key: string): T {
  if (res && typeof res === 'object' && key in (res as Record<string, unknown>)) return (res as Record<string, T>)[key] as T;
  return res as T;
}

// ---- chat -----------------------------------------------------------------------------------
export const chat = {
  postMessage: (body: { text: string; clientId: string; attachments?: string[]; replyTo?: string }) =>
    api.post<PostEventResponse>('/v1/messages', body),
  events: (q: { before?: string; after?: string; limit?: number } = {}, opts?: RequestOptions) => {
    const p = new URLSearchParams();
    if (q.before) p.set('before', q.before);
    if (q.after) p.set('after', q.after);
    if (q.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return api.get<EventsPage>(`/v1/events${qs ? `?${qs}` : ''}`, opts);
  },
  uploadFile: (file: File, onProgress?: (f: number) => void, signal?: AbortSignal) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return upload<{ blob: BlobRef }>('/v1/uploads', form, onProgress, signal);
  },
  commitUploads: (blobs: string[], caption?: string) =>
    api.post<PostEventResponse>('/v1/uploads/commit', { blobs, ...(caption ? { caption } : {}) }),
  voiceNote: (audio: Blob, filename: string, onProgress?: (f: number) => void, signal?: AbortSignal) => {
    const form = new FormData();
    form.append('audio', audio, filename);
    return upload<PostEventResponse>('/v1/voice-notes', form, onProgress, signal);
  },
  uiAction: (body: { source: { messageId?: string; viewId?: string }; action: string; payload?: unknown; wake: boolean }) =>
    api.post<unknown>('/v1/ui-actions', body),
  reaction: (messageId: string, reaction: string) => api.post<void>('/v1/reactions', { messageId, reaction }),
  read: (messageIds: string[]) => api.post<void>('/v1/read', { messageIds }),
  deviceContext: (tz: string, locale: string) => api.post<void>('/v1/device-context', { tz, locale }),
  blobUrl: (sha: string) => `/v1/blobs/${sha}`,
};

// ---- views ----------------------------------------------------------------------------------
export const views = {
  app: () => api.get<AppInfo>('/v1/app'),
  query: (id: string, sql: string, params?: unknown[]) => api.post<unknown>(`/v1/views/${enc(id)}/query`, { sql, params }),
  file: (id: string, path: string) => api.post<unknown>(`/v1/views/${enc(id)}/file`, { path }),
  write: (id: string, body: { target: string; op: 'insert' | 'update' | 'delete'; row: Record<string, unknown>; key?: Record<string, unknown> }) =>
    api.post<unknown>(`/v1/views/${enc(id)}/write`, body),
  act: (id: string, body: { name: string; payload?: unknown; wake?: boolean }) => api.post<unknown>(`/v1/views/${enc(id)}/act`, body),
  error: (id: string, body: { version: string; message: string; stack?: string; viewport: string }) =>
    api.post<unknown>(`/v1/views/${enc(id)}/error`, body),
  versions: async (id: string): Promise<UiVersionRecord[]> => {
    const res = await api.get<unknown>(`/v1/views/${enc(id)}/versions`);
    if (Array.isArray(res)) return res as UiVersionRecord[];
    return ((res as { versions?: UiVersionRecord[] })?.versions ?? []) as UiVersionRecord[];
  },
  revert: (id: string, toVersion?: string) => api.post<unknown>(`/v1/views/${enc(id)}/revert`, toVersion ? { toVersion } : {}),
  changes: (before?: string) => api.get<{ changes: ChangeEntry[] }>(`/v1/changes${before ? `?before=${encodeURIComponent(before)}` : ''}`),
};

const enc = encodeURIComponent;

// ---- calls ----------------------------------------------------------------------------------
export const calls = {
  create: (mode?: 'realtime' | 'cascaded', purpose?: string) =>
    api.post<CallSessionInfo>('/v1/calls', { ...(mode ? { mode } : {}), ...(purpose ? { purpose } : {}) }),
  attach: (callId: string, providerCallId: string) => api.post<void>(`/v1/calls/${enc(callId)}/attach`, { providerCallId }),
  utterance: (callId: string, audio: Blob, filename: string) => {
    const form = new FormData();
    form.append('audio', audio, filename);
    return upload<CascadedUtteranceResponse>(`/v1/calls/${enc(callId)}/utterance`, form);
  },
  end: (callId: string) => api.post<void>(`/v1/calls/${enc(callId)}/end`),
};

// ---- push -----------------------------------------------------------------------------------
export const push = {
  vapidKey: () => api.get<{ key: string }>('/v1/push/vapid-public-key'),
  subscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) => api.post<void>('/v1/push/subscriptions', sub),
};

// ---- data rights ----------------------------------------------------------------------------
export const account = {
  startExport: () => api.post<{ jobId: string }>('/v1/export'),
  exportUrl: (jobId: string) => `/v1/export/${enc(jobId)}`,
  delete: () => api.del<void>('/v1/account'),
};

// ---- admin ----------------------------------------------------------------------------------
export const admin = {
  athletes: () => api.get<unknown>('/admin/athletes'),
  invite: () => api.post<{ code: string }>('/admin/invites'),
  costs: () => api.get<unknown>('/admin/costs'),
  turns: () => api.get<unknown>('/admin/turns'),
  turn: (id: string) => api.get<unknown>(`/admin/turns/${enc(id)}`),
};

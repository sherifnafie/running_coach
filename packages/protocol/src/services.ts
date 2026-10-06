import type { BlobRef } from './common';
import type { BlobOrigin, PushSubscriptionRecord } from './store';
import type { PreviewReport } from './views';

// ------------------------------------------------------------------ blob store (SPEC [WS-7])

export interface StoredBlob extends BlobRef {
  /** Absolute host path of the immutable bytes. */
  path: string;
  /** True if the bytes already existed (content-addressed dedupe). */
  existed: boolean;
}

export interface BlobStore {
  /**
   * Store bytes content-addressed per athlete. Images from the athlete have GPS EXIF stripped in
   * the coach-visible copy unless keepImageLocation (handled by the caller/gateway).
   * Also records metadata in the Store.
   */
  put(athleteId: string, data: Uint8Array, meta: { mime: string; name?: string; origin: BlobOrigin; extra?: Record<string, unknown> }): Promise<StoredBlob>;
  /** Host path of the bytes, or undefined if missing. */
  path(athleteId: string, sha256: string): Promise<string | undefined>;
  read(athleteId: string, sha256: string): Promise<Uint8Array>;
  delete(athleteId: string, sha256: string): Promise<void>;
}

// ------------------------------------------------------------------ push (SPEC §14)

export interface PushNotification {
  title: string;
  body: string;
  tag?: string;
  /** Opaque data delivered to the service worker. */
  data: { url?: string; messageId?: string; athleteId: string; kind?: 'message' | 'safety' | 'system' };
  actions?: Array<{ action: string; title: string }>;
  silent?: boolean;
}

export interface PushProvider {
  readonly kind: PushSubscriptionRecord['kind'];
  /** `gone: true` means the subscription is invalid and should be deleted. */
  send(sub: PushSubscriptionRecord, n: PushNotification): Promise<{ ok: boolean; gone?: boolean; error?: string }>;
  publicKey?(): string | undefined;
}

// ------------------------------------------------------------------ UI preview renderer (SPEC §9.6)

export interface UiRenderInput {
  athleteId: string;
  /** Host path of the workspace (contains ui/ and data/coach.db). */
  workspaceDir: string;
  /** Views to render (ids). */
  views: string[];
  /** Host dir to write screenshots into. */
  outDir: string;
  /** Host dir of the UI kit build (served at /kit/<major>/). */
  kitDir: string;
}

export interface UiRenderer {
  preview(input: UiRenderInput): Promise<PreviewReport>;
  dispose(): Promise<void>;
}

// ------------------------------------------------------------------ web research

export interface WebSearchBackend {
  readonly kind: string;
  search(query: string, maxResults: number): Promise<Array<{ title: string; url: string; snippet: string }>>;
}

// ------------------------------------------------------------------ safety screen (SPEC [SAFE-2])

export type SafetyCategory = 'cardiac' | 'heat_illness' | 'stress_fracture' | 'neuro' | 'rhabdo' | 'dvt' | 'eating_disorder' | 'self_harm' | 'other_acute';

export interface SafetyScreenResult {
  flagged: boolean;
  categories: SafetyCategory[];
  acute: boolean;
  method: 'heuristic' | 'model';
}

export interface SafetyScreen {
  screen(text: string): Promise<SafetyScreenResult>;
}

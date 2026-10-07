import { z } from 'zod';

/**
 * Coach-authored views (SPEC §9, Appendix C §C.4). These files live in the coach's workspace:
 *   ui/app.json, ui/views/<id>/view.json, ui/views/<id>/<entry>.html, assets...
 * They are model-authored → snake_case keys as specified.
 */

export const ViewId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'view id must match [a-z0-9-]{1,32}');

export const AppManifest = z.object({
  version: z.literal(1).default(1),
  nav: z.array(ViewId).max(12).default([]),
  home: ViewId.optional(),
  theme: z.object({ accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).default({}),
});
export type AppManifest = z.infer<typeof AppManifest>;

/** "db:<table>" or "file:<glob relative to /workspace>" */
export const ReadTarget = z.string().regex(/^(db:[A-Za-z_][A-Za-z0-9_]*|file:.+)$/);

export const WriteTarget = z.union([
  z.object({
    db: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    ops: z.array(z.enum(['insert', 'update', 'delete'])).min(1),
    columns: z.array(z.string()).optional(),
  }),
  z.object({
    /** Must be under athlete-input/ (relative to /workspace). */
    file: z.string().regex(/^athlete-input\/.+/),
    ops: z.array(z.literal('write')).min(1),
  }),
]);
export type WriteTarget = z.infer<typeof WriteTarget>;

export const ViewPlacement = z.union([
  z.object({ nav: z.number().int().min(0) }),
  z.object({ home_card: z.number().int().min(0) }),
  z.object({ hidden: z.literal(true) }),
]);

export const ViewManifest = z.object({
  id: ViewId,
  title: z.string().min(1).max(40),
  icon: z.string().min(1).max(40).default('circle'),
  placement: ViewPlacement.default({ hidden: true }),
  entry: z.string().default('index.html'),
  kit: z.string().regex(/^\d+$/).default('1'),
  reads: z.array(ReadTarget).default([]),
  writes: z.array(WriteTarget).default([]),
  actions: z.array(z.string().max(64)).default([]),
  params: z.record(z.string(), z.enum(['string', 'date', 'number'])).optional(),
  refresh: z.enum(['on-change', 'manual']).default('on-change'),
  card: z.object({ entry: z.string(), height: z.enum(['s', 'm', 'l']) }).optional(),
});
export type ViewManifest = z.infer<typeof ViewManifest>;

/** Published view as served to clients. */
export interface PublishedView {
  manifest: ViewManifest;
  version: string;
  /** Absolute URL on the isolated views origin (SPEC [SEC-3]). */
  url: string;
  cardUrl?: string;
  /** Previous version for last-known-good fallback (SPEC §9.6 step 6). */
  previousVersion?: string;
  previousUrl?: string;
}

export interface AppInfo {
  app: AppManifest;
  views: PublishedView[];
  kitUrl: string;
}

// ---------------------------------------------------------------------------------------------
// Bridge protocol: JSON-RPC 2.0 over postMessage between view iframe (kit) and host (shell).
// Modeled on MCP Apps (SEP-1865). Methods are namespaced like the window.coach API.
// ---------------------------------------------------------------------------------------------

export const BridgeMethod = z.enum([
  'ready',
  'env.get',
  'db.query',
  'db.write',
  'files.read',
  'act',
  'navigate',
  'openChat',
  'subscribe',
  'unsubscribe',
  'toast',
  'report',
  'resize',
]);
export type BridgeMethod = z.infer<typeof BridgeMethod>;

export const BridgeRequest = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: BridgeMethod,
  params: z.unknown().optional(),
});
export type BridgeRequest = z.infer<typeof BridgeRequest>;

export interface BridgeResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Host → view notifications. */
export interface BridgeNotification {
  jsonrpc: '2.0';
  method: 'changed' | 'env.changed';
  params: unknown;
}

export const BridgeParams = {
  'db.query': z.object({ sql: z.string().max(20_000), params: z.array(z.unknown()).max(100).optional() }),
  'db.write': z.object({
    target: z.string(),
    op: z.enum(['insert', 'update', 'delete']),
    row: z.record(z.string(), z.unknown()),
    key: z.record(z.string(), z.unknown()).optional(),
  }),
  'files.read': z.object({ path: z.string() }),
  act: z.object({ name: z.string().max(64), payload: z.unknown().optional(), wake: z.boolean().optional() }),
  navigate: z.object({ viewId: ViewId, params: z.record(z.string(), z.string()).optional() }),
  openChat: z.object({ prefill: z.string().max(2000).optional(), ref: z.object({ viewId: z.string(), params: z.record(z.string(), z.unknown()).optional() }).optional() }),
  subscribe: z.object({ targets: z.array(z.string()).max(20) }),
  unsubscribe: z.object({ subscriptionId: z.string() }),
  toast: z.object({ text: z.string().max(200) }),
  report: z.object({ level: z.enum(['error', 'warn', 'info']), message: z.string().max(4000), detail: z.unknown().optional() }),
  resize: z.object({ height: z.number().int().min(0).max(10_000) }),
} as const;

export interface ViewEnv {
  theme: 'light' | 'dark';
  accent?: string;
  locale: string;
  units: 'metric' | 'imperial';
  tz: string;
  /** Epoch ms from the harness clock at the time env was sent; kit computes now() = nowMs + (Date.now() - receivedAt). */
  nowMs: number;
  safeArea: { top: number; right: number; bottom: number; left: number };
  viewport: { w: number; h: number };
  online: boolean;
  viewId: string;
  params: Record<string, string>;
  mode: 'live' | 'preview';
}

/** Limits for view queries (Appendix C §C.4). */
export const VIEW_QUERY_LIMITS = { maxRows: 5000, timeoutMs: 2000 } as const;

// ---------------------------------------------------------------------------------------------
// Preview / publish pipeline (SPEC §9.6)
// ---------------------------------------------------------------------------------------------

export const PREVIEW_VARIANTS = ['phone-light', 'phone-dark', 'tablet-light', 'empty-state'] as const;
export type PreviewVariant = (typeof PREVIEW_VARIANTS)[number];

export interface ViewPreview {
  viewId: string;
  ok: boolean;
  staticErrors: string[];
  runtimeErrors: string[];
  cspViolations: string[];
  a11y: { critical: number; serious: number; details: string[] };
  perf: { firstRenderMs: number; bundleKb: number };
  /** PNG screenshots on the host filesystem. */
  screenshots: Array<{ variant: PreviewVariant; path: string }>;
}

export interface PreviewReport {
  ok: boolean;
  views: ViewPreview[];
  /** Problems not tied to one view (app.json invalid, nav references unknown view, ...). */
  globalErrors: string[];
}

/** Gates (SPEC §9.6 step 3). */
export const PUBLISH_GATES = {
  maxFirstRenderMs: 1500,
  maxBundleKb: 500,
  maxCriticalA11y: 0,
} as const;

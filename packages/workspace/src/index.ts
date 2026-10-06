/**
 * @opencoach/workspace — everything about the athlete's on-disk data (SPEC §6):
 * seed init, git versioning, coach.db access/snapshots/dumps, rendered history, VirtualFS,
 * content-addressed blob store, view manifests & data access, export/import.
 *
 * STUB: signatures are final; implementation provided by the platform work package.
 */
import type {
  AnyEvent,
  AppManifest,
  AthletePaths,
  BlobStore,
  Clock,
  Store,
  ViewManifest,
  VirtualFS,
} from '@opencoach/protocol';

const ni = (name: string): never => {
  throw new Error(`not implemented: ${name}`);
};

// ---------------------------------------------------------------- layout & system dir

/** mkdir -p every directory in AthletePaths. */
export async function ensureAthleteDirs(paths: AthletePaths): Promise<void> {
  void paths;
  ni('ensureAthleteDirs');
}

/**
 * Compose the read-only /system mount for this harness version from the seed:
 *   <seedRoot>/core/constitution.md + <seedRoot>/<pack>/constitution/*.md → constitution.md (raw, placeholders kept)
 *   <seedRoot>/<pack>/system/** → docs/, skills/, CHANGELOG-for-coach.md, ...
 *   extraDocs (e.g. the UI kit docs dir) → docs/
 * Idempotent; rebuilds when the source tree hash changes. Returns the host path.
 */
export async function buildSystemDir(opts: { dataDir: string; seedRoot: string; pack: string; harnessVersion: string; extraDocs?: Record<string, string> }): Promise<string> {
  void opts;
  return ni('buildSystemDir');
}

// ---------------------------------------------------------------- workspace init & git

/**
 * Initialise a new athlete workspace from <seedRoot>/<pack>/workspace:
 * copy files, render {{var}} placeholders in text files, write .gitignore (data/coach.db*, tmp),
 * create data/coach.db by applying data/migrations/*.sql in order, git init + "seed" commit
 * (author "OpenCoach Harness <harness@opencoach.local>", committer date from clock).
 */
export async function initWorkspace(opts: { paths: AthletePaths; seedRoot: string; pack: string; vars: Record<string, string>; clock: Clock }): Promise<{ commit: string }> {
  void opts;
  return ni('initWorkspace');
}

export interface CommitInfo {
  commit: string;
  at: string;
  message: string;
  files: string[];
  /** Parsed trailers, e.g. Turn-Id, Kind. */
  trailers: Record<string, string>;
}

/** Git operations on a workspace repo (shells out to `git`; deterministic dates from the clock). */
export interface WorkspaceGit {
  readonly dir: string;
  /** `git add -A && git commit` if there are changes. Trailers are appended as "Key: value" lines. Returns null if nothing changed. */
  commitAll(message: string, trailers?: Record<string, string>): Promise<CommitInfo | null>;
  head(): Promise<string>;
  /** Newest first. */
  log(opts: { before?: string; limit: number; paths?: string[] }): Promise<CommitInfo[]>;
  /** Uncommitted changes (porcelain) as workspace-relative paths. */
  status(): Promise<string[]>;
  /** Restore the given paths to their state at `commit` (deleting files that did not exist then). */
  restorePaths(paths: string[], commit: string): Promise<void>;
  /**
   * Revert uncommitted changes to files NOT matching any of the globs (helper write-scope
   * enforcement, SPEC [SUB-3]). Returns the reverted paths.
   */
  revertOutside(globs: string[]): Promise<string[]>;
  /** Commits made since `sinceCommit` whose author is not the harness (external edits, SPEC [WS-6]). */
  foreignCommitsSince(sinceCommit: string): Promise<CommitInfo[]>;
  /** Content of a file at a commit, or undefined. */
  show(commit: string, path: string): Promise<string | undefined>;
}

export function openWorkspaceGit(dir: string, clock: Clock): WorkspaceGit {
  void dir;
  void clock;
  return ni('openWorkspaceGit');
}

// ---------------------------------------------------------------- coach.db

/** Snapshot data/coach.db (VACUUM INTO / backup) if it changed since the last snapshot. Retains 50 recent + 1/day for 90 days. */
export async function snapshotDb(paths: AthletePaths, clock: Clock): Promise<string | null> {
  void paths;
  void clock;
  return ni('snapshotDb');
}

/** Write a full SQL text dump to <workspace>/data/dump/coach.sql (for diffable history). */
export async function dumpDb(workspaceDir: string): Promise<string> {
  void workspaceDir;
  return ni('dumpDb');
}

/** Schema SQL of the current coach.db (CREATE statements), used for empty-state preview fixtures. */
export async function schemaSql(workspaceDir: string): Promise<string> {
  void workspaceDir;
  return ni('schemaSql');
}

/**
 * Read-only query for views (SPEC §9.4): parses SQL (single SELECT/WITH only), verifies every
 * referenced table is in `allowedTables`, opens coach.db read-only, wraps with a row cap, and runs
 * with a timeout (worker thread). Throws ToolError('NOT_ALLOWED' | 'INVALID_INPUT' | 'TIMEOUT').
 */
export async function runViewQuery(opts: { workspaceDir: string; sql: string; params?: unknown[]; allowedTables: string[]; maxRows: number; timeoutMs: number }): Promise<Array<Record<string, unknown>>> {
  void opts;
  return ni('runViewQuery');
}

/**
 * Apply a direct view write (SPEC [UI-1]) after validating it against the manifest's `writes`:
 * db targets → parameterised INSERT/UPDATE/DELETE limited to declared columns (key required for
 * update/delete); file targets → write under athlete-input/. Returns a short description.
 */
export async function applyViewWrite(opts: {
  workspaceDir: string;
  manifest: ViewManifest;
  write: { target: string; op: 'insert' | 'update' | 'delete'; row: Record<string, unknown>; key?: Record<string, unknown> };
}): Promise<{ description: string }> {
  void opts;
  return ni('applyViewWrite');
}

// ---------------------------------------------------------------- manifests, pinned files, skills

export interface UiManifests {
  app: AppManifest | null;
  views: Record<string, ViewManifest>;
  /** Validation errors (file → message). */
  errors: Array<{ path: string; message: string }>;
}

export async function readUiManifests(workspaceDir: string): Promise<UiManifests> {
  void workspaceDir;
  return ni('readUiManifests');
}

/** Parse AGENTS.md front-matter `pinned:` list (workspace-relative paths). Missing → []. */
export async function readPinnedList(workspaceDir: string): Promise<string[]> {
  void workspaceDir;
  return ni('readPinnedList');
}

export interface SkillInfo {
  name: string;
  description: string;
  /** Virtual path of SKILL.md (e.g. /system/skills/intake/SKILL.md). */
  path: string;
  source: 'system' | 'workspace';
}

/** Scan <dir>/<skill>/SKILL.md front-matter in /system/skills and /workspace/skills. */
export async function listSkills(opts: { systemDir: string; workspaceDir: string }): Promise<SkillInfo[]> {
  void opts;
  return ni('listSkills');
}

/** Copy ui/views/<viewId> into published/<viewId>/<version>/ (immutable). Returns the host dir. */
export async function copyPublishedView(paths: AthletePaths, viewId: string, version: string): Promise<string> {
  void paths;
  void viewId;
  void version;
  return ni('copyPublishedView');
}

// ---------------------------------------------------------------- history

/** (Re)render /history/YYYY/MM/DD.md for the athlete-local days touched by `events`. */
export async function renderHistory(opts: { paths: AthletePaths; store: Store; athleteId: string; tz: string; days: string[] }): Promise<void> {
  void opts;
  ni('renderHistory');
}

/** Render one event as a single markdown/plain line for transcripts (also used by the runtime). */
export function renderEventLine(e: AnyEvent, tz: string): string {
  void e;
  void tz;
  return ni('renderEventLine');
}

// ---------------------------------------------------------------- virtual FS & blobs

export interface MountedFsOptions {
  workspace: string;
  raw: string;
  history: string;
  system: string;
  /** Globs relative to /workspace; null = unrestricted. */
  writeScope?: string[] | null;
  /** Default 2 MiB. */
  maxReadBytes?: number;
}

export function createMountedFS(opts: MountedFsOptions): VirtualFS {
  void opts;
  return ni('createMountedFS');
}

/**
 * Filesystem BlobStore: athlete/sync origins → <raw>/<sha256>.<ext> + <sha256>.json sidecar
 * (visible at /raw), other origins → <blobs>/<sha[0:2]>/<sha256>. Records metadata in the Store.
 */
export function createFsBlobStore(opts: { dataDir: string; store: Store; clock: Clock }): BlobStore {
  void opts;
  return ni('createFsBlobStore');
}

/** Strip GPS/location metadata from an image (re-encode with sharp, keep orientation). */
export async function stripImageLocation(data: Uint8Array, mime: string): Promise<Uint8Array> {
  void data;
  void mime;
  return ni('stripImageLocation');
}

/** Downscale/convert an image for model input (longest edge ≤ maxEdge, png/jpeg). */
export async function prepareImageForModel(data: Uint8Array, mime: string, maxEdge?: number): Promise<{ data: Uint8Array; mediaType: 'image/png' | 'image/jpeg' }> {
  void data;
  void mime;
  void maxEdge;
  return ni('prepareImageForModel');
}

// ---------------------------------------------------------------- export / import (SPEC [SEC-5])

/** Write a .tar.gz with workspace (git bundle + files), raw/, blobs/, events.jsonl, settings.json, manifest.json. */
export async function exportAthlete(opts: { dataDir: string; athleteId: string; store: Store; clock: Clock }): Promise<string> {
  void opts;
  return ni('exportAthlete');
}

/** Import a bundle created by exportAthlete into a (new) athlete id. */
export async function importAthlete(opts: { dataDir: string; bundlePath: string; store: Store; clock: Clock; newAthleteId?: string }): Promise<{ athleteId: string }> {
  void opts;
  return ni('importAthlete');
}

/** Remove all on-disk data for an athlete. */
export async function deleteAthleteData(paths: AthletePaths): Promise<void> {
  void paths;
  ni('deleteAthleteData');
}

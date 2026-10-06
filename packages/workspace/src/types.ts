/** Public types of @opencoach/workspace (re-exported from index.ts). */
import type { AppManifest, ViewManifest } from '@opencoach/protocol';

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

export interface UiManifests {
  app: AppManifest | null;
  views: Record<string, ViewManifest>;
  /** Validation errors (file → message). */
  errors: Array<{ path: string; message: string }>;
}

export interface SkillInfo {
  name: string;
  description: string;
  /** Virtual path of SKILL.md (e.g. /system/skills/intake/SKILL.md). */
  path: string;
  source: 'system' | 'workspace';
}

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

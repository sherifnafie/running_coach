/**
 * @opencoach/workspace — everything about the athlete's on-disk data (SPEC §6):
 * seed init, git versioning, coach.db access/snapshots/dumps, rendered history, VirtualFS,
 * content-addressed blob store, view manifests & data access, export/import.
 *
 * Signatures are the platform contracts (see docs/implementation.md). Behaviour is documented on
 * each export in its module.
 */

// ---- layout, system dir, workspace init
export { ensureAthleteDirs } from './layout';
export { buildSystemDir } from './system-dir';
export { initWorkspace, renderPlaceholders, WORKSPACE_GITIGNORE } from './init';

// ---- git
export type { CommitInfo, WorkspaceGit } from './types';
export { openWorkspaceGit, HARNESS_GIT_NAME, HARNESS_GIT_EMAIL } from './git';

// ---- coach.db
export { snapshotDb, dumpDb, schemaSql } from './db';
export { runViewQuery } from './view-query';
export { applyViewWrite } from './view-write';

// ---- manifests, pinned files, skills, published views
export type { UiManifests, SkillInfo } from './types';
export { readUiManifests, readPinnedList, listSkills, copyPublishedView } from './manifests';

// ---- history
export { renderHistory, renderEventLine, renderDayMarkdown } from './history';

// ---- virtual FS & blobs
export type { MountedFsOptions } from './types';
export { createMountedFS } from './mounted-fs';
export { createFsBlobStore } from './blobs';
export { extForMime, baseMime } from './mime';
export { stripImageLocation, prepareImageForModel, prepareCoachAvatar } from './images';

// ---- export / import / delete
export { exportAthlete, importAthlete, deleteAthleteData } from './export';

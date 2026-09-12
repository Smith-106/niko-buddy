import { invoke } from "@tauri-apps/api/core";

/**
 * 快照时间机器的 TS 契约镜像。
 *
 * 真源是 `src-tauri/src/snapshot_timemachine.rs`。本文件只做类型与调用，不含任何裁决权；
 * 恢复动作在 Rust 侧过确认门并做原子落盘，前端无法绕过。
 */

export const TIMELINE_PAGE_SIZE = 50;
export const SNAPSHOT_DIR = ".novel/snapshots";
export const STATUS_FILE = ".novel/status.json";
export const PROJECTION_STATUS_FILE = ".novel/projection-status.json";

export interface SnapshotMeta {
  id: string;
  ts_ms: number;
  chapter_span: string | null;
  file_count: number;
  size_bytes: number;
}

export interface SnapshotChain {
  points: SnapshotMeta[];
  total: number;
  offset: number;
  limit: number;
  page_size: number;
}

export interface FieldDiff {
  path: string;
  before: string;
  after: string;
}

export interface StateDiff {
  state: string;
  before_hash: string;
  after_hash: string;
  changed: FieldDiff[];
}

export interface SnapshotDiff {
  snapshot_id: string;
  status_diff: FieldDiff[];
  world_state_diffs: StateDiff[];
  projection_status_diff: FieldDiff[];
}

export interface CanonVerifyOutcome {
  verified: boolean;
  detail: string;
}

export interface RestoreOutcome {
  snapshot_id: string;
  restored: string[];
  rolled_back: boolean;
  gate_decision: string;
  verify: CanonVerifyOutcome | null;
  message: string;
}

export async function listSnapshotChain(
  projectPath: string,
  offset = 0,
  limit = TIMELINE_PAGE_SIZE,
): Promise<SnapshotChain> {
  return invoke<SnapshotChain>("snapshot_list_chain", { projectPath, offset, limit });
}

export async function previewSnapshotPoint(
  projectPath: string,
  snapshotId: string,
): Promise<SnapshotDiff> {
  return invoke<SnapshotDiff>("snapshot_preview_point", { projectPath, snapshotId });
}

/** 恢复必须带确认令牌；空令牌会被 Rust 侧拒绝。 */
export async function restoreSnapshotAtomic(
  projectPath: string,
  snapshotId: string,
  confirmToken: string,
): Promise<RestoreOutcome> {
  return invoke<RestoreOutcome>("snapshot_restore_atomic", {
    projectPath,
    snapshotId,
    confirmToken,
  });
}

export function hasNextPage(chain: SnapshotChain): boolean {
  return chain.offset + chain.points.length < chain.total;
}

export function nextOffset(chain: SnapshotChain): number {
  return chain.offset + chain.points.length;
}

/**
 * 恢复后的复验是否构成「恢复成功」——回滚过（rolled_back）一律不算成功，
 * 即使文件最终一致。
 */
export function restoreSucceeded(outcome: RestoreOutcome): boolean {
  return !outcome.rolled_back && outcome.restored.length > 0;
}

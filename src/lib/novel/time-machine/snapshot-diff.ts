import type { FieldDiff, SnapshotDiff, StateDiff } from "./timeline-client";

/**
 * 快照 diff 的纯展示计算。无副作用、无 IPC，供时间线视图与测试共用。
 */

/** 恢复范围里属于真源面的文件——变更必须显式提示，不能默默回滚。 */
export const TRUTH_SURFACE_FILES = [
  ".novel/status.json",
  ".novel/projection-status.json",
] as const;

export interface DiffTotals {
  statusChanges: number;
  projectionChanges: number;
  worldStateChanges: number;
  totalChanges: number;
}

export function diffTotals(diff: SnapshotDiff): DiffTotals {
  const statusChanges = diff.status_diff.length;
  const projectionChanges = diff.projection_status_diff.length;
  const worldStateChanges = diff.world_state_diffs.reduce(
    (sum, s) => sum + s.changed.length,
    0,
  );
  return {
    statusChanges,
    projectionChanges,
    worldStateChanges,
    totalChanges: statusChanges + projectionChanges + worldStateChanges,
  };
}

/** 只列出真正发生变化的七个世界状态。 */
export function changedWorldStates(diff: SnapshotDiff): StateDiff[] {
  return diff.world_state_diffs.filter((s) => s.changed.length > 0);
}

export function isEmptyDiff(diff: SnapshotDiff): boolean {
  return diffTotals(diff).totalChanges === 0;
}

/**
 * 该快照点与当前状态是否触及真源面（status / projection-status）。
 * 触及即必须在恢复确认里二次确认。
 */
export function touchesTruthSurface(diff: SnapshotDiff): boolean {
  return diff.status_diff.length > 0 || diff.projection_status_diff.length > 0;
}

/** 字段级 diff 的单行文本（两侧都可能是空串 = 新增/删除）。 */
export function formatFieldDiff(field: FieldDiff): string {
  const before = field.before === "" ? "∅" : field.before;
  const after = field.after === "" ? "∅" : field.after;
  return `${field.path}: ${before} → ${after}`;
}

/** 供对照视图截断显示；避免超长值撑破布局。 */
export function truncateValue(value: string, max = 120): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

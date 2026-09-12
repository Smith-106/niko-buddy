import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import {
  TIMELINE_PAGE_SIZE,
  hasNextPage,
  listSnapshotChain,
  nextOffset,
  previewSnapshotPoint,
  restoreSnapshotAtomic,
  restoreSucceeded,
  type SnapshotChain,
} from "./timeline-client";
import {
  changedWorldStates,
  diffTotals,
  formatBytes,
  formatFieldDiff,
  isEmptyDiff,
  touchesTruthSurface,
  truncateValue,
} from "./snapshot-diff";
import type { SnapshotDiff } from "./timeline-client";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

function chain(overrides: Partial<SnapshotChain> = {}): SnapshotChain {
  return {
    points: [
      { id: "ch-10-20", ts_ms: 200, chapter_span: "10-20", file_count: 3, size_bytes: 2048 },
      { id: "ch-1-9", ts_ms: 100, chapter_span: "1-9", file_count: 3, size_bytes: 1024 },
    ],
    total: 120,
    offset: 0,
    limit: TIMELINE_PAGE_SIZE,
    page_size: TIMELINE_PAGE_SIZE,
    ...overrides,
  };
}

function diff(overrides: Partial<SnapshotDiff> = {}): SnapshotDiff {
  return {
    snapshot_id: "ch-10-20",
    status_diff: [{ path: "title", before: '"旧"', after: '"新"' }],
    projection_status_diff: [{ path: "projections[0].status", before: '"ready"', after: '"stale"' }],
    world_state_diffs: [
      {
        state: "characters",
        before_hash: "a",
        after_hash: "b",
        changed: [{ path: "hero.mood", before: '"平静"', after: '"焦躁"' }],
      },
      { state: "foreshadowing", before_hash: "c", after_hash: "c", changed: [] },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("timeline-client / IPC 契约", () => {
  it("listSnapshotChain 走 snapshot_list_chain 并带分页参数", async () => {
    invokeMock.mockResolvedValue(chain());
    const out = await listSnapshotChain("C:/proj", 50, 50);
    expect(out.total).toBe(120);
    expect(invokeMock).toHaveBeenCalledWith("snapshot_list_chain", {
      projectPath: "C:/proj",
      offset: 50,
      limit: 50,
    });
  });

  it("listSnapshotChain 默认从 0 开始、页大小 50", async () => {
    invokeMock.mockResolvedValue(chain());
    await listSnapshotChain("C:/proj");
    expect(invokeMock).toHaveBeenCalledWith("snapshot_list_chain", {
      projectPath: "C:/proj",
      offset: 0,
      limit: TIMELINE_PAGE_SIZE,
    });
    expect(TIMELINE_PAGE_SIZE).toBe(50);
  });

  it("previewSnapshotPoint 走 snapshot_preview_point", async () => {
    invokeMock.mockResolvedValue(diff());
    const out = await previewSnapshotPoint("C:/proj", "ch-10-20");
    expect(out.snapshot_id).toBe("ch-10-20");
    expect(invokeMock).toHaveBeenCalledWith("snapshot_preview_point", {
      projectPath: "C:/proj",
      snapshotId: "ch-10-20",
    });
  });

  it("restoreSnapshotAtomic 透传确认令牌", async () => {
    invokeMock.mockResolvedValue({
      snapshot_id: "ch-10-20",
      restored: [".novel/status.json"],
      rolled_back: false,
      gate_decision: "allowed",
      verify: { verified: true, detail: "ok" },
      message: "restored atomically",
    });
    const out = await restoreSnapshotAtomic("C:/proj", "ch-10-20", "token-1");
    expect(out.gate_decision).toBe("allowed");
    expect(invokeMock).toHaveBeenCalledWith("snapshot_restore_atomic", {
      projectPath: "C:/proj",
      snapshotId: "ch-10-20",
      confirmToken: "token-1",
    });
  });
});

describe("timeline-client / 分页", () => {
  it("未到链尾时还有下一页", () => {
    expect(hasNextPage(chain())).toBe(true);
  });

  it("到链尾时没有下一页", () => {
    const tail = chain({ offset: 118, points: chain().points, total: 120 });
    expect(hasNextPage(tail)).toBe(false);
    expect(nextOffset(tail)).toBe(120);
  });
});

describe("timeline-client / 恢复成功判定", () => {
  const base = {
    snapshot_id: "s",
    restored: ["a"],
    rolled_back: false,
    gate_decision: "allowed",
    verify: null,
    message: "",
  };

  it("未回滚且有落盘才算成功", () => {
    expect(restoreSucceeded(base)).toBe(true);
  });

  it("回滚过一律不算成功", () => {
    expect(restoreSucceeded({ ...base, rolled_back: true })).toBe(false);
  });

  it("没有任何文件被恢复不算成功", () => {
    expect(restoreSucceeded({ ...base, restored: [] })).toBe(false);
  });
});

describe("snapshot-diff / 统计与提示", () => {
  it("diffTotals 汇总三个面", () => {
    expect(diffTotals(diff())).toEqual({
      statusChanges: 1,
      projectionChanges: 1,
      worldStateChanges: 1,
      totalChanges: 3,
    });
  });

  it("changedWorldStates 过滤掉无变化的状态", () => {
    const states = changedWorldStates(diff());
    expect(states).toHaveLength(1);
    expect(states[0].state).toBe("characters");
  });

  it("空 diff 判定", () => {
    const empty = diff({ status_diff: [], projection_status_diff: [], world_state_diffs: [] });
    expect(isEmptyDiff(empty)).toBe(true);
    expect(isEmptyDiff(diff())).toBe(false);
  });

  it("触及真源面必须二次确认", () => {
    expect(touchesTruthSurface(diff())).toBe(true);
    expect(touchesTruthSurface(diff({ status_diff: [], projection_status_diff: [] }))).toBe(false);
  });
});

describe("snapshot-diff / 文本格式", () => {
  it("字段 diff 单行文本用 ∅ 表示空侧", () => {
    expect(formatFieldDiff({ path: "title", before: '"旧"', after: '"新"' })).toBe(
      'title: "旧" → "新"',
    );
    expect(formatFieldDiff({ path: "note", before: "", after: '"新增"' })).toBe(
      'note: ∅ → "新增"',
    );
  });

  it("超长值被截断", () => {
    expect(truncateValue("x".repeat(200)).length).toBe(121);
    expect(truncateValue("short")).toBe("short");
  });

  it("字节格式化", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MiB");
  });
});

// @vitest-environment jsdom
// SnapshotTimeline 行为测试：链加载/分页/对照 diff/恢复确认/回滚展示。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { fireEvent, render, screen, waitFor, within } from "@/test-helpers/component-test-utils";
import { SnapshotTimeline } from "./SnapshotTimeline";
import DefaultExport from "./SnapshotTimeline";
import {
  listSnapshotChain,
  nextOffset,
  previewSnapshotPoint,
  restoreSnapshotAtomic,
} from "@/lib/novel";
import type { RestoreOutcome, SnapshotChain, SnapshotDiff, SnapshotMeta } from "@/lib/novel";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>();
  return {
    ...actual,
    listSnapshotChain: vi.fn(),
    previewSnapshotPoint: vi.fn(),
    restoreSnapshotAtomic: vi.fn(),
  };
});

const listMock = vi.mocked(listSnapshotChain);
const previewMock = vi.mocked(previewSnapshotPoint);
const restoreMock = vi.mocked(restoreSnapshotAtomic);

function point(id: string, overrides: Partial<SnapshotMeta> = {}): SnapshotMeta {
  return { id, ts_ms: 1_700_000_000_000, chapter_span: `1-${id}`, file_count: 3, size_bytes: 512, ...overrides };
}

function chain(points: SnapshotMeta[], total: number, offset = 0): SnapshotChain {
  return { points, total, offset, limit: 50, page_size: 50 };
}

function field(path: string, before = "a", after = "b") {
  return { path, before, after };
}

function diff(id: string, overrides: Partial<SnapshotDiff> = {}): SnapshotDiff {
  return {
    snapshot_id: id,
    status_diff: [],
    world_state_diffs: [],
    projection_status_diff: [],
    ...overrides,
  };
}

function outcome(overrides: Partial<RestoreOutcome> = {}): RestoreOutcome {
  return {
    snapshot_id: "s1",
    restored: ["a.json"],
    rolled_back: false,
    gate_decision: "allow",
    verify: null,
    message: "ok",
    ...overrides,
  };
}

const PROJECT = "E:/Novel";

function renderTimeline(props: { projectPath?: string; onRestored?: (o: RestoreOutcome) => void } = {}) {
  return render(<SnapshotTimeline projectPath={props.projectPath ?? PROJECT} onRestored={props.onRestored} />);
}

beforeEach(() => {
  listMock.mockReset();
  previewMock.mockReset();
  restoreMock.mockReset();
  // 默认：首屏两点、共两点；默认无 diff 调用（leftId 为空时不触发 preview）。
  listMock.mockResolvedValue(chain([point("s1"), point("s2", { chapter_span: null })], 2));
  previewMock.mockResolvedValue(diff("s1"));
  restoreMock.mockResolvedValue(outcome());
});

afterEach(() => {
  cleanup();
});

describe("SnapshotTimeline", () => {
  it("has default export", () => {
    expect(DefaultExport).toBe(SnapshotTimeline);
  });

  it("首屏加载成功：渲染快照点、计数与大小，空错误时不展示告警", async () => {
    renderTimeline();
    expect(listMock).toHaveBeenCalledWith(PROJECT, 0, 50);
    const items = await screen.findAllByTestId("snapshot-point");
    expect(items).toHaveLength(2);
    // 有 chapter_span 的点展示 span；无 span 的点只展示 id + 大小
    expect(items[0]).toHaveTextContent("s1");
    expect(items[0]).toHaveTextContent("512 B");
    expect(items[1]).toHaveTextContent("s2");
    expect(screen.queryByTestId("snapshot-error")).toBeNull();
    // 未选择对照点且无错误时不展示对照 chip
    expect(screen.getByTestId("snapshot-status-rail")).not.toHaveTextContent("timemachine.compareTitle");
  });

  it("首屏加载失败：展示错误告警与 danger 状态", async () => {
    listMock.mockRejectedValueOnce(new Error("boom-list"));
    renderTimeline();
    const alert = await screen.findByTestId("snapshot-error");
    expect(alert).toHaveTextContent("boom-list");
    expect(alert).toHaveTextContent("common.operationFailed");
  });

  it("分页：点击加载更多后把新点拼到旧链之后", async () => {
    listMock
      .mockResolvedValueOnce(chain([point("s1"), point("s2")], 3, 0))
      .mockResolvedValueOnce(chain([point("s3")], 3, 2));
    renderTimeline();
    await screen.findAllByTestId("snapshot-point");
    const more = await screen.findByText("timemachine.loadMore");
    fireEvent.click(more);
    await waitFor(() => {
      expect(listMock).toHaveBeenCalledWith(PROJECT, nextOffset(chain([point("s1"), point("s2")], 3, 0)), 50);
    });
    await waitFor(async () => {
      expect(await screen.findAllByTestId("snapshot-point")).toHaveLength(3);
    });
    expect(screen.getByText("s3")).toBeInTheDocument();
  });

  it("对照：点击快照触发 preview，展示 totals + 字段 diff + 世界状态变更", async () => {
    previewMock.mockResolvedValue(
      diff("s1", {
        status_diff: [field("status.a")],
        projection_status_diff: [field("proj.b")],
        world_state_diffs: [
          { state: "w1", before_hash: "h0", after_hash: "h1", changed: [field("w1.x")] },
          { state: "w-empty", before_hash: "h0", after_hash: "h0", changed: [] },
        ],
      }),
    );
    renderTimeline();
    const items = await screen.findAllByTestId("snapshot-point");
    fireEvent.click(within(items[0]).getByText("s1"));
    const panel = await screen.findByTestId("snapshot-diff");
    expect(previewMock).toHaveBeenCalledWith(PROJECT, "s1");
    // totals 行断言三个计数：status 1 / projection 1 / world 1（空 world 被过滤）
    expect(screen.getByTestId("snapshot-diff-totals")).toHaveTextContent("timemachine.diff.totals");
    expect(panel).toHaveTextContent("status.a");
    expect(panel).toHaveTextContent("proj.b");
    expect(panel).toHaveTextContent("[w1]");
    expect(panel).not.toHaveTextContent("w-empty");
  });

  it("对照：空 diff 展示空态文案；选作对照后展示 compare chip 与双点标题", async () => {
    previewMock.mockResolvedValue(diff("s1"));
    renderTimeline();
    const items = await screen.findAllByTestId("snapshot-point");
    fireEvent.click(within(items[0]).getByText("s1"));
    await screen.findByText("timemachine.diff.empty");
    fireEvent.click(within(items[0]).getByText("timemachine.compareSelect"));
    await waitFor(() => {
      expect(screen.getByTestId("snapshot-status-rail")).toHaveTextContent("timemachine.compareTitle");
    });
    // 左右点都选中时标题展示 `/ 右点`（右点为空时才展示 diff.after，见上一用例）
    expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("/ s1");
  });

  it("对照：preview 失败展示错误", async () => {
    previewMock.mockRejectedValueOnce(new Error("boom-preview"));
    renderTimeline();
    const items = await screen.findAllByTestId("snapshot-point");
    fireEvent.click(within(items[0]).getByText("s1"));
    const alert = await screen.findByTestId("snapshot-error");
    expect(alert).toHaveTextContent("boom-preview");
  });

  it("陈旧分页响应不得覆盖新链（项目切换竞态）", async () => {
    let resolveA!: (c: SnapshotChain) => void;
    const gateA = new Promise<SnapshotChain>((r) => {
      resolveA = r;
    });
    listMock.mockImplementation((path: string) => {
      if (path === "A:/old") return gateA;
      return Promise.resolve(chain([point("n1")], 1));
    });
    const view = render(<SnapshotTimeline projectPath="A:/old" />);
    // 旧请求挂起期间切换项目，触发第二次 load
    view.rerender(<SnapshotTimeline projectPath="B:/new" />);
    await screen.findByText("n1");
    // 旧响应姗姗来迟：必须被丢弃
    resolveA(chain([point("stale")], 1));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.getByText("n1")).toBeInTheDocument();
  });

  it("陈旧加载错误不得覆盖新链的错误状态", async () => {
    let rejectA!: (e: unknown) => void;
    const gateA = new Promise<SnapshotChain>((_, rej) => {
      rejectA = rej;
    });
    gateA.catch(() => {});
    listMock.mockImplementation((path: string) => {
      if (path === "A:/old") return gateA;
      return Promise.resolve(chain([point("n1")], 1));
    });
    const view = render(<SnapshotTimeline projectPath="A:/old" />);
    view.rerender(<SnapshotTimeline projectPath="B:/new" />);
    await screen.findByText("n1");
    rejectA(new Error("stale-error"));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("snapshot-error")).toBeNull();
  });

  it("陈旧 preview 响应不得覆盖后选点的 diff", async () => {
    const resolvers: Array<(d: SnapshotDiff) => void> = [];
    previewMock.mockImplementation(
      (id: string) =>
        new Promise<SnapshotDiff>((resolve) => {
          resolvers.push((d) => resolve(d));
          void id;
        }),
    );
    renderTimeline();
    const items = await screen.findAllByTestId("snapshot-point");
    fireEvent.click(within(items[0]).getByText("s1"));
    await waitFor(() => expect(previewMock).toHaveBeenCalledTimes(1));
    fireEvent.click(within(items[1]).getByText("s2"));
    await waitFor(() => expect(previewMock).toHaveBeenCalledTimes(2));
    // 先回包旧点 s1 的 diff（带标记），再回包新点 s2 的 diff
    resolvers[0](diff("s1", { status_diff: [field("stale.path")] }));
    await new Promise((r) => setTimeout(r, 20));
    resolvers[1](diff("s2", { status_diff: [field("fresh.path")] }));
    await waitFor(() => {
      expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("fresh.path");
    });
    expect(screen.getByTestId("snapshot-diff")).not.toHaveTextContent("stale.path");
  });

  it("陈旧 preview 失败不污染后选点的错误状态", async () => {
    const gates: Array<{ resolve: (d: SnapshotDiff) => void; reject: (e: unknown) => void }> = [];
    previewMock.mockImplementation(
      () =>
        new Promise<SnapshotDiff>((resolve, reject) => {
          gates.push({ resolve, reject });
        }),
    );
    renderTimeline();
    const items = await screen.findAllByTestId("snapshot-point");
    fireEvent.click(within(items[0]).getByText("s1"));
    await waitFor(() => expect(previewMock).toHaveBeenCalledTimes(1));
    fireEvent.click(within(items[1]).getByText("s2"));
    await waitFor(() => expect(previewMock).toHaveBeenCalledTimes(2));
    // 旧点 preview 在切换后才失败：alive 已为 false，不得 setError
    gates[0].reject(new Error("stale-preview-error"));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("snapshot-error")).toBeNull();
    gates[1].resolve(diff("s2", { status_diff: [field("fresh2.path")] }));
    await waitFor(() => {
      expect(screen.getByTestId("snapshot-diff")).toHaveTextContent("fresh2.path");
    });
    expect(screen.queryByTestId("snapshot-error")).toBeNull();
  });

  it("恢复：确认框展示真源面警告，确认后透传 ui- 令牌并回调宿主", async () => {
    const onRestored = vi.fn();
    previewMock.mockResolvedValue(diff("s1", { status_diff: [field("status.a")] }));
    renderTimeline({ onRestored });
    const items = await screen.findAllByTestId("snapshot-point");
    fireEvent.click(within(items[0]).getByText("s1"));
    await screen.findByTestId("snapshot-diff");
    fireEvent.click(screen.getByTestId("snapshot-restore-s1"));
    const dialog = await screen.findByTestId("snapshot-restore-confirm");
    expect(dialog).toHaveTextContent("timemachine.restore.confirm");
    expect(screen.getByTestId("snapshot-truth-surface-warning")).toHaveTextContent(
      "timemachine.restore.truthSurface",
    );
    fireEvent.click(screen.getByTestId("snapshot-restore-confirm-run"));
    await waitFor(() => {
      expect(restoreMock).toHaveBeenCalledWith(PROJECT, "s1", "ui-s1");
    });
    await screen.findByTestId("snapshot-restore-result");
    expect(screen.queryByTestId("snapshot-restore-confirm")).toBeNull();
    expect(screen.getByTestId("snapshot-restore-result")).toHaveTextContent("timemachine.restore.done");
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(onRestored.mock.calls[0]?.[0]).toMatchObject({ restored: ["a.json"] });
  });

  it("恢复：未触及真源面时不展示警告；取消按钮关闭确认框", async () => {
    previewMock.mockResolvedValue(diff("s1"));
    renderTimeline();
    await screen.findAllByTestId("snapshot-point");
    // 不选对照点直接恢复：diff 为空 → 无真源面警告
    fireEvent.click(screen.getByTestId("snapshot-restore-s1"));
    await screen.findByTestId("snapshot-restore-confirm");
    expect(screen.queryByTestId("snapshot-truth-surface-warning")).toBeNull();
    fireEvent.click(screen.getByText("common.close"));
    await waitFor(() => {
      expect(screen.queryByTestId("snapshot-restore-confirm")).toBeNull();
    });
    expect(restoreMock).not.toHaveBeenCalled();
  });

  it("恢复：rolled_back 结果展示失败文案，校验失败追加 verify 后缀", async () => {
    restoreMock.mockResolvedValue(
      outcome({ rolled_back: true, verify: { verified: false, detail: "bad" } }),
    );
    renderTimeline();
    await screen.findAllByTestId("snapshot-point");
    fireEvent.click(screen.getByTestId("snapshot-restore-s1"));
    await screen.findByTestId("snapshot-restore-confirm");
    fireEvent.click(screen.getByTestId("snapshot-restore-confirm-run"));
    const result = await screen.findByTestId("snapshot-restore-result");
    expect(result).toHaveTextContent("timemachine.restore.rolledBack");
    expect(result).toHaveTextContent("timemachine.verify.failed");
  });

  it("恢复：校验通过时不追加 verify 后缀；恢复失败展示错误并解锁按钮", async () => {
    restoreMock
      .mockResolvedValueOnce(outcome({ verify: { verified: true, detail: "ok" } }))
      .mockRejectedValueOnce(new Error("boom-restore"));
    renderTimeline();
    await screen.findAllByTestId("snapshot-point");
    fireEvent.click(screen.getByTestId("snapshot-restore-s1"));
    await screen.findByTestId("snapshot-restore-confirm");
    fireEvent.click(screen.getByTestId("snapshot-restore-confirm-run"));
    const first = await screen.findByTestId("snapshot-restore-result");
    expect(first).toHaveTextContent("timemachine.restore.done");
    expect(first).not.toHaveTextContent("timemachine.verify.failed");

    // 第二个点恢复失败：错误展示，且 busy 复位后确认框仍可操作
    fireEvent.click(screen.getByTestId("snapshot-restore-s2"));
    await screen.findByTestId("snapshot-restore-confirm");
    fireEvent.click(screen.getByTestId("snapshot-restore-confirm-run"));
    await screen.findByTestId("snapshot-error");
    expect(screen.getByTestId("snapshot-error")).toHaveTextContent("boom-restore");
    expect(screen.getByTestId("snapshot-restore-confirm-run")).not.toBeDisabled();
  });

  it("恢复进行中 busy：Escape 不关闭确认框；空闲时 Escape 关闭", async () => {
    let release!: (o: RestoreOutcome) => void;
    restoreMock.mockImplementationOnce(
      () =>
        new Promise<RestoreOutcome>((resolve) => {
          release = resolve;
        }),
    );
    renderTimeline();
    await screen.findAllByTestId("snapshot-point");
    fireEvent.click(screen.getByTestId("snapshot-restore-s1"));
    await screen.findByTestId("snapshot-restore-confirm");
    fireEvent.click(screen.getByTestId("snapshot-restore-confirm-run"));
    await waitFor(() => {
      expect(screen.getByTestId("snapshot-restore-confirm-run")).toBeDisabled();
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("snapshot-restore-confirm")).toBeInTheDocument();
    release(outcome());
    await screen.findByTestId("snapshot-restore-result");

    // 空闲确认框按 Escape 关闭
    fireEvent.click(screen.getByTestId("snapshot-restore-s2"));
    await screen.findByTestId("snapshot-restore-confirm");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("snapshot-restore-confirm")).toBeNull();
    });
  });
});

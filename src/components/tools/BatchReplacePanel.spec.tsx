// @vitest-environment jsdom
/** BatchReplacePanel 行为测试（TASK-029：替代 C4 空壳；与 batch-replace-panel.spec.tsx 互补）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  fireEvent,
  render,
  screen,
  setupDomGlobals,
  waitFor,
} from "@/test-helpers/component-test-utils";
import { BatchReplacePanel } from "./BatchReplacePanel";
import { useWikiStore } from "@/stores/wiki-store";

const mocks = vi.hoisted(() => ({
  queryCanonEdges: vi.fn(),
  previewBatchReplace: vi.fn(),
  applyBatchReplace: vi.fn(),
  preflightCanonEdgeGate: vi.fn(),
  t: vi.fn((key: string, opts?: Record<string, unknown>) =>
    opts?.detail !== undefined ? `${key}:${String(opts.detail)}` : key,
  ),
}));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}));

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>();
  return {
    ...actual,
    queryCanonEdges: mocks.queryCanonEdges,
    previewBatchReplace: mocks.previewBatchReplace,
    applyBatchReplace: mocks.applyBatchReplace,
    preflightCanonEdgeGate: mocks.preflightCanonEdgeGate,
  };
});

const DIFF_OK = [
  {
    path: "book/c1.md",
    replacements: 2,
    changes: [{ line: 1, before: "林舟走进屋。", after: "林舟舟走进屋。" }],
  },
];

function renderPanel(targets: string[] = ["book/c1.md"]) {
  return render(<BatchReplacePanel projectPath="C:/proj" targets={targets} />);
}

async function setFindReplace(find: string, replace: string) {
  fireEvent.change(screen.getByTestId("batchreplace-find"), { target: { value: find } });
  fireEvent.change(screen.getByTestId("batchreplace-replace"), { target: { value: replace } });
}

beforeEach(() => {
  setupDomGlobals();
  useWikiStore.getState().setNovelConfig({ preWriteGateMode: "warn" });
  mocks.queryCanonEdges.mockReset();
  mocks.previewBatchReplace.mockReset();
  mocks.applyBatchReplace.mockReset();
  mocks.preflightCanonEdgeGate.mockReset();
  mocks.queryCanonEdges.mockResolvedValue([]);
  mocks.preflightCanonEdgeGate.mockReturnValue({ state: "PASS", conflicts: [], notes: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useWikiStore.getState().setNovelConfig({ preWriteGateMode: "warn" });
});

describe("BatchReplacePanel — 空态与预览", () => {
  it("未预览时显示引导，不显示结论区", () => {
    renderPanel();
    expect(screen.getByTestId("batchreplace-empty-hint")).toBeTruthy();
    expect(screen.queryByTestId("batchreplace-summary")).toBeNull();
    expect(screen.queryByTestId("batchreplace-safety")).toBeNull();
    expect(screen.queryByTestId("batchreplace-canon-gate-state")).toBeNull();
  });

  it("预览成功：摘要计数 + 文件列表 + 门 PASS", async () => {
    mocks.previewBatchReplace.mockResolvedValue(DIFF_OK);
    renderPanel();
    await setFindReplace("林舟", "林舟舟");
    fireEvent.click(screen.getByTestId("batchreplace-preview"));
    await waitFor(() => expect(mocks.previewBatchReplace).toHaveBeenCalled());
    // 摘要出现（非 none 分支）
    expect(await screen.findByTestId("batchreplace-summary")).toBeTruthy();
    // 文件列表渲染命中文件
    await waitFor(() => {
      expect(screen.getByTestId("batchreplace-files").textContent).toContain("book/c1.md");
    });
    // 门 PASS：state=ready 显示 label
    const gate = await screen.findByTestId("batchreplace-canon-gate-state");
    await waitFor(() => expect(gate).toHaveAttribute("data-state", "PASS"));
    expect(screen.queryByTestId("batchreplace-canon-gate")).toBeNull();
  });

  it("空 find 预览：既有边直接 ready([])，safety 报 empty_find_text", async () => {
    mocks.previewBatchReplace.mockResolvedValue([]);
    renderPanel();
    await setFindReplace("", "x");
    fireEvent.click(screen.getByTestId("batchreplace-preview"));
    await waitFor(() => expect(mocks.previewBatchReplace).toHaveBeenCalled());
    // 空 find 不查 canon，直接 ready
    expect(mocks.queryCanonEdges).not.toHaveBeenCalled();
    const safety = await screen.findByTestId("batchreplace-safety");
    expect(safety.textContent).toBeTruthy();
    // 空结果摘要走 none 分支
    expect(screen.getByTestId("batchreplace-summary")).toBeTruthy();
  });

  it("unsafe_path 结论带 detail（formatReason 插值分支）", async () => {
    mocks.previewBatchReplace.mockResolvedValue([
      { path: "/abs/evil.md", replacements: 1, changes: [{ line: 1, before: "a", after: "b" }] },
    ]);
    renderPanel();
    await setFindReplace("a", "b");
    fireEvent.click(screen.getByTestId("batchreplace-preview"));
    const safety = await screen.findByTestId("batchreplace-safety");
    await waitFor(() => {
      expect(safety.textContent).toContain("/abs/evil.md");
    });
  });

  it("预览失败 → status error", async () => {
    mocks.previewBatchReplace.mockRejectedValue(new Error("preview-boom"));
    renderPanel();
    await setFindReplace("a", "b");
    fireEvent.click(screen.getByTestId("batchreplace-preview"));
    await waitFor(() => {
      expect(screen.getByTestId("batchreplace-status")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByTestId("batchreplace-status").getAttribute("data-phase")).toBe("error");
    });
  });

  it("门就绪后显示模式标签（ready 分支）", async () => {
    mocks.previewBatchReplace.mockResolvedValue(DIFF_OK);
    renderPanel();
    await setFindReplace("林舟", "林舟舟");
    fireEvent.click(screen.getByTestId("batchreplace-preview"));
    await waitFor(() => expect(mocks.previewBatchReplace).toHaveBeenCalled());
    const gate = await screen.findByTestId("batchreplace-canon-gate-state");
    await waitFor(() => expect(gate).toHaveAttribute("data-state", "PASS"));
    expect(gate).toHaveAttribute("data-mode", "warn");
  });
});

describe("BatchReplacePanel — 提交分支", () => {
  it("提交成功 → applied", async () => {
    mocks.previewBatchReplace.mockResolvedValue(DIFF_OK);
    mocks.applyBatchReplace.mockResolvedValue({ total_replacements: 2, drafts: [{ id: "d1" }] });
    renderPanel();
    await setFindReplace("林舟", "林舟舟");
    fireEvent.click(screen.getByTestId("batchreplace-preview"));
    await waitFor(() => expect(mocks.previewBatchReplace).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("batchreplace-apply"));
    await waitFor(() => expect(mocks.applyBatchReplace).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByTestId("batchreplace-status").getAttribute("data-phase")).toBe("applied");
    });
  });

  it("提交被确认门拦截 → confirm", async () => {
    mocks.previewBatchReplace.mockResolvedValue(DIFF_OK);
    mocks.applyBatchReplace.mockRejectedValue(new Error("GATE_REQUIRE_CONFIRM:abc"));
    renderPanel();
    await setFindReplace("林舟", "林舟舟");
    fireEvent.click(screen.getByTestId("batchreplace-preview"));
    await waitFor(() => expect(mocks.previewBatchReplace).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("batchreplace-apply"));
    await waitFor(() => {
      expect(screen.getByTestId("batchreplace-status").getAttribute("data-phase")).toBe("confirm");
    });
  });

  it("提交事务回滚 → rolledback + 回滚提示", async () => {
    mocks.previewBatchReplace.mockResolvedValue(DIFF_OK);
    mocks.applyBatchReplace.mockRejectedValue(new Error("BATCH_REPLACE_ROLLED_BACK"));
    renderPanel();
    await setFindReplace("林舟", "林舟舟");
    fireEvent.click(screen.getByTestId("batchreplace-preview"));
    await waitFor(() => expect(mocks.previewBatchReplace).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("batchreplace-apply"));
    await waitFor(() => {
      expect(screen.getByTestId("batchreplace-status").getAttribute("data-phase")).toBe("rolledback");
    });
    expect(screen.getByTestId("batchreplace-rollback-notice")).toBeTruthy();
  });

  it("提交被拒绝 → denied", async () => {
    mocks.previewBatchReplace.mockResolvedValue(DIFF_OK);
    mocks.applyBatchReplace.mockRejectedValue(new Error("GATE_DENIED:nope"));
    renderPanel();
    await setFindReplace("林舟", "林舟舟");
    fireEvent.click(screen.getByTestId("batchreplace-preview"));
    await waitFor(() => expect(mocks.previewBatchReplace).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("batchreplace-apply"));
    await waitFor(() => {
      expect(screen.getByTestId("batchreplace-status").getAttribute("data-phase")).toBe("denied");
    });
  });

  it("提交未知错误 → error", async () => {
    mocks.previewBatchReplace.mockResolvedValue(DIFF_OK);
    mocks.applyBatchReplace.mockRejectedValue(new Error("disk-gone"));
    renderPanel();
    await setFindReplace("林舟", "林舟舟");
    fireEvent.click(screen.getByTestId("batchreplace-preview"));
    await waitFor(() => expect(mocks.previewBatchReplace).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("batchreplace-apply"));
    await waitFor(() => {
      expect(screen.getByTestId("batchreplace-status").getAttribute("data-phase")).toBe("error");
    });
  });

  it("BLOCK 门禁用提交按钮", async () => {
    mocks.previewBatchReplace.mockResolvedValue(DIFF_OK);
    mocks.preflightCanonEdgeGate.mockReturnValue({ state: "BLOCK", conflicts: [], notes: [] });
    renderPanel();
    await setFindReplace("林舟", "林舟舟");
    fireEvent.click(screen.getByTestId("batchreplace-preview"));
    await waitFor(() => expect(mocks.previewBatchReplace).toHaveBeenCalled());
    await waitFor(() => {
      expect((screen.getByTestId("batchreplace-apply") as HTMLButtonElement).disabled).toBe(true);
    });
  });
});

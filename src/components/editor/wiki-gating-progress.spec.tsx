// @vitest-environment jsdom
/** ChapterGatingProgress 行为测试（TASK-034：替代 C4 空壳）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  render,
  screen,
  setupDomGlobals,
  waitFor,
} from "@/test-helpers/component-test-utils";
import { ChapterGatingProgress } from "./wiki-gating-progress";
import { useWikiStore } from "@/stores/wiki-store";

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
}));

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>();
  return { ...actual, listDirectory: mocks.listDirectory };
});

function md(name: string, path: string, children?: unknown[]) {
  return { name, path, is_dir: false, children };
}

beforeEach(() => {
  setupDomGlobals();
  mocks.listDirectory.mockReset();
  const s = useWikiStore.getState();
  s.setNovelMode(true);
  s.setProject({ id: "p1", name: "Book", path: "/proj" } as never);
  s.clearThrillSoftGateAcknowledged(undefined as never);
  s.setNovelConfig({
    stateDeltaLightCheckEnabled: true,
    exemplarEnabled: true,
    literaryPolishAfterGate: false,
  } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  const s = useWikiStore.getState();
  s.setNovelMode(true);
  s.setProject(null);
  s.clearThrillSoftGateAcknowledged(undefined as never);
});

describe("ChapterGatingProgress — 非 novel 模式", () => {
  it("novelMode 关闭不渲染", () => {
    useWikiStore.getState().setNovelMode(false);
    const { container } = render(<ChapterGatingProgress totalChapters={5} acknowledgedChapters={2} />);
    expect(container.querySelector('[data-testid="wiki-gating-progress"]')).toBeNull();
    useWikiStore.getState().setNovelMode(true);
  });
});

describe("ChapterGatingProgress — 受控 props", () => {
  it("渲染比例/百分比/进度条与三门控开关", () => {
    render(<ChapterGatingProgress totalChapters={4} acknowledgedChapters={1} />);
    expect(screen.getByTestId("wiki-gating-progress")).toBeTruthy();
    expect(screen.getByTestId("wiki-gating-ratio").textContent).toContain("25");
    const bar = screen.getByTestId("wiki-gating-bar");
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    // 默认：一致性开、抗 AI 开、质量关
    expect(screen.getByTestId("wiki-gating-gate-consistency")).toHaveAttribute("data-on", "true");
    expect(screen.getByTestId("wiki-gating-gate-antiAi")).toHaveAttribute("data-on", "true");
    expect(screen.getByTestId("wiki-gating-gate-quality")).toHaveAttribute("data-on", "false");
  });

  it("门控开关跟随 novelConfig", () => {
    useWikiStore.getState().setNovelConfig({
      stateDeltaLightCheckEnabled: false,
      exemplarEnabled: false,
      literaryPolishAfterGate: true,
    } as never);
    render(<ChapterGatingProgress totalChapters={2} acknowledgedChapters={2} />);
    expect(screen.getByTestId("wiki-gating-gate-consistency")).toHaveAttribute("data-on", "false");
    expect(screen.getByTestId("wiki-gating-gate-antiAi")).toHaveAttribute("data-on", "false");
    expect(screen.getByTestId("wiki-gating-gate-quality")).toHaveAttribute("data-on", "true");
  });

  it("总数为 0 时百分比为 0（除零守卫）", () => {
    render(<ChapterGatingProgress totalChapters={0} acknowledgedChapters={0} />);
    expect(screen.getByTestId("wiki-gating-bar").getAttribute("aria-valuenow")).toBe("0");
  });

  it("acknowledged 缺省时从 store 派生", () => {
    useWikiStore.getState().setThrillSoftGateAcknowledged(1, true);
    useWikiStore.getState().setThrillSoftGateAcknowledged(2, true);
    useWikiStore.getState().setThrillSoftGateAcknowledged(3, false);
    render(<ChapterGatingProgress totalChapters={4} />);
    expect(screen.getByTestId("wiki-gating-ratio").textContent).toContain("50");
  });
});

describe("ChapterGatingProgress — 目录读取", () => {
  it("从 wiki/chapters 读取总数并过滤草稿/非 md", async () => {
    mocks.listDirectory.mockResolvedValue([
      md("c01.md", "/proj/wiki/chapters/c01.md"),
      md("c02.md", "/proj/wiki/chapters/c02.md"),
      md("c03.draft.md", "/proj/wiki/chapters/c03.draft.md"),
      md("note.txt", "/proj/wiki/chapters/note.txt"),
    ]);
    render(<ChapterGatingProgress acknowledgedChapters={1} />);
    await waitFor(() => expect(mocks.listDirectory).toHaveBeenCalledWith("/proj/wiki/chapters"));
    await waitFor(() => {
      // 草稿与非 md 被过滤 → 总数 2，通过 1 → 50%
      expect(screen.getByTestId("wiki-gating-bar").getAttribute("aria-valuenow")).toBe("50");
    });
  });

  it("读取失败 → 总数 0", async () => {
    mocks.listDirectory.mockRejectedValue(new Error("no-dir"));
    render(<ChapterGatingProgress acknowledgedChapters={0} />);
    await waitFor(() => expect(mocks.listDirectory).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByTestId("wiki-gating-bar").getAttribute("aria-valuenow")).toBe("0");
    });
  });

  it("无项目路径时不读取", () => {
    useWikiStore.getState().setProject(null);
    render(<ChapterGatingProgress acknowledgedChapters={0} />);
    expect(mocks.listDirectory).not.toHaveBeenCalled();
  });

  it("卸载后目录回包不再 setState（cancelled 守卫）", async () => {
    let resolveList!: (v: unknown[]) => void;
    mocks.listDirectory.mockReturnValue(
      new Promise<unknown[]>((r) => {
        resolveList = r;
      }),
    );
    const { unmount } = render(<ChapterGatingProgress acknowledgedChapters={0} />);
    expect(mocks.listDirectory).toHaveBeenCalled();
    unmount();
    resolveList([]);
    await new Promise((r) => setTimeout(r, 20));
  });

  it("卸载后目录报错也不再 setState（catch 内 cancelled 守卫）", async () => {
    let rejectList!: (e: unknown) => void;
    mocks.listDirectory.mockReturnValue(
      new Promise<unknown[]>((_, rej) => {
        rejectList = rej;
      }),
    );
    const { unmount } = render(<ChapterGatingProgress acknowledgedChapters={0} />);
    unmount();
    rejectList(new Error("late-fail"));
    await new Promise((r) => setTimeout(r, 20));
  });

  it("受控 totalChapters 优先于目录读取", () => {
    render(<ChapterGatingProgress totalChapters={8} acknowledgedChapters={4} />);
    expect(mocks.listDirectory).not.toHaveBeenCalled();
    expect(screen.getByTestId("wiki-gating-bar").getAttribute("aria-valuenow")).toBe("50");
  });
});

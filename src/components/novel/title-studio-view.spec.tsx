// @vitest-environment jsdom
/**
 * title-studio-view.spec.tsx — 标题工坊视图契约（机械筛选，无 LLM 许诺）。
 *
 * 覆盖：
 *   1. 无种子（title_seed.json 缺失）→ 诚实空态 title-empty，不造条目；
 *   2. 有种子 → 种子模式列表（pattern＋constraints）渲染，无空态；
 *   3. 输入候选＋「筛选」→ 通过/淘汰两组结果＋逐条命中明细；
 *   4. 空输入点筛选 → 提示而不出假结果；
 *   5. projectPath 为空 → 空态，不崩。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { buildLibraryArtifact } from "@/lib/novel"
import { TitleStudioView } from "./title-studio-view"

/** 装载行为开关：real 走真 loadAssetLibraryArtifact；pending/reject 注入迟到与失败。 */
const loadBehavior = vi.hoisted(() => ({
  mode: "real" as "real" | "pending" | "reject",
  resolve: null as ((value: null) => void) | null,
  reject: null as ((reason: unknown) => void) | null,
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  const real = actual.loadAssetLibraryArtifact.bind(actual)
  return {
    ...actual,
    loadAssetLibraryArtifact: (
      ...args: Parameters<typeof actual.loadAssetLibraryArtifact>
    ) => {
      if (loadBehavior.mode === "reject") return Promise.reject(new Error("seed load boom"))
      if (loadBehavior.mode === "pending") {
        return new Promise<null>((resolve, reject) => {
          loadBehavior.resolve = resolve
          loadBehavior.reject = reject
        })
      }
      return real(...args)
    },
  }
})

const fs = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(async () => {
    throw new Error("ENOENT")
  }),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    readFile: fs.readFile,
  }
})

afterEach(() => {
  cleanup()
  fs.readFile.mockReset()
  fs.readFile.mockRejectedValue(new Error("ENOENT"))
  loadBehavior.mode = "real"
  loadBehavior.resolve = null
  loadBehavior.reject = null
})

/** 经 barrel 构造守恒合法的 title_seed.json（loadAssetLibraryArtifact 才会回显）。 */
function seedFileJson(): string {
  const artifact = buildLibraryArtifact({
    libraryId: "title_seed",
    generatorVersion: "spec-1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entries: [
      { entryId: "s1", pattern: "江湖", constraints: ["剑", "恩仇"], examples: [] },
      { entryId: "s2", pattern: "长安", constraints: ["灯火"], examples: [] },
    ],
  })
  return JSON.stringify(artifact)
}

describe("TitleStudioView", () => {
  it("无种子（文件缺失）→ 诚实空态 title-empty，不造条目、不出结果", async () => {
    render(<TitleStudioView projectPath="/p" />)
    await waitFor(() => expect(screen.getByTestId("title-empty")).toBeTruthy())
    expect(screen.getByTestId("title-studio-view")).toBeTruthy()
    expect(screen.getByTestId("title-empty").textContent).toContain("暂无标题种子")
    expect(screen.queryByTestId("title-seeds")).toBeNull()
    expect(screen.queryByTestId("title-result")).toBeNull()
  })

  it("有种子 → 种子模式列表渲染 pattern＋constraints，无空态", async () => {
    fs.readFile.mockResolvedValue(seedFileJson())
    render(<TitleStudioView projectPath="/p" />)
    await waitFor(() => expect(screen.getByTestId("title-seeds")).toBeTruthy())
    const seeds = screen.getByTestId("title-seeds")
    expect(seeds.textContent).toContain("江湖")
    expect(seeds.textContent).toContain("剑")
    expect(seeds.textContent).toContain("恩仇")
    expect(seeds.textContent).toContain("长安")
    expect(screen.getByTestId("title-seed-s1")).toBeTruthy()
    expect(screen.queryByTestId("title-empty")).toBeNull()
  })

  it("输入候选＋筛选 → 通过/淘汰分组＋逐条命中明细", async () => {
    fs.readFile.mockResolvedValue(seedFileJson())
    render(<TitleStudioView projectPath="/p" />)
    await waitFor(() => expect(screen.getByTestId("title-seeds")).toBeTruthy())
    fireEvent.change(screen.getByTestId("title-input"), {
      target: { value: "江湖剑恩仇传\n星际远航" },
    })
    fireEvent.click(screen.getByTestId("title-filter"))
    await waitFor(() => expect(screen.getByTestId("title-result")).toBeTruthy())
    expect(screen.getByTestId("title-admitted").textContent).toContain("江湖剑恩仇传")
    expect(screen.getByTestId("title-rejected").textContent).toContain("星际远航")
    // 命中明细：约束锚逐条对账（命中/缺失均留证据）
    expect(screen.getByTestId("title-result").textContent).toContain("命中约束锚「剑」")
    expect(screen.getByTestId("title-result").textContent).toContain("no_seed_pattern_match")
  })

  it("空输入点筛选 → 提示而不出假结果", async () => {
    fs.readFile.mockResolvedValue(seedFileJson())
    render(<TitleStudioView projectPath="/p" />)
    await waitFor(() => expect(screen.getByTestId("title-seeds")).toBeTruthy())
    fireEvent.click(screen.getByTestId("title-filter"))
    expect(screen.queryByTestId("title-result")).toBeNull()
    expect(screen.getByTestId("title-hint").textContent).toContain("每行一个")
  })

  it("projectPath 为空 → 空态，不崩", async () => {
    render(<TitleStudioView projectPath="" />)
    await waitFor(() => expect(screen.getByTestId("title-empty")).toBeTruthy())
    expect(screen.queryByTestId("title-seeds")).toBeNull()
  })
})

describe("TitleStudioView · 分支补齐", () => {
  it("模式命中但约束不足 → below_min_constraint_hits，且通过组为空时显「无」", async () => {
    fs.readFile.mockResolvedValue(seedFileJson())
    render(<TitleStudioView projectPath="/p" />)
    await waitFor(() => expect(screen.getByTestId("title-seeds")).toBeTruthy())
    fireEvent.change(screen.getByTestId("title-input"), { target: { value: "江湖传说" } })
    fireEvent.click(screen.getByTestId("title-filter"))
    await waitFor(() => expect(screen.getByTestId("title-result")).toBeTruthy())
    const rejected = screen.getByTestId("title-rejected")
    expect(rejected.textContent).toContain("江湖传说")
    expect(rejected.textContent).toContain("约束命中数不足")
    expect(rejected.textContent).toContain("below_min_constraint_hits")
    // 通过组为空 → 空态「无」而非空列表
    expect(screen.getByTestId("title-admitted").textContent).toContain("无")
  })

  it("无约束种子：种子行显「无约束」，结果行约束计数 0/0 且无逐条明细", async () => {
    const artifact = buildLibraryArtifact({
      libraryId: "title_seed",
      generatorVersion: "spec-1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      entries: [{ entryId: "s3", pattern: "星际", constraints: [], examples: [] }],
    })
    fs.readFile.mockResolvedValue(JSON.stringify(artifact))
    render(<TitleStudioView projectPath="/p" />)
    await waitFor(() => expect(screen.getByTestId("title-seeds")).toBeTruthy())
    expect(screen.getByTestId("title-seeds").textContent).toContain("无约束（仅按模式命中）")
    fireEvent.change(screen.getByTestId("title-input"), { target: { value: "星际远航" } })
    fireEvent.click(screen.getByTestId("title-filter"))
    await waitFor(() => expect(screen.getByTestId("title-result")).toBeTruthy())
    const result = screen.getByTestId("title-result")
    expect(result.textContent).toContain("星际远航")
    // 空约束的种子行：计数 0/0，且不渲染逐条约束明细列表
    expect(result.textContent).toContain("约束 0/0")
    expect(result.textContent).not.toContain("约束锚")
  })

  it("种子装载失败 → 诚实错误态（不臆造种子、不出结果）", async () => {
    loadBehavior.mode = "reject"
    render(<TitleStudioView projectPath="/p" />)
    await waitFor(() => expect(screen.getByTestId("title-error")).toBeTruthy())
    expect(screen.getByTestId("title-error").textContent).toContain("seed load boom")
    expect(screen.queryByTestId("title-seeds")).toBeNull()
    expect(screen.queryByTestId("title-result")).toBeNull()
  })

  it("卸载后迟到的装载成功被丢弃（取消守卫，不写已卸载状态）", async () => {
    loadBehavior.mode = "pending"
    const { unmount } = render(<TitleStudioView projectPath="/p" />)
    await waitFor(() => expect(screen.getByTestId("title-loading")).toBeTruthy())
    unmount()
    await act(async () => {
      loadBehavior.resolve?.(null)
    })
    expect(screen.queryByTestId("title-studio-view")).toBeNull()
  })

  it("卸载后迟到的装载失败同样被丢弃", async () => {
    loadBehavior.mode = "pending"
    const { unmount } = render(<TitleStudioView projectPath="/p" />)
    await waitFor(() => expect(screen.getByTestId("title-loading")).toBeTruthy())
    unmount()
    await act(async () => {
      loadBehavior.reject?.(new Error("late boom"))
      // 让拒绝 microtask 落定：catch 分支看到 cancelled 后直接返回
      await Promise.resolve()
    })
    expect(screen.queryByTestId("title-studio-view")).toBeNull()
    expect(screen.queryByTestId("title-error")).toBeNull()
  })
})

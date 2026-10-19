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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { buildLibraryArtifact } from "@/lib/novel"
import { TitleStudioView } from "./title-studio-view"

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

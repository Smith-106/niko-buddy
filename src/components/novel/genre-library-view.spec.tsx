// @vitest-environment jsdom
/**
 * genre-library-view.spec.tsx — 题材基底库视图（只读浏览）契约。
 *
 * 覆盖：
 *   1. 快照缺失（readFile 抛错 → present:false）→ 诚实标注「未生成」，分类树照常可浏览；
 *   2. 快照存在（readFile 返回 genre_base 产物）→ 显示已生成 / 条目数 / 内容哈希；
 *   3. 男女频切换 → 主分类与子类型随频道更换（切换后选中各频道首个主分类）；
 *   4. 主分类切换 → 子类型树随选择更换，且子类型只渲染 label；
 *   5. 频道内 18 主分类 + 汇总行；
 *   6. 显式注入快照 → 跳过磁盘装载（不调用 readFile）。
 *
 * 磁盘统一经 `@/commands/fs` 的 readFile（store 默认 deps），此处只 mock 该模块。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: vi.fn() }
})

import { readFile } from "@/commands/fs"
import { buildLibraryArtifact } from "@/lib/novel"
import { GenreLibraryView } from "./genre-library-view"

const readFileMock = vi.mocked(readFile)

afterEach(cleanup)

beforeEach(() => {
  readFileMock.mockReset()
})

describe("GenreLibraryView", () => {
  it("快照缺失 → 诚实标注「未生成」，分类树照常可浏览", async () => {
    readFileMock.mockRejectedValue(new Error("missing"))
    render(<GenreLibraryView projectPath="C:/proj" />)
    await waitFor(() => expect(screen.getByTestId("genre-empty")).toBeTruthy())
    expect(screen.getByTestId("genre-library-view")).toBeTruthy()
    expect(screen.getByTestId("genre-snapshot")).toBeTruthy()
    expect(screen.getByTestId("genre-empty").textContent).toContain("未生成")
    expect(screen.queryByTestId("genre-snapshot-present")).toBeNull()
    // 静态树不受快照缺失影响：默认男频首个主分类「玄幻」及其子类型可见。
    expect(screen.getByTestId("genre-tree")).toBeTruthy()
    expect(screen.getByTestId("genre-main-xuanhuan").textContent).toContain("玄幻")
    expect(screen.getByTestId("genre-sub-system").textContent).toBe("系统流")
  })

  it("快照存在 → 显示已生成 / 条目数 / 内容哈希", async () => {
    const artifact = buildLibraryArtifact({
      libraryId: "genre_base",
      generatorVersion: "spec-1",
      generatedAt: "2026-10-19T00:00:00.000Z",
      entries: [
        {
          entryId: "g1",
          name: "玄幻·系统流",
          toneTags: ["热血"],
          forbidPatterns: ["某某"],
          plotBeats: ["开局"],
        },
        { entryId: "g2", name: "古代言情·宫斗", toneTags: [], forbidPatterns: [], plotBeats: [] },
      ],
    })
    readFileMock.mockResolvedValue(JSON.stringify(artifact))
    render(<GenreLibraryView projectPath="C:/proj" />)
    await waitFor(() => expect(screen.getByTestId("genre-snapshot-present")).toBeTruthy())
    expect(screen.getByTestId("genre-snapshot-present").textContent).toContain("已生成")
    expect(screen.getByTestId("genre-snapshot-count").textContent).toContain("2 条")
    expect(screen.getByTestId("genre-snapshot-hash").textContent).toContain(artifact.contentHash)
    expect(screen.queryByTestId("genre-empty")).toBeNull()
  })

  it("男女频切换 → 主分类与子类型随频道更换", async () => {
    readFileMock.mockRejectedValue(new Error("missing"))
    render(<GenreLibraryView projectPath="C:/proj" />)
    await waitFor(() => expect(screen.getByTestId("genre-empty")).toBeTruthy())
    expect(screen.getByTestId("genre-main-xuanhuan")).toBeTruthy()
    fireEvent.click(screen.getByTestId("genre-channel-female"))
    expect(screen.getByTestId("genre-main-gudaiyanqing").textContent).toContain("古代言情")
    expect(screen.queryByTestId("genre-main-xuanhuan")).toBeNull()
    // 切换频道后自动选中女频首个主分类，其子类型可见。
    expect(screen.getByTestId("genre-sub-gudai_chuanyue").textContent).toBe("穿越重生")
    fireEvent.click(screen.getByTestId("genre-channel-male"))
    expect(screen.getByTestId("genre-main-xuanhuan")).toBeTruthy()
    expect(screen.queryByTestId("genre-main-gudaiyanqing")).toBeNull()
  })

  it("主分类切换 → 子类型树随选择更换，且只渲染 label", async () => {
    readFileMock.mockRejectedValue(new Error("missing"))
    render(<GenreLibraryView projectPath="C:/proj" />)
    await waitFor(() => expect(screen.getByTestId("genre-empty")).toBeTruthy())
    fireEvent.click(screen.getByTestId("genre-main-xianxia"))
    const leaf = screen.getByTestId("genre-sub-xiuzhen")
    expect(leaf.textContent).toBe("修真文明")
    expect(leaf.children.length).toBe(0)
    expect(leaf.textContent).not.toContain("xiuzhen")
    expect(screen.queryByTestId("genre-sub-system")).toBeNull()
  })

  it("频道内 18 主分类 + 汇总行（男频/女频各 18）", async () => {
    readFileMock.mockRejectedValue(new Error("missing"))
    render(<GenreLibraryView projectPath="C:/proj" />)
    await waitFor(() => expect(screen.getByTestId("genre-tree-summary")).toBeTruthy())
    expect(screen.getByTestId("genre-tree-summary").textContent).toContain("男频")
    expect(screen.getByTestId("genre-tree-summary").textContent).toContain("18 主分类")
    fireEvent.click(screen.getByTestId("genre-channel-female"))
    expect(screen.getByTestId("genre-tree-summary").textContent).toContain("女频")
    expect(screen.getByTestId("genre-tree-summary").textContent).toContain("18 主分类")
  })

  it("显式注入快照 → 跳过磁盘装载", () => {
    render(
      <GenreLibraryView
        projectPath="C:/proj"
        snapshot={{
          libraryId: "genre_base",
          present: false,
          entryCount: 0,
          contentHash: null,
          schemaVersion: null,
          conserved: false,
          health: null,
        }}
      />,
    )
    expect(screen.getByTestId("genre-empty").textContent).toContain("未生成")
    expect(readFileMock).not.toHaveBeenCalled()
  })
})

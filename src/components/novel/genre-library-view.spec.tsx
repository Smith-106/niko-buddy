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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, readFile: vi.fn() }
})

import { readFile } from "@/commands/fs"
import {
  buildLibraryArtifact,
  loadAssetLibrarySnapshot,
  CHANNELS,
  type AssetLibrarySnapshot,
  type ChannelGenre,
} from "@/lib/novel"

// 覆盖补齐：装载失败分支经 barrel 注入（默认透传真实实现，既有用例行为不变）。
vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    loadAssetLibrarySnapshot: vi.fn((...args: Parameters<typeof actual.loadAssetLibrarySnapshot>) =>
      actual.loadAssetLibrarySnapshot(...args),
    ),
  }
})
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

describe("GenreLibraryView 覆盖补齐：空项目/装载抛错/兜底分支", () => {
  it("projectPath 为空且无注入 → 诚实未生成（不读盘）", () => {
    render(<GenreLibraryView projectPath="" />)
    expect(screen.getByTestId("genre-empty")).toBeTruthy()
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it("快照装载抛错（非缺失，是装载器异常）→ 诚实未生成（不崩）", async () => {
    vi.mocked(loadAssetLibrarySnapshot).mockRejectedValueOnce(new Error("store gone"))
    render(<GenreLibraryView projectPath="C:/proj" />)
    await waitFor(() => expect(screen.getByTestId("genre-empty")).toBeTruthy())
    expect(screen.getByTestId("genre-empty").textContent).toContain("未生成")
  })

  it("CHANNELS 缺 male → 启动即抛 genre channels missing（静态数据漂移兜底）", () => {
    const mutable = CHANNELS as unknown as unknown[]
    const backup = [...mutable]
    mutable.length = 0
    try {
      expect(() => render(<GenreLibraryView projectPath="C:/proj" snapshot={null} />)).toThrow(
        "genre channels missing",
      )
    } finally {
      mutable.push(...backup)
    }
    expect(CHANNELS.length).toBe(2)
  })
})

describe("GenreLibraryView 分支补齐：频道漂移回退/主分类空/迟到装载/快照字段", () => {
  const channels = () => CHANNELS as unknown as ChannelGenre[]
  const male = () => channels().find((channel) => channel.key === "male")

  const presentSnapshot = (entryCount: number): AssetLibrarySnapshot => ({
    libraryId: "genre_base",
    present: true,
    entryCount,
    contentHash: `hash-${entryCount}`,
    schemaVersion: "1",
    conserved: true,
    health: null,
  })

  it("女频数据缺失 → channelByKey 回退男频（不崩、不空屏）", () => {
    render(<GenreLibraryView projectPath="C:/proj" snapshot={null} />)
    const femaleButton = screen.getByTestId("genre-channel-female")
    const list = channels()
    const index = list.findIndex((channel) => channel.key === "female")
    const removed = list.splice(index, 1)[0]
    try {
      // 按钮上的 onClick 闭包仍持 "female"：此刻频道表里已无女频 → 走 fallback 男频。
      fireEvent.click(femaleButton)
      const summary = screen.getByTestId("genre-tree-summary").textContent ?? ""
      expect(summary).toContain("男频")
      expect(summary).toContain("18 主分类")
      expect(screen.getByTestId("genre-main-xuanhuan")).toBeTruthy()
      // 频道切换请求已生效（男频不再处于按下态），但展示的是回退后的男频树。
      expect(screen.getByTestId("genre-channel-male").getAttribute("aria-pressed")).toBe("false")
      expect(screen.queryByTestId("genre-channel-female")).toBeNull()
    } finally {
      channels().splice(index, 0, removed as ChannelGenre)
    }
    expect(channels().some((channel) => channel.key === "female")).toBe(true)
  })

  it("男频数据缺失（只剩女频）→ 启动即抛 genre channels missing（数据漂移兜底）", () => {
    const list = channels()
    const index = list.findIndex((channel) => channel.key === "male")
    const removed = list.splice(index, 1)[0]
    try {
      // find("male") 会逐个回调，但表里已无男频 → 诚实抛错而不是空树。
      expect(() => render(<GenreLibraryView projectPath="C:/proj" snapshot={null} />)).toThrow(
        "genre channels missing",
      )
    } finally {
      channels().splice(index, 0, removed as ChannelGenre)
    }
    expect(male()).toBeTruthy()
  })

  it("主分类为空（数据漂移）→ 0 主分类 0 子类型，不渲染下钻", () => {
    const target = male()
    if (!target) throw new Error("male channel missing")
    const backup = target.mainGenres
    target.mainGenres = []
    try {
      render(<GenreLibraryView projectPath="C:/proj" snapshot={null} />)
      expect(screen.getByTestId("genre-tree-summary").textContent).toContain("0 主分类 · 0 子类型")
      expect(screen.queryByTestId("genre-selected-main")).toBeNull()
      expect(screen.queryByTestId("genre-main-xuanhuan")).toBeNull()
    } finally {
      target.mainGenres = backup
    }
  })

  it("主分类漂移修复后 mainKey 失效 → 自动回退首个主分类", async () => {
    const target = male()
    if (!target) throw new Error("male channel missing")
    const backup = target.mainGenres
    const deferred: { resolve?: (value: AssetLibrarySnapshot) => void } = {}
    vi.mocked(loadAssetLibrarySnapshot).mockImplementationOnce(
      () =>
        new Promise<AssetLibrarySnapshot>((resolve) => {
          deferred.resolve = resolve
        }),
    )
    target.mainGenres = []
    try {
      render(<GenreLibraryView projectPath="C:/proj" />)
      // mainKey 在空表上落成 ""（首个主分类不存在）。
      expect(screen.queryByTestId("genre-main-xuanhuan")).toBeNull()
      // 数据恢复 → 下一次渲染时 mainKey 已失效，须回退首个主分类而不是空树。
      target.mainGenres = backup
      await act(async () => {
        deferred.resolve?.(presentSnapshot(1))
      })
      expect(screen.getByTestId("genre-selected-main").textContent).toBe("玄幻")
      expect(screen.getByTestId("genre-main-xuanhuan").getAttribute("aria-pressed")).toBe("true")
    } finally {
      target.mainGenres = backup
    }
  })

  it("切项目后旧项目的装载结果迟到 → 丢弃，不覆盖新项目", async () => {
    const deferred: { resolve?: (value: AssetLibrarySnapshot) => void } = {}
    vi.mocked(loadAssetLibrarySnapshot)
      .mockImplementationOnce(
        () =>
          new Promise<AssetLibrarySnapshot>((resolve) => {
            deferred.resolve = resolve
          }),
      )
      .mockResolvedValueOnce(presentSnapshot(2))
    const { rerender } = render(<GenreLibraryView projectPath="C:/a" />)
    rerender(<GenreLibraryView projectPath="C:/b" />)
    await waitFor(() => expect(screen.getByTestId("genre-snapshot-count").textContent).toContain("2 条"))
    await act(async () => {
      deferred.resolve?.(presentSnapshot(99))
    })
    // 旧项目的迟到结果被取消标记拦下。
    expect(screen.getByTestId("genre-snapshot-count").textContent).toContain("2 条")
    expect(screen.getByTestId("genre-snapshot-hash").textContent).toContain("hash-2")
  })

  it("切项目后旧项目的装载失败迟到 → 不把新项目打成未生成", async () => {
    const deferred: { reject?: (reason: unknown) => void } = {}
    vi.mocked(loadAssetLibrarySnapshot)
      .mockImplementationOnce(
        () =>
          new Promise<AssetLibrarySnapshot>((_resolve, reject) => {
            deferred.reject = reject
          }),
      )
      .mockResolvedValueOnce(presentSnapshot(3))
    const { rerender } = render(<GenreLibraryView projectPath="C:/a" />)
    rerender(<GenreLibraryView projectPath="C:/b" />)
    await waitFor(() => expect(screen.getByTestId("genre-snapshot-count").textContent).toContain("3 条"))
    await act(async () => {
      deferred.reject?.(new Error("stale load failed"))
    })
    expect(screen.getByTestId("genre-snapshot-count").textContent).toContain("3 条")
    expect(screen.queryByTestId("genre-empty")).toBeNull()
  })

  it("已生成但缺内容哈希 → 显示「未知」而不是空白", () => {
    render(
      <GenreLibraryView
        projectPath="C:/proj"
        snapshot={{
          libraryId: "genre_base",
          present: true,
          entryCount: 0,
          contentHash: null,
          schemaVersion: "1",
          conserved: true,
          health: null,
        }}
      />,
    )
    expect(screen.getByTestId("genre-snapshot-hash").textContent).toBe("未知")
    expect(screen.getByTestId("genre-snapshot-present").textContent).toContain("已生成")
  })

  it("快照可读但内容损坏（present=false + error）→ 未生成 + 失败原因同现", () => {
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
          error: "invalid_json",
        }}
      />,
    )
    expect(screen.getByTestId("genre-empty").textContent).toContain("未生成")
    expect(screen.getByTestId("genre-snapshot-error").textContent).toContain("invalid_json")
    expect(screen.queryByTestId("genre-snapshot-present")).toBeNull()
  })
})

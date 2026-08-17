// @vitest-environment jsdom
/**
 * ForeshadowingPanel — 伏笔面板。
 * 覆盖：无项目、加载骨架、store 数据（未解决/已解决分区、状态徽标、描述可选、
 * resolvedChapter 兜底）、空 store、加载失败、dataVersion 重取、陈旧请求忽略。
 */
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, waitFor } from "@/test-helpers/component-test-utils"
import type { ForeshadowingStore } from "@/lib/novel/foreshadowing-tracker"

const tMock = vi.hoisted(() => ({
  t: vi.fn((key: string, opts?: Record<string, unknown>) => (opts ? `${key}::${JSON.stringify(opts)}` : key)),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tMock.t }),
}))

const wiki = vi.hoisted(() => ({
  state: { project: { id: "p1", name: "Novel", path: "E:/Novel" } as { id: string; name: string; path: string } | null, dataVersion: 0 },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: typeof wiki.state) => unknown) => selector(wiki.state),
}))

const tracker = vi.hoisted(() => ({
  loadForeshadowingTracker: vi.fn(async () => ({ items: [], lastUpdated: "" })),
}))

vi.mock("@/lib/novel/foreshadowing-tracker", () => ({
  loadForeshadowingTracker: tracker.loadForeshadowingTracker,
}))

import { ForeshadowingPanel } from "./foreshadowing-panel"

function makeStore(overrides: Partial<ForeshadowingStore> = {}): ForeshadowingStore {
  return {
    items: [
      { id: "f1", name: "玉牌", description: "刻着神秘符文的玉牌", status: "planted", plantedChapter: 2, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
      { id: "f2", name: "旧友", description: "", status: "advanced", plantedChapter: 5, advancedChapters: [6], relatedCharacters: [], relatedEvents: [], notes: "" },
      { id: "f3", name: "密信", description: "一封没有署名的信", status: "resolved", plantedChapter: 1, advancedChapters: [], resolvedChapter: 12, relatedCharacters: [], relatedEvents: [], notes: "" },
    ],
    lastUpdated: "2026-07-25T10:00:00.000Z",
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  wiki.state.project = { id: "p1", name: "Novel", path: "E:/Novel" }
  wiki.state.dataVersion = 0
  tracker.loadForeshadowingTracker.mockResolvedValue(makeStore())
})

afterEach(() => cleanup())

describe("ForeshadowingPanel", () => {
  it("renders nothing when no project is open", () => {
    wiki.state.project = null
    render(<ForeshadowingPanel />)
    expect(tracker.loadForeshadowingTracker).not.toHaveBeenCalled()
  })

  it("shows the loading skeleton while fetching", async () => {
    let resolve!: (v: ForeshadowingStore) => void
    tracker.loadForeshadowingTracker.mockImplementationOnce(() => new Promise((res) => { resolve = res }))
    render(<ForeshadowingPanel />)
    expect(screen.getByRole("status")).toBeInTheDocument()
    resolve(makeStore())
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument())
  })

  it("renders the title with a warning bulb when unresolved items exist", async () => {
    const { container } = render(<ForeshadowingPanel />)
    expect(await screen.findByText("novel.foreshadowing.title")).toBeInTheDocument()
    // 有未解决项 → 标题灯泡点亮（源码 unresolved.length > 0 分支，foreshadowing-panel.tsx:60）
    expect(container.querySelector(".lucide-lightbulb")?.classList.contains("text-warning")).toBe(true)
    expect(screen.getByText(/novel.foreshadowing.summary/)).toBeInTheDocument()
    // 未解决分区
    expect(screen.getByText(/novel.foreshadowing.unresolved.*\(2\)/)).toBeInTheDocument()
    expect(screen.getByText("玉牌")).toBeInTheDocument()
    expect(screen.getByText("旧友")).toBeInTheDocument()
    expect(screen.getByText("刻着神秘符文的玉牌")).toBeInTheDocument()
    // 状态徽标按 status 映射 label key
    expect(screen.getByText("novel.foreshadowing.planted")).toBeInTheDocument()
    expect(screen.getByText("novel.foreshadowing.advanced")).toBeInTheDocument()
    // f1/f2 两个未解决项各渲染一行 plantedAt
    expect(screen.getAllByText(/novel.foreshadowing.plantedAt/)).toHaveLength(2)
    // 已解决分区
    expect(screen.getByText(/novel.foreshadowing.resolved.*\(1\)/)).toBeInTheDocument()
    expect(screen.getByText("密信")).toBeInTheDocument()
    expect(screen.getByText(/novel.foreshadowing.resolvedAt/)).toBeInTheDocument()
    expect(tracker.loadForeshadowingTracker).toHaveBeenCalledWith("E:/Novel")
  })

  it("renders only the resolved section when no unresolved items exist", async () => {
    tracker.loadForeshadowingTracker.mockResolvedValue(
      makeStore({ items: [makeStore().items[2]] }),
    )
    render(<ForeshadowingPanel />)
    await screen.findByText("novel.foreshadowing.title")
    expect(screen.queryByText(/novel.foreshadowing.unresolved.*\(/)).not.toBeInTheDocument()
    expect(screen.getByText(/novel.foreshadowing.resolved.*\(1\)/)).toBeInTheDocument()
  })

  it("renders only the unresolved section when no resolved items exist", async () => {
    tracker.loadForeshadowingTracker.mockResolvedValue(
      makeStore({ items: [makeStore().items[0], makeStore().items[1]] }),
    )
    render(<ForeshadowingPanel />)
    await screen.findByText("novel.foreshadowing.title")
    expect(screen.queryByText(/novel.foreshadowing.resolved.*\(/)).not.toBeInTheDocument()
    expect(screen.getByText(/novel.foreshadowing.unresolved.*\(2\)/)).toBeInTheDocument()
  })

  it("falls back to a default chapter placeholder when resolvedChapter is missing", async () => {
    tracker.loadForeshadowingTracker.mockResolvedValue(
      makeStore({ items: [{ ...makeStore().items[2], resolvedChapter: undefined }] }),
    )
    render(<ForeshadowingPanel />)
    await screen.findByText("novel.foreshadowing.title")
    expect(screen.getByText(/novel.foreshadowing.resolvedAt.*"?"/)).toBeInTheDocument()
  })

  it("shows the no-data state for an empty store", async () => {
    tracker.loadForeshadowingTracker.mockResolvedValue(makeStore({ items: [] }))
    render(<ForeshadowingPanel />)
    expect(await screen.findByText("novel.foreshadowing.noData")).toBeInTheDocument()
    expect(screen.getByText("novel.foreshadowing.noDataHint")).toBeInTheDocument()
  })

  it("shows the no-data state when loading fails", async () => {
    tracker.loadForeshadowingTracker.mockRejectedValue(new Error("boom"))
    render(<ForeshadowingPanel />)
    expect(await screen.findByText("novel.foreshadowing.noData")).toBeInTheDocument()
  })

  it("falls back to default styles/labels for unknown statuses in the unresolved section", async () => {
    // 磁盘 store 数据无运行时类型约束：旧版本/损坏数据可能带地图之外的 status
    // → STATUS_BULB_CLASS/STATUS_BADGE/STATUS_LABEL_KEY 的 ?? 兜底分支
    const unknown = makeStore().items[0]
    tracker.loadForeshadowingTracker.mockResolvedValue(
      makeStore({ items: [{ ...unknown, status: "planned" as unknown as "planted", id: "f-u" }] }),
    )
    const { container } = render(<ForeshadowingPanel />)
    await screen.findByText("novel.foreshadowing.title")
    // 条目灯泡（源码 L93）无映射 class → ?? "" 兜底（标题灯泡因 unresolved>0 恒亮，不能用作断言）
    const bulbs = Array.from(container.querySelectorAll(".lucide-lightbulb"))
    const itemBulb = bulbs.find((b) => !b.classList.contains("text-warning")) ?? bulbs[1]
    expect(itemBulb.classList.contains("text-warning/40")).toBe(false)
    // 徽标无映射 class → ?? "" 兜底；label → ?? unresolved 兜底
    const badges = screen.getByText("novel.foreshadowing.unresolved")
    expect(badges.className).not.toContain("bg-warning/15")
  })

  it("refetches when dataVersion changes", async () => {
    const { rerender } = render(<ForeshadowingPanel />)
    await screen.findByText("玉牌")
    expect(tracker.loadForeshadowingTracker).toHaveBeenCalledTimes(1)
    wiki.state.dataVersion = 1
    rerender(<ForeshadowingPanel />)
    await waitFor(() => expect(tracker.loadForeshadowingTracker).toHaveBeenCalledTimes(2))
  })

  it("ignores a stale failure after unmount (cancelled catch guard)", async () => {
    let rejectTracker!: (e: Error) => void
    tracker.loadForeshadowingTracker.mockImplementationOnce(
      () => new Promise((_res, rej) => { rejectTracker = rej }),
    )
    const { unmount } = render(<ForeshadowingPanel />)
    unmount()
    await act(async () => { rejectTracker(new Error("迟到失败")) })
    // cancelled=true → .catch 的 `if (!cancelled)` 静默跳过，不崩溃
  })

  it("ignores a stale fetch after project change (cancelled flag)", async () => {
    let resolveFirst!: (v: ForeshadowingStore) => void
    tracker.loadForeshadowingTracker.mockImplementationOnce(() => new Promise((res) => { resolveFirst = res }))
    const { rerender } = render(<ForeshadowingPanel />)
    wiki.state.project = { id: "p2", name: "Other", path: "E:/Other" }
    rerender(<ForeshadowingPanel />)
    resolveFirst(makeStore({ items: [{ ...makeStore().items[0], name: "陈旧伏笔" }] }))
    await waitFor(() => expect(tracker.loadForeshadowingTracker).toHaveBeenCalledTimes(2))
    expect(screen.queryByText("陈旧伏笔")).not.toBeInTheDocument()
  })
})

// @vitest-environment jsdom
/**
 * TimelineView — 时间线视图（从 snapshots 派生）。
 * 覆盖：无项目、加载骨架、事件列表渲染、空事件、加载失败、dataVersion 重取、陈旧请求忽略。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, within } from "@testing-library/react"
import { render, screen, waitFor } from "@/test-helpers/component-test-utils"
import type { TimelineEntry } from "@/lib/novel"

const tMock = vi.hoisted(() => ({
  t: vi.fn((key: string, opts?: Record<string, unknown>) => (opts ? `${key}::${JSON.stringify(opts)}` : key)),
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: tMock.t }),
}))

const wiki = vi.hoisted(() => ({
  state: {
    project: { id: "p1", name: "Novel", path: "E:/Novel" } as { id: string; name: string; path: string } | null,
    dataVersion: 0,
    setSelectedFile: undefined as ((file: string | null) => void) | undefined,
  },
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: (selector: (s: typeof wiki.state) => unknown) => selector(wiki.state),
    
  }
})

const timeline = vi.hoisted(() => ({
  getTimelineEvents: vi.fn<(projectPath: string) => Promise<TimelineEntry[]>>(async () => []),
}))

vi.mock("@/lib/novel/timeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/timeline")>()
  return {
    ...actual,
      getTimelineEvents: timeline.getTimelineEvents,
    
  }
})

// 覆盖补齐：handleOpenChapter 经 barrel 注入（默认 null=找不到章节；既有用例行为不变）。
vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    findChapterFileByNumber: vi.fn(async () => null),
  }
})

import { findChapterFileByNumber } from "@/lib/novel"

import { TimelineView } from "./timeline-view"

beforeEach(() => {
  vi.clearAllMocks()
  wiki.state.project = { id: "p1", name: "Novel", path: "E:/Novel" }
  wiki.state.dataVersion = 0
  timeline.getTimelineEvents.mockResolvedValue([
    { chapterNumber: 3, event: "辰时 入城" },
    { chapterNumber: 4, event: "夜宴交锋" },
  ])
})

afterEach(() => cleanup())

describe("TimelineView", () => {
  it("renders nothing when no project is open", () => {
    wiki.state.project = null
    render(<TimelineView />)
    expect(timeline.getTimelineEvents).not.toHaveBeenCalled()
    expect(screen.queryByText("novel.timeline.title")).not.toBeInTheDocument()
  })

  it("shows the loading skeleton while fetching", async () => {
    let resolve!: (v: { chapterNumber: number; event: string }[]) => void
    timeline.getTimelineEvents.mockImplementationOnce(() => new Promise((res) => { resolve = res }))
    render(<TimelineView />)
    expect(screen.getByRole("status")).toBeInTheDocument()
    resolve([])
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument())
  })

  it("renders timeline entries grouped by chapter", async () => {
    render(<TimelineView />)
    expect(await screen.findByText("novel.timeline.title")).toBeInTheDocument()
    const list = screen.getByTestId("timeline-list")
    expect(within(list).getByText("辰时 入城")).toBeInTheDocument()
    expect(within(list).getByText("夜宴交锋")).toBeInTheDocument()
    expect(screen.getAllByText(/novel.timeline.chapter/).length).toBe(2)
    expect(timeline.getTimelineEvents).toHaveBeenCalledWith("E:/Novel")
  })

  it("shows the empty state when there are no events", async () => {
    timeline.getTimelineEvents.mockResolvedValue([])
    render(<TimelineView />)
    expect(await screen.findByText("novel.timeline.noEvents")).toBeInTheDocument()
    expect(screen.getByText("novel.timeline.noEventsHint")).toBeInTheDocument()
  })

  it("falls back to an empty list when loading fails", async () => {
    timeline.getTimelineEvents.mockRejectedValue(new Error("boom"))
    render(<TimelineView />)
    expect(await screen.findByText("novel.timeline.noEvents")).toBeInTheDocument()
  })

  it("refetches when dataVersion changes", async () => {
    const { rerender } = render(<TimelineView />)
    await within(await screen.findByTestId("timeline-list")).findByText("辰时 入城")
    expect(timeline.getTimelineEvents).toHaveBeenCalledTimes(1)
    wiki.state.dataVersion = 1
    rerender(<TimelineView />)
    await waitFor(() => expect(timeline.getTimelineEvents).toHaveBeenCalledTimes(2))
  })

  it("ignores a stale rejected fetch after the project changes (cancelled catch)", async () => {
    let rejectFirst!: (error: unknown) => void
    timeline.getTimelineEvents.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject }))
    const { rerender } = render(<TimelineView />)
    wiki.state.project = { id: "p2", name: "Other", path: "E:/Other" }
    rerender(<TimelineView />)
    rejectFirst(new Error("陈旧错误"))
    await waitFor(() => expect(timeline.getTimelineEvents).toHaveBeenCalledTimes(2))
    expect(screen.queryByText("陈旧错误")).not.toBeInTheDocument()
  })

  it("ignores a stale fetch when the project changes (cancelled flag)", async () => {
    let resolveFirst!: (v: { chapterNumber: number; event: string }[]) => void
    timeline.getTimelineEvents.mockImplementationOnce(() => new Promise((res) => { resolveFirst = res }))
    const { rerender } = render(<TimelineView />)
    wiki.state.project = { id: "p2", name: "Other", path: "E:/Other" }
    rerender(<TimelineView />)
    resolveFirst([{ chapterNumber: 99, event: "陈旧事件" }])
    await waitFor(() => expect(timeline.getTimelineEvents).toHaveBeenCalledTimes(2))
    expect(screen.queryByText("陈旧事件")).not.toBeInTheDocument()
  })
})

describe("TimelineView 覆盖补齐：范围过滤/打开章节", () => {
  it("范围输入过滤事件（起/止双向）", async () => {
    render(<TimelineView />)
    await screen.findByTestId("timeline-list")
    expect(within(screen.getByTestId("timeline-list")).getByText("辰时 入城")).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText("1"), { target: { value: "4" } })
    expect(within(screen.getByTestId("timeline-list")).queryByText("辰时 入城")).toBeNull()
    expect(within(screen.getByTestId("timeline-list")).getByText("夜宴交锋")).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText("∞"), { target: { value: "3" } })
    expect(screen.queryByTestId("timeline-list")?.textContent).not.toContain("夜宴交锋")
  })

  it("点击事件行 → 打开对应章节文件（setSelectedFile 接线）", async () => {
    const setSelectedFile = vi.fn<(file: string | null) => void>()
    wiki.state.setSelectedFile = setSelectedFile
    vi.mocked(findChapterFileByNumber).mockResolvedValue("E:/Novel/wiki/chapter-3.md")
    render(<TimelineView />)
    const list = await screen.findByTestId("timeline-list")
    fireEvent.click(within(list).getByText("辰时 入城"))
    await waitFor(() => expect(findChapterFileByNumber).toHaveBeenCalledWith("E:/Novel", 3))
    expect(setSelectedFile).toHaveBeenCalledWith("E:/Novel/wiki/chapter-3.md")
    delete (wiki.state as Record<string, unknown>).setSelectedFile
  })

  it("时间轴刻度点击 → 同一打开通道（TimelineBoard onOpenChapter）", async () => {
    const setSelectedFile = vi.fn<(file: string | null) => void>()
    wiki.state.setSelectedFile = setSelectedFile
    vi.mocked(findChapterFileByNumber).mockResolvedValue("E:/Novel/wiki/chapter-4.md")
    render(<TimelineView />)
    await screen.findByTestId("timeline-list")
    fireEvent.click(screen.getByTestId("timeline-board-tick-4"))
    await waitFor(() => expect(findChapterFileByNumber).toHaveBeenCalledWith("E:/Novel", 4))
    expect(setSelectedFile).toHaveBeenCalledWith("E:/Novel/wiki/chapter-4.md")
    delete (wiki.state as Record<string, unknown>).setSelectedFile
  })
})

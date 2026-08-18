// @vitest-environment jsdom
/**
 * TimelineView — 时间线视图（从 snapshots 派生）。
 * 覆盖：无项目、加载骨架、事件列表渲染、空事件、加载失败、dataVersion 重取、陈旧请求忽略。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, waitFor } from "@/test-helpers/component-test-utils"
import type { TimelineEntry } from "@/lib/novel/timeline"

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

const timeline = vi.hoisted(() => ({
  getTimelineEvents: vi.fn<(projectPath: string) => Promise<TimelineEntry[]>>(async () => []),
}))

vi.mock("@/lib/novel/timeline", () => ({
  getTimelineEvents: timeline.getTimelineEvents,
}))

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
    expect(screen.getByText("辰时 入城")).toBeInTheDocument()
    expect(screen.getByText("夜宴交锋")).toBeInTheDocument()
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
    await screen.findByText("辰时 入城")
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

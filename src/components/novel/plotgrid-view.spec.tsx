// @vitest-environment jsdom
/**
 * PlotgridView — 情节线×章节矩阵（F-010）。
 * 覆盖：无项目、加载骨架、单情节线单元格参与标记、多情节线、空矩阵、
 * 有情节线无章节、图例渲染、derivePlotlineParticipation 派生纯逻辑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { render, screen, waitFor } from "@/test-helpers/component-test-utils"
import type { Foreshadowing } from "@/lib/novel/foreshadowing-tracker"
import { derivePlotlineParticipation, derivePlotlineRows } from "./plotgrid-view"

const tMock = vi.hoisted(() => ({
  t: vi.fn((key: string, opts?: Record<string, unknown>) => (opts ? `${key}::${JSON.stringify(opts)}` : key)),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tMock.t }),
}))

const wiki = vi.hoisted(() => ({
  state: {
    project: { id: "p1", name: "Novel", path: "E:/Novel" } as { id: string; name: string; path: string } | null,
    dataVersion: 0,
  },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: typeof wiki.state) => unknown) => selector(wiki.state),
}))

const ingest = vi.hoisted(() => ({
  listSnapshots: vi.fn<(projectPath: string) => Promise<number[]>>(async () => []),
}))

vi.mock("@/lib/novel/chapter-ingest", () => ({
  listSnapshots: ingest.listSnapshots,
}))

const tracker = vi.hoisted(() => ({
  loadForeshadowingTracker: vi.fn<(projectPath: string) => Promise<{ items: Foreshadowing[]; lastUpdated: string }>>(async () => ({ items: [], lastUpdated: "" })),
}))

vi.mock("@/lib/novel/foreshadowing-tracker", () => ({
  loadForeshadowingTracker: tracker.loadForeshadowingTracker,
}))

import { PlotgridView } from "./plotgrid-view"

function foreshadowing(overrides: Partial<Foreshadowing>): Foreshadowing {
  return {
    id: "f1",
    name: "玉佩之谜",
    description: "",
    status: "planted",
    plantedChapter: 2,
    advancedChapters: [],
    relatedCharacters: [],
    relatedEvents: [],
    notes: "",
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  wiki.state.project = { id: "p1", name: "Novel", path: "E:/Novel" }
  wiki.state.dataVersion = 0
  ingest.listSnapshots.mockResolvedValue([])
  tracker.loadForeshadowingTracker.mockResolvedValue({ items: [], lastUpdated: "" })
})

afterEach(() => cleanup())

describe("PlotgridView", () => {
  it("renders nothing when no project is open", () => {
    wiki.state.project = null
    render(<PlotgridView />)
    expect(tracker.loadForeshadowingTracker).not.toHaveBeenCalled()
    expect(screen.queryByText("novel.plotgrid.title")).not.toBeInTheDocument()
  })

  it("shows the loading skeleton while fetching", async () => {
    let resolve!: (v: { items: Foreshadowing[]; lastUpdated: string }) => void
    tracker.loadForeshadowingTracker.mockImplementationOnce(() => new Promise((res) => { resolve = res }))
    render(<PlotgridView />)
    expect(screen.getByRole("status")).toBeInTheDocument()
    resolve({ items: [], lastUpdated: "" })
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument())
  })

  it("renders a single plotline with participation marks across chapter columns", async () => {
    tracker.loadForeshadowingTracker.mockResolvedValue({
      items: [foreshadowing({ plantedChapter: 2, advancedChapters: [3], resolvedChapter: 5 })],
      lastUpdated: "",
    })
    ingest.listSnapshots.mockResolvedValue([1, 2, 3, 4, 5])

    render(<PlotgridView />)
    expect(await screen.findByText("novel.plotgrid.title")).toBeInTheDocument()
    expect(tracker.loadForeshadowingTracker).toHaveBeenCalledWith("E:/Novel")
    expect(document.querySelector("[data-plotgrid-matrix]")).toBeTruthy()

    // 列头：第1..5章
    for (let ch = 1; ch <= 5; ch++) {
      expect(screen.getByText(`novel.plotgrid.chapterShort::{"num":${ch}}`)).toBeInTheDocument()
    }
    // 行名
    expect(screen.getByText("玉佩之谜")).toBeInTheDocument()
    // 单元格参与标记
    const mark = (ch: number) =>
      document.querySelector(`[data-plotgrid-cell="f1:${ch}"]`)?.getAttribute("data-plotgrid-mark")
    expect(mark(2)).toBe("planted")
    expect(mark(3)).toBe("advanced")
    expect(mark(4)).toBe("")
    expect(mark(5)).toBe("resolved")
  })

  it("renders multiple plotlines as multiple rows", async () => {
    tracker.loadForeshadowingTracker.mockResolvedValue({
      items: [
        foreshadowing({ id: "f1", name: "线一" }),
        foreshadowing({ id: "f2", name: "线二", status: "advanced", plantedChapter: 1 }),
        foreshadowing({ id: "f3", name: "线三", status: "resolved", plantedChapter: 2, resolvedChapter: 4 }),
      ],
      lastUpdated: "",
    })
    ingest.listSnapshots.mockResolvedValue([1, 2, 3, 4])

    render(<PlotgridView />)
    await screen.findByText("novel.plotgrid.title")
    expect(screen.getByText("线一")).toBeInTheDocument()
    expect(screen.getByText("线二")).toBeInTheDocument()
    expect(screen.getByText("线三")).toBeInTheDocument()
    const rows = document.querySelectorAll("[data-plotgrid-matrix] tbody tr")
    expect(rows.length).toBe(3)
  })

  it("shows the empty state when there are no plotlines", async () => {
    ingest.listSnapshots.mockResolvedValue([1, 2])
    render(<PlotgridView />)
    expect(await screen.findByText("novel.plotgrid.noData")).toBeInTheDocument()
    expect(screen.getByText("novel.plotgrid.noDataHint")).toBeInTheDocument()
    expect(document.querySelector("[data-plotgrid-matrix]")).toBeNull()
  })

  it("shows the no-chapters state when plotlines exist but snapshots are absent", async () => {
    tracker.loadForeshadowingTracker.mockResolvedValue({
      items: [foreshadowing({})],
      lastUpdated: "",
    })
    render(<PlotgridView />)
    expect(await screen.findByText("novel.plotgrid.noChapters")).toBeInTheDocument()
    expect(screen.getByText("novel.plotgrid.noChaptersHint")).toBeInTheDocument()
  })

  it("renders the legend when rows exist and filters outline snapshot columns", async () => {
    tracker.loadForeshadowingTracker.mockResolvedValue({
      items: [foreshadowing({})],
      lastUpdated: "",
    })
    ingest.listSnapshots.mockResolvedValue([-1, 2])
    render(<PlotgridView />)
    await screen.findByText("novel.plotgrid.title")
    // 图例三项 + 行状态徽标（planted 状态行复用同一标签）
    expect(screen.getAllByText("novel.foreshadowing.planted").length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText("novel.foreshadowing.advanced").length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText("novel.foreshadowing.resolved").length).toBeGreaterThanOrEqual(1)
    // outline 负号列被过滤，仅剩第2章
    expect(screen.queryByText(`novel.plotgrid.chapterShort::{"num":-1}`)).not.toBeInTheDocument()
    expect(screen.getByText(`novel.plotgrid.chapterShort::{"num":2}`)).toBeInTheDocument()
  })

  it("falls back to empty data when loading fails", async () => {
    tracker.loadForeshadowingTracker.mockRejectedValue(new Error("boom"))
    render(<PlotgridView />)
    expect(await screen.findByText("novel.plotgrid.noData")).toBeInTheDocument()
  })

  it("refetches when dataVersion changes", async () => {
    const { rerender } = render(<PlotgridView />)
    await waitFor(() => expect(tracker.loadForeshadowingTracker).toHaveBeenCalledTimes(1))
    wiki.state.dataVersion = 1
    rerender(<PlotgridView />)
    await waitFor(() => expect(tracker.loadForeshadowingTracker).toHaveBeenCalledTimes(2))
  })
})

describe("derivePlotlineParticipation — 派生纯逻辑", () => {
  it("derives planted + advanced + resolved cells sorted by chapter", () => {
    expect(
      derivePlotlineParticipation({ plantedChapter: 3, advancedChapters: [5, 4], resolvedChapter: 8 }),
    ).toEqual([
      { chapterNumber: 3, mark: "planted" },
      { chapterNumber: 4, mark: "advanced" },
      { chapterNumber: 5, mark: "advanced" },
      { chapterNumber: 8, mark: "resolved" },
    ])
  })

  it("dedupes advanced chapters equal to the planted chapter", () => {
    expect(
      derivePlotlineParticipation({ plantedChapter: 2, advancedChapters: [2, 3] }),
    ).toEqual([
      { chapterNumber: 2, mark: "planted" },
      { chapterNumber: 3, mark: "advanced" },
    ])
  })

  it("dedupes resolved chapter already present as advanced", () => {
    expect(
      derivePlotlineParticipation({ plantedChapter: 1, advancedChapters: [4], resolvedChapter: 4 }),
    ).toEqual([
      { chapterNumber: 1, mark: "planted" },
      { chapterNumber: 4, mark: "advanced" },
    ])
  })

  it("omits resolved cell when resolvedChapter is undefined", () => {
    expect(
      derivePlotlineParticipation({ plantedChapter: 1, advancedChapters: [] }),
    ).toEqual([{ chapterNumber: 1, mark: "planted" }])
  })
})

describe("derivePlotlineRows — 派生纯逻辑", () => {
  it("maps foreshadowing items to plotline rows", () => {
    const rows = derivePlotlineRows([
      foreshadowing({ id: "a", name: "甲", plantedChapter: 1 }),
      foreshadowing({ id: "b", name: "乙", status: "resolved", plantedChapter: 2, resolvedChapter: 3 }),
    ])
    expect(rows.map((r) => r.id)).toEqual(["a", "b"])
    expect(rows[0].participation).toEqual([{ chapterNumber: 1, mark: "planted" }])
    expect(rows[1].participation).toEqual([
      { chapterNumber: 2, mark: "planted" },
      { chapterNumber: 3, mark: "resolved" },
    ])
  })
})

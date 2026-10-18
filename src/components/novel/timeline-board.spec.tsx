// @vitest-environment jsdom
/** TimelineBoard：章节序刻度 + 每章泳道 + 事件点 + 显式 N/A（不做伪故事线分道）。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}::${JSON.stringify(opts)}` : key,
  }),
}))

const { TimelineBoard, buildTicks, groupEntriesByChapter } = await import("./timeline-board")

describe("groupEntriesByChapter / buildTicks", () => {
  it("按章分组并升序，同章事件保序", () => {
    const lanes = groupEntriesByChapter([
      { chapterNumber: 3, event: "c" },
      { chapterNumber: 1, event: "a" },
      { chapterNumber: 1, event: "b" },
    ])
    expect(lanes.map((l) => l.chapterNumber)).toEqual([1, 3])
    expect(lanes[0]?.events).toEqual(["a", "b"])
  })

  it("刻度覆盖 min..max（缺章留空位）", () => {
    expect(buildTicks([{ chapterNumber: 2, event: "x" }, { chapterNumber: 5, event: "y" }])).toEqual([2, 3, 4, 5])
  })

  it("空事件 → 空刻度", () => {
    expect(buildTicks([])).toEqual([])
  })
})

describe("TimelineBoard", () => {
  afterEach(cleanup)

  it("空事件：诚实空态；筛选为空走另一套文案（不得说成尚未入库）", () => {
    render(<TimelineBoard entries={[]} />)
    expect(screen.getByTestId("timeline-board-empty").textContent).toBe("novel.timelineBoard.empty")

    cleanup()
    render(<TimelineBoard entries={[]} filteredOut />)
    expect(screen.getByTestId("timeline-board-filtered-empty").textContent).toBe(
      "novel.timelineBoard.filteredEmpty",
    )
    expect(screen.queryByTestId("timeline-board-empty")).toBeNull()
  })

  it("空刻度不画柱，只在可见位置标 N/A", () => {
    render(<TimelineBoard entries={[{ chapterNumber: 1, event: "a" }, { chapterNumber: 3, event: "b" }]} />)
    expect(screen.getByTestId("timeline-board-tick-na-2").textContent).toBe("novel.timelineBoard.na")
    expect(screen.queryByTestId("timeline-board-tick-na-1")).toBeNull()
  })

  it("跨度 > 400 折叠刻度时必须标注柱距不等于章距", () => {
    render(<TimelineBoard entries={[{ chapterNumber: 1, event: "a" }, { chapterNumber: 500, event: "b" }]} />)
    expect(buildTicks([{ chapterNumber: 1, event: "a" }, { chapterNumber: 500, event: "b" }])).toEqual([1, 500])
    expect(screen.getByTestId("timeline-board-na-folded").textContent).toBe("novel.timelineBoard.naFolded")
  })

  it("N/A 文案本身被断言（防止改成「这是完整故事线」还绿）", () => {
    render(<TimelineBoard entries={[{ chapterNumber: 2, event: "x" }]} />)
    expect(screen.getByTestId("timeline-board-na-lanes").textContent).toBe("novel.timelineBoard.naThreads")
    expect(screen.getByTestId("timeline-board-na-granularity").textContent).toBe("novel.timelineBoard.naGranularity")
    expect(screen.getByTestId("timeline-board-na-pacing").textContent).toBe("novel.timelineBoard.naPacing")
  })

  it("负数（大纲章号）进入刻度且不被丢弃", () => {
    expect(buildTicks([{ chapterNumber: -2, event: "o" }, { chapterNumber: 2, event: "c" }])).toEqual([-2, -1, 0, 1, 2])
  })

  it("渲染刻度/泳道/事件点，缺章刻度 count=0", () => {
    render(
      <TimelineBoard
        entries={[
          { chapterNumber: 1, event: "开端" },
          { chapterNumber: 1, event: "变故" },
          { chapterNumber: 3, event: "转折" },
        ]}
      />,
    )
    expect(screen.getByTestId("timeline-board-lane-1")).toBeTruthy()
    expect(screen.getByTestId("timeline-board-point-1-0").textContent).toBe("开端")
    expect(screen.getByTestId("timeline-board-point-1-1").textContent).toBe("变故")
    // 第 2 章无事件：刻度存在但 count=0（不补点）
    expect(screen.getByTestId("timeline-board-tick-2").getAttribute("data-count")).toBe("0")
    expect(screen.queryByTestId("timeline-board-lane-2")).toBeNull()
  })

  it("三条 N/A 诚实声明必须存在（无类型/无粒度/无节奏打分）", () => {
    render(<TimelineBoard entries={[{ chapterNumber: 1, event: "x" }]} />)
    expect(screen.getByTestId("timeline-board-na-lanes")).toBeTruthy()
    expect(screen.getByTestId("timeline-board-na-granularity")).toBeTruthy()
    expect(screen.getByTestId("timeline-board-na-pacing")).toBeTruthy()
  })

  it("点击有事件的刻度才触发 openChapter", () => {
    const onOpen = vi.fn()
    render(
      <TimelineBoard
        entries={[{ chapterNumber: 1, event: "x" }, { chapterNumber: 3, event: "y" }]}
        onOpenChapter={onOpen}
      />,
    )
    fireEvent.click(screen.getByTestId("timeline-board-tick-2"))
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("timeline-board-tick-3"))
    expect(onOpen).toHaveBeenCalledWith(3)
  })
})

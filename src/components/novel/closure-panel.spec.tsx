// @vitest-environment jsdom
/**
 * ClosurePanel — Closure 级叙事结构面只读面板。
 *
 * 断言都「可失败」：注入假 projection → 行/计数/字段必须跟着变；空真源 → 空态 + 逐条中文 N/A；
 * 删掉 N/A 行即红；注入 loader → 行来自 loader 返回值（默认走真实 loader 的那条路）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

const wiki = vi.hoisted(() => ({
  state: {
    project: { id: "p1", name: "Novel", path: "E:/Novel" } as { id: string; name: string; path: string } | null,
    dataVersion: 0,
  },
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: (selector: (s: typeof wiki.state) => unknown) => selector(wiki.state),
  }
})

import type { ClosureProjection } from "@/lib/novel"
import { ClosurePanel } from "./closure-panel"

const projectionWithRows: ClosureProjection = {
  infoGaps: [
    {
      id: "d1",
      kind: "info-gap",
      source: ".novel/narrative-state.json",
      label: "loc-cafe.atmosphere",
      detail: "咖啡厅角落有暗门",
      modality: "fact",
      chapterNumber: null,
      storyTime: "ch1",
      relatedIds: ["c1", "c2"],
      knownCount: 1,
      unknownCount: 1,
      consequenceCount: null,
    },
  ],
  worldEvents: [
    {
      id: "timeline:3:城门失守",
      kind: "world-event",
      source: ".novel/timeline.json",
      label: "城门失守",
      detail: null,
      modality: null,
      chapterNumber: 3,
      storyTime: null,
      relatedIds: [],
      knownCount: null,
      unknownCount: null,
      consequenceCount: null,
    },
  ],
  ripples: [
    {
      id: "ripple:root",
      kind: "ripple",
      source: ".novel/narrative-state.json",
      label: "王城大火",
      detail: "王城大火",
      modality: null,
      chapterNumber: null,
      storyTime: "ch1",
      relatedIds: ["A1", "b2"],
      knownCount: null,
      unknownCount: null,
      consequenceCount: 2,
    },
  ],
  missingSources: [],
}

const emptyProjection: ClosureProjection = {
  infoGaps: [],
  worldEvents: [],
  ripples: [],
  missingSources: [
    "信息差：.novel/narrative-state.json 的 declarations 为空——没有任何声明，无法判定「谁知道什么」",
    "涟漪：.novel/narrative-state.json 的 events 里没有任何 causedBy 因果链——无下游后果可派生（不造空行假装有涟漪）",
  ],
}

describe("ClosurePanel", () => {
  beforeEach(() => {
    wiki.state.project = { id: "p1", name: "Novel", path: "E:/Novel" }
    wiki.state.dataVersion = 0
  })

  afterEach(cleanup)

  it("注入有数据的 projection：计数、行、字段全部来自 projection", () => {
    render(<ClosurePanel projection={projectionWithRows} />)

    const scope = screen.getByTestId("closure-panel-scope").textContent ?? ""
    expect(scope).toContain("信息差 1 行")
    expect(scope).toContain("世界事件 1 行")
    expect(scope).toContain("涟漪 1 行")
    expect(scope).toContain("合计 3 行")

    const gap = screen.getByTestId("closure-row-d1")
    expect(gap.textContent).toContain("loc-cafe.atmosphere")
    expect(gap.textContent).toContain("咖啡厅角落有暗门")
    expect(gap.textContent).toContain("模态 fact")
    expect(gap.textContent).toContain("故事时间 ch1")
    expect(gap.textContent).toContain("已知 1 人 · 未知 1 人")
    expect(gap.textContent).toContain("来源 .novel/narrative-state.json")
    // narrative-state 无章号真源 → 该行章号必须显式 N/A，而不是写 0
    expect(screen.getByTestId("closure-na-chapter-d1").textContent).toContain("N/A")

    const event = screen.getByTestId("closure-row-timeline:3:城门失守")
    expect(event.textContent).toContain("城门失守")
    expect(event.textContent).toContain("第 3 章")
    // timeline 无故事时间真源 → 显式 N/A
    expect(screen.getByTestId("closure-na-storytime-timeline:3:城门失守").textContent).toContain("N/A")

    const ripple = screen.getByTestId("closure-row-ripple:root")
    expect(ripple.textContent).toContain("下游 2 个事件")
    expect(ripple.textContent).toContain("A1 b2")

    // 真源齐备 → 不得出现缺失真源 N/A
    expect(screen.getByTestId("closure-na-source-none").textContent).toContain("无缺失真源")
    expect(screen.queryByTestId("closure-na-source-0")).toBeNull()
    expect(screen.queryByTestId("closure-panel-empty")).toBeNull()
  })

  it("注入空 projection：三个区块空态 + 逐条中文 N/A（删掉 N/A 即红）", () => {
    render(<ClosurePanel projection={emptyProjection} />)

    const scope = screen.getByTestId("closure-panel-scope").textContent ?? ""
    expect(scope).toContain("合计 0 行")

    expect(screen.getByTestId("closure-panel-empty").textContent).toContain("不造 0 行假装统计过")
    expect(screen.getByTestId("closure-panel-empty-info-gap").textContent).toContain("没有信息差行")
    expect(screen.getByTestId("closure-panel-empty-world-event").textContent).toContain("没有世界事件行")
    expect(screen.getByTestId("closure-panel-empty-ripple").textContent).toContain("没有涟漪行")

    expect(screen.getByTestId("closure-na-source-0").textContent).toContain("N/A")
    expect(screen.getByTestId("closure-na-source-0").textContent).toContain("信息差")
    expect(screen.getByTestId("closure-na-source-1").textContent).toContain("N/A")
    expect(screen.getByTestId("closure-na-source-1").textContent).toContain("涟漪")
    expect(screen.queryByTestId("closure-na-source-2")).toBeNull()
    expect(screen.queryByTestId("closure-na-source-none")).toBeNull()
  })

  it("换一份 projection → UI 跟随变化（计数/行不硬编码）", () => {
    const { rerender } = render(<ClosurePanel projection={projectionWithRows} />)
    expect(screen.getByTestId("closure-panel-scope").textContent).toContain("合计 3 行")

    rerender(<ClosurePanel projection={emptyProjection} />)
    expect(screen.getByTestId("closure-panel-scope").textContent).toContain("合计 0 行")
    expect(screen.queryByTestId("closure-row-d1")).toBeNull()
    expect(screen.queryByTestId("closure-row-ripple:root")).toBeNull()
    expect(screen.getByTestId("closure-na-source-0").textContent).toContain("信息差")

    rerender(<ClosurePanel projection={projectionWithRows} />)
    expect(screen.getByTestId("closure-panel-scope").textContent).toContain("合计 3 行")
    expect(screen.getByTestId("closure-row-d1").textContent).toContain("loc-cafe.atmosphere")
  })

  it("无项目 + 不注入 → 空真源：空态 + 逐条 N/A，且不调用 loader", async () => {
    wiki.state.project = null
    const loader = vi.fn(async () => projectionWithRows)

    render(<ClosurePanel loader={loader} />)

    expect(screen.getByTestId("closure-panel-no-project").textContent).toContain("没有打开的项目")
    expect(screen.getByTestId("closure-panel-scope").textContent).toContain("合计 0 行")
    expect(screen.getByTestId("closure-na-source-0").textContent).toContain("N/A")
    // 缺真源逐条：空真源必须给出 4 条中文理由
    expect(screen.getByTestId("closure-na-source-3").textContent).toContain("N/A")
    expect(loader).not.toHaveBeenCalled()
  })

  it("注入 loader + 有项目 → 行来自 loader 返回值（默认真实 loader 的接线）", async () => {
    const loader = vi.fn(async () => projectionWithRows)

    render(<ClosurePanel loader={loader} />)

    await waitFor(() => expect(screen.getByTestId("closure-row-d1")).toBeTruthy())
    expect(loader).toHaveBeenCalledWith("E:/Novel")
    expect(screen.getByTestId("closure-panel-scope").textContent).toContain("合计 3 行")
    expect(screen.getByTestId("closure-row-ripple:root").textContent).toContain("下游 2 个事件")
  })

  it("loader 失败 → 按空真源渲染 + 显式错误（不把读不到说成没数据）", async () => {
    const loader = vi.fn(async () => {
      throw new Error("boom")
    })

    render(<ClosurePanel loader={loader} />)

    await waitFor(() => expect(screen.getByTestId("closure-panel-error")).toBeTruthy())
    expect(screen.getByTestId("closure-panel-error").textContent).toContain("boom")
    expect(screen.getByTestId("closure-panel-scope").textContent).toContain("合计 0 行")
    expect(screen.getByTestId("closure-na-source-0").textContent).toContain("N/A")
  })
})

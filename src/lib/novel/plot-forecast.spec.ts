import { describe, expect, it } from "vitest"
import {
  forecastBranches,
  forecastResultsToContextText,
  type ForecastBranch,
} from "./plot-forecast"
import {
  createEmptySubplotBoardStore,
  type Subplot,
  type SubplotBoardStore,
} from "./subplot-board"

function makeSubplot(overrides: Partial<Subplot> & { id: string }): Subplot {
  return {
    title: overrides.id,
    status: "active",
    startChapter: 1,
    relatedCharacters: [],
    summary: "",
    progress: [],
    notes: "",
    ...overrides,
  }
}

function makeStore(items: Subplot[]): SubplotBoardStore {
  return { items, lastUpdated: "2026-01-01T00:00:00.000Z" }
}

function branch(overrides: Partial<ForecastBranch>): ForecastBranch {
  return {
    id: overrides.id ?? "b1",
    subplotId: overrides.subplotId ?? "s1",
    direction: "推进主线冲突",
    projectedChapter: 10,
    ...overrides,
  }
}

describe("forecastBranches（吸收自 inkos forecast 多线推演模式）", () => {
  it("空输入返回空结果（确定性纯函数）", () => {
    expect(forecastBranches(createEmptySubplotBoardStore(), [])).toEqual([])
  })

  it("活跃支线正常推进 → advance 无风险", () => {
    const store = makeStore([makeSubplot({ id: "s1" })])
    const results = forecastBranches(store, [branch({ subplotId: "s1" })])
    expect(results).toHaveLength(1)
    expect(results[0].verdict).toBe("advance")
    expect(results[0].risks).toEqual([])
  })

  it("已回收支线被推进 → dormant_revive error → revise", () => {
    const store = makeStore([
      makeSubplot({ id: "s1", status: "resolved", resolvedChapter: 5 }),
    ])
    const results = forecastBranches(store, [branch({ subplotId: "s1", projectedChapter: 9 })])
    expect(results[0].verdict).toBe("revise")
    expect(results[0].risks.some((r) => r.code === "dormant_revive" && r.severity === "error")).toBe(true)
  })

  it("已废弃支线被推进 → abandoned_reference error", () => {
    const store = makeStore([makeSubplot({ id: "s1", abandoned: true })])
    const results = forecastBranches(store, [branch({ subplotId: "s1" })])
    expect(results[0].verdict).toBe("revise")
    expect(results[0].risks.some((r) => r.code === "abandoned_reference")).toBe(true)
  })

  it("暂停支线直接推进 → paused_advance warn（不阻断 verdict）", () => {
    const store = makeStore([makeSubplot({ id: "s1", status: "paused" })])
    const results = forecastBranches(store, [branch({ subplotId: "s1" })])
    expect(results[0].verdict).toBe("advance")
    expect(results[0].risks.some((r) => r.code === "paused_advance" && r.severity === "warn")).toBe(true)
  })

  it("超出目标回收章 → target_overshoot warn", () => {
    const store = makeStore([makeSubplot({ id: "s1", targetResolutionChapter: 8 })])
    const results = forecastBranches(store, [branch({ subplotId: "s1", projectedChapter: 12 })])
    expect(results[0].verdict).toBe("advance")
    expect(results[0].risks.some((r) => r.code === "target_overshoot")).toBe(true)
  })

  it("同章多线并发 → concurrent_collision warn 注入该章全部分支", () => {
    const store = makeStore([makeSubplot({ id: "s1" }), makeSubplot({ id: "s2" })])
    const results = forecastBranches(store, [
      branch({ id: "b1", subplotId: "s1", projectedChapter: 7 }),
      branch({ id: "b2", subplotId: "s2", projectedChapter: 7 }),
    ])
    for (const r of results) {
      expect(r.risks.some((rk) => rk.code === "concurrent_collision")).toBe(true)
    }
    expect(results.every((r) => r.verdict === "advance")).toBe(true)
  })

  it("幽灵引用（不存在支线）→ error revise", () => {
    const results = forecastBranches(createEmptySubplotBoardStore(), [
      branch({ subplotId: "ghost" }),
    ])
    expect(results[0].verdict).toBe("revise")
    expect(results[0].risks[0].severity).toBe("error")
  })

  it("确定性：相同输入两次调用输出全等（JSON 序列化比对）", () => {
    const store = makeStore([
      makeSubplot({ id: "s1", status: "paused", targetResolutionChapter: 6 }),
    ])
    const input = [branch({ subplotId: "s1", projectedChapter: 9 })]
    expect(JSON.stringify(forecastBranches(store, input))).toBe(
      JSON.stringify(forecastBranches(store, input)),
    )
  })

  it("不回写 store（只读推演纪律：A23/ANL-013 C4 无第二真源）", () => {
    const store = makeStore([makeSubplot({ id: "s1", status: "active" })])
    forecastBranches(store, [branch({ subplotId: "s1" })])
    expect(store.items[0].status).toBe("active")
    expect(store.items[0].progress).toEqual([])
  })
})

describe("forecastResultsToContextText", () => {
  it("空结果返回空串", () => {
    expect(forecastResultsToContextText([])).toBe("")
  })

  it("含风险分支渲染警告/错误标签", () => {
    const store = makeStore([makeSubplot({ id: "s1", status: "resolved", resolvedChapter: 3 })])
    const results = forecastBranches(store, [branch({ id: "b1", subplotId: "s1" })])
    const text = forecastResultsToContextText(results)
    expect(text).toContain("[需修订]")
    expect(text).toContain("b1")
    expect(text).toContain("复活已闭合线")
  })
})

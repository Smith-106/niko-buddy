// @vitest-environment jsdom
/**
 * BranchCompareView 补测：KeyDifferencesTab 的 branches.length < 2 早退守卫。
 *
 * KeyDifferencesTab 是模块内私有组件，父组件 `BranchCompareView` 只在
 * `compareBranches.length >= 2` 时才挂载它，因此正常渲染永远进不了子组件的
 * 「不足两条分支」早退分支。为了在不改生产代码的前提下把该子组件放进
 * 「空装配」状态，这里对 react 的 useMemo/useEffect 做局部包装：
 *   - useMemo 产出的 compareBranches 用一个 Proxy 承载，其 `length` 在
 *     effect 执行期间读成 1、渲染期间读成 2；
 *   - 于是父组件仍判定「有 2 条分支」并渲染 tab，而子组件 effect 内
 *     读到 length=1，命中 setLoading(false) + return。
 * 断言的是可观察行为：worker 的 calcBranchDiff 完全不被调用（守卫拦住了派发），
 * 且面板不崩溃、不产生结论。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { fireEvent, render, screen, setupDomGlobals } from "@/test-helpers/component-test-utils"
import type { SimulationBranch } from "@/lib/novel"
import zh from "@/i18n/zh.json"

const t = zh.storySimulation as unknown as Record<string, string>
const state = vi.hoisted(() => ({ inEffect: false, degrade: false }))

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>()
  return {
    ...actual,
    useMemo: (factory: () => unknown) => {
      const value = factory() as unknown
      if (state.degrade && Array.isArray(value) && value.length >= 2 &&
          value[0] && typeof value[0] === "object" && "timelineEvents" in (value[0] as object)) {
        return new Proxy(value, {
          get(target, prop, receiver) {
            if (prop === "length") return state.inEffect ? 1 : target.length
            return Reflect.get(target, prop, receiver)
          },
        })
      }
      return value
    },
    useEffect: (fn: () => void | (() => void), deps: unknown[]) =>
      actual.useEffect(() => {
        state.inEffect = true
        try {
          return fn()
        } finally {
          state.inEffect = false
        }
      }, deps),
  }
})

function makeBranch(id: string, name: string): SimulationBranch {
  return {
    id,
    name,
    frameworkId: "fw1",
    mode: "event-driven",
    createdAt: "2026-10-30T11:21:00.000Z",
    timelineEvents: [],
    rumors: [],
    finalAgentSnapshots: [],
    directorEvaluations: [],
    overallScore: 80,
    scoreDetails: {
      avgDirectorScore: 4,
      eventCount: 4,
      characterDiversity: 4,
      plotProgression: 4,
    },
  }
}

describe("BranchCompareView — KeyDifferencesTab 不足分支早退", () => {
  beforeEach(() => {
    setupDomGlobals()
    state.degrade = true
    state.inEffect = false
    document.body.innerHTML = ""
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
    state.degrade = false
    state.inEffect = false
  })

  it("effect 内 branches 退化为 <2 时：不派发 calcBranchDiff，面板停在分析中且不崩", async () => {
    const { BranchCompareView } = await import("./branch-compare-view")
    const workerMod = await import("./use-simulation-worker")
    const calcBranchDiff = vi.fn().mockResolvedValue({
      dimensionDiffs: [], eventCounts: [0, 0], characterCounts: [0, 0],
      topSentimentDiffs: [], divergenceRound: 0, bestBranchIdx: 0,
    })
    vi.spyOn(workerMod, "useSimulationWorker").mockReturnValue({ calcBranchDiff } as never)

    const branches = [makeBranch("b-a", "甲线"), makeBranch("b-b", "乙线")]
    render(<BranchCompareView branches={branches} compareBranchIds={["b-a", "b-b"]} onBack={vi.fn()} />)
    // 父组件渲染期读到 length=2 → tab 正常出现
    fireEvent.click(screen.getByText(t.tabKeyDifferences))
    // 子组件 effect 内读到 length=1 → setLoading(false) + return，worker 从未被派发
    expect(calcBranchDiff).not.toHaveBeenCalled()
    // loading 被置 false 但 diffResult 仍为 null → 仍显示「分析中」，且无结论渲染
    expect(screen.getByText(t.analyzing)).toBeTruthy()
    expect(document.body.textContent).not.toContain(t.recommendationConclusion.split("{{")[0])
  })
})

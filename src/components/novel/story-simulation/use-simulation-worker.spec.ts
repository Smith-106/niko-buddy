// @vitest-environment jsdom
/**
 * use-simulation-worker 行为测试。
 * 该 hook 在 v2 适配后无真实 Web Worker 通道（ensureWorker 恒返回 null），
 * 三个 calc* 方法全部走主线程同步 fallback 计算；本 spec 直接断言这些
 * fallback 的行为：返回值、排序、上限、边界与分支对比结果。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, renderHook } from "@testing-library/react"

import { useSimulationWorker } from "./use-simulation-worker"
import type {
  DirectorEvaluation,
  DirectorScore,
  SimulationBranch,
  TimelineEvent,
} from "@/lib/novel"

afterEach(() => {
  cleanup()
})

function makeScores(v: number): DirectorScore {
  return {
    tension: v,
    pace: v,
    characterUtilization: v,
    characterArc: v,
    infoDensity: v,
    emotionalResonance: v,
    logicConsistency: v,
  }
}

function makeEval(v: number): DirectorEvaluation {
  return {
    scores: makeScores(v),
    totalScore: v * 7,
    highlights: [],
    issues: [],
    suggestion: "",
    shouldInjectEvent: false,
  }
}

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: "e1",
    round: 0,
    nodeIndex: 0,
    actorId: "c1",
    actorName: "寨主",
    actionType: "speak",
    content: "今夜子时动手共商大计",
    observableBy: [],
    impacts: [],
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function makeBranch(overrides: Partial<SimulationBranch> = {}): SimulationBranch {
  return {
    id: "b1",
    name: "甲分支",
    frameworkId: "fw1",
    mode: "event-driven",
    createdAt: "2026-01-01T00:00:00.000Z",
    timelineEvents: [],
    rumors: [],
    finalAgentSnapshots: [],
    directorEvaluations: [],
    overallScore: 80,
    scoreDetails: {
      avgDirectorScore: 7,
      eventCount: 0,
      characterDiversity: 0,
      plotProgression: 0,
    },
    ...overrides,
  }
}

describe("useSimulationWorker.calcClueRelations", () => {
  it("共享关键词的线索成对返回，分数为共有词占比", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    const out = await result.current.calcClueRelations([
      { id: "c1", content: "城堡谋杀案，管家嫌疑" },
      { id: "c2", content: "城堡谋杀案，女仆嫌疑" },
    ])
    // tokens: [城堡谋杀案，管家嫌疑] vs [城堡谋杀案，女仆嫌疑] → 共有 1 / min(2,2) = 0.5
    expect(out).toEqual({ pairs: [["c1", "c2", 0.5]] })
    unmount()
  })

  it("完全相同的两条线索分数为 1 并排在最前", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    const out = await result.current.calcClueRelations([
      { id: "a", content: "城堡谋杀案，管家嫌疑" },
      { id: "b", content: "城堡谋杀案，管家嫌疑" },
      { id: "c", content: "城堡谋杀案，女仆嫌疑" },
    ])
    expect(out.pairs).toHaveLength(3)
    expect(out.pairs[0]).toEqual(["a", "b", 1])
    // 后续按分数降序：0.5, 0.5
    const scores = out.pairs.map((p) => p[2])
    expect([...scores].sort((x, y) => y - x)).toEqual(scores)
    unmount()
  })

  it("无共享关键词时不产生成对", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    const out = await result.current.calcClueRelations([
      { id: "c1", content: "城堡谋杀案，管家嫌疑" },
      { id: "c2", content: "花园茶会，玫瑰盛开" },
    ])
    expect(out).toEqual({ pairs: [] })
    unmount()
  })

  it("过短分词被过滤后关键词为空 → 相似度为 0", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    const out = await result.current.calcClueRelations([
      { id: "c1", content: "好，的" },
      { id: "c2", content: "城堡谋杀案，管家嫌疑" },
    ])
    expect(out).toEqual({ pairs: [] })
    unmount()
  })

  it("空数组与单条线索都返回空 pairs", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    await expect(result.current.calcClueRelations([])).resolves.toEqual({ pairs: [] })
    await expect(
      result.current.calcClueRelations([{ id: "only", content: "城堡谋杀案，管家嫌疑" }]),
    ).resolves.toEqual({ pairs: [] })
    unmount()
  })

  it("候选超过 50 对时截断并保持降序", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    const clues = Array.from({ length: 12 }, (_, i) => ({
      id: `c${i}`,
      content: `共同案件线索，线索${i}号细节`,
    }))
    const out = await result.current.calcClueRelations(clues)
    // C(12,2)=66 对 → 截断到 50
    expect(out.pairs).toHaveLength(50)
    for (const [, , score] of out.pairs) {
      expect(score).toBeCloseTo(0.5)
    }
    unmount()
  })
})

describe("useSimulationWorker.calcBoardLayout", () => {
  it("空卡片返回空数组", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    await expect(result.current.calcBoardLayout([], [])).resolves.toEqual([])
    unmount()
  })

  it("单卡片无连接时位置保持不变（中心偏移相互抵消）", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    const out = await result.current.calcBoardLayout(
      [{ id: "a", x: 10, y: 20, width: 100 }],
      [],
    )
    expect(out).toEqual([{ id: "a", x: 10, y: 20 }])
    unmount()
  })

  it("有连接的一对卡片被推开到有限坐标", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    const out = await result.current.calcBoardLayout(
      [
        { id: "a", x: 0, y: 0, width: 40 },
        { id: "b", x: 30, y: 0, width: 40 },
      ],
      [{ fromCardId: "a", toCardId: "b" }],
    )
    expect(out).toHaveLength(2)
    expect(out.map((n) => n.id).sort()).toEqual(["a", "b"])
    for (const n of out) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
    }
    const ax = out.find((n) => n.id === "a")!.x
    const bx = out.find((n) => n.id === "b")!.x
    // 斥力远大于弹簧初始拉力，两者必被推开
    expect(ax).not.toBe(0)
    expect(bx).not.toBe(30)
    expect(Math.abs(ax - bx)).toBeGreaterThan(30)
    unmount()
  })

  it("引用未知节点的连接被跳过且不抛错", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    const out = await result.current.calcBoardLayout(
      [{ id: "a", x: 5, y: 5, width: 40 }],
      [{ fromCardId: "a", toCardId: "ghost" }],
    )
    expect(out).toEqual([{ id: "a", x: 5, y: 5 }])
    unmount()
  })

  it("间距小于 1 的节点走距离钳制分支仍收敛到有限坐标", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    const out = await result.current.calcBoardLayout(
      [
        { id: "a", x: 0, y: 0, width: 40 },
        { id: "b", x: 0.5, y: 0, width: 40 },
      ],
      [{ fromCardId: "a", toCardId: "b" }],
    )
    expect(out).toHaveLength(2)
    for (const n of out) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
    }
    unmount()
  })
})

describe("useSimulationWorker.calcBranchDiff", () => {
  function twoBranches() {
    const branchA = makeBranch({
      id: "a",
      name: "甲分支",
      overallScore: 90,
      directorEvaluations: [makeEval(7), makeEval(8), makeEval(8)],
      timelineEvents: [
        makeEvent({ id: "a0", round: 0, nodeIndex: 0, content: "城门相遇结盟共商大计" }),
        makeEvent({ id: "a1", round: 1, nodeIndex: 0, content: "夜袭粮仓行动开始了啊" }),
      ],
      finalAgentSnapshots: [
        { agentId: "c1", name: "寨主", knownSecrets: [], sentiments: [["c2", 80], ["c3", 60]] },
        { agentId: "c2", name: "军师", knownSecrets: [], sentiments: [["c1", 50]] },
      ],
    })
    const branchB = makeBranch({
      id: "b",
      name: "乙分支",
      overallScore: 60,
      directorEvaluations: [],
      timelineEvents: [
        makeEvent({ id: "b0", round: 0, nodeIndex: 0, actorId: "c1", actorName: "寨主", content: "城门相遇结盟共商大计" }),
        makeEvent({ id: "b1", round: 1, nodeIndex: 0, actorId: "c1", actorName: "寨主", content: "白天议和谈判开始了啊" }),
      ],
      finalAgentSnapshots: [
        { agentId: "c1", name: "寨主", knownSecrets: [], sentiments: [["c2", 10]] },
      ],
    })
    return { branchA, branchB }
  }

  it("导演评分取平均并保留一位小数；空评估回退 3.0", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    const { branchA, branchB } = twoBranches()
    const out = await result.current.calcBranchDiff(branchA, branchB)
    // (7+8+8)/3 = 7.666… → 7.7
    expect(out.scoresList[0].tension).toBe(7.7)
    expect(out.scoresList[0].pace).toBe(7.7)
    expect(out.scoresList[1].tension).toBe(3.0)
    // 取差异最大的前 3 个维度：全部 7 个维度 diff 均为 4.7
    expect(out.dimensionDiffs).toHaveLength(3)
    for (const d of out.dimensionDiffs) {
      expect(d.diff).toBeCloseTo(4.7)
      expect(d.maxBranchName).toBe("甲分支")
      expect(d.maxValue).toBe(7.7)
      expect(d.minValue).toBe(3.0)
    }
    unmount()
  })

  it("事件数/角色数按分支统计；overallScore 高者为最佳", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    const { branchA, branchB } = twoBranches()
    const out = await result.current.calcBranchDiff(branchA, branchB)
    expect(out.eventCounts).toEqual([2, 2])
    expect(out.characterCounts).toEqual([2, 1])
    expect(out.bestBranchIdx).toBe(0)
    unmount()
  })

  it("overallScore 持平时保留靠前的分支", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    const { branchA, branchB } = twoBranches()
    const out = await result.current.calcBranchDiff(
      { ...branchA, overallScore: 80 },
      { ...branchB, overallScore: 80 },
    )
    expect(out.bestBranchIdx).toBe(0)
    unmount()
  })

  it("首个内容不同的轮次即分歧轮（从 1 计数）", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    const { branchA, branchB } = twoBranches()
    const out = await result.current.calcBranchDiff(branchA, branchB)
    // round 0 内容前 10 字相同，round 1 不同 → 分歧轮为 2
    expect(out.divergenceRound).toBe(2)
    unmount()
  })

  it("内容完全相同的分支分歧轮为 -1", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    const { branchA } = twoBranches()
    const out = await result.current.calcBranchDiff(branchA, { ...branchA, id: "a-copy" })
    expect(out.divergenceRound).toBe(-1)
    unmount()
  })

  it("双方都无事件时分歧轮为 -1", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    const out = await result.current.calcBranchDiff(makeBranch(), makeBranch({ id: "b" }))
    expect(out.divergenceRound).toBe(-1)
    expect(out.eventCounts).toEqual([0, 0])
    unmount()
  })

  it("情感差异按角色聚合；缺席分支计 0 分", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    const { branchA, branchB } = twoBranches()
    const out = await result.current.calcBranchDiff(branchA, branchB)
    // c1: 甲 (80+60)/2=70 vs 乙 10 → 差 60；c2 只在甲出现：50 vs 0 → 差 50
    expect(out.topSentimentDiffs[0]).toEqual({
      charId: "c1",
      charName: "寨主",
      maxDiff: 60,
      maxBranch: "甲分支",
      values: [70, 10],
    })
    expect(out.topSentimentDiffs[1].charId).toBe("c2")
    expect(out.topSentimentDiffs[1].values).toEqual([50, 0])
    unmount()
  })
})

describe("useSimulationWorker.calcBranchDiff 增补：最佳分支判定", () => {
  it("后分支 overallScore 更高时最佳索引为 1", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    const branchA = makeBranch({ id: "a", name: "甲分支", overallScore: 70 })
    const branchB = makeBranch({ id: "b", name: "乙分支", overallScore: 95 })
    const out = await result.current.calcBranchDiff(branchA, branchB)
    // reduce 真分支：b.overallScore(95) > branches[0].overallScore(70) → 取 idx=1
    expect(out.bestBranchIdx).toBe(1)
    unmount()
  })
})

describe("useSimulationWorker.terminate", () => {
  it("幂等：多次 terminate 后 calc 仍走 fallback 正常返回", async () => {
    const { result, unmount } = renderHook(() => useSimulationWorker())
    result.current.terminate()
    result.current.terminate()
    await expect(
      result.current.calcClueRelations([{ id: "c1", content: "城堡谋杀案，管家嫌疑" }]),
    ).resolves.toEqual({ pairs: [] })
    // 卸载走 effect 清理路径，不应抛错
    unmount()
  })
})

describe("useSimulationWorker.v2 无 Worker 通道锁定", () => {
  it("即使全局存在 Worker 构造器，也绝不建 Worker 并走主线程 fallback", async () => {
    const constructed: unknown[][] = []
    class FakeWorker {
      constructor(...args: unknown[]) {
        constructed.push(args)
      }
      postMessage(): void {}
      terminate(): void {}
    }
    vi.stubGlobal("Worker", FakeWorker)
    try {
      const { result, unmount } = renderHook(() => useSimulationWorker())
      const out = await result.current.calcClueRelations([
        { id: "c1", content: "城堡谋杀案，管家嫌疑" },
        { id: "c2", content: "花园茶会，玫瑰盛开" },
      ])
      // v2 适配：ensureWorker 硬编码返回 null，从不 new Worker
      expect(constructed).toHaveLength(0)
      expect(out).toEqual({ pairs: [] })
      unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

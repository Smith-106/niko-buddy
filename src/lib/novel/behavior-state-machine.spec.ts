import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({ readFileSync: vi.fn() }))
vi.mock("fs", async () => {
  const actual = await import("fs")
  return { ...actual, readFileSync: fsMocks.readFileSync }
})

import {
  analyzeBehaviorStateMachine,
  behaviorStateReportToText,
  type BehaviorStateReport,
} from "./behavior-state-machine"

function chapterText(char: string, action: string, times: number): string {
  return Array.from({ length: times }, () => `${char}${action}`).join("。")
}

describe("behavior-state-machine", () => {
  beforeEach(() => {
    fsMocks.readFileSync.mockReset()
    fsMocks.readFileSync.mockImplementation(() => "")
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns profiles and empty anomalies for no actions", () => {
    fsMocks.readFileSync.mockImplementation(() => "一些没有动作的普通文本。")
    const report = analyzeBehaviorStateMachine([
      { num: 1, path: "ch1.md" },
      { num: 2, path: "ch2.md" },
    ])
    expect(report.profiles["白砚"].archetype).toBe("冷静观察者")
    expect(report.anomalies).toEqual([])
    expect(report.consistencyScores).toEqual({})
    expect(report.evolutionTraces).toEqual({})
  })

  it("assigns score 10 and skips traces for characters with fewer than 3 records", () => {
    fsMocks.readFileSync.mockImplementation((p: string) => {
      const num = Number(p.replace(/[^0-9]/g, ""))
      return chapterText("白鹭", "低下头", 1)
    })
    const report = analyzeBehaviorStateMachine([
      { num: 1, path: "c1.md" },
      { num: 2, path: "c2.md" },
    ])
    expect(report.anomalies).toEqual([])
    expect(report.consistencyScores["白鹭"]).toBe(10)
    expect(report.evolutionTraces["白鹭"]).toBeUndefined()
  })

  it("skips unreadable chapters", () => {
    fsMocks.readFileSync.mockImplementation(() => {
      throw new Error("ENOENT")
    })
    const report = analyzeBehaviorStateMachine([{ num: 1, path: "missing.md" }])
    expect(report.anomalies).toEqual([])
  })

  it("flags overuse for non-established action (warning) and established_pattern (info)", () => {
    fsMocks.readFileSync.mockImplementation((p: string) => {
      const ch = Number(p.replace(/[^0-9]/g, ""))
      if (ch === 1) return chapterText("王迦", "低下头", 5)
      if (ch === 2) return chapterText("白砚", "戒指在指间转动", 5)
      if (ch === 3) return chapterText("王迦", "推眼镜", 1)
      if (ch === 4) return chapterText("王迦", "嘴角上扬", 1)
      if (ch === 5) return chapterText("白砚", "低下头", 1)
      return chapterText("白砚", "抠指甲", 1)
    })
    const report = analyzeBehaviorStateMachine([
      { num: 1, path: "c1.md" },
      { num: 2, path: "c2.md" },
      { num: 3, path: "c3.md" },
      { num: 4, path: "c4.md" },
      { num: 5, path: "c5.md" },
      { num: 6, path: "c6.md" },
    ])
    const types = report.anomalies.map((a) => a.type)
    expect(types).toContain("overuse")
    expect(types).toContain("established_pattern")
    const overuse = report.anomalies.find((a) => a.type === "overuse")
    expect(overuse?.character).toBe("王迦")
    expect(overuse?.severity).toBe("warning")
    const pattern = report.anomalies.find((a) => a.type === "established_pattern")
    expect(pattern?.character).toBe("白砚")
    expect(pattern?.severity).toBe("info")
  })

  it("flags no_evolution when same actions across 4+ chapters", () => {
    fsMocks.readFileSync.mockImplementation((p: string) => {
      const num = Number(p.replace(/[^0-9]/g, ""))
      return chapterText("苏未晞", "抠指甲", 3)
    })
    const report = analyzeBehaviorStateMachine([
      { num: 1, path: "c1.md" },
      { num: 2, path: "c2.md" },
      { num: 3, path: "c3.md" },
      { num: 4, path: "c4.md" },
    ])
    const noEvo = report.anomalies.find((a) => a.type === "no_evolution")
    expect(noEvo).toBeDefined()
    expect(noEvo?.severity).toBe("info")
    expect(noEvo?.character).toBe("苏未晞")
  })

  it("skips characters without profile and short spans", () => {
    fsMocks.readFileSync.mockImplementation(() => chapterText("白鹭", "低下头", 1))
    const report = analyzeBehaviorStateMachine([
      { num: 1, path: "c1.md" },
      { num: 2, path: "c2.md" },
      { num: 3, path: "c3.md" },
    ])
    // 白鹭 has no profile -> anomalies skipped; 3 records -> consistency computed
    expect(report.anomalies).toEqual([])
    expect(report.consistencyScores["白鹭"]).toBe(10)
  })

  it("skips no_evolution flag when late chapters add new actions", () => {
    fsMocks.readFileSync.mockImplementation((p: string) => {
      const num = Number(p.replace(/[^0-9]/g, ""))
      if (num <= 3) return chapterText("苏未晞", "抠指甲", 2)
      return chapterText("苏未晞", "抠指甲", 1) + "。" + chapterText("苏未晞", "推眼镜", 1)
    })
    const report = analyzeBehaviorStateMachine([
      { num: 1, path: "c1.md" },
      { num: 2, path: "c2.md" },
      { num: 3, path: "c3.md" },
      { num: 4, path: "c4.md" },
    ])
    expect(report.anomalies.filter((a) => a.type === "no_evolution")).toEqual([])
  })

  it("computes consistency scores with concentration and count penalties", () => {
    fsMocks.readFileSync.mockImplementation((p: string) => {
      const num = Number(p.replace(/[^0-9]/g, ""))
      if (num === 1) return chapterText("王迦", "低下头", 5)
      if (num === 2) return chapterText("王迦", "推眼镜", 1)
      return chapterText("王迦", "嘴角上扬", 1)
    })
    const report = analyzeBehaviorStateMachine([
      { num: 1, path: "c1.md" },
      { num: 2, path: "c2.md" },
      { num: 3, path: "c3.md" },
    ])
    // 低下头 total 5 -> -1.5; all 5 concentrated in ch1 (5 >= 5*0.7) -> -2 => 6.5
    expect(report.consistencyScores["王迦"]).toBeCloseTo(6.5, 5)
  })

  it("keeps score 10 for sparse actions and builds evolution traces", () => {
    fsMocks.readFileSync.mockImplementation((p: string) => {
      const num = Number(p.replace(/[^0-9]/g, ""))
      if (num === 1) return chapterText("王迦", "推眼镜", 2) + "。" + chapterText("王迦", "嘴角上扬", 1)
      if (num === 2) return chapterText("王迦", "推眼镜", 1)
      return ""
    })
    const report = analyzeBehaviorStateMachine([
      { num: 1, path: "c1.md" },
      { num: 2, path: "c2.md" },
    ])
    expect(report.consistencyScores["王迦"]).toBe(10)
    const trace = report.evolutionTraces["王迦"]
    expect(trace[1]).toEqual(["推眼镜×2", "嘴角上扬×1"])
    expect(trace[2]).toEqual(["推眼镜×1"])
  })

  it("behaviorStateReportToText renders anomalies with severity icons", () => {
    const report: BehaviorStateReport = {
      profiles: {},
      anomalies: [
        {
          character: "A",
          severity: "error",
          type: "overuse",
          message: "m1",
          suggestion: "s1",
        },
        {
          character: "B",
          severity: "warning",
          type: "context_mismatch",
          message: "m2",
          suggestion: "s2",
        },
        {
          character: "C",
          severity: "info",
          type: "no_evolution",
          message: "m3",
          suggestion: "s3",
        },
      ],
      consistencyScores: {},
      evolutionTraces: {},
    }
    const text = behaviorStateReportToText(report)
    expect(text).toContain("❌ [A] m1")
    expect(text).toContain("⚠️ [B] m2")
    expect(text).toContain("ℹ️ [C] m3")
    expect(text).toContain("建议: s1")
    expect(text).toContain("行为异常")
  })

  it("behaviorStateReportToText renders score bands and skips empty sections", () => {
    const report: BehaviorStateReport = {
      profiles: {},
      anomalies: [],
      consistencyScores: { good: 8.2, mid: 6.5, bad: 3.1, perfect: 10 },
      evolutionTraces: {},
    }
    const text = behaviorStateReportToText(report)
    expect(text).toContain("✅ good: 8.2/10")
    expect(text).toContain("⚠️ mid: 6.5/10")
    expect(text).toContain("❌ bad: 3.1/10")
    expect(text).not.toContain("perfect")
    expect(text).not.toContain("行为异常")
  })

  it("behaviorStateReportToText returns header only for empty report", () => {
    const report: BehaviorStateReport = {
      profiles: {},
      anomalies: [],
      consistencyScores: {},
      evolutionTraces: {},
    }
    expect(behaviorStateReportToText(report)).toBe("角色行为状态机分析:")
  })
})

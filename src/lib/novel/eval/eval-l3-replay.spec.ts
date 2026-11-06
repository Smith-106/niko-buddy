/** C4 冒烟覆盖：src/lib/novel/eval/eval-l3-replay.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { replayL3 } from "./eval-l3-replay"
describe("eval-l3-replay.ts smoke", () => {
  it("exports replayL3", () => {
    expect(replayL3).toBeDefined()
  })
})

// ── 行为加深（statements 100% 专项）：回放委托 + critical/mechanical 过滤口径 ──
import type { ContinuityFinding } from "../deterministic-continuity-engine"
import type { EvalCase } from "./eval-schema"

const caseItem: EvalCase = {
  id: "case-l3-1",
  chapter: 3,
  query: "回放 L3",
  goldChunks: [],
  poisonChunks: [],
  expectedLayer: "protected",
  source: "synthetic",
}

function finding(
  over: Pick<ContinuityFinding, "subtype" | "severity"> & { type: ContinuityFinding["type"]; ref: string },
): ContinuityFinding {
  const base = {
    type: over.type,
    subtype: over.subtype,
    severity: over.severity,
    ref: over.ref,
    message: `finding ${over.ref}`,
    chapter: 3,
  }
  return over.subtype === "data_gap"
    ? { ...base, subtype: "data_gap", missingField: "lastSeenChapter" }
    : { ...base, subtype: "consistency_mechanical" }
}

describe("replayL3：checkContinuity 委托 + L3 过滤口径", () => {
  it("把 context 原样交给注入的 runCheckContinuity（真实引擎接线点）", async () => {
    const context = { canonRules: "rule-a", timeline: "t-1" }
    const seen: unknown[] = []
    await replayL3(caseItem, {
      runCheckContinuity: async (input) => {
        seen.push(input)
        return []
      },
      context,
    })
    // 可观察：执行器收到调用方装配的 ContextPack 上下文同一引用
    expect(seen).toEqual([context])
    expect(seen[0]).toBe(context)
  })

  it("只保留 critical + consistency_mechanical（warning/info/data_gap 全被滤掉）", async () => {
    const raw: ContinuityFinding[] = [
      finding({ type: "dormant_thread", subtype: "consistency_mechanical", severity: "critical", ref: "subplot:复仇线" }),
      finding({ type: "absent_character", subtype: "consistency_mechanical", severity: "warning", ref: "character:甲" }),
      finding({ type: "timeline_drift", subtype: "consistency_mechanical", severity: "info", ref: "character:乙" }),
      finding({ type: "data_gap", subtype: "data_gap", severity: "critical", ref: "subplot:丙" }),
    ]
    const kept = await replayL3(caseItem, { runCheckContinuity: async () => raw, context: {} })
    expect(kept.map((f) => f.ref)).toEqual(["subplot:复仇线"])
  })

  it("执行器抛错向上冒泡（不静默吞成 pass）", async () => {
    await expect(
      replayL3(caseItem, {
        runCheckContinuity: async () => {
          throw new Error("engine boom")
        },
        context: {},
      }),
    ).rejects.toThrow("engine boom")
  })
})

/**
 * E-06 (run-execute-1, 双库架构蓝图) 验收② — 评测 gate spec。
 *
 * 共识 C-6/C-7：gate 常量在 offline-replay-config.ts（EVAL_GATE 冻结）；
 * 三态 verdict（PASS/FAIL/BLOCKED）；种子未就绪 → 恒 BLOCKED(seed-missing)，
 * 绝不默认 PASS；报告无 MRR/NDCG 验收语义（GOV-EVAL-05）。
 */
import { describe, it, expect } from "vitest"
import { EVAL_GATE, type TripleCriteria } from "./offline-replay-config"
import {
  GOV_SEED_CASE_SCHEMA,
  loadGovSeedSet,
  validateGovSeedScale,
  computeTripleCriteria,
  evaluateRetrievalGate,
  renderEvalGateReport,
  GOV_SEED_MIN_SCALE,
  type GovSeedCase,
} from "./eval-gate"

function makeCase(overrides: Record<string, unknown> = {}): GovSeedCase {
  return {
    caseId: "EVAL-OBL-001",
    category: "obligation_recall",
    intent: "draft",
    query: "密道在哪里",
    expectedObligationIds: ["密道"],
    ...overrides,
  } as GovSeedCase
}

describe("E-06 EVAL_GATE 常量（GOV-EVAL-08：冻结，MUST NOT 运行时关闭）", () => {
  it("常量值 = 0.01 / 0.95 且 Object.isFrozen", () => {
    expect(EVAL_GATE.canonViolationMax).toBe(0.01)
    expect(EVAL_GATE.obligationCoverageMin).toBe(0.95)
    expect(Object.isFrozen(EVAL_GATE)).toBe(true)
  })
})

describe("E-06 G-1 种子契约（REQ-EVAL-001）", () => {
  it("schema 接受完整契约字段", () => {
    const parsed = GOV_SEED_CASE_SCHEMA.parse(makeCase())
    expect(parsed.caseId).toBe("EVAL-OBL-001")
    expect(parsed.category).toBe("obligation_recall")
  })

  it("非法 category/intent → throw", () => {
    expect(() => GOV_SEED_CASE_SCHEMA.parse(makeCase({ category: "bogus" }))).toThrow()
    expect(() => GOV_SEED_CASE_SCHEMA.parse(makeCase({ intent: "bogus" }))).toThrow()
  })

  it("最小规模基线（GOV-EVAL-03）：≥60/≥30/≥20", () => {
    expect(GOV_SEED_MIN_SCALE.obligationRecall).toBe(60)
    expect(GOV_SEED_MIN_SCALE.poisonBlock).toBe(30)
    expect(GOV_SEED_MIN_SCALE.canonViolationReplay).toBe(20)
  })

  it("规模校验：不足 → violations；齐备 → 空", () => {
    const few = [makeCase(), makeCase({ caseId: "EVAL-OBL-002" })]
    const violations = validateGovSeedScale(few)
    expect(violations.some((v) => v.category === "obligation_recall")).toBe(true)
    expect(validateGovSeedScale([]).length).toBeGreaterThan(0)
  })
})

describe("E-06 loadGovSeedSet 三态（C-7）", () => {
  it("空/缺失 → missing", () => {
    expect(loadGovSeedSet([]).status).toBe("missing")
    expect(loadGovSeedSet([""]).status).toBe("missing")
  })

  it("规模不足 → insufficient + scaleViolations", () => {
    const lines = [JSON.stringify(makeCase()), JSON.stringify(makeCase({ caseId: "EVAL-OBL-002" }))]
    const set = loadGovSeedSet(lines)
    expect(set.status).toBe("insufficient")
    expect(set.scaleViolations.length).toBeGreaterThan(0)
  })

  it("齐备 → ready（构造最小齐备集：60 recall + 30 poison + 20 replay 含 P-1..P-6 各≥2）", () => {
    const cases: unknown[] = []
    for (let i = 0; i < 60; i++) cases.push(makeCase({ caseId: `EVAL-OBL-${i}` }))
    for (let i = 0; i < 30; i++) cases.push(makeCase({ caseId: `EVAL-PSN-${i}`, category: "poison_block" }))
    for (let i = 0; i < 20; i++) {
      const trap = `P-${(i % 6) + 1}`
      cases.push(makeCase({ caseId: `EVAL-VIO-${i}-${trap}`, category: "canon_violation_replay" }))
    }
    const set = loadGovSeedSet(cases.map((c) => JSON.stringify(c)))
    expect(set.status).toBe("ready")
    expect(set.scaleViolations).toEqual([])
  })
})

describe("E-06 evaluateRetrievalGate（GOV-EVAL-04/08，三态）", () => {
  const passCriteria: TripleCriteria = { canonViolationRate: 0.005, obligationCoverage: 0.96, atmosphereScore: 0.9 }

  it("(2%, 90%) → FAIL；(<1%, >95%) → PASS（严格 < / > 口径）", () => {
    expect(
      evaluateRetrievalGate({ criteria: { canonViolationRate: 0.02, obligationCoverage: 0.9, atmosphereScore: 0.9 }, seedStatus: "ready" }).verdict,
    ).toBe("FAIL")
    expect(evaluateRetrievalGate({ criteria: passCriteria, seedStatus: "ready" }).verdict).toBe("PASS")
  })

  it("边界：canonViolationRate=1.0% → FAIL；obligationCoverage=95.0% → FAIL", () => {
    expect(
      evaluateRetrievalGate({ criteria: { canonViolationRate: 0.01, obligationCoverage: 0.96, atmosphereScore: 0.9 }, seedStatus: "ready" }).verdict,
    ).toBe("FAIL")
    expect(
      evaluateRetrievalGate({ criteria: { canonViolationRate: 0.005, obligationCoverage: 0.95, atmosphereScore: 0.9 }, seedStatus: "ready" }).verdict,
    ).toBe("FAIL")
  })

  it("种子未就绪 → 恒 BLOCKED(seed-missing)，绝不 PASS", () => {
    const v = evaluateRetrievalGate({ criteria: passCriteria, seedStatus: "missing" })
    expect(v.verdict).toBe("BLOCKED")
    if (v.verdict === "BLOCKED") expect(v.reason).toBe("seed-missing")
  })

  it("种子不足 → BLOCKED(seed-insufficient) + detail", () => {
    const v = evaluateRetrievalGate({
      criteria: passCriteria,
      seedStatus: "insufficient",
      scaleViolations: [{ category: "obligation_recall", expected: 60, actual: 2 }],
    })
    expect(v.verdict).toBe("BLOCKED")
    if (v.verdict === "BLOCKED") {
      expect(v.reason).toBe("seed-insufficient")
      expect(v.detail).toContain("obligation_recall")
    }
  })

  it("任一判据 null（不可采集）→ BLOCKED(metric-unavailable)，不降级为 PASS", () => {
    const v = evaluateRetrievalGate({
      criteria: { canonViolationRate: null, obligationCoverage: 0.96, atmosphereScore: null },
      seedStatus: "ready",
    })
    expect(v.verdict).toBe("BLOCKED")
    if (v.verdict === "BLOCKED") expect(v.reason).toBe("metric-unavailable")
  })

  it("atmosphereScore 低于阈值 → FAIL", () => {
    expect(
      evaluateRetrievalGate({ criteria: { canonViolationRate: 0.005, obligationCoverage: 0.96, atmosphereScore: 0.5 }, seedStatus: "ready" }).verdict,
    ).toBe("FAIL")
  })
})

describe("E-06 报告（GOV-EVAL-05/06：无 MRR/NDCG 验收语义）", () => {
  it("computeTripleCriteria 透传三判据（atmosphere 缺省 null 不伪造）", () => {
    const c = computeTripleCriteria({ canonViolationRate: 0.005, obligationCoverage: 0.96 })
    expect(c.atmosphereScore).toBeNull()
  })

  it("报告渲染含三判据 + 固定文案（MRR/NDCG 缺席声明）", () => {
    const report = {
      seedStatus: "ready" as const,
      criteria: { canonViolationRate: 0.005, obligationCoverage: 0.96, atmosphereScore: 0.9 },
      verdict: { verdict: "PASS" as const },
      trapInterception: { "P-1": 2, "P-2": 2 },
      acceptanceNote: "本报告不含 MRR/NDCG 验收语义（GOV-EVAL-05 / SA-06）。",
    }
    const text = renderEvalGateReport(report)
    expect(text).toContain("canon_violation_rate")
    expect(text).toContain("obligation_coverage")
    expect(text).toContain("本报告不含 MRR/NDCG 验收语义")
    // 报告体不含任何 MRR/NDCG 指标行（仅固定文案声明缺席）
    const bodyLines = text.split("\n").filter((l) => l.startsWith("-"))
    expect(bodyLines.join("\n")).not.toMatch(/MRR|NDCG/)
  })
})

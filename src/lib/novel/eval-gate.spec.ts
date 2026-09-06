/**
 * E-06 (run-execute-1, 双库架构蓝图) 验收② — 评测 gate spec。
 *
 * 共识 C-6/C-7：gate 常量在 offline-replay-config.ts（EVAL_GATE 冻结）；
 * 三态 verdict（PASS/FAIL/BLOCKED）；种子未就绪 → 恒 BLOCKED(seed-missing)，
 * 绝不默认 PASS；报告无 MRR/NDCG 验收语义（GOV-EVAL-05）。
 */
import { describe, it, expect } from "vitest"
import { EVAL_GATE, type TripleCriteria } from "./offline-replay-config"
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  GOV_SEED_CASE_SCHEMA,
  loadGovSeedSet,
  validateGovSeedScale,
  computeTripleCriteria,
  evaluateRetrievalGate,
  renderEvalGateReport,
  GOV_SEED_MIN_SCALE,
  GOV_TRAPS,
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

// ──────────────────────────────────────────────────────────────────────────
// P1-IMP-11：真实种子文件契约用例（docs/p0/gov-seed/gov-seed-v1.jsonl）
// ──────────────────────────────────────────────────────────────────────────

/** 种子文件路径：spec 位于 QMAI/src/lib/novel/ → hub 根 QMAI/docs/p0/gov-seed。 */
const GOV_SEED_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/p0/gov-seed/gov-seed-v1.jsonl")

/** 读真实种子文件（每行一例；文件缺失 = 契约破坏 → 测试必须红）。 */
function readGovSeedFileLines(): string[] {
  return readFileSync(GOV_SEED_PATH, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
}

describe("P1-IMP-11 真实种子文件契约（docs/p0/gov-seed/gov-seed-v1.jsonl）", () => {
  it("文件存在且每行严格对齐 GOV_SEED_CASE_SCHEMA（schema 外字段即违反）", () => {
    const lines = readGovSeedFileLines()
    expect(lines.length).toBeGreaterThanOrEqual(20)
    expect(lines.length).toBeLessThanOrEqual(50)
    for (const line of lines) {
      const raw = JSON.parse(line) as Record<string, unknown>
      const parsed = GOV_SEED_CASE_SCHEMA.parse(raw)
      expect(parsed.caseId).toBeTruthy()
      expect(parsed.query.length).toBeGreaterThan(0)
      // 严格契约：schema 外字段（溯源/复核字段）视为违反——溯源信息必须编码进 caseId
      const allowed = Object.keys(GOV_SEED_CASE_SCHEMA.shape)
      for (const key of Object.keys(raw)) expect(allowed).toContain(key)
    }
  })

  it("真实文件 status !== missing（种子实体存在，非空壳）", () => {
    const set = loadGovSeedSet(readGovSeedFileLines())
    expect(set.status).not.toBe("missing")
    expect(set.cases.length).toBeGreaterThanOrEqual(20)
  })

  it("三类用例（GOV-EVAL-01）均非零 + 五 intent 分布", () => {
    const set = loadGovSeedSet(readGovSeedFileLines())
    for (const cat of ["obligation_recall", "poison_block", "canon_violation_replay"] as const) {
      expect(set.cases.filter((c) => c.category === cat).length).toBeGreaterThan(0)
    }
    for (const intent of ["plan", "draft", "revise", "lookup", "style"] as const) {
      expect(set.cases.filter((c) => c.intent === intent).length).toBeGreaterThan(0)
    }
  })

  it("六陷阱 P-1..P-6 各 ≥2（trapMinPerTrap，GOV-EVAL-03）", () => {
    const set = loadGovSeedSet(readGovSeedFileLines())
    for (const trap of GOV_TRAPS) {
      const count = set.cases.filter(
        (c) => c.category === "canon_violation_replay" && c.caseId.includes(trap),
      ).length
      expect(count).toBeGreaterThanOrEqual(GOV_SEED_MIN_SCALE.trapMinPerTrap)
    }
  })

  it("「未达 110 显式钉死」：v1 冷启动批 < GOV_SEED_MIN_SCALE → status=insufficient + violation 列表与实测规模一致（防误判就绪）", () => {
    const lines = readGovSeedFileLines()
    const set = loadGovSeedSet(lines)
    // v1 首批 20-50 例 < 110 底线 → 恒 insufficient，绝不 ready（V5 不伪造就绪）
    expect(lines.length).toBeLessThan(
      GOV_SEED_MIN_SCALE.obligationRecall + GOV_SEED_MIN_SCALE.poisonBlock + GOV_SEED_MIN_SCALE.canonViolationReplay,
    )
    expect(set.status).toBe("insufficient")
    // violation 列表与实测规模一致（六陷阱 ≥2 已达标 → trap 子校验零 violation）
    const actual = {
      obligation_recall: set.cases.filter((c) => c.category === "obligation_recall").length,
      poison_block: set.cases.filter((c) => c.category === "poison_block").length,
      canon_violation_replay: set.cases.filter((c) => c.category === "canon_violation_replay").length,
    }
    for (const v of set.scaleViolations) {
      expect(v.actual).toBe(actual[v.category])
      expect(v.expected).toBe(
        v.category === "obligation_recall"
          ? GOV_SEED_MIN_SCALE.obligationRecall
          : v.category === "poison_block"
            ? GOV_SEED_MIN_SCALE.poisonBlock
            : GOV_SEED_MIN_SCALE.canonViolationReplay,
      )
    }
    expect(set.scaleViolations.length).toBe(3) // 三类均未达（20-50 例冷启动）
  })

  it("gate 语义：真实 v1 种子 → 恒 BLOCKED（绝无 PASS），剩余例待 IMP-06/07/08 就位后补齐", () => {
    const set = loadGovSeedSet(readGovSeedFileLines())
    const verdict = evaluateRetrievalGate({
      criteria: { canonViolationRate: 0, obligationCoverage: 1, atmosphereScore: 1 },
      seedStatus: set.status,
      scaleViolations: set.scaleViolations,
    })
    expect(verdict.verdict).toBe("BLOCKED")
    if (verdict.verdict === "BLOCKED") expect(verdict.reason).toBe("seed-insufficient")
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

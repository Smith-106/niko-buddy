/** C4 冒烟覆盖 + N-4 采纳门控真值矩阵：src/lib/novel/deep-chapter-decision-gates.ts */
import { describe, expect, it } from "vitest"
import {
  createEmptyDecisionGate,
  emptyDecisionGates,
  buildDecisionGates,
  collectBlockingIssues,
  collectRepairIssues,
  collectLiteraryPolishIssues,
  isNonBlockingQualityUpgrade,
  decideDraftAdoptionGate,
  type DeepChapterDecisionGate,
  type DeepChapterDecisionGates,
} from "./deep-chapter-decision-gates"
import type { NovelReviewResult } from "./review-adapter"

function makeFinding(
  severity: "error" | "warning" | "info",
  type: string,
  message = `${type}:${severity}`,
): NovelReviewResult {
  return {
    severity,
    type,
    message,
    evidence: "正文片段",
    relatedMemory: "",
    suggestion: "建议调整",
  }
}

function makeGate(overrides: Partial<DeepChapterDecisionGate> = {}): DeepChapterDecisionGate {
  return {
    status: "passed",
    verdict: "pass",
    findings: [],
    repair_suggestions: [],
    retry_count: 0,
    ...overrides,
  }
}

describe("deep-chapter-decision-gates.ts smoke", () => {
  it("createEmptyDecisionGate() executes", async () => {
    await (createEmptyDecisionGate() as unknown as Promise<unknown>)
  })
  it("emptyDecisionGates() executes", async () => {
    await (emptyDecisionGates() as unknown as Promise<unknown>)
  })
  it("exports buildDecisionGates", () => {
    expect(buildDecisionGates).toBeDefined()
  })
  it("exports collectBlockingIssues", () => {
    expect(collectBlockingIssues).toBeDefined()
  })
  it("exports collectRepairIssues", () => {
    expect(collectRepairIssues).toBeDefined()
  })
  it("exports collectLiteraryPolishIssues", () => {
    expect(collectLiteraryPolishIssues).toBeDefined()
  })
})

describe("N-4 decideDraftAdoptionGate 真值矩阵与 Quality upgradedToFail 死锁回归", () => {
  const threeQualityWarnings = (): NovelReviewResult[] => [
    makeFinding("warning", "quality", "节奏偏慢-1"),
    makeFinding("warning", "plot", "爽点密度偏弱-2"),
    makeFinding("warning", "thrill", "钩子偏弱-3"),
  ]

  it("3 条 Quality warning 在题材下触发 upgradedToFail 时不阻断采纳（Consistency(P0) > Anti-AI(P1) > Quality(P2)）", () => {
    const gates = buildDecisionGates(threeQualityWarnings(), 0, false, "悬疑", true)
    // buildDecisionGates 原有返回值保持不变（零破坏既有单测）
    expect(gates.consistency.status).toBe("passed")
    expect(gates.anti_ai.status).toBe("passed")
    expect(gates.quality.status).toBe("failed")
    expect(gates.quality.verdict).toBe("fail")
    expect(gates.overall).toBe("fail")
    // collectBlockingIssues 仍为空（不会进入阶段5自动返修），isNonBlockingQualityUpgrade 为 true
    expect(collectBlockingIssues(gates)).toEqual([])
    expect(isNonBlockingQualityUpgrade(gates)).toBe(true)
    // reviewed=true 时解锁采纳死锁 → passed；reviewed=false 仍 fail-closed → unassessed
    expect(decideDraftAdoptionGate(gates, { reviewed: true })).toBe("passed")
    expect(decideDraftAdoptionGate(gates, { reviewed: false })).toBe("unassessed")
    // partial 与 manualReviewRequired 优先级仍高于非阻断升级
    expect(decideDraftAdoptionGate(gates, { reviewed: true, partial: true })).toBe("partial")
    expect(decideDraftAdoptionGate(gates, { reviewed: true, manualReviewRequired: true })).toBe("manual_review")
  })

  it("P0 consistency warning + P1 anti_ai passed + P2 upgradedToFail（0 error）时仍可采纳", () => {
    const gates = buildDecisionGates(
      [makeFinding("warning", "consistency", "轻微时间锚提示"), ...threeQualityWarnings()],
      0,
      false,
      "悬疑",
      true,
    )
    expect(gates.consistency.status).toBe("passed")
    expect(gates.consistency.verdict).toBe("warning")
    expect(gates.anti_ai.status).toBe("passed")
    expect(gates.quality.status).toBe("failed")
    expect(gates.overall).toBe("fail")
    expect(isNonBlockingQualityUpgrade(gates)).toBe(true)
    expect(decideDraftAdoptionGate(gates, { reviewed: true })).toBe("passed")
  })

  it("manualReviewRequired 或 overall=manual_review 时返回 manual_review", () => {
    const gates = buildDecisionGates(threeQualityWarnings(), 0, true, "悬疑", true)
    expect(gates.overall).toBe("manual_review")
    expect(gates.quality.verdict).toBe("manual_review")
    expect(gates.quality.manual_review_required).toBe(true)
    expect(decideDraftAdoptionGate(gates, { reviewed: true })).toBe("manual_review")
  })

  it("R2-W03：collectRepairIssues 对英文/中文/拼音题材统一命中 repair_scope 路由", () => {
    const consistencyWarn = makeFinding("warning", "consistency", "时间线提示")
    const antiAiWarn = makeFinding("warning", "anti_ai", "AI腔提示")
    const qualityWarn = makeFinding("warning", "quality", "节奏提示")
    const gates = buildDecisionGates([consistencyWarn, antiAiWarn, qualityWarn], 0, false, undefined, true)
    // mystery / 悬疑 / tuili：consistency=resettle_only、quality=warn_only，仅 anti_ai=rewrite_body 进入自动返修
    expect(collectRepairIssues(gates, "mystery").map((i) => i.type)).toEqual(["anti_ai"])
    expect(collectRepairIssues(gates, "悬疑").map((i) => i.type)).toEqual(["anti_ai"])
    expect(collectRepairIssues(gates, "tuili").map((i) => i.type)).toEqual(["anti_ai"])
    // 空白串视同未指定题材，保留全部 warning
    expect(collectRepairIssues(gates, "   ")).toHaveLength(3)
  })

  it("P0/P1 failed 或 P2 含真实 error finding 时必须返回 blocked", () => {
    // P0 consistency error
    const p0Fail = buildDecisionGates([makeFinding("error", "consistency")], 0, false, "悬疑", true)
    expect(isNonBlockingQualityUpgrade(p0Fail)).toBe(false)
    expect(decideDraftAdoptionGate(p0Fail, { reviewed: true })).toBe("blocked")

    // P1 anti_ai error
    const p1Fail = buildDecisionGates([makeFinding("error", "anti_ai")], 0, false, "悬疑", true)
    expect(isNonBlockingQualityUpgrade(p1Fail)).toBe(false)
    expect(decideDraftAdoptionGate(p1Fail, { reviewed: true })).toBe("blocked")

    // P2 quality real error（即使混杂 warning）
    const p2RealError = buildDecisionGates(
      [makeFinding("warning", "quality", "告警"), makeFinding("error", "quality", "硬错误")],
      0,
      false,
      "悬疑",
      true,
    )
    expect(p2RealError.consistency.status).toBe("passed")
    expect(p2RealError.anti_ai.status).toBe("passed")
    expect(p2RealError.quality.status).toBe("failed")
    expect(isNonBlockingQualityUpgrade(p2RealError)).toBe(false)
    expect(decideDraftAdoptionGate(p2RealError, { reviewed: true })).toBe("blocked")

    // 伪造 overall="warning" 但 quality 含真实 error → 仍由 hasBlockingQualityError 兜底 blocked
    const forgedWarningWithQualityError: DeepChapterDecisionGates = {
      consistency: makeGate({ status: "passed", verdict: "pass" }),
      anti_ai: makeGate({ status: "passed", verdict: "pass" }),
      quality: makeGate({
        status: "failed",
        verdict: "fail",
        findings: [makeFinding("error", "quality", "伪造 overall 下的硬错")],
      }),
      overall: "warning",
    }
    expect(decideDraftAdoptionGate(forgedWarningWithQualityError, { reviewed: true })).toBe("blocked")
  })

  it("P0/P1 pending + Quality upgradedToFail 或伪造 overall=fail → fail-closed 返回 blocked", () => {
    // P0 pending + P1 passed + Quality warning upgrade
    const p0PendingUpgrade: DeepChapterDecisionGates = {
      consistency: createEmptyDecisionGate(),
      anti_ai: makeGate({ status: "passed", verdict: "pass" }),
      quality: makeGate({ status: "failed", verdict: "fail", findings: threeQualityWarnings() }),
      overall: "fail",
    }
    expect(decideDraftAdoptionGate(p0PendingUpgrade, { reviewed: true })).toBe("blocked")

    // P0 passed + P1 pending + Quality warning upgrade
    const p1PendingUpgrade: DeepChapterDecisionGates = {
      consistency: makeGate({ status: "passed", verdict: "pass" }),
      anti_ai: createEmptyDecisionGate(),
      quality: makeGate({ status: "failed", verdict: "fail", findings: threeQualityWarnings() }),
      overall: "fail",
    }
    expect(decideDraftAdoptionGate(p1PendingUpgrade, { reviewed: true })).toBe("blocked")

    // 伪造 overall="fail" 但三门均为 passed（非 quality 升级）→ fail-closed blocked
    const forgedOverallFail: DeepChapterDecisionGates = {
      consistency: makeGate({ status: "passed", verdict: "pass" }),
      anti_ai: makeGate({ status: "passed", verdict: "pass" }),
      quality: makeGate({ status: "passed", verdict: "pass" }),
      overall: "fail",
    }
    expect(decideDraftAdoptionGate(forgedOverallFail, { reviewed: true })).toBe("blocked")
  })

  it("常规 pass / warning / unassessed 与伪造不一致门控边界覆盖", () => {
    // 常规全 pass
    const allPass = buildDecisionGates([], 0, false, undefined, true)
    expect(decideDraftAdoptionGate(allPass, { reviewed: true })).toBe("passed")
    expect(decideDraftAdoptionGate(allPass, { reviewed: false })).toBe("unassessed")

    // 常规 warning（无升级）
    const singleWarn = buildDecisionGates([makeFinding("warning", "plot")], 0, false, undefined, true)
    expect(singleWarn.overall).toBe("warning")
    expect(decideDraftAdoptionGate(singleWarn, { reviewed: true })).toBe("passed")
    expect(decideDraftAdoptionGate(singleWarn, { reviewed: false })).toBe("unassessed")

    // 空门（pending）→ unassessed
    expect(decideDraftAdoptionGate(emptyDecisionGates(), { reviewed: true })).toBe("unassessed")

    // 伪造 consistency.status=passed 但 verdict=pending → unassessed
    const forgedPendingVerdict: DeepChapterDecisionGates = {
      consistency: makeGate({ status: "passed", verdict: "pending" }),
      anti_ai: makeGate({ status: "passed", verdict: "pass" }),
      quality: makeGate({ status: "passed", verdict: "pass" }),
      overall: "pass",
    }
    expect(decideDraftAdoptionGate(forgedPendingVerdict, { reviewed: true })).toBe("unassessed")

    // 伪造 overall=pending 且非 quality 升级 → unassessed
    const forgedOverallPending: DeepChapterDecisionGates = {
      consistency: makeGate({ status: "passed", verdict: "pass" }),
      anti_ai: makeGate({ status: "passed", verdict: "pass" }),
      quality: createEmptyDecisionGate(),
      overall: "pending",
    }
    expect(decideDraftAdoptionGate(forgedOverallPending, { reviewed: true })).toBe("unassessed")
  })
})

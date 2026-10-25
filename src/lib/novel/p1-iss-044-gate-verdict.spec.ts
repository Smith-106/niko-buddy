/**
 * ISS-20260709-044：3-gate verdict 与 WARNING 路由在 buildDecision 中耦合解开。
 *
 * 解开前：`createGate` 内 status/verdict 由同一嵌套三元算出，WARNING 路由与裁决字面交织。
 * 解开后：resolveGateStatus / resolveGateVerdict / resolveOverallVerdict 三个显式分支
 * 纯函数 + collectRepairIssues（只读 severity）。本文件以真值表锁定行为等价。
 */
import { describe, expect, it } from "vitest"
import {
  buildDecisionGates,
  collectBlockingIssues,
  collectRepairIssues,
  resolveGateStatus,
  resolveGateVerdict,
  resolveOverallVerdict,
  type DeepChapterDecisionGates,
} from "./deep-chapter-decision-gates"
import type { NovelReviewResult } from "./review-adapter"

function finding(
  severity: "error" | "warning" | "info",
  type = "consistency",
): NovelReviewResult {
  return {
    severity,
    type,
    message: `${type}:${severity}`,
    evidence: "",
    relatedMemory: "",
    suggestion: "修",
  }
}

function gatesWith(
  consistency: Partial<{ status: "passed" | "failed"; verdict: "pass" | "warning" | "fail" | "manual_review" | "pending" }> = {},
  antiAi: Partial<{ status: "passed" | "failed"; verdict: "pass" | "warning" | "fail" | "manual_review" | "pending" }> = {},
  quality: Partial<{ status: "passed" | "failed"; verdict: "pass" | "warning" | "fail" | "manual_review" | "pending" }> = {},
): DeepChapterDecisionGates {
  const gate = (p: typeof consistency) => ({
    status: p.status ?? ("passed" as const),
    verdict: p.verdict ?? ("warning" as const),
    findings: [],
    repair_suggestions: [],
    retry_count: 0,
  })
  return {
    consistency: gate(consistency),
    anti_ai: gate(antiAi),
    quality: gate(quality),
    overall: "pending",
  }
}

describe("ISS-20260709-044：resolveGateVerdict 真值表（与改前三元等价）", () => {
  it("error → fail（manualReviewRequired=false）", () => {
    expect(
      resolveGateVerdict({ hasError: true, upgradedToFail: false, hasWarning: false, manualReviewRequired: false }),
    ).toBe("fail")
  })

  it("error + manualReviewRequired → manual_review", () => {
    expect(
      resolveGateVerdict({ hasError: true, upgradedToFail: false, hasWarning: true, manualReviewRequired: true }),
    ).toBe("manual_review")
  })

  it("题材升级（upgradedToFail）视同 error", () => {
    expect(
      resolveGateVerdict({ hasError: false, upgradedToFail: true, hasWarning: true, manualReviewRequired: false }),
    ).toBe("fail")
    expect(
      resolveGateVerdict({ hasError: false, upgradedToFail: true, hasWarning: true, manualReviewRequired: true }),
    ).toBe("manual_review")
  })

  it("仅 warning → warning（manualReviewRequired 不提升 warning）", () => {
    expect(
      resolveGateVerdict({ hasError: false, upgradedToFail: false, hasWarning: true, manualReviewRequired: true }),
    ).toBe("warning")
    expect(
      resolveGateVerdict({ hasError: false, upgradedToFail: false, hasWarning: true, manualReviewRequired: false }),
    ).toBe("warning")
  })

  it("无 error 无 warning → pass", () => {
    expect(
      resolveGateVerdict({ hasError: false, upgradedToFail: false, hasWarning: false, manualReviewRequired: true }),
    ).toBe("pass")
  })

  it("resolveGateStatus：error/升级 → failed，否则 passed", () => {
    expect(resolveGateStatus({ hasError: true, upgradedToFail: false })).toBe("failed")
    expect(resolveGateStatus({ hasError: false, upgradedToFail: true })).toBe("failed")
    expect(resolveGateStatus({ hasError: false, upgradedToFail: false })).toBe("passed")
  })
})

describe("ISS-20260709-044：resolveOverallVerdict 真值表（CORR-108 优先级不变）", () => {
  it("任一 failed → fail（Quality-failure 不被 Anti-AI warning 掩盖）", () => {
    const g = gatesWith({ status: "passed", verdict: "pass" }, { status: "passed", verdict: "warning" }, { status: "failed", verdict: "fail" })
    expect(resolveOverallVerdict(g, false)).toBe("fail")
  })

  it("failed + manualReviewRequired → manual_review", () => {
    const g = gatesWith({ status: "failed", verdict: "fail" }, {}, {})
    expect(resolveOverallVerdict(g, true)).toBe("manual_review")
  })

  it("全 passed + 任一 warning → warning", () => {
    const g = gatesWith({}, { status: "passed", verdict: "warning" }, { status: "passed", verdict: "pass" })
    expect(resolveOverallVerdict(g, false)).toBe("warning")
  })

  it("全 pass → pass", () => {
    const g = gatesWith(
      { status: "passed", verdict: "pass" },
      { status: "passed", verdict: "pass" },
      { status: "passed", verdict: "pass" },
    )
    expect(resolveOverallVerdict(g, false)).toBe("pass")
  })
})

describe("ISS-20260709-044：端到端等价 + WARNING 路由解耦", () => {
  it("buildDecisionGates：error 进 blocking（不进 repair），warning 进 repair（不 blocking）", () => {
    const gates = buildDecisionGates(
      [finding("error", "consistency"), finding("warning", "quality")],
      0,
    )
    expect(gates.overall).toBe("fail")
    expect(gates.consistency.verdict).toBe("fail")
    expect(gates.quality.verdict).toBe("warning")
    // 路由与裁决解开：repair 只看 severity=warning，blocking 只看 error。
    expect(collectRepairIssues(gates).map((f) => f.severity)).toEqual(["warning"])
    expect(collectBlockingIssues(gates).map((f) => f.severity)).toEqual(["error"])
  })

  it("buildDecisionGates：纯 warning → overall warning + 全进 repair", () => {
    const gates = buildDecisionGates([finding("warning", "quality")], 1)
    expect(gates.overall).toBe("warning")
    expect(collectRepairIssues(gates)).toHaveLength(1)
    expect(collectBlockingIssues(gates)).toHaveLength(0)
  })

  it("buildDecisionGates：manualReviewRequired + error → manual_review", () => {
    const gates = buildDecisionGates([finding("error", "anti_ai")], 0, true)
    expect(gates.overall).toBe("manual_review")
    expect(gates.anti_ai.verdict).toBe("manual_review")
  })
})

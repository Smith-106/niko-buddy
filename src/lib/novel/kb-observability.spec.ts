/**
 * E-06 (run-execute-1, 双库架构蓝图) 验收④⑤ — 可观测 + 错误分级 spec。
 *
 * 共识 C-8：6 指标聚合（缺源显式 N/A 不伪造）；truth_fold_drift>0 告警；
 * 3 健康检查；四类错误分级 + 恢复策略（GOV-OBS-01..04）。
 */
import { describe, it, expect } from "vitest"
import {
  collectKbMetrics,
  checkTruthFoldDrift,
  checkFacadeReady,
  checkAtomicStoreIntegrity,
  checkKbViewStaleness,
  classifyKbError,
  recoveryPlanFor,
} from "./kb-observability"

describe("E-06 6 指标聚合（GOV-OBS-01：缺源显式 N/A 不伪造）", () => {
  it("全源齐备 → 6 指标可采集", () => {
    const m = collectKbMetrics({
      canonViolationRate: 0.005,
      obligationCoverage: 0.96,
      hardInjectionBudgetUsage: 0.3,
      promotionReplaySuccess: 1,
      truthFoldDrift: 0,
      gapReportRate: 0.1,
    })
    expect(m.canon_violation_rate.value).toBe(0.005)
    expect(m.obligation_coverage.value).toBe(0.96)
    expect(m.hard_injection_budget_usage.value).toBe(0.3)
    expect(m.promotion_replay_success.value).toBe(1)
    expect(m.truth_fold_drift.value).toBe(0)
    expect(m.gap_report_rate.value).toBe(0.1)
  })

  it("缺源 → null + unavailableReason（绝不伪造 0）", () => {
    const m = collectKbMetrics({})
    expect(m.canon_violation_rate.value).toBeNull()
    expect(m.canon_violation_rate.unavailableReason).toContain("seed-missing")
    expect(m.hard_injection_budget_usage.value).toBeNull()
    expect(m.truth_fold_drift.value).toBeNull()
  })
})

describe("E-06 truth_fold_drift 告警（GOV-OBS-01：不静默降级）", () => {
  it("drift>0 → alarm；drift=0 → 无告警；null → N/A 无告警", () => {
    expect(checkTruthFoldDrift(0.1).alarm).toBe(true)
    expect(checkTruthFoldDrift(0).alarm).toBe(false)
    expect(checkTruthFoldDrift(null).alarm).toBe(false)
  })
})

describe("E-06 3 健康检查（GOV-OBS-03）", () => {
  it("H1 门面只读装配就绪：ok/fail 双向", () => {
    expect(checkFacadeReady({ facadeReadable: true, techLeak: false }).ok).toBe(true)
    expect(checkFacadeReady({ facadeReadable: false, techLeak: false }).ok).toBe(false)
    expect(checkFacadeReady({ facadeReadable: true, techLeak: true }).ok).toBe(false)
  })

  it("H2 原子存储完整性：可解析 + fileVersion + drift=0", () => {
    expect(checkAtomicStoreIntegrity({ parseable: true, fileVersionOk: true, drift: 0 }).ok).toBe(true)
    expect(checkAtomicStoreIntegrity({ parseable: false, fileVersionOk: true, drift: 0 }).ok).toBe(false)
    expect(checkAtomicStoreIntegrity({ parseable: true, fileVersionOk: false, drift: 0 }).ok).toBe(false)
    expect(checkAtomicStoreIntegrity({ parseable: true, fileVersionOk: true, drift: 0.5 }).ok).toBe(false)
  })

  it("H3 KB-VIEW 重建时效：staleness 阈值（[需校准]）", () => {
    const now = 1_000_000_000_000
    expect(checkKbViewStaleness({ generatedAt: now - 86_400_000, now }).ok).toBe(true)
    expect(checkKbViewStaleness({ generatedAt: now - 86_400_000 * 30, now }).ok).toBe(false)
    expect(checkKbViewStaleness({ generatedAt: null, now }).ok).toBe(false)
  })
})

describe("E-06 四类错误分级 + 恢复（GOV-OBS-04）", () => {
  it("DISASTER：原子写失败 → 终止写阶段 fail-loud", () => {
    expect(classifyKbError(new Error("commit failed"), { atomicWriteFailed: true })).toBe("DISASTER")
    const plan = recoveryPlanFor("DISASTER")
    expect(plan.terminal).toBe(true)
    expect(plan.action).toContain("终止写阶段")
  })

  it("DEGRADED：检索超时 → 降级硬注入兜底，不终止写作", () => {
    expect(classifyKbError(new Error("timeout"), { retrievalFailed: true })).toBe("DEGRADED")
    const plan = recoveryPlanFor("DEGRADED")
    expect(plan.terminal).toBe(false)
    expect(plan.action).toContain("降级硬注入兜底")
  })

  it("RECOVERABLE：采源失败 → 重试或 QUARANTINE；未知错误保守归 RECOVERABLE", () => {
    expect(classifyKbError(new Error("source down"), { sourceFailed: true })).toBe("RECOVERABLE")
    expect(classifyKbError(new Error("weird"))).toBe("RECOVERABLE")
    const plan = recoveryPlanFor("RECOVERABLE")
    expect(plan.action).toContain("QUARANTINE")
  })

  it("CONTROLLED：accept 拒绝 → 阻断晋升保留草稿", () => {
    expect(classifyKbError(new Error("gate block"), { gateBlocked: true })).toBe("CONTROLLED")
    const plan = recoveryPlanFor("CONTROLLED")
    expect(plan.action).toContain("阻断晋升")
    expect(plan.action).toContain("保留草稿")
  })
})

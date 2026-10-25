/**
 * deep-chapter-decision-gates — 决策门纯函数子模块（arch-risk W4 god-object 拆分）。
 *
 * 从 deep-chapter-generation.ts 抽出的自足纯函数块：决策门类型 +
 * buildDecisionGates/collect*Issues/createEmpty*。接口与实现原样搬迁，
 * 主文件只做编排——改决策门逻辑不再动 3000 行编排体。
 */

import { resolveReviewGateKey, type NovelReviewResult } from "./review-adapter"
import { getUpgradeThreshold, getRepairScope, GATE_MAPPING } from "./audit-taxonomy"

export type DeepChapterDecisionGateKey = "consistency" | "anti_ai" | "quality"
export type DeepChapterGateVerdict = "pending" | "pass" | "warning" | "fail" | "manual_review"

export interface DeepChapterDecisionGate {
  status: "pending" | "passed" | "failed"
  verdict: DeepChapterGateVerdict
  findings: NovelReviewResult[]
  repair_suggestions: string[]
  retry_count: number
  updated_at?: string
  manual_review_required?: boolean
}

export interface DeepChapterDecisionGates {
  consistency: DeepChapterDecisionGate
  anti_ai: DeepChapterDecisionGate
  quality: DeepChapterDecisionGate
  overall: DeepChapterGateVerdict
}

export function createEmptyDecisionGate(): DeepChapterDecisionGate {
  return {
    status: "pending",
    verdict: "pending",
    findings: [],
    repair_suggestions: [],
    retry_count: 0,
  }
}

export function emptyDecisionGates(): DeepChapterDecisionGates {
  return {
    consistency: createEmptyDecisionGate(),
    anti_ai: createEmptyDecisionGate(),
    quality: createEmptyDecisionGate(),
    overall: "pending",
  }
}

/**
 * 解析审查 finding type → 三门控键（consistency / anti_ai / quality）。
 * DEBT-20260824-T24-02 偿还：已迁移到 review-adapter.resolveReviewGateKey
 * （GATE_MAPPING 唯一真源），normalize 口径（trim + lowercase）一致。
 */
function resolveDecisionGateKey(type: string): DeepChapterDecisionGateKey {
  return resolveReviewGateKey(type) as DeepChapterDecisionGateKey
}

function uniqueSuggestions(findings: NovelReviewResult[]): string[] {
  return [...new Set(
    findings
      .map((item) => item.suggestion?.trim())
      .filter((value): value is string => Boolean(value)),
  )]
}

/**
 * ISS-20260709-044 去耦合：单门 verdict 显式分支（行为等价）。
 *
 * 解开前：`createGate` 内 `status` 与 `verdict` 由同一嵌套三元一次算出，WARNING 路由
 * （collectRepairIssues）与 verdict 判定字面交织——读者无法分辨“门状态机”与“修复路由”边界。
 * 解开后：状态（resolveGateStatus）与裁决（本函数）各自显式 if/else；路由函数只读
 * `severity`（见 collectRepairIssues），三者经真值表 spec 锁定（p1-iss-044-gate-verdict.spec.ts）。
 * 真值表（与改前三元逐项等价）：manualReview+（error|升级）→ manual_review；
 * （error|升级）→ fail；warning → warning；否则 pass。
 */
export function resolveGateVerdict(input: {
  hasError: boolean
  upgradedToFail: boolean
  hasWarning: boolean
  manualReviewRequired: boolean
}): DeepChapterGateVerdict {
  if (input.manualReviewRequired && (input.hasError || input.upgradedToFail)) {
    return "manual_review"
  }
  if (input.hasError || input.upgradedToFail) {
    return "fail"
  }
  if (input.hasWarning) {
    return "warning"
  }
  return "pass"
}

export function resolveGateStatus(input: {
  hasError: boolean
  upgradedToFail: boolean
}): "passed" | "failed" {
  if (input.hasError || input.upgradedToFail) {
    return "failed"
  }
  return "passed"
}

export function buildDecisionGates(
  reviewResults: NovelReviewResult[],
  retryCount: number,
  manualReviewRequired = false,
  genre?: string,
): DeepChapterDecisionGates {
  const grouped: Record<DeepChapterDecisionGateKey, NovelReviewResult[]> = {
    consistency: [],
    anti_ai: [],
    quality: [],
  }
  for (const item of reviewResults) {
    grouped[resolveDecisionGateKey(item.type)].push(item)
  }
  const updatedAt = new Date().toISOString()
  const createGate = (findings: NovelReviewResult[], gateKey: DeepChapterDecisionGateKey): DeepChapterDecisionGate => {
    const hasError = findings.some((item) => item.severity === "error")
    const hasWarning = findings.some((item) => item.severity === "warning")
    const warningCount = findings.filter((item) => item.severity === "warning").length
    // 53 号报告 P0-3 接线② additive: 题材级 warn→fail 升级 (inkos
    // getUpgradeThreshold 模式, AGPL 只借模式)。仅 genre 已传时启用
    // (缺省零行为变更), 且只作用于 Quality 门 (P0/P1 恒硬门不受题材影响)。
    const upgradedToFail =
      gateKey === "quality" &&
      genre !== undefined &&
      !hasError &&
      hasWarning &&
      warningCount >= getUpgradeThreshold(genre, GATE_MAPPING.quality.dimensionIds[0])
    // ISS-20260709-044: 状态与裁决分两步显式分支（与改前嵌套三元逐项等价）。
    const status = resolveGateStatus({ hasError, upgradedToFail })
    return {
      status,
      verdict: resolveGateVerdict({ hasError, upgradedToFail, hasWarning, manualReviewRequired }),
      findings,
      repair_suggestions: uniqueSuggestions(findings),
      retry_count: retryCount,
      updated_at: updatedAt,
      manual_review_required: manualReviewRequired && hasError ? true : undefined,
    }
  }
  const gates: DeepChapterDecisionGates = {
    consistency: createGate(grouped.consistency, "consistency"),
    anti_ai: createGate(grouped.anti_ai, "anti_ai"),
    quality: createGate(grouped.quality, "quality"),
    overall: "pass",
  }
  // ISS-20260709-044: overall 经显式分支函数聚合（与改前 CORR-108 注释块逐项等价）。
  gates.overall = resolveOverallVerdict(gates, manualReviewRequired)
  return gates
}

/**
 * ISS-20260709-044 去耦合：overall 聚合显式分支（行为等价）。
 * CORR-108 (ADR-17 priority: Consistency > Anti-AI > Quality)：任一门 failed →
 * overall fail（Quality-failure 不被 Anti-AI warning 掩盖）；manualReviewRequired +
 * 任一 failed → manual_review；否则任一 warning → warning；否则 pass。
 * 本函数只读各门已算好的 status/verdict，不再参与单门判定——与 WARNING 路由
 * （collectRepairIssues，只读 severity）彻底解开：判定归判定，路由归路由。
 */
export function resolveOverallVerdict(
  gates: Pick<DeepChapterDecisionGates, "consistency" | "anti_ai" | "quality">,
  manualReviewRequired: boolean,
): DeepChapterGateVerdict {
  const anyFailed =
    gates.consistency.status === "failed" ||
    gates.anti_ai.status === "failed" ||
    gates.quality.status === "failed"
  if (manualReviewRequired && anyFailed) {
    return "manual_review"
  }
  if (anyFailed) {
    return "fail"
  }
  if (
    gates.consistency.verdict === "warning" ||
    gates.anti_ai.verdict === "warning" ||
    gates.quality.verdict === "warning"
  ) {
    return "warning"
  }
  return "pass"
}

export function collectBlockingIssues(decisionGates: DeepChapterDecisionGates): NovelReviewResult[] {
  // CORR-005 fix: accumulate error-severity findings across ALL failed gates.
  const blocking: NovelReviewResult[] = []
  for (const gateKey of ["consistency", "anti_ai", "quality"] as const) {
    const gate = decisionGates[gateKey]
    if (gate.status === "failed") {
      for (const finding of gate.findings) {
        if (finding.severity === "error") {
          blocking.push(finding)
        }
      }
    }
  }
  return blocking
}

/**
 * F-003 (ANL-010): route WARNING-severity review findings to the stage-5
 * repair loop. Error-only collectBlockingIssues MUST stay that way —
 * warnings never block, but SHOULD reach the repair model. Exported for TS-01.
 *
 * ISS-20260709-044: WARNING 路由唯一入口，只读 finding.severity，不读/不写门 verdict。
 */
export function collectRepairIssues(
  decisionGates: DeepChapterDecisionGates,
  genre?: string,
): NovelReviewResult[] {
  const warnings: NovelReviewResult[] = []
  for (const gateKey of ["consistency", "anti_ai", "quality"] as const) {
    const gate = decisionGates[gateKey]
    // 53 号报告 P0-3 接线③ additive: 题材级 repair_scope 路由 (inkos
    // getRepairScope 模式)。scope=warn_only/resettle_only 的门不进自动修复。
    if (genre !== undefined) {
      const scope = getRepairScope(genre, GATE_MAPPING[gateKey].dimensionIds[0])
      if (scope === "warn_only" || scope === "resettle_only") continue
    }
    for (const finding of gate.findings) {
      if (finding.severity === "warning") {
        warnings.push(finding)
      }
    }
  }
  return warnings
}

/**
 * Track B literary polish (optional, post Track A gate-green):
 * thril/pacing/pull warnings only. Never includes consistency/anti_ai errors.
 */
export function collectLiteraryPolishIssues(decisionGates: DeepChapterDecisionGates): NovelReviewResult[] {
  const literaryTypes = new Set(["plot", "thrill", "pacing", "pull", "quality"])
  const out: NovelReviewResult[] = []
  for (const finding of collectRepairIssues(decisionGates)) {
    const t = (finding.type || "").toLowerCase()
    if (finding.severity !== "warning" && finding.severity !== "info") continue
    if (literaryTypes.has(t) || t.includes("thrill") || t.includes("pacing") || t.includes("pull") || t.includes("plot")) {
      out.push(finding)
    }
  }
  const quality = decisionGates.quality
  for (const finding of quality.findings) {
    if (finding.severity === "error") continue
    const t = (finding.type || "").toLowerCase()
    if (literaryTypes.has(t) || t.includes("thrill") || t.includes("pacing") || t.includes("pull") || t.includes("plot")) {
      if (!out.some((x) => x.message === finding.message)) out.push(finding)
    }
  }
  return out
}

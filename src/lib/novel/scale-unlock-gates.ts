/**
 * scale-unlock-gates.ts — R2 规模触发表契约化（解冻提名谓词）。
 *
 * 共识来源：批准计划 r2 §R2（planHandoffKey 738a75141a5a6b2386f8b38eef21ef600dedf9461eca4972037b2f0b68f55113）；
 * 单一真源门控语义 = `docs/kb-flag-promotion-flow.md`（P1-IMP-15 双臂离线评测 → gate PASS → 翻默认值，ADR-48）。
 *
 * 语义冻结（不可在此模块内变更）：
 *   ① 提名 ≠ 开启：本模块**只产出解冻候选提名**，不写任何配置；flag 默认值仍为
 *      hardInjectEnabled=true / 其余 false（`consensus-antigoals.EXPECTED_RETRIEVAL_FLAGS`）。
 *      开启仍须走 kb-flag-promotion-flow.md 双臂门（A/B 对照 + consistencyNoRegression + qualityGain）。
 *   ② rerank 提名条件 = 语料规模 > 阈值（**待标定初值**）AND R0-b 证据 status=triggered；
 *      R0-b 产物不存在（存在性硬检查）→ 相关谓词直接 locked。
 *   ③ ANN（近似检索）保持 locked，理由 = 无实现（版本前缀谓词已删除）。
 *   ④ 全部数量阈值标注**待标定初值**（非同源矩阵缺失期间不得当作已标定口径）。
 *   ⑤ MMR 公式 = 同源簇内 top3 增益(pp) − 延迟成本(pp)；延迟成本(pp) = p95 延迟增量(ms) / λ(ms_per_pp)
 *      （计划字面量「λ·p95 延迟增量」的纲量一致形式：λ 单位为 ms/pp，故延迟折质量 = 延迟/λ）。
 *      λ 取 R0-d 输出，缺失 → locked。
 *   ⑥ 扇出提名调用 R0-b 采集器 + 既有 generateMultiQueries（仅零 LLM 路径；门控启用）。
 *
 * 机械层（ADR-19）：纯函数 + zod，零 IO / 零时钟 / 零模型调用；产物存在性与状态由调用方采集后注入 ctx。
 *
 * @license MIT © QMAI
 */

import { z } from "zod"
import { generateMultiQueries } from "./search-adapter"
import { collectRerankTriggerEvidence, RERANK_TRIGGER_EVIDENCE_SCHEMA } from "./rerank-trigger-evidence"
import { RETRIEVAL_LAMBDA_SCHEMA } from "./retrieval-budget"
import { RETRIEVAL_SPAN_STAGES } from "./retrieval-span"

// ============================================================================
// 阈值（全部为待标定初值）
// ============================================================================

/** 规模阈值面（**待标定初值**：非同源矩阵缺失期间不得当作已标定口径）。 */
export const SCALE_UNLOCK_THRESHOLDS = {
  /** rerank / 扇出 / 双轨路由的语料规模下限（待标定初值）。 */
  corpusMinEntries: 1000,
  /** chunk 规模下限（待标定初值；R5 采集面）。 */
  chunkMinCount: 10000,
  /** MMR 提名所需的同源簇 query 数下限（待标定初值）。 */
  mmrMinClusterQueries: 30,
  /** MMR 净增益下限（pp；净增益必须严格大于此值，待标定初值）。 */
  mmrMinNetGainPp: 0,
} as const

/** 提名对象：配置 flag 或能力面（能力面无 config 开关，开启语义=接线进主链）。 */
export const SCALE_UNLOCK_TARGETS = [
  "usefulnessRerankEnabled",
  "dualKbRoutingEnabled",
  "multiQueryFanout",
  "annApproximateSearch",
] as const

export type ScaleUnlockTarget = (typeof SCALE_UNLOCK_TARGETS)[number]

/** 提名裁决（locked 一律带理由；unlock-candidate 仅提名，不等于开启）。 */
export const SCALE_UNLOCK_VERDICT_SCHEMA = z.enum(["locked", "unlock-candidate", "enabled"])

export type ScaleUnlockVerdict = z.infer<typeof SCALE_UNLOCK_VERDICT_SCHEMA>

/** locked / 未提名理由码（可枚举，供可观测输出与文档引用）。 */
export const SCALE_UNLOCK_REASON_CODES = [
  "rr_corpus_below_threshold",
  "rr_evidence_missing",
  "rr_evidence_not_triggered",
  "mmr_corpus_below_threshold",
  "mmr_lambda_missing",
  "mmr_cluster_below_threshold",
  "mmr_net_gain_not_positive",
  "fanout_corpus_below_threshold",
  "fanout_probe_missing",
  "fanout_evidence_missing",
  "fanout_evidence_inconsistent",
  "ann_no_implementation",
  "hard_inject_already_enabled",
  "span_sequence_incomplete",
  "promotion_flow_doc_missing",
  "nominated_pending_dual_arm_gate",
] as const

export type ScaleUnlockReasonCode = (typeof SCALE_UNLOCK_REASON_CODES)[number]

// ============================================================================
// 输入契约（调用方采集后注入；本模块零 IO）
// ============================================================================

/** R0-b 证据面（产物存在性 + 状态；不存在时 present=false / status=null）。 */
export const R0_EVIDENCE_FACE_SCHEMA = z
  .object({
    present: z.boolean(),
    evidence: RERANK_TRIGGER_EVIDENCE_SCHEMA.nullable(),
  })
  .strict()

/** 同源簇实证（R0-a 面；缺失 = null）。 */
export const SAME_CLUSTER_FACE_SCHEMA = z
  .object({
    clusterQueries: z.number().int().nonnegative(),
    /** 簇内 top3 增益（百分点）。 */
    top3GainPp: z.number(),
    /** p95 延迟增量（毫秒）。 */
    p95LatencyDeltaMs: z.number().nonnegative(),
  })
  .strict()

/** 扇出面探针（零 LLM 路径；缺失 = null → 提名 locked）。 */
export const FANOUT_PROBE_SCHEMA = z
  .object({
    query: z.string().min(1),
    decomposition: z
      .object({
        original: z.string(),
        verbatim: z.array(z.string()),
        entityMentions: z.array(z.string()),
        facets: z
          .object({
            character: z.string().optional(),
            location: z.string().optional(),
            item: z.string().optional(),
          })
          .strict(),
        rest: z.string(),
      })
      .strict(),
    maxQueries: z.number().int().positive().optional(),
  })
  .strict()

/** 文档结构标志（kb-flag-promotion-flow.md 存在性；缺失 → 提名降为 locked）。 */
export const PROMOTION_DOC_FACE_SCHEMA = z
  .object({
    promotionFlowDocPresent: z.boolean(),
  })
  .strict()

/** 运行时 span 面（R0-c：六 stage 契约序是否完整观测到）。 */
export const SPAN_FACE_SCHEMA = z
  .object({
    observedStages: z.array(z.string()),
  })
  .strict()

/** 解冻提名判定上下文（strict）。 */
export const SCALE_UNLOCK_CTX_SCHEMA = z
  .object({
    schemaVersion: z.literal(1),
    /** 写作面语料规模（world_ref/lexicon/craft/corpus 合计；调用方按现役产物采集）。 */
    corpusEntries: z.number().int().nonnegative(),
    /** chunk 规模（R5 面）。 */
    chunkCount: z.number().int().nonnegative(),
    /** R0-b 证据面（产物存在性硬检查）。 */
    rerankEvidence: R0_EVIDENCE_FACE_SCHEMA,
    /** 同源簇实证（R0-a 面）。 */
    sameCluster: SAME_CLUSTER_FACE_SCHEMA.nullable(),
    /** R0-d λ（缺失 → MMR 相关谓词 locked）。 */
    lambda: RETRIEVAL_LAMBDA_SCHEMA.nullable(),
    /** 扇出面探针（零 LLM）。 */
    fanoutProbe: FANOUT_PROBE_SCHEMA.nullable(),
    /** 文档结构标志。 */
    docs: PROMOTION_DOC_FACE_SCHEMA,
    /** 运行时 span 面。 */
    spans: SPAN_FACE_SCHEMA,
  })
  .strict()

export type ScaleUnlockCtx = z.infer<typeof SCALE_UNLOCK_CTX_SCHEMA>

// ============================================================================
// 输出契约
// ============================================================================

export const SCALE_UNLOCK_DECISION_SCHEMA = z
  .object({
    target: z.enum(SCALE_UNLOCK_TARGETS),
    kind: z.enum(["flag", "capability"]),
    verdict: SCALE_UNLOCK_VERDICT_SCHEMA,
    reasonCode: z.enum(SCALE_UNLOCK_REASON_CODES),
    reason: z.string().min(1),
    /** 提名 ≠ 开启：本字段恒为 false（无写入面）。 */
    appliesToConfig: z.literal(false),
    /** 提名所需的下一步（开启路径 = 双臂门，见 docs/kb-flag-promotion-flow.md）。 */
    nextStep: z.string().min(1),
    metrics: z.record(z.string(), z.number()).optional(),
  })
  .strict()

export type ScaleUnlockDecision = z.infer<typeof SCALE_UNLOCK_DECISION_SCHEMA>

export const SCALE_UNLOCK_REPORT_SCHEMA = z
  .object({
    schemaVersion: z.literal(1),
    /** 恒为 false：本模块不写配置（语义冻结①）。 */
    configMutated: z.literal(false),
    thresholds: z.record(z.string(), z.number()),
    decisions: z.array(SCALE_UNLOCK_DECISION_SCHEMA),
    nominatedTargets: z.array(z.enum(SCALE_UNLOCK_TARGETS)),
    lockedCount: z.number().int().nonnegative(),
    scale: z
      .object({
        corpusEntries: z.number().int().nonnegative(),
        chunkCount: z.number().int().nonnegative(),
      })
      .strict(),
    /** span 面完整性（六 stage 契约序）。 */
    spanSequenceComplete: z.boolean(),
  })
  .strict()

export type ScaleUnlockReport = z.infer<typeof SCALE_UNLOCK_REPORT_SCHEMA>

export class ScaleUnlockGateError extends Error {
  constructor(message: string) {
    super(`[scale-unlock-gates] ${message}`)
    this.name = "ScaleUnlockGateError"
  }
}

// ============================================================================
// 谓词核
// ============================================================================

const DUAL_ARM_NEXT_STEP =
  "开启须走 docs/kb-flag-promotion-flow.md 双臂离线评测（A/B：flag=false 基线 vs flag=true 实验，" +
  "consistencyNoRegression && qualityGain && seedCaseCoverage ≥ MIN_SEED）→ gate PASS 判据包才授权翻默认值（ADR-48）"

function spanSequenceComplete(observed: readonly string[]): boolean {
  // 契约序完整 = 六 stage 全部观测到（顺序性由 R0-c assertRetrievalSpanSequence 负责）
  return RETRIEVAL_SPAN_STAGES.every((stage) => observed.includes(stage))
}

function decision(
  target: ScaleUnlockTarget,
  kind: "flag" | "capability",
  verdict: ScaleUnlockVerdict,
  reasonCode: ScaleUnlockReasonCode,
  reason: string,
  extra: { nextStep?: string; metrics?: Record<string, number> } = {},
): ScaleUnlockDecision {
  return {
    target,
    kind,
    verdict,
    reasonCode,
    reason,
    appliesToConfig: false,
    nextStep: extra.nextStep ?? (verdict === "locked" ? "补齐证据面后复评（本谓词只读，不改默认值）" : DUAL_ARM_NEXT_STEP),
    ...(extra.metrics ? { metrics: extra.metrics } : {}),
  }
}

/**
 * 解冻提名谓词核（纯函数）：对每个目标输出 locked / unlock-candidate，一律带理由码与理由。
 * 现役规模（语料 80 条）下预期全部 locked 且各有理由（可观测输出见 formatUnlockGateReport）。
 */
export function evaluateUnlockGates(ctx: ScaleUnlockCtx): ScaleUnlockReport {
  const parsed = SCALE_UNLOCK_CTX_SCHEMA.safeParse(ctx)
  if (!parsed.success) {
    throw new ScaleUnlockGateError(`上下文契约非法：${parsed.error.message}`)
  }
  const c = parsed.data
  const spanOk = spanSequenceComplete(c.spans.observedStages)
  const decisions: ScaleUnlockDecision[] = []
  const thresholds = SCALE_UNLOCK_THRESHOLDS as unknown as Record<string, number>

  // ── 1) usefulnessRerankEnabled（rerank）：语料 > 阈值 AND R0-b status=triggered ──
  if (c.corpusEntries <= SCALE_UNLOCK_THRESHOLDS.corpusMinEntries) {
    decisions.push(
      decision(
        "usefulnessRerankEnabled",
        "flag",
        "locked",
        "rr_corpus_below_threshold",
        `语料规模 ${c.corpusEntries} ≤ 阈值 ${SCALE_UNLOCK_THRESHOLDS.corpusMinEntries}（待标定初值）：规模未达，rerank 无采纳依据`,
        { metrics: { corpusEntries: c.corpusEntries } },
      ),
    )
  } else if (!c.rerankEvidence.present || !c.rerankEvidence.evidence) {
    decisions.push(
      decision(
        "usefulnessRerankEnabled",
        "flag",
        "locked",
        "rr_evidence_missing",
        "R0-b 触发证据产物不存在（存在性硬检查失败）：谓词直接 locked",
      ),
    )
  } else if (c.rerankEvidence.evidence.status !== "triggered") {
    decisions.push(
      decision(
        "usefulnessRerankEnabled",
        "flag",
        "locked",
        "rr_evidence_not_triggered",
        `R0-b 证据 status=${c.rerankEvidence.evidence.status}（非 triggered）：top20 守住而 top3 未掉档，rerank 未获采纳依据`,
        {
          metrics: {
            top3Rate: c.rerankEvidence.evidence.top3Rate,
            top20Rate: c.rerankEvidence.evidence.top20Rate,
          },
        },
      ),
    )
  } else if (!spanOk) {
    decisions.push(
      decision(
        "usefulnessRerankEnabled",
        "flag",
        "locked",
        "span_sequence_incomplete",
        "运行时 span 面六 stage 契约序未完整观测：采纳面不可观测",
      ),
    )
  } else if (!c.docs.promotionFlowDocPresent) {
    decisions.push(
      decision(
        "usefulnessRerankEnabled",
        "flag",
        "locked",
        "promotion_flow_doc_missing",
        "kb-flag-promotion-flow.md 缺失：开启路径无真源可参照",
      ),
    )
  } else {
    decisions.push(
      decision(
        "usefulnessRerankEnabled",
        "flag",
        "unlock-candidate",
        "nominated_pending_dual_arm_gate",
        `语料 ${c.corpusEntries} > 阈值 ${SCALE_UNLOCK_THRESHOLDS.corpusMinEntries} 且 R0-b status=triggered：产出解冻候选提名（未开启）`,
        {
          metrics: {
            corpusEntries: c.corpusEntries,
            top3Rate: c.rerankEvidence.evidence.top3Rate,
          },
        },
      ),
    )
  }

  // ── 2) dualKbRoutingEnabled（MMR）：净增益 = 簇内 top3 增益(pp) − 延迟成本(pp) ──
  // 延迟成本(pp) = p95 延迟增量(ms) / λ(ms_per_pp)（纲量一致形式：λ=25 ms/pp ⇒ 200ms ⇔ 8pp）
  const lambda = c.lambda
  if (c.corpusEntries <= SCALE_UNLOCK_THRESHOLDS.corpusMinEntries) {
    decisions.push(
      decision(
        "dualKbRoutingEnabled",
        "flag",
        "locked",
        "mmr_corpus_below_threshold",
        `语料规模 ${c.corpusEntries} ≤ 阈值 ${SCALE_UNLOCK_THRESHOLDS.corpusMinEntries}（待标定初值）`,
        { metrics: { corpusEntries: c.corpusEntries } },
      ),
    )
  } else if (!lambda) {
    decisions.push(
      decision(
        "dualKbRoutingEnabled",
        "flag",
        "locked",
        "mmr_lambda_missing",
        "R0-d λ 缺失：MMR 公式 top3增益(pp) − λ·p95延迟增量(ms) 无定价口径，谓词 locked",
      ),
    )
  } else if (!c.sameCluster || c.sameCluster.clusterQueries < SCALE_UNLOCK_THRESHOLDS.mmrMinClusterQueries) {
    decisions.push(
      decision(
        "dualKbRoutingEnabled",
        "flag",
        "locked",
        "mmr_cluster_below_threshold",
        `同源簇 query 数 ${c.sameCluster?.clusterQueries ?? 0} < 阈值 ${SCALE_UNLOCK_THRESHOLDS.mmrMinClusterQueries}（待标定初值）`,
        { metrics: { clusterQueries: c.sameCluster?.clusterQueries ?? 0 } },
      ),
    )
  } else {
    const netGainPp =
      c.sameCluster.top3GainPp -
      (lambda.value > 0 ? c.sameCluster.p95LatencyDeltaMs / lambda.value : Number.POSITIVE_INFINITY)
    if (netGainPp <= SCALE_UNLOCK_THRESHOLDS.mmrMinNetGainPp) {
      decisions.push(
        decision(
          "dualKbRoutingEnabled",
          "flag",
          "locked",
          "mmr_net_gain_not_positive",
          `MMR 净增益 ${netGainPp.toFixed(3)} pp ≤ 下限 ${SCALE_UNLOCK_THRESHOLDS.mmrMinNetGainPp}：增益未覆盖延迟成本（延迟成本 = p95 ${c.sameCluster.p95LatencyDeltaMs}ms / λ ${lambda.value} ms/pp）`,
          {
            metrics: {
              top3GainPp: c.sameCluster.top3GainPp,
              p95LatencyDeltaMs: c.sameCluster.p95LatencyDeltaMs,
              lambdaMsPerPp: lambda.value,
              netGainPp,
            },
          },
        ),
      )
    } else if (!c.docs.promotionFlowDocPresent) {
      decisions.push(
        decision(
          "dualKbRoutingEnabled",
          "flag",
          "locked",
          "promotion_flow_doc_missing",
          "kb-flag-promotion-flow.md 缺失：开启路径无真源可参照",
        ),
      )
    } else {
      decisions.push(
        decision(
          "dualKbRoutingEnabled",
          "flag",
          "unlock-candidate",
          "nominated_pending_dual_arm_gate",
          `MMR 净增益 ${netGainPp.toFixed(3)} pp > 0（λ=${lambda.value} ms/pp，calibrated=${lambda.calibrated}）：产出解冻候选提名（未开启）`,
          {
            metrics: {
              top3GainPp: c.sameCluster.top3GainPp,
              p95LatencyDeltaMs: c.sameCluster.p95LatencyDeltaMs,
              lambdaMsPerPp: lambda.value,
              netGainPp,
            },
          },
        ),
      )
    }
  }

  // ── 3) multiQueryFanout（能力面）：R0-b 采集器 + generateMultiQueries（零 LLM 路径）──
  if (c.corpusEntries <= SCALE_UNLOCK_THRESHOLDS.corpusMinEntries) {
    decisions.push(
      decision(
        "multiQueryFanout",
        "capability",
        "locked",
        "fanout_corpus_below_threshold",
        `语料规模 ${c.corpusEntries} ≤ 阈值 ${SCALE_UNLOCK_THRESHOLDS.corpusMinEntries}（待标定初值）`,
        { metrics: { corpusEntries: c.corpusEntries } },
      ),
    )
  } else if (!c.fanoutProbe) {
    decisions.push(
      decision(
        "multiQueryFanout",
        "capability",
        "locked",
        "fanout_probe_missing",
        "扇出面探针缺失（零 LLM 路径未提供 query/decomposition）：提名 locked",
      ),
    )
  } else if (!c.rerankEvidence.present || !c.rerankEvidence.evidence) {
    decisions.push(
      decision(
        "multiQueryFanout",
        "capability",
        "locked",
        "fanout_evidence_missing",
        "R0-b 触发证据产物不存在（存在性硬检查失败）：扇出采纳面 locked",
      ),
    )
  } else {
    // 真实调用既有零 LLM 面：generateMultiQueries（复用主链实现，不另造展开器）
    const probe = c.fanoutProbe
    const expanded = generateMultiQueries(probe.query, probe.decomposition, {
      ...(probe.maxQueries !== undefined ? { maxQueries: probe.maxQueries } : {}),
    })
    // 复用 R0-b 采集器：由证据快照的分档计数忠实重建 ranks 并重放，
    // 重放状态与证据声明不符 = 证据自相矛盾（完整性失败）→ locked
    const ev = c.rerankEvidence.evidence
    const top3Hits = Math.min(ev.top3Hits, ev.top20Hits)
    const replayed = collectRerankTriggerEvidence({
      ranks: Array.from({ length: ev.n }, (_, i) => ({
        query: `replay-${i + 1}`,
        rank: i + 1,
        top3: i < top3Hits,
        top20: i < ev.top20Hits,
      })),
      baseline: { minTop3Rate: ev.minTop3Rate, minTop20Rate: ev.minTop20Rate },
    })
    if (replayed.status !== ev.status) {
      decisions.push(
        decision(
          "multiQueryFanout",
          "capability",
          "locked",
          "fanout_evidence_inconsistent",
          `R0-b 证据快照自相矛盾：声明 status=${ev.status}，由分档计数重放得 status=${replayed.status}`,
          { metrics: { replayedStatus: replayed.status === "triggered" ? 1 : 0 } },
        ),
      )
    } else {
      decisions.push(
        decision(
          "multiQueryFanout",
          "capability",
          "unlock-candidate",
          "nominated_pending_dual_arm_gate",
          `扇出探针展开 ${expanded.length} 条查询（零 LLM 面 generateMultiQueries）+ R0-b 采集器重放 status=${replayed.status}（与证据面一致）：产出解冻候选提名（未开启）`,
          {
            metrics: {
              expandedQueries: expanded.length,
              corpusEntries: c.corpusEntries,
            },
          },
        ),
      )
    }
  }

  // ── 4) ANN（近似检索）：无实现 → 恒 locked（版本前缀谓词已删除）──
  decisions.push(
    decision(
      "annApproximateSearch",
      "capability",
      "locked",
      "ann_no_implementation",
      "无实现（代码面无 ANN 索引/查询路径）：版本前缀谓词已删除，保持 locked",
    ),
  )

  const nominatedTargets = decisions
    .filter((d) => d.verdict === "unlock-candidate")
    .map((d) => d.target)

  const report: ScaleUnlockReport = {
    schemaVersion: 1,
    configMutated: false,
    thresholds,
    decisions,
    nominatedTargets,
    lockedCount: decisions.filter((d) => d.verdict === "locked").length,
    scale: { corpusEntries: c.corpusEntries, chunkCount: c.chunkCount },
    spanSequenceComplete: spanOk,
  }
  return SCALE_UNLOCK_REPORT_SCHEMA.parse(report)
}

/**
 * 可观测输出（零 IO / 零时钟）：逐谓词一行，含裁决 + 理由码 + 理由。
 * 现役规模下预期输出四条 locked（各有理由），用于 R3 评测矩阵与人工审计。
 */
export function formatUnlockGateReport(report: ScaleUnlockReport): string {
  const lines = [
    `[scale-unlock] corpus=${report.scale.corpusEntries} chunks=${report.scale.chunkCount} ` +
      `spanSequenceComplete=${report.spanSequenceComplete} nominated=${report.nominatedTargets.length} ` +
      `locked=${report.lockedCount} configMutated=${report.configMutated}`,
  ]
  for (const d of report.decisions) {
    const metrics = d.metrics
      ? ` metrics=${JSON.stringify(d.metrics)}`
      : ""
    lines.push(`  - ${d.target} [${d.kind}] ${d.verdict} (${d.reasonCode}) ${d.reason}${metrics}`)
  }
  return lines.join("\n")
}

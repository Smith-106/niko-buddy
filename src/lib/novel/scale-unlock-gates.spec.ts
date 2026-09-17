/**
 * scale-unlock-gates.spec — R2 解冻提名谓词测试。
 *
 * 覆盖：① 现役规模（语料 80 条）下四目标全部 locked 且各有理由码（可观测输出）；
 * ② rerank 谓词四象限（规模不足 / 证据缺失 / 非 triggered / 规模+触发 → 提名）；
 * ③ MMR 公式（λ 缺失 locked、簇不足 locked、净增益 ≤0 locked、净增益 >0 提名；
 *    净增益(pp) = 簇内 top3 增益(pp) − p95 延迟增量(ms)/λ(ms_per_pp)）；
 * ④ 扇出提名真实调用 generateMultiQueries + R0-b 采集器；
 * ⑤ ANN 恒 locked（无实现）；⑥ 提名 ≠ 开启（appliesToConfig 恒 false、configMutated 恒 false，
 *    且与 consensus-antigoals 期望 flag 默认值不冲突）；⑦ 契约非法 fail-loud；⑧ span 面不完整降级锁定。
 *
 * @license MIT © QMAI
 */
import { describe, expect, it } from "vitest"
import {
  SCALE_UNLOCK_CTX_SCHEMA,
  SCALE_UNLOCK_REPORT_SCHEMA,
  SCALE_UNLOCK_THRESHOLDS,
  SCALE_UNLOCK_TARGETS,
  ScaleUnlockGateError,
  evaluateUnlockGates,
  formatUnlockGateReport,
  type ScaleUnlockCtx,
} from "./scale-unlock-gates"
import { EXPECTED_RETRIEVAL_FLAGS } from "./consensus-antigoals"
import { collectRerankTriggerEvidence } from "./rerank-trigger-evidence"
import { RETRIEVAL_LAMBDA_INITIAL, RETRIEVAL_SPAN_STAGES } from "./index"

/** 现役规模（2026-09-17：world_ref 18 + lexicon 44 + craft 12 + corpus 6 = 80）。 */
const LIVE_CORPUS_ENTRIES = 80

function ctx(overrides: Partial<ScaleUnlockCtx> = {}): ScaleUnlockCtx {
  return {
    schemaVersion: 1,
    corpusEntries: LIVE_CORPUS_ENTRIES,
    chunkCount: 320,
    rerankEvidence: { present: true, evidence: null },
    sameCluster: null,
    lambda: null,
    fanoutProbe: null,
    docs: { promotionFlowDocPresent: true },
    spans: { observedStages: [...RETRIEVAL_SPAN_STAGES] },
    ...overrides,
  }
}

/** 规模已达标 + 用真实 R0-b 采集器产出证据（status=triggered / armed）。 */
function evidence(status: "triggered" | "armed") {
  const ranks = Array.from({ length: 34 }, (_, i) => ({
    query: `q${i + 1}`,
    rank: i + 1,
    top3: status === "armed" ? true : i < 17,
    top20: true,
  }))
  return collectRerankTriggerEvidence({
    ranks,
    baseline: { minTop3Rate: 0.7, minTop20Rate: 0.9 },
  })
}

function triggeredEvidence(): { present: true; evidence: ReturnType<typeof evidence> } {
  return { present: true, evidence: evidence("triggered") }
}

describe("R2 现役规模面（全部 locked 可观测）", () => {
  const report = evaluateUnlockGates(ctx())

  it("四目标全部 locked 且各有理由码（无一提名）", () => {
    expect(report.decisions).toHaveLength(SCALE_UNLOCK_TARGETS.length)
    expect(report.lockedCount).toBe(4)
    expect(report.nominatedTargets).toEqual([])
    const byTarget = Object.fromEntries(report.decisions.map((d) => [d.target, d.reasonCode]))
    expect(byTarget).toEqual({
      usefulnessRerankEnabled: "rr_corpus_below_threshold",
      dualKbRoutingEnabled: "mmr_corpus_below_threshold",
      multiQueryFanout: "fanout_corpus_below_threshold",
      annApproximateSearch: "ann_no_implementation",
    })
  })

  it("可观测输出：逐谓词打印 target/verdict/reasonCode/reason（非空）", () => {
    const text = formatUnlockGateReport(report)
    expect(text).toContain("corpus=80")
    expect(text).toContain("locked=4")
    expect(text).toContain("configMutated=false")
    for (const d of report.decisions) {
      expect(text).toContain(`${d.target} [${d.kind}] ${d.verdict} (${d.reasonCode})`)
      expect(d.reason.length).toBeGreaterThan(8)
    }
  })

  it("语义冻结①：提名≠开启——configMutated 恒 false、appliesToConfig 恒 false", () => {
    expect(report.configMutated).toBe(false)
    for (const d of report.decisions) expect(d.appliesToConfig).toBe(false)
    // 与 R-1 期望默认值一致（本模块不构成第二真源，也未改变默认值）
    expect(EXPECTED_RETRIEVAL_FLAGS).toEqual({
      dualKbRoutingEnabled: false,
      hardInjectEnabled: true,
      usefulnessRerankEnabled: false,
    })
  })

  it("阈值全部为待标定初值（1000 语料 / 1e4 chunk / 30 簇）", () => {
    expect(SCALE_UNLOCK_THRESHOLDS.corpusMinEntries).toBe(1000)
    expect(SCALE_UNLOCK_THRESHOLDS.chunkMinCount).toBe(10000)
    expect(SCALE_UNLOCK_THRESHOLDS.mmrMinClusterQueries).toBe(30)
    expect(report.thresholds["corpusMinEntries"]).toBe(1000)
  })
})

describe("R2 rerank 谓词（语料 > 阈值 AND R0-b triggered）", () => {
  const big = { corpusEntries: 1200 }

  it("规模达标但证据产物不存在 → locked(rr_evidence_missing)（存在性硬检查）", () => {
    const r = evaluateUnlockGates(ctx({ ...big, rerankEvidence: { present: false, evidence: null } }))
    const d = r.decisions.find((x) => x.target === "usefulnessRerankEnabled")!
    expect(d.verdict).toBe("locked")
    expect(d.reasonCode).toBe("rr_evidence_missing")
  })

  it("规模达标 + 证据存在但 status=armed → locked(rr_evidence_not_triggered)", () => {
    const r = evaluateUnlockGates(
      ctx({ ...big, rerankEvidence: { present: true, evidence: evidence("armed") } }),
    )
    const d = r.decisions.find((x) => x.target === "usefulnessRerankEnabled")!
    expect(d.reasonCode).toBe("rr_evidence_not_triggered")
    expect(d.metrics?.["top20Rate"]).toBe(1)
    expect(d.metrics?.["top3Rate"]).toBe(1)
  })

  it("规模达标 + status=triggered + span 序完整 → unlock-candidate（仍不写配置）", () => {
    const r = evaluateUnlockGates(ctx({ ...big, rerankEvidence: triggeredEvidence() }))
    const d = r.decisions.find((x) => x.target === "usefulnessRerankEnabled")!
    expect(d.verdict).toBe("unlock-candidate")
    expect(d.reasonCode).toBe("nominated_pending_dual_arm_gate")
    expect(d.appliesToConfig).toBe(false)
    expect(d.nextStep).toContain("kb-flag-promotion-flow.md")
    expect(d.nextStep).toContain("ADR-48")
    expect(r.nominatedTargets).toContain("usefulnessRerankEnabled")
  })

  it("span 面不完整（五 stage）→ 提名降为 locked(span_sequence_incomplete)", () => {
    const r = evaluateUnlockGates(
      ctx({
        ...big,
        rerankEvidence: triggeredEvidence(),
        spans: { observedStages: RETRIEVAL_SPAN_STAGES.slice(0, 5) },
      }),
    )
    const d = r.decisions.find((x) => x.target === "usefulnessRerankEnabled")!
    expect(d.reasonCode).toBe("span_sequence_incomplete")
    expect(r.spanSequenceComplete).toBe(false)
  })

  it("文档结构标志缺失 → locked(promotion_flow_doc_missing)", () => {
    const r = evaluateUnlockGates(
      ctx({ ...big, rerankEvidence: triggeredEvidence(), docs: { promotionFlowDocPresent: false } }),
    )
    const d = r.decisions.find((x) => x.target === "usefulnessRerankEnabled")!
    expect(d.reasonCode).toBe("promotion_flow_doc_missing")
  })
})

describe("R2 MMR 谓词（净增益 = 簇内 top3 增益(pp) − λ·p95 延迟增量(ms)）", () => {
  const big = { corpusEntries: 1200, rerankEvidence: triggeredEvidence() }
  const cluster = { clusterQueries: 34, top3GainPp: 12, p95LatencyDeltaMs: 200 }

  it("λ 缺失 → locked(mmr_lambda_missing)（R0-d 输出为硬依赖）", () => {
    const r = evaluateUnlockGates(ctx({ ...big, sameCluster: cluster, lambda: null }))
    const d = r.decisions.find((x) => x.target === "dualKbRoutingEnabled")!
    expect(d.reasonCode).toBe("mmr_lambda_missing")
  })

  it("同源簇 query 数低于阈值 → locked(mmr_cluster_below_threshold)", () => {
    const r = evaluateUnlockGates(
      ctx({ ...big, lambda: RETRIEVAL_LAMBDA_INITIAL, sameCluster: { ...cluster, clusterQueries: 3 } }),
    )
    const d = r.decisions.find((x) => x.target === "dualKbRoutingEnabled")!
    expect(d.reasonCode).toBe("mmr_cluster_below_threshold")
  })

  it("净增益 ≤ 0（延迟成本吃掉增益）→ locked(mmr_net_gain_not_positive) 且带 metrics", () => {
    // λ=25 ms/pp → 200ms 延迟成本 = 200/25 = 8pp；增益 6pp → 净 -2pp
    const r = evaluateUnlockGates(
      ctx({
        ...big,
        lambda: RETRIEVAL_LAMBDA_INITIAL,
        sameCluster: { ...cluster, top3GainPp: 6 },
      }),
    )
    const d = r.decisions.find((x) => x.target === "dualKbRoutingEnabled")!
    expect(d.reasonCode).toBe("mmr_net_gain_not_positive")
    expect(d.metrics?.["netGainPp"]).toBeCloseTo(6 - 200 / 25, 6)
    expect(d.metrics?.["lambdaMsPerPp"]).toBe(25)
  })

  it("净增益 > 0 → unlock-candidate（λ 未标定照实标注 calibrated=false）", () => {
    // 增益 12pp − 200/25(=8pp) = 4pp > 0
    const r = evaluateUnlockGates(
      ctx({ ...big, lambda: RETRIEVAL_LAMBDA_INITIAL, sameCluster: cluster }),
    )
    const d = r.decisions.find((x) => x.target === "dualKbRoutingEnabled")!
    expect(d.verdict).toBe("unlock-candidate")
    expect(d.metrics?.["netGainPp"]).toBeCloseTo(4, 6)
    expect(d.reason).toContain("calibrated=false")
  })

  it("λ 未标定不阻塞提名但被显式标注；λ 标定值直接参与公式", () => {
    const calibrated = { ...RETRIEVAL_LAMBDA_INITIAL, value: 40, calibrated: true }
    const r = evaluateUnlockGates(ctx({ ...big, lambda: calibrated, sameCluster: cluster }))
    const d = r.decisions.find((x) => x.target === "dualKbRoutingEnabled")!
    // 12pp − 200/40(=5pp) = 7pp
    expect(d.metrics?.["netGainPp"]).toBeCloseTo(7, 6)
    expect(d.reason).toContain("calibrated=true")
  })
})

describe("R2 扇出谓词与 ANN 冻结", () => {
  const big = { corpusEntries: 1200, rerankEvidence: triggeredEvidence() }
  const probe = {
    query: "青云门内门弟子在灵脉争夺中如何站位",
    decomposition: {
      original: "青云门内门弟子在灵脉争夺中如何站位",
      verbatim: ["灵脉争夺"],
      entityMentions: ["character:青云门"],
      facets: { character: "青云门" },
      rest: "内门弟子如何站位",
    },
  }

  it("探测缺失 → locked(fanout_probe_missing)", () => {
    const r = evaluateUnlockGates(ctx({ ...big, fanoutProbe: null }))
    const d = r.decisions.find((x) => x.target === "multiQueryFanout")!
    expect(d.reasonCode).toBe("fanout_probe_missing")
  })

  it("探测齐备 → unlock-candidate，且真实调用 generateMultiQueries 与 R0-b 采集器重放", () => {
    const r = evaluateUnlockGates(ctx({ ...big, fanoutProbe: probe }))
    const d = r.decisions.find((x) => x.target === "multiQueryFanout")!
    expect(d.verdict).toBe("unlock-candidate")
    expect(d.metrics?.["expandedQueries"]).toBeGreaterThanOrEqual(2)
    expect(d.reason).toContain("generateMultiQueries")
    // R0-b 采集器重放（由分档计数忠实重建）→ status 与证据面一致
    expect(d.reason).toContain("status=triggered")
  })

  it("证据快照自相矛盾（status 与分档计数不符）→ locked(fanout_evidence_inconsistent)", () => {
    const tampered = { ...triggeredEvidence().evidence, status: "triggered" as const, top3Hits: 34 }
    const r = evaluateUnlockGates(
      ctx({ ...big, fanoutProbe: probe, rerankEvidence: { present: true, evidence: tampered } }),
    )
    const d = r.decisions.find((x) => x.target === "multiQueryFanout")!
    expect(d.verdict).toBe("locked")
    expect(d.reasonCode).toBe("fanout_evidence_inconsistent")
    expect(d.reason).toContain("自相矛盾")
  })

  it("R0-b 产物缺失时扇出亦 locked（存在性硬检查覆盖扇出面）", () => {
    const r = evaluateUnlockGates(
      ctx({ corpusEntries: 1200, fanoutProbe: probe, rerankEvidence: { present: false, evidence: null } }),
    )
    const d = r.decisions.find((x) => x.target === "multiQueryFanout")!
    expect(d.reasonCode).toBe("fanout_evidence_missing")
  })

  it("ANN 恒 locked(ann_no_implementation)：任意规模/证据面均不提名", () => {
    for (const c of [
      ctx(),
      ctx({ ...big, fanoutProbe: probe, lambda: RETRIEVAL_LAMBDA_INITIAL, sameCluster: { clusterQueries: 40, top3GainPp: 30, p95LatencyDeltaMs: 10 } }),
      ctx({ corpusEntries: 100000, chunkCount: 5_000_000 }),
    ]) {
      const d = evaluateUnlockGates(c).decisions.find((x) => x.target === "annApproximateSearch")!
      expect(d.verdict).toBe("locked")
      expect(d.reasonCode).toBe("ann_no_implementation")
      expect(d.reason).toContain("无实现")
    }
  })
})

describe("R2 契约与输出 schema", () => {
  it("上下文非法 fail-loud（负语料 / schemaVersion 错 / 未知字段 / 缺 span 面）", () => {
    expect(() => evaluateUnlockGates({ ...ctx(), corpusEntries: -1 })).toThrow(ScaleUnlockGateError)
    expect(() => evaluateUnlockGates({ ...ctx(), schemaVersion: 2 as never })).toThrow(
      ScaleUnlockGateError,
    )
    expect(() => evaluateUnlockGates({ ...ctx(), extra: true } as never)).toThrow(ScaleUnlockGateError)
    const noSpans = { ...ctx() } as Record<string, unknown>
    delete noSpans["spans"]
    expect(() => evaluateUnlockGates(noSpans as never)).toThrow(ScaleUnlockGateError)
  })

  it("ctx schema strict 校验通过 + 输出 report 通过 report schema", () => {
    expect(SCALE_UNLOCK_CTX_SCHEMA.safeParse(ctx()).success).toBe(true)
    const report = evaluateUnlockGates(ctx())
    expect(SCALE_UNLOCK_REPORT_SCHEMA.safeParse(report).success).toBe(true)
  })

  it("全提名象限：规模+触发+λ+簇齐备 → 3 提名（ANN 仍 locked）", () => {
    const r = evaluateUnlockGates(
      ctx({
        corpusEntries: 1200,
        chunkCount: 20000,
        rerankEvidence: triggeredEvidence(),
        lambda: RETRIEVAL_LAMBDA_INITIAL,
        sameCluster: { clusterQueries: 34, top3GainPp: 12, p95LatencyDeltaMs: 200 },
        fanoutProbe: {
          query: "灵脉争夺",
          decomposition: {
            original: "灵脉争夺",
            verbatim: ["灵脉争夺"],
            entityMentions: [],
            facets: {},
            rest: "",
          },
        },
      }),
    )
    expect(r.nominatedTargets).toEqual([
      "usefulnessRerankEnabled",
      "dualKbRoutingEnabled",
      "multiQueryFanout",
    ])
    expect(r.lockedCount).toBe(1)
    expect(r.lockedCount + r.nominatedTargets.length).toBe(SCALE_UNLOCK_TARGETS.length)
  })
})

/**
 * rerank-trigger-evidence.spec — R0-b rerank 触发证据采集器测试。
 * 覆盖：triggered/armed 判据四象限（top20 守/掉 × top3 守/掉）/ 候选集内容与序 /
 * 顶部边界（全中、全掉）/ 规则漂移自检（golden _meta.rerankTrigger.status 与本采集器
 * 判定一致）/ 输入非法 fail-loud / trace 条目形状（channel 字面量 + slotManifest 候选）/
 * 零时钟（timestamp 由调用方注入）。
 *
 * @license MIT © QMAI
 */
import { describe, expect, it } from "vitest"
import {
  RERANK_TRIGGER_CHANNEL,
  RERANK_TRIGGER_EVIDENCE_SCHEMA,
  RERANK_TRIGGER_RULE,
  RerankTriggerEvidenceError,
  buildRerankTriggerTraceEntry,
  collectRerankTriggerEvidence,
  type RerankTriggerRank,
} from "./rerank-trigger-evidence"

const BASELINE = { minTop3Rate: 0.7, minTop20Rate: 0.9 }

function ranksFrom(flags: Array<{ top3: boolean; top20: boolean }>): RerankTriggerRank[] {
  return flags.map((f, i) => ({
    query: `q${i + 1}`,
    rank: f.top3 ? 1 : f.top20 ? 10 : 25,
    top3: f.top3,
    top20: f.top20,
  }))
}

/** 生成 n 条：前 a 条 top3 命中，其后 b 条 top20-only，余下全掉。 */
function ranksMixed(a: number, b: number, n: number): RerankTriggerRank[] {
  return ranksFrom([
    ...Array(a).fill({ top3: true, top20: true }),
    ...Array(b).fill({ top3: false, top20: true }),
    ...Array(n - a - b).fill({ top3: false, top20: false }),
  ])
}

describe("R0-b collectRerankTriggerEvidence 判据", () => {
  it("top20 守住 + top3 掉档 → triggered（候选=top3 掉档集）", () => {
    const evidence = collectRerankTriggerEvidence({ ranks: ranksMixed(20, 14, 34), baseline: BASELINE })
    expect(evidence.status).toBe("triggered")
    expect(evidence.n).toBe(34)
    expect(evidence.top3Rate).toBeCloseTo(20 / 34, 10)
    expect(evidence.top20Rate).toBe(1)
    expect(evidence.droppedQueries).toHaveLength(14)
    expect(evidence.top20DroppedQueries).toEqual([])
    expect(RERANK_TRIGGER_EVIDENCE_SCHEMA.safeParse(evidence).success).toBe(true)
  })

  it("top20 守住 + top3 守住 → armed（无候选）", () => {
    const evidence = collectRerankTriggerEvidence({ ranks: ranksMixed(34, 0, 34), baseline: BASELINE })
    expect(evidence.status).toBe("armed")
    expect(evidence.droppedQueries).toEqual([])
    expect(evidence.top3Rate).toBe(1)
  })

  it("top20 掉档 → armed（top20 未达即非触发，即使 top3 也掉）", () => {
    const evidence = collectRerankTriggerEvidence({ ranks: ranksMixed(10, 11, 34), baseline: BASELINE })
    expect(evidence.top20Rate).toBeCloseTo(21 / 34, 10)
    expect(evidence.top20Rate).toBeLessThan(BASELINE.minTop20Rate)
    expect(evidence.status).toBe("armed")
    expect(evidence.droppedQueries).toHaveLength(24)
    expect(evidence.top20DroppedQueries).toHaveLength(13)
  })

  it("边界：top20Rate 恰等阈值且 top3 掉 → triggered；top3Rate 恰等阈值 → armed", () => {
    // 30/34 = 0.882 < 0.9 → armed；用 31/34=0.912 ≥0.9 且 top3=23/34=0.676<0.7 → triggered
    const triggered = collectRerankTriggerEvidence({ ranks: ranksMixed(23, 8, 34), baseline: BASELINE })
    expect(triggered.status).toBe("triggered")
    // top3 恰等 0.7（24/34≈0.7059 ≥0.7）→ armed（严格小于才触发）
    const armed = collectRerankTriggerEvidence({ ranks: ranksMixed(24, 10, 34), baseline: BASELINE })
    expect(armed.top3Rate).toBeGreaterThanOrEqual(BASELINE.minTop3Rate)
    expect(armed.status).toBe("armed")
  })

  it("全掉：top20 未守 → armed，且候选与诊断集都满", () => {
    const evidence = collectRerankTriggerEvidence({ ranks: ranksMixed(0, 0, 34), baseline: BASELINE })
    expect(evidence.status).toBe("armed")
    expect(evidence.droppedQueries).toHaveLength(34)
    expect(evidence.top20DroppedQueries).toHaveLength(34)
  })

  it("规则陈述为模块常量（判据可读，供证据文件引用）", () => {
    expect(RERANK_TRIGGER_RULE).toContain("top20")
    expect(RERANK_TRIGGER_RULE).toContain("minTop3Rate")
  })

  it("输入非法 fail-loud（空 ranks / 缺 baseline / top3Rate 越界）", () => {
    expect(() => collectRerankTriggerEvidence({ ranks: [], baseline: BASELINE })).toThrow(
      RerankTriggerEvidenceError,
    )
    expect(() =>
      collectRerankTriggerEvidence({ ranks: ranksMixed(34, 0, 34), baseline: undefined as never }),
    ).toThrow(RerankTriggerEvidenceError)
    expect(() =>
      collectRerankTriggerEvidence({
        ranks: ranksMixed(34, 0, 34),
        baseline: { minTop3Rate: 2, minTop20Rate: 0.9 },
      }),
    ).toThrow(RerankTriggerEvidenceError)
  })
})

describe("R0-b rerank-trigger trace 面", () => {
  it("条目通道为唯一字面量 rerank-trigger，候选经 slotManifest 承载", () => {
    const evidence = collectRerankTriggerEvidence({ ranks: ranksMixed(20, 14, 34), baseline: BASELINE })
    const entry = buildRerankTriggerTraceEntry(evidence, "rt-1", "2026-09-16T00:00:00.000Z")
    expect(entry.channel).toBe(RERANK_TRIGGER_CHANNEL)
    expect(entry.channel).toBe("rerank-trigger")
    expect(entry.recordedAt).toBe("2026-09-16T00:00:00.000Z")
    expect(entry.hits).toEqual([])
    expect(entry.slotManifest).toHaveLength(14)
    expect(entry.slotManifest?.[0]).toEqual({ slot: "rerank-candidate", sourceId: "query:q21", score: 0 })
    expect(entry.slotManifest?.[13]?.sourceId).toBe("query:q34")
  })

  it("armed 状态条目候选为空（哨位留痕，无候选）", () => {
    const evidence = collectRerankTriggerEvidence({ ranks: ranksMixed(34, 0, 34), baseline: BASELINE })
    const entry = buildRerankTriggerTraceEntry(evidence, "rt-2", "2026-09-16T00:00:00.000Z")
    expect(entry.slotManifest).toEqual([])
    expect(entry.query).toBe("golden-34 rerank-trigger sentinel")
  })

  it("判据不一致 fail-loud（triggered 但候选空）", () => {
    expect(() =>
      buildRerankTriggerTraceEntry(
        {
          status: "triggered",
          rule: RERANK_TRIGGER_RULE,
          n: 34,
          top3Hits: 0,
          top20Hits: 34,
          top3Rate: 0,
          top20Rate: 1,
          minTop3Rate: 0.7,
          minTop20Rate: 0.9,
          droppedQueries: [],
          top20DroppedQueries: [],
        },
        "rt-3",
        "2026-09-16T00:00:00.000Z",
      ),
    ).toThrow(RerankTriggerEvidenceError)
  })
})

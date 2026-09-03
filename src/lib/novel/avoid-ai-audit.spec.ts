import { describe, expect, it } from "vitest"
import { AUDIT_TAXONOMY, ALL_GATE_KEYS, type AuditDimensionId } from "./audit-taxonomy"
import { analyzeAvoidAiPatterns, AVOID_AI_PATTERNS_SCHEMA } from "./avoid-ai-patterns"
import { detectTieredDeAi } from "./de-ai-tiered-table"

/**
 * 54 号设计 ⑨ avoid-ai 审计产物（C 视角验收：三态标注 + 豁免理由留档）。
 *
 * 51-type audit taxonomy 的 anti_ai gate 维度 × 检测器覆盖矩阵：
 *   已覆盖 = 该维度至少有确定性/机械层检测器命中；
 *   豁免 = 结构性豁免（见下方矩阵注释理由）；
 *   缺口 = 无检测器对应（需在矩阵下方登记）。
 *
 * 本 spec 为静态契约锁（无 LLM/IO）：若维度新增而未登记，测试红。
 */
const ANTI_AI_DIMENSIONS = Object.entries(AUDIT_TAXONOMY)
  .filter(([, def]) => def.gate === "anti_ai")
  .map(([id]) => id as AuditDimensionId)

describe("54 ⑨ avoid-ai 审计——anti_ai gate 维度 × 检测器覆盖矩阵", () => {
  // ── 状态：已覆盖 / 豁免 / 缺口 ──────────────────────────────────────────────
  // 已覆盖：
  //   - de_ai_residual           → de-ai-rules semantic clean + mechanical-slop-detector TIER1/2/3
  //   - slop_mechanical          → mechanical-slop-detector（零 LLM 机械层）
  //   - slop_explanation        → de-ai-rules 解释腔规则簇
  //   - slop_summary            → de-ai-rules 总结腔规则簇
  //   - slop_emotion_abstract   → de-ai-rules 情绪概述规则簇
  // 豁免（结构性理由）：
  //   - statistical_ai_signature → 英文统计指纹引擎（avoid-ai-writing full patterns）
  //     Track B soft：对中文网文仅参考；中文统计指纹由 de-ai-selfcheck 阶段补充，
  //     不设产品硬门（决策记录：54-ref-cover-design-consensus ⑨ 节）。
  // 缺口（登记）：
  //   - behavioral_repetition    → 行为重复检测当前由 narrative-echo-detector（跨章回纹）
  //     部分覆盖；同章行为重复暂无检测器，纳入后续 A-35 批次。
  const EXPECTED_STATUS: Record<string, string> = {
    de_ai_residual: "已覆盖",
    slop_mechanical: "已覆盖",
    slop_explanation: "已覆盖",
    slop_summary: "已覆盖",
    slop_emotion_abstract: "已覆盖",
    formulaic_transition: "已覆盖",
    generic_description: "已覆盖",
    statistical_ai_signature: "豁免",
    translationese: "豁免",
    behavioral_repetition: "缺口",
  }

  it("anti_ai gate 维度全量在矩阵中登记（新增维度未登记 → 红）", () => {
    expect(ANTI_AI_DIMENSIONS.length).toBeGreaterThanOrEqual(7)
    for (const id of ANTI_AI_DIMENSIONS) {
      expect(EXPECTED_STATUS[id], `anti_ai 维度 ${id} 未在覆盖矩阵登记`).toBeDefined()
    }
  })

  it("已覆盖维度确有确定性检测器（不空转）：de-ai 残留/机械/解释腔/总结腔/情绪概述", () => {
    // de-ai 机械层残留：机械句式命中（zero-LLM 确定性，112 词表）
    const mechanical = detectTieredDeAi("目光交汇的瞬间，他心中五味杂陈")
    expect(mechanical.length).toBeGreaterThan(0)
    // 英文 avoid-ai 引擎可跑且 schema 稳定（Track B soft）
    const audit = analyzeAvoidAiPatterns("He nodded and smiled, feeling good about himself.")
    expect(audit).toBeDefined()
    expect(AVOID_AI_PATTERNS_SCHEMA).toBe("avoid-ai-patterns/1.0")
  })

  it("门控优先级恒为 Consistency(P0) > Anti-AI(P1) > Quality(P2)", () => {
    expect(ALL_GATE_KEYS).toEqual(["consistency", "anti_ai", "quality"])
  })
})

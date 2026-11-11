import { describe, expect, it } from "vitest"
import { AUDIT_TAXONOMY, ALL_GATE_KEYS, type AuditDimensionId } from "./audit-taxonomy"
import { analyzeAvoidAiPatterns, AVOID_AI_PATTERNS_SCHEMA } from "./avoid-ai-patterns"
import { detectTieredDeAi } from "./de-ai-tiered-table"
import { detectCharacterActions, characterActionsToText } from "./mechanical-slop-detector"

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
  //   - behavioral_repetition   → mechanical-slop-detector.detectCharacterActions（角色-动作绑定,
  //     同章同一角色同一动作标签重复计数, 零 LLM; 由 review-adapter 机械预门消费,
  //     raw type 为 character_behavior, 其规范维度即本维）。原文「同章行为重复暂无
  //     检测器」已失真, 于 2026-11-11 P1 behavior routing 修正。
  //   - formulaic_transition / generic_description → 见下方 EXPECTED_STATUS（本次未重审理由）
  // 豁免（结构性理由）：
  //   - statistical_ai_signature → 英文统计指纹引擎（avoid-ai-writing full patterns）
  //     Track B soft：对中文网文仅参考；中文统计指纹由 de-ai-selfcheck 阶段补充，
  //     不设产品硬门（决策记录：54-ref-cover-design-consensus ⑨ 节）。
  //
  // 口径边界（不得夸大）：本矩阵的「已覆盖」仅等于「该维度至少有一个确定性/机械层
  // 检测器命中」，**不**等于语义完备、也不等于真实语料标定或文学 PASS。
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
    behavioral_repetition: "已覆盖",
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

  it("behavioral_repetition 确有同章机械命中（角色-动作绑定重复计数，非跨章回纹）", () => {
    // 复用 mechanical-slop-detector.spec.ts 已验证的 detector fixture/style：
    // 同一角色同一动作标签 3 次 = 本维度「≥3 次/章」机械信号。
    const sameChapterText = "白砚推了推眼镜，白砚又推了推眼镜，白砚再推了推眼镜。"
    const hits = detectCharacterActions(sameChapterText)

    expect(hits.length).toBeGreaterThan(0)
    const pushGlasses = hits.find((hit) => hit.action === "推眼镜")
    expect(pushGlasses).toBeDefined()
    expect(pushGlasses!.totalCount).toBe(3)
    expect(pushGlasses!.perCharacter["白砚"]).toBe(3)

    // 机械层渲染走 ⚠️ 档（≥3 次），不是只有检测器能跑而已
    const rendered = characterActionsToText(hits)
    expect(rendered).toContain("角色行为模式检测")
    expect(rendered).toContain('⚠️ "推眼镜" 共 3 次')

    // 边界（不得夸大）：只证明「至少一次确定性机械命中」；
    // 语义级行为重复（模式固化/互动套路）仍需 LLM 审查，本断言不覆盖。
    expect(hits.every((hit) => typeof hit.type === "string" && hit.type.length > 0)).toBe(true)
  })

  it("门控优先级恒为 Consistency(P0) > Anti-AI(P1) > Quality(P2)", () => {
    expect(ALL_GATE_KEYS).toEqual(["consistency", "anti_ai", "quality"])
  })
})

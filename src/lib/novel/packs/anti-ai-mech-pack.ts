/**
 * anti-ai-mech-pack.ts — T24 反 AI 机械规则包 (Anti-AI P1, 零模型调用)
 *
 * 蓝图 §6 T24 (TASK-P3-24) 要求 1: packs/anti-ai-mech-pack.ts
 *   「接线 T19 anti-ai-candidate-pool 四统计因子 warn 态 + mechanical-slop TIER3」。
 *
 * 接线内容:
 *   A) T19 四统计因子（nGramOverlap / sentenceEntropy / punctuationFingerprint /
 *      paragraphLengthDist）→ 各自一条 warn 态规则（标定前只 warn 不 block，
 *      守 T19 口径）；pool.analyze() 每 pack 实例**至多求值一次**（memo），
 *      四条规则共享同一 AntiAiAnalysisReport（共享特征预计算语义）。
 *   B) mechanical-slop TIER3 机械句式 → slop_mechanical 维；classifySlop()==="block"
 *      时升格 error（保持 review-adapter 现行阻断语义），有命中未达阻断 → warning。
 *
 * ADR-19 边界: 本包零模型调用。T19 候选池经依赖注入（AntiAiPoolLike 结构化最小
 * 接口 + type-only 导入），**不做运行时 import**——anti-ai-candidate-pool.ts 含
 * 模块级 __dirname 语料路径解析（node 环境专用），renderer bundle 不安全；
 * 生产接线点由后续任务在持有语料访问权的层构造池实例传入。未注入 pool 时
 * 四因子规则恒空产出（惰性降级，不抛错不阻断）。
 *
 * 组合语义: 未冻结 RulePackDefinition，须经 T23 combinePacks() 冻结后运行。
 *
 * @license MIT © QMAI
 */

import { classifySlop, slopScore } from "../mechanical-slop-detector"
import type { AntiAiAnalysisReport, AntiAiTextOrigin } from "../anti-ai-candidate-pool"
import type { RawRuleFinding, RuleDefinition, RulePackDefinition } from "../rule-stack"

// ============================================================================
// 类型
// ============================================================================

/** T19 候选池结构化最小接口（DI 注入；与 AntiAiCandidatePool.analyze 同构）。 */
export interface AntiAiPoolLike {
  analyze(text: string): AntiAiAnalysisReport
}

export interface AntiAiMechPackInput {
  /** 章节正文（undefined/空 → 全部规则空产出）。 */
  readonly text?: string
  /**
   * 共享特征预计算产物（composeCoreRulePacks 注入）。提供时 slop 扫描直接消费
   * features.normalizedText（跳过一次全文防绕过扫描；normalizeText 幂等，重入
   * 安全，tier 命中/penalty 与传原文完全一致），bypassCount 随阻断消息透传。
   */
  readonly features?: {
    readonly normalizedText: string
    readonly bypassCount?: number
  }
  /** T19 候选池（可注入 stub；缺省无池 → 四因子规则空产出）。 */
  readonly pool?: AntiAiPoolLike
  /**
   * 文本来源声明（20260823 #34 前置埋点，getPoolReport origin 标注）。
   * 调用方上下文数据：生成管线自审 → ai_draft；用户文本审查 → user_text；
   * 无法判定时缺省（消费侧归一化为 unknown）。纯元数据：绝不进 finding message、
   * 绝不影响门控结果。
   */
  readonly origin?: AntiAiTextOrigin
  /** #34 sink 暴露钩子：memo 首次计算后回调一次（含 origin 装饰后报告）；
   *  短路未求值（无 pool/无文本/consistency P0 硬短跳过 anti_ai）则不回调。*/
  readonly onPoolReport?: (report: AntiAiAnalysisReport | null) => void
}

/** anti-ai-mech-pack 唯一包 id。 */
export const ANTI_AI_MECH_PACK_ID = "pack.anti-ai-mech"

// ============================================================================
// 工厂
// ============================================================================

/**
 * 构建反 AI 机械规则包（5 条规则，全属 anti_ai 门）:
 *   - t19 四因子各一条（warn 态，dimensionId 见各规则注记）;
 *   - slop TIER3 一条（slop_mechanical，block→error / 命中→warning）。
 */
export function createAntiAiMechPack(input: AntiAiMechPackInput): RulePackDefinition {
  const text = input.text ?? ""
  const hasText = text.trim().length > 0

  // 共享预计算（anti-AI 域）: 池分析 memo —— 四因子规则共享同一份报告，
  // 无论 runRuleStack 执行几条规则、短路与否，analyze 至多调用一次。
  let poolReport: AntiAiAnalysisReport | null = null
  let poolReportComputed = false
  const getPoolReport = (): AntiAiAnalysisReport | null => {
    if (!input.pool || !hasText) return null
    if (!poolReportComputed) {
      const raw = input.pool.analyze(text)
      // origin 装饰（#34 前置埋点）：有标注时浅拷贝打标，缺省保原引用
      // （memo 至多一次语义与对象共享不变；analyze 本体保持 text→report 纯函数）
      poolReport = input.origin ? { ...raw, origin: input.origin } : raw
      poolReportComputed = true
      // #34 sink 暴露钩子（T24-01 接线）：memo 首次计算后回调一次，
      // 把装饰后报告递给调用方（推式保 analyze 至多一次 memo 语义）。短路未求值不回调。
      input.onPoolReport?.(poolReport)
    }
    return poolReport
  }

  /** T19 因子 → warn 态 finding（非 warn 返回空）。 */
  const factorFinding = (
    report: AntiAiAnalysisReport | null,
    factor: string,
    dimensionId: "statistical_ai_signature" | "slop_mechanical",
  ): readonly RawRuleFinding[] => {
    if (!report) return []
    const hit = report.factors.find((f) => f.factor === factor)
    if (!hit || !hit.warn) return []
    return [{
      dimensionId,
      severity: "warning",
      message: `[T19 ${factor}] ${hit.description}`,
    }]
  }

  const rules: RuleDefinition[] = [
    {
      id: "anti-ai-mech.t19-ngram-overlap",
      gate: "anti_ai",
      // n-gram 重合度 → 统计 AI 签名维（37 维 checks: n-gram 重复率超阈值）
      dimensionId: "statistical_ai_signature",
      run: () => factorFinding(getPoolReport(), "nGramOverlap", "statistical_ai_signature"),
    },
    {
      id: "anti-ai-mech.t19-sentence-entropy",
      gate: "anti_ai",
      // 句长熵过低（句式机械）→ 机械句式维（37 维 checks: 句式长度分布过于均匀）
      dimensionId: "slop_mechanical",
      run: () => factorFinding(getPoolReport(), "sentenceEntropy", "slop_mechanical"),
    },
    {
      id: "anti-ai-mech.t19-punctuation-fingerprint",
      gate: "anti_ai",
      // 标点指纹趋近 AI 语料 → 统计 AI 签名维（checks: 标点使用模式过于规整）
      dimensionId: "statistical_ai_signature",
      run: () => factorFinding(getPoolReport(), "punctuationFingerprint", "statistical_ai_signature"),
    },
    {
      id: "anti-ai-mech.t19-paragraph-distribution",
      gate: "anti_ai",
      // 段落长度 CV 过低（模板段落）→ 统计 AI 签名维（checks: 段落长度方差过小）
      dimensionId: "statistical_ai_signature",
      run: () => factorFinding(getPoolReport(), "paragraphLengthDist", "statistical_ai_signature"),
    },
    {
      id: "anti-ai-mech.slop-tier3",
      gate: "anti_ai",
      dimensionId: "slop_mechanical",
      run: (): readonly RawRuleFinding[] => {
        if (!hasText) return []
        // 共享预计算复用：调用方已预计算 features 时直接消费规范化文本
        // （省一次全文 normalizeText 扫描；幂等重入安全，结果与传原文一致）；
        // 未提供时回退原文，与 review-adapter 现行调用完全同口径。
        const scanText = input.features?.normalizedText ?? text
        const report = slopScore(scanText)
        const verdict = classifySlop(report)
        if (verdict === "block") {
          const bypass = input.features?.bypassCount ?? report.bypassCount ?? 0
          return [{
            dimensionId: "slop_mechanical",
            severity: "error",
            message: `机械 slop 阻断: penalty ${report.slopPenalty.toFixed(1)}/10 (tier1:${report.tier1Hits.length} tier2:${report.tier2Hits.length} tier3:${report.tier3Hits.length} 命中${bypass > 0 ? `, bypass:${bypass}` : ""})`,
          }]
        }
        if (report.tier3Hits.length === 0) return []
        return [{
          dimensionId: "slop_mechanical",
          severity: "warning",
          message: `机械句式 TIER3 命中 ${report.tier3Hits.length} 类 (共 ${report.tier3Hits.reduce((s, h) => s + h.count, 0)} 次): ${report.tier3Hits.slice(0, 5).map((h) => h.kw).join(" / ")}`,
        }]
      },
    },
  ]

  return { id: ANTI_AI_MECH_PACK_ID, rules }
}

/**
 * 纯助手：为报告打来源标（origin 缺省返回同一引用，无复制）。
 * 供测试与未来 #34 sink 以稳定契约复用；与 getPoolReport memo 装饰同语义。
 */
export function withPoolReportOrigin(
  report: AntiAiAnalysisReport,
  origin?: AntiAiTextOrigin,
): AntiAiAnalysisReport {
  return origin ? { ...report, origin } : report
}

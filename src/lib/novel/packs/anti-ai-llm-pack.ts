/**
 * anti-ai-llm-pack.ts — T24 反 AI LLM 维规则包 (Anti-AI P1, 投影层)
 *
 * 蓝图 §6 T24 (TASK-P3-24) 要求 1: packs/anti-ai-llm-pack.ts（LLM 维，保持
 * ADR-19 边界）。
 *
 * ADR-19 边界口径:
 *   机械层零模型调用 —— 本包自身**不发起任何模型调用**（无 streamChat / 无 IO /
 *   无 Tauri invoke）。LLM 产出在管线更上游（reviewChapter 六维/深度审查）完成，
 *   以数据形态注入本包；本包只做「LLM finding → T22 37 维 anti_ai 门」的纯投影
 *   （类型映射 + severity 透传），机械检测不因本包引入任何模型依赖。
 *
 * 设计:
 *   - 输入用结构化最小接口 AntiAiLlmFindingInput（与 review-adapter.NovelReviewResult
 *     结构同型），**不做 runtime import**——review-adapter 拉起 UI store/i18n 全链，
 *     packs 保持零 UI 依赖（type-only 也避免，直接本地声明同构接口）。
 *   - 类型 → 维度映射表 ANTI_AI_LLM_TYPE_TO_DIM 显式导出（可测可审计）；
 *     无专属 37 维槽位的 legacy type（如 style）落跨维通用（dimensionId 缺省，
 *     rule-stack 合法槽位），不强行归维。
 *
 * 组合语义: 未冻结 RulePackDefinition，须经 T23 combinePacks() 冻结后运行。
 *
 * @license MIT © QMAI
 */

import type { AuditDimensionId } from "../audit-taxonomy"
import type { RawRuleFinding, RuleDefinition, RulePackDefinition, RuleSeverity } from "../rule-stack"

// ============================================================================
// 类型
// ============================================================================

/** LLM 审查产出的结构化最小接口（与 NovelReviewResult 结构同型，零 import 耦合）。 */
export interface AntiAiLlmFindingInput {
  readonly severity: RuleSeverity
  readonly type: string
  readonly message: string
}

export interface AntiAiLlmPackInput {
  /** 上游 LLM 审查中反 AI 相关 findings（空 → 规则空产出）。 */
  readonly findings: readonly AntiAiLlmFindingInput[]
}

/** anti-ai-llm-pack 唯一包 id。 */
export const ANTI_AI_LLM_PACK_ID = "pack.anti-ai-llm"

// ============================================================================
// 类型 → T22 37 维映射（显式常量，可测可审计）
// ============================================================================

/**
 * legacy 反 AI review type → T22 anti_ai 门维度。
 *
 * 映射依据（T22 audit-taxonomy 维度语义对照）:
 *   - anti_ai / slop → slop_mechanical（机械句式总槽位）
 *   - de_ai          → de_ai_residual（去 AI 残留）
 *   - translationese → translationese（翻译腔）
 *   - generic_description → generic_description（泛化描述）
 *   - style → undefined（文风类无专属 anti_ai 37 维槽位 → 跨维通用检查项；
 *     文风一致性属 quality 门 consistency_of_voice，此处不得越门归维）
 *
 * 未列出的 type 一律 undefined（跨维通用），不做静默猜测归维。
 */
export const ANTI_AI_LLM_TYPE_TO_DIM: Readonly<Record<string, AuditDimensionId | undefined>> = {
  anti_ai: "slop_mechanical",
  slop: "slop_mechanical",
  de_ai: "de_ai_residual",
  translationese: "translationese",
  generic_description: "generic_description",
  style: undefined,
}

// ============================================================================
// 工厂
// ============================================================================

/**
 * 构建反 AI LLM 投影规则包。单条规则 `anti-ai-llm.projection`：把注入的每条
 * LLM finding 映射为 anti_ai 门 RawRuleFinding（severity/type 原样透传，
 * dimensionId 经映射表；severity 由运行器盖章校验，非法值组合期/run 期拒绝）。
 */
export function createAntiAiLlmPack(input: AntiAiLlmPackInput): RulePackDefinition {
  // 共享预计算（LLM 投影域）: 映射结果 memo 一次，run() 只读同一快照数组。
  const projected: readonly RawRuleFinding[] = Object.freeze(
    input.findings.map((finding): RawRuleFinding => ({
      dimensionId: ANTI_AI_LLM_TYPE_TO_DIM[finding.type],
      severity: finding.severity,
      message: `[llm:${finding.type}] ${finding.message}`,
    })),
  )

  const rules: RuleDefinition[] = [
    {
      id: "anti-ai-llm.projection",
      gate: "anti_ai",
      // 规则级 dimensionId 不声明：逐 finding 维度经映射表决定（含跨维通用 undefined）。
      run: () => projected,
    },
  ]

  return { id: ANTI_AI_LLM_PACK_ID, rules }
}

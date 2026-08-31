/**
 * de-ai-intensity.ts — P0-2 介入程度分级 (EditLens 映射)
 *
 * 2026 检测前沿: EditLens 把「介入程度」从二元 (整篇改写/未改写) 连续化 —
 * 检测器可回溯「改写强度局部分布」, 重写越深越可能被识别为改写痕迹。
 * 反直觉结论: 乱加错字/假口语对深度分类器适得其反。
 *
 * 本模块实现三层 triage (轻改/中改/重写), 与 A19 机械层 (slopPenalty) +
 * F-009 分级表 (weightedScore) 结合, 输出介入档位与过滤建议 —
 * 供调度器决定改写深度与 prompt 注入强度, 防止「为过指标而过度改写」。
 *
 * Track B soft: 本模块只输出建议档位, 不设产品硬门 (productHardGate=false,
 * 与 de-ai-percentile 同一立场)。
 */

export type { SlopReport } from "./mechanical-slop-detector"


/** 介入程度档位 (EditLens 三档连续化) */
export type InterventionTier = "light" | "medium" | "rewrite"

/** triage 输入: slop 机械报告 + F-009 分级表加权分 + 可选改写痕迹信号 */
export interface InterventionInput {
  /** mechanical-slop-detector 输出 (0-10) */
  slopPenalty: number
  /** de-ai-rules runDeAiDualPass pass1.weightedScore */
  weightedScore: number
  /** 改写痕迹: overCorrectionReport 的 humanizerCavityScore (0-1), 无则 0 */
  humanizerCavityScore?: number
  /** 句长变异系数 (改写过度时异常高/低) */
  sentenceLengthCV?: number
}

/** 分级结果 */
export interface InterventionVerdict {
  tier: InterventionTier
  /** 建议的改写深度说明 (注入 prompt) */
  guidance: string
  /** 是否建议跳过改写 (已有人工痕迹, 再改反而暴露) */
  skip: boolean
  /** Track B soft — 永不产品硬门 */
  productHardGate: false
}

/** 阈值配置项 (可部分覆盖) */
export interface InterventionThresholds {
  /** weightedScore 低于此 → 轻改 (只处理 flag 片段) */
  lightUpper: number
  /** weightedScore 高于此 → 重写 (需人工确认) */
  rewriteLower: number
  /** slopPenalty 高于此 → 至少中改 */
  slopFloor: number
  /** humanizerCavityScore 高于此 → 跳过改写 (过度改写信号) */
  cavitySkipUpper: number
}

/** 默认阈值 (DD-3 待校准, 与 slop 阈值同量级) */
export const INTERVENTION_DEFAULTS: InterventionThresholds = {
  lightUpper: 6,
  rewriteLower: 16,
  slopFloor: 5,
  cavitySkipUpper: 0.7,
}

/**
 * 介入程度 triage: light / medium / rewrite。
 *
 * 规则 (按优先级):
 *  1. humanizerCavityScore 高 → skip (已有人工/改写痕迹, 再改暴露 humanizer 腔)
 *  2. slopPenalty >= slopFloor 或 weightedScore >= lightUpper → 至少 medium (扫描全文)
 *  3. weightedScore >= rewriteLower → rewrite (整章级别, 调度器需人工确认)
 *  4. 其余 → light (只处理 flag 片段, 不改其余)
 *
 * 防过拟合: 目标不是把 slop 分数压到 0, 而是「分布对齐自然文本」 —
 * 完全干净 (score 0) 反而是改写器腔信号 (见 humanizer-cavity-guard)。
 */
export function classifyIntervention(
  input: InterventionInput,
  opts?: Partial<InterventionThresholds>,
): InterventionVerdict {
  const cfg = { ...INTERVENTION_DEFAULTS, ...opts }
  const cavity = input.humanizerCavityScore ?? 0

  if (cavity >= cfg.cavitySkipUpper) {
    return {
      tier: "light",
      guidance:
        "检测到改写痕迹 (humanizer 腔): 句长异常齐整/假口语/填充词密度异常。跳过整章改写, 仅对明确 slop 片段做最小替换, 防止改写越深越暴露。",
      skip: true,
      productHardGate: false,
    }
  }

  if (input.weightedScore >= cfg.rewriteLower && input.slopPenalty >= cfg.slopFloor) {
    return {
      tier: "rewrite",
      guidance:
        "重写档: 全文级 AI 信号密集, 需整章重写。注意 EditLens 回溯 — 重写后保持句式/词汇/标点多样性, 勿收敛到统一改写风格。建议人工确认后执行。",
      skip: false,
      productHardGate: false,
    }
  }

  if (input.slopPenalty >= cfg.slopFloor || input.weightedScore >= cfg.lightUpper) {
    return {
      tier: "medium",
      guidance:
        "中改档: 全章扫描, 按 severity 过滤 (critical+high+medium), 局部替换 + 句式多样化。保留角色声线, 不整段重写。",
      skip: false,
      productHardGate: false,
    }
  }

  return {
    tier: "light",
    guidance:
      "轻改档: 仅处理明确 flag 的片段 (1A 高权重 + 机械 slop), 其余原文不动。介入度最低, EditLens 回溯风险最小。",
    skip: false,
    productHardGate: false,
  }
}

/** 文本化 triage 结果 (供 scheduler note / 审计) */
export function formatInterventionVerdict(v: InterventionVerdict): string {
  return [
    `intervention=${v.tier}`,
    v.skip ? "skip(rewriter-cavity)" : "rewrite-bounded",
    v.productHardGate ? "hard" : "Track B soft",
  ].join(" ")
}

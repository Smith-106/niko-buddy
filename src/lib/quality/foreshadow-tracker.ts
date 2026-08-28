/**
 * foreshadow-tracker.ts — v2.6.10 D2: 伏笔追踪器（登记→回收闭环）
 *
 * 蓝图 `docs/p0/blueprint-v2610-20260828.md` D2：
 *   - Foreshadow 纯数据结构（id/kind/key/loc/status/links）
 *   - key 归一化匹配（角色/道具名——确定性抽取）+ 别名词典兜底
 *   - 登记置信度≥0.7 才入册（防过度登记弱伏笔）
 *   - 回收判定：目标章出现呼应且置「已收」；超章未收触发漏收告警
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 伏笔数据结构
// ============================================================================

/** 伏笔类型（明/暗）。 */
export type ForeshadowKind = "explicit" | "implicit"

/** 伏笔状态（登记→回收闭环）。 */
export type ForeshadowStatus = "planted" | "resolved" | "orphan"

/** 伏笔记录。 */
export interface Foreshadow {
  /** 伏笔 ID（UUID）。 */
  id: string
  /** 类型（明/暗）。 */
  kind: ForeshadowKind
  /** 归一化 key（角色/道具名——确定性抽取）。 */
  key: string
  /** 埋设位置（章/句）。 */
  loc: { chapter: number; sentence: number }
  /** 状态（登记→回收闭环）。 */
  status: ForeshadowStatus
  /** 预期回收章。 */
  expectedPayoffChapter: number
  /** 登记置信度（≥0.7 才入册）。 */
  confidence: number
}

/** 登记置信度阈值（冻结——防过度登记弱伏笔）。 */
export const REGISTER_CONFIDENCE = 0.7

/** 别名词典（key 匹配兜底——防漏别名/转述误报 dangling）。 */
export const ALIAS_DICTIONARY: Record<string, string[]> = {
  阿明: ["阿明", "小明", "明哥"],
  玉簪: ["玉簪", "簪子", "那支簪"],
}

// ============================================================================
// 登记（纯函数）
// ============================================================================

/**
 * 伏笔登记（纯函数——确定性）。
 * 置信度<0.7 拒绝入册（防过度登记弱伏笔）。
 */
export function registerForeshadow(
  input: Omit<Foreshadow, "id" | "status">,
  id: string,
): { ok: boolean; foreshadow?: Foreshadow; reason?: string } {
  if (input.confidence < REGISTER_CONFIDENCE) {
    return { ok: false, reason: `置信度不足: ${input.confidence}（要求 ≥${REGISTER_CONFIDENCE}）` }
  }
  return { ok: true, foreshadow: { ...input, id, status: "planted" } }
}

// ============================================================================
// 回收判定（纯函数——key 归一化匹配 + 别名词典）
// ============================================================================

/**
 * key 归一化匹配（纯函数——确定性）。
 * 输入：文本 + key；输出：是否命中（含别名词典兜底）。
 */
export function matchForeshadowKey(text: string, key: string): boolean {
  const aliases = ALIAS_DICTIONARY[key] ?? [key]
  return aliases.some((a) => text.includes(a))
}

/**
 * 回收判定（纯函数——确定性）。
 * 输入：伏笔 + 目标章文本 + 当前章号；输出：回收结果。
 * 目标章出现呼应 → resolved；超预期章未收 → orphan（漏收告警）。
 */
export function resolveForeshadow(
  foreshadow: Foreshadow,
  payoffText: string,
  currentChapter: number,
): { status: ForeshadowStatus; alert?: string } {
  if (matchForeshadowKey(payoffText, foreshadow.key)) {
    return { status: "resolved" }
  }
  if (currentChapter > foreshadow.expectedPayoffChapter) {
    return { status: "orphan", alert: `漏收告警: 伏笔 ${foreshadow.id}（${foreshadow.key}）超预期章 ${foreshadow.expectedPayoffChapter} 未回收` }
  }
  return { status: "planted" }
}

/**
 * 回扣质量观测（纯函数——确定性）。
 * 输入：锚点摘要 + 回收章上下文；输出：回扣相关性（0-1）。
 * 语义：机械闭环≠文学闭环——回扣质量观测补语义层（锚点摘要与回收上下文的重叠度）。
 */
export function payoffQuality(anchorSummary: string, payoffContext: string): number {
  if (anchorSummary.length === 0 || payoffContext.length === 0) return 0
  // 锚点摘要关键词在回收上下文的覆盖率（简化：字符重叠率）
  const anchorChars = new Set(anchorSummary.split(""))
  const contextChars = new Set(payoffContext.split(""))
  let overlap = 0
  for (const c of anchorChars) {
    if (contextChars.has(c)) overlap++
  }
  return overlap / anchorChars.size
}

/**
 * 回扣质量二级校验（纯函数——确定性）。
 * 输入：锚点摘要 + 回收章上下文；输出：回扣质量（0-1）+ 偷懒标记。
 * 语义：一级重叠度有对称风险（逐字复述偷懒回扣得高分）——二级校验惩罚逐字复述。
 */
export function payoffQualityV2(anchorSummary: string, payoffContext: string): { quality: number; lazyCopy: boolean } {
  if (anchorSummary.length === 0 || payoffContext.length === 0) return { quality: 0, lazyCopy: false }
  // 一级：重叠度（代理量）
  const anchorChars = new Set(anchorSummary.split(""))
  const contextChars = new Set(payoffContext.split(""))
  let overlap = 0
  for (const c of anchorChars) {
    if (contextChars.has(c)) overlap++
  }
  const overlapRate = overlap / anchorChars.size
  // 二级：逐字复述检测（偷懒回扣——原文片段直接出现在回收上下文）
  const lazyCopy = payoffContext.includes(anchorSummary.slice(0, 8))
  // 偷懒回扣惩罚：质量减半（防误判高质量）
  const quality = lazyCopy ? overlapRate * 0.5 : overlapRate
  return { quality, lazyCopy }
}

/**
 * 闭环统计（纯函数——确定性）。
 * 输入：伏笔列表；输出：回收率（已回收/已登记——零悬挂）。
 */
export function closureRate(foreshadows: Foreshadow[]): { rate: number; dangling: Foreshadow[] } {
  if (foreshadows.length === 0) return { rate: 1, dangling: [] }
  const dangling = foreshadows.filter((f) => f.status !== "resolved")
  return { rate: 1 - dangling.length / foreshadows.length, dangling }
}

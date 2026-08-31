/**
 * mechanical-slop-detector.ts — A19 机械层零 LLM 中文 slop 检测器
 *
 * 借鉴点 #1 (ANL-20260715-16proj-selrev F-007): QMAI 现有 Anti-AI 全靠 LLM 语义
 * 审查 (de-ai-rules.ts 是 Markdown prompt 喂 LLM, dimension-review-adapter 是 LLM
 * 六维审查), 缺机械层正则这一整层。本模块补这一层: 融合 autonovel evaluate.py 的
 * 三级架构 (TIER1_BANNED/TIER2_SUSPICIOUS/TIER3_FILLER + slop_score 密度统计) 与
 * QMAI de-ai-rules.ts 已有中文 slop 词库, 产出零 LLM 中文机械 slop 检测。
 *
 * A19 机械层零 LLM: slopScore 纯正则+算术, 不调 streamChat/llm/invoke。门控优先级
 * '机械层先于语义层': slop 属 Anti-AI(P1), 机械检测在 LLM 六维审查前前置门控,
 * penalty 超阈值直接阻断 Anti-AI (跳过 LLM 省 token + 防 LLM 自我纵容)。
 * Consistency(P0) 不被 slop 覆盖 (一致性由 LLM consistency 维度管)。
 *
 * 参考 (只读, 不改上游):
 *   - autonovel/evaluate.py: TIER1/2/3 英文词库 + slop_score 密度统计架构
 *   - QMAI/src/lib/novel/de-ai-rules.ts: CHINESE_NOVEL_DE_AI_RULES 中文词库来源
 *   - QMAI/src/lib/novel/emotion-ledger.ts: A19 机械层正则+算术+文本化注入范式
 *
 * 中文差异: autonovel 英文词库 (delve/tapestry) 不适用中文长篇, 词库从 de-ai-rules.ts
 * 已验证中文 slop 词提取 (总结腔/解释腔/AI 特征词/模板句首/机械句式)。
 */

import {
  normalizeSourceText,
} from "./normalize-source-text"

// ============================================================================
// ABI 兼容转发: normalizeText 原语提升至 normalize-source-text.ts，历史消费方
// (shared-text-features / packs / spec) 从本模块 import normalizeText 保持可用；
// 本模块内部 slopScore 改用 normalizeSourceText (A4 检测视图)。
// ============================================================================
export { normalizeText } from "./normalize-source-text"
export type { NormalizeTextResult } from "./normalize-source-text"

// ============================================================================
// 三级中文 slop 词库 (从 de-ai-rules.ts CHINESE_NOVEL_DE_AI_RULES 提取)
// 分级对齐 autonovel: TIER1 强禁用 / TIER2 可疑 / TIER3 机械句式正则
// ============================================================================

/** TIER1_BANNED: 总结腔/解释腔/AI 特征词 — 命中即高 penalty (强禁用) */
const TIER1_BANNED = [
  // 总结腔
  "这一切", "显然", "事实上", "实际上", "毫无疑问", "无可否认",
  // 解释腔
  "其实", "说白了", "换句话说", "简单来说", "通俗点讲",
  // Stage 6 ISS-20260802-001: high-signal summary / conclusion boilerplate.
  "值得一提的是", "不难发现", "综上所述", "总而言之",
  // S1a absorb (humanizer-zh 23 条禁止模式, 未覆盖部分): AI 套话/指纹词
  "众所周知", "不可否认", "显而易见", "不言而喻", "毋庸置疑",
  "值得注意的是", "需要指出的是", "在某种程度上",
  "多维度", "深层次", "彰显", "淋漓尽致",
  "令人印象深刻", "引人注目", "至关重要",
  // AI 特征词 (过度使用即 slop, 合理语境由中低 penalty + LLM 复核兜底)
  "似乎", "仿佛", "如同", "宛如", "犹如",
  // A11 TIER1 扩容: 高频中文 AI 强信号 (结语腔/情感强化), 已核实不与现有词重叠；
  // 「不禁」已由 TIER3 正则覆盖故不重复; 避免 突然/终于 等正常叙事常用词逆向误伤
  "意味深长",
  "久久无法平静",
  "涌上心头",
  "难以忘怀",
  "刻骨铭心",
  "历历在目",
  "心潮澎湃",
  "思绪万千",
] as const

/** TIER2_SUSPICIOUS: 模板句首/空洞形容/转折滥用 — 命中计中 penalty (可疑) */
const TIER2_SUSPICIOUS = [
  // 模板句首
  "与此同时", "紧接着", "就在这时", "恰在此时", "正当此刻",
  // 空洞形容
  "复杂", "微妙", "深刻", "独特", "特殊", "某种程度",
  // Stage 6 ISS-20260802-001: business / framework boilerplate.
  "赋能", "抓手", "底层逻辑", "颗粒度",
  // 转折滥用 (每段都用即 slop)
  "然而", "但是", "不过", "可是",
  // A11 TIER2 扩容: 可疑情感/动作虚饰 (空洞限定), 已核实不与现有库重叠
  "微微一愣",
  "一丝不易察觉的",
  "莫名地",
  "若有所思地",
  "说不清缘由",
  "无端地",
  "隐约觉得",
  "怔怔地",
] as const

/**
 * TIER3_FILLER: 机械句式正则 (prose cliché)。
 * 基线来自 de-ai-rules；Quality Foundation v1 / E6 追加 **有界** 高价值中文 AI 腔子集
 * （灵感参考 avoid-ai-writing 类检测思路，非整仓 corpus 迁移；仅 10–20 条）。
 */
const TIER3_FILLER: readonly RegExp[] = [
  /目光交汇的瞬间/,
  /空气仿佛凝固/,
  /心中五味杂陈/,
  /眼神变得坚定/,
  /时间一分一秒过去/,
  /双方陷入僵持/,
  /既[^，。]{1,8}又[^，。]{1,8}/, // 机械排比 既...又...
  /不仅[^，。]{1,8}还[^，。]{1,8}/, // 机械排比 不仅...还...
  // --- QF-v1 E6 bounded extension (generic Chinese AI mannerisms) ---
  /不禁(?:陷入了?|感到|觉得)/,
  /心中暗道/,
  /嘴角(?:勾起|扬起)一丝/,
  /深吸一口气/,
  /眉头[微紧]?[锁皱]/,
  /一抹[^，。]{0,6}闪过/,
  /无法言说的/,
  /说不清道不明/,
  /像是在[说告]诉/,
  /空气中弥漫着/,
  /时间仿佛静止/,
  /不由自主地/,
  // Stage 6 ISS-20260802-001: density-marked boilerplate terms.
  /确保/,
  /至关重要/,
  /全方位/,
  // --- TASK-P2-19 (T19): TIER3_EXTENDED — 中文 AI 机械腔批量扩展 (synthetic-degraded 语料驱动) ---
  // 心理描写模板 (AI 腔常见: 过度概括式情绪)
  /心中充满了/,
  /心中[^，。]{0,8}充满/,
  /感到[^，。]{0,6}意外/,
  /感到[^。]{0,12}不安/,
  /充满了疑惑/,  // 焦虑/疑惑/恐惧等概括
  /充满了[^，。]{2,6}和[^，。]{2,6}/,  // 充满了 X 和 Y 并列情绪
  /无法[^，。]{0,8}改变/,
  /不知道该如何[^，。]{0,8}/,  // 不知道如何面对/选择/回答
  /只能默默[^，。]{0,8}/,
  /暗暗[^，。]{0,8}决定/,
  // 叙事模板句 (AI 转场/开场套路)
  /从此[^，。]{0,12}发生了/,
  /等待[^，。]{0,6}的将是一场/,  // 等待她的将是一场…
  /命运的齿轮/,  // 经典 AI 命运腔
  /一切只是开始/,
  /一切才刚刚开始/,
  /时间仿佛[^，。]{0,6}停止/,  // 同义变体 (时间仿佛静止/停止)
  /目光在空气中相遇/,
  /努力保持镇定/,
  /她只能默默祈祷/,
  /[^，。]{0,6}心跳加速/,
  // 商战/职场 AI 腔 (过度抽象叙事)
  /[^。]{0,10}的战略意义/,  // 过度抽象名词化
  /[^。]{0,10}的深远影响/,
  /[^。]{0,10}提供了新的[^。]{0,6}/,
  /在[^，。]{3,8}的背景下/,  // 在...的背景下
  /[^。]{0,8}翻天地覆/,  // 翻天覆地的变化 等
  /无法避免的冲突/,
  /[^。]{0,8}的碰撞/,  // 文化/理念/价值观的碰撞
  // 对白/交互 AI 腔
  /[「"]好了[」"]?[^。]{0,6}说/,  // 好了，他说…
  /[「"]没事[」"]?[^。]{0,6}说/,  // 没事，她说…
  /[「"]就这样[」"]?[^。]{0,6}说/,  // 就这样，他说…
  /[「"]好久不见[」"]/,  // 经典 AI 重逢对白
  /[「"]你还好吗[」"]/,
  /[「"]我会一直[」"]/,  // 我会一直…
  /[「"]我回来了[」"]/,  // 我回来了 (AI 重聚标配)
  // --- A11 TIER3 扩容: 高频中文 AI 腔句式 (心理/动作模板, 与现有正则不重叠) ---
  /呐呐自语/,
  /眼底深处闪过/,
  /压在心头的/,
  /出来时已成/,
  /暗中计划/,
  /不禁陷入(?:深思|回忆)/,
  /内心深处涌起的/,
  /刚想开口/,
]

/** Exported for tests — count of extended TIER3 patterns (non-baseline). */
export const TIER3_EXTENDED_PATTERN_COUNT = 56

// ============================================================================
// A3 质检公平性窗口：slop 公式常量区（集中一处，便于校准与回退）
// ============================================================================

/**
 * 公式开关: RAW_COUNT_FALLBACK = true → 回退旧裸计数制 (tier*n weight 直接求和)；
 * false (默认) → 新 density 制：severity = Σ max(0, density_i - target_i) * weight_i
 *   + Σ_sameTypeBurst * SLOP_CLUSTER_PENALTY。一键回退便于 A/B 比对与发版降级。
 */
export const RAW_COUNT_FALLBACK = false

/** slop 惩罚上限 (0-10)。 */
export const SLOP_PENALTY_MAX = 10
/** classifySlop 阈值（DD-3）——【待校准】暂维持 8/5，需真实语料校准后收敛。 */
export const SLOP_CLASSIFY_BLOCK_THRESHOLD = 8
/** classifySlop 阈值（DD-3）——【待校准】。 */
export const SLOP_CLASSIFY_WARN_THRESHOLD = 5

/** 裸计数旧公式权重 (RAW_COUNT_FALLBACK 时用)。 */
export const RAW_COUNT_WEIGHTS = { tier1: 1.5, tier2: 0.8, tier3: 1.0 } as const

/** 词数口径: Chinese 无词界，以非空白字符近似词数（density = hits / words * 1000）。 */
export const SLOP_DENSITY_PER = 1000
/** 各 tier 每千字可容忍命中密度（低于容忍线不计 severity = 不误伤）。 */
export const SLOP_DENSITY_TARGETS = {
  tier1: 1.0,
  tier2: 2.0,
  tier3: 3.0,
} as const
/** 各 tier 超出容忍线的边际权重。 */
export const SLOP_DENSITY_WEIGHTS = {
  tier1: 3.0,
  tier2: 1.5,
  tier3: 1.0,
} as const
/** 同类型短窗连击单体罚分。 */
export const SLOP_CLUSTER_PENALTY = 1.5
/** 同类型连击判定窗口（字符）。 */
export const SLOP_CLUSTER_WINDOW_CHARS = 200
/** 同类型连击最小爆发次数：窗口内 >= 3 次同类型命中算一次连击。 */
export const SLOP_CLUSTER_MIN_BURST = 3

/** 段落开头转折词比阈值（结构罚，与 density 无关，保留）。 */
const TRANSITION_OPENER_THRESHOLD = 0.4
/**
 * 句长变异系数阈值 (低于此 → 句式机械 → +2 惩罚)。
 * 中文短句为主 CV 天然偏低 (autonovel 英文按词数分句 CV 分布更高, 阈值 0.3 对英文
 * 合理但对中文过严 — 正常中文叙事 CV 常在 0.2~0.3)。中文版调到 0.1: 只有句长
 * 极度一致 (几乎全同长) 才罚。另加 SENTENCE_MIN_FOR_CV_PENALTY 句数 guard,
 * 避免短文本 (2-3 句) 偶然 CV 低被误罚。
 */
const SENTENCE_CV_LOW_THRESHOLD = 0.1
const SENTENCE_MIN_FOR_CV_PENALTY = 5
/** 结构罚常量（CV 过齐 / 转折开头过多）。 */
const STRUCTURAL_PENALTY_CV = 2
const STRUCTURAL_PENALTY_TRANSITION = 2

/** 段落开头转折词集合 (用于 transitionOpenerRatio 统计) */
const PARAGRAPH_TRANSITION_OPENERS = [
  "然而", "但是", "不过", "可是", "与此同时", "紧接着", "此外", "因此",
] as const
// ============================================================================
// slopScore: 机械算术 (零 LLM)
// ============================================================================

export interface SlopHit {
  kw: string
  count: number
}

export interface SlopReport {
  tier1Hits: SlopHit[]
  tier2Hits: SlopHit[]
  tier3Hits: SlopHit[]
  /** 句长变异系数 (CV): 越低越机械 (全短句/全长句), 高 CV = 句长多样 = 更人写 */
  sentenceLengthCV: number
  /** 段落开头转折词占比: 越高越模板化 */
  transitionOpenerRatio: number
  /** 综合 slop 惩罚分 0-10 (0=clean, 10=pure slop) */
  slopPenalty: number
  /** S1a: 防绕过预处理计数 (零宽+同形字) — humanizer 旁路痕迹, 0=无旁路 */
  bypassCount?: number
  /** S1a: 被剥离的零宽字符数 */
  zeroWidthCount?: number
  /** S1a: 被还原的同形字字符数 */
  homoglyphCount?: number
}

/** 统计某词在文本中的出现次数 (indexOf 遍历, 中文无词界) */
function countOccurrences(haystack: string, needle: string): number {
  /* v8 ignore next */
  if (!needle) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

/** 统计某词在文本中的所有出现位置（字符索引，供同型短窗连击聚类）。 */
function occurrencePositions(haystack: string, needle: string): number[] {
  if (!needle) return []
  const positions: number[] = []
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    positions.push(idx)
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return positions
}

/** 统计某正则命中的所有位置（matchAll/bepush 的 index）。 */
function regexOccurrencePositions(text: string, pattern: RegExp): number[] {
  const positions: number[] = []
  const re = new RegExp(pattern.source, "g")
  let m: RegExpExecArray | null
  let guard = 0
  while ((m = re.exec(text)) !== null && guard++ < 1000) {
    positions.push(m.index)
    if (m.index === re.lastIndex) re.lastIndex++
  }
  return positions
}

/** 收集某 tier（词库 + 可选正则）全部匹配位置。 */
function collectTierPositions(
  text: string,
  lexicon: readonly string[],
  patterns: readonly RegExp[],
): number[] {
  const positions: number[] = []
  for (const kw of lexicon) positions.push(...occurrencePositions(text, kw))
  for (const re of patterns) positions.push(...regexOccurrencePositions(text, re))
  return positions.sort((a, b) => a - b)
}

/**
 * 同类型短窗连击计数: 同一窗口 (SLOP_CLUSTER_WINDOW_CHARS) 内 >= SLOP_CLUSTER_MIN_BURST
 * 次同类型命中计 1 次连击。滑窗贪心: 以每个起点向后取窗口内最大连续同型命中段。
 */
function countSameTypeBursts(positions: number[]): number {
  if (positions.length < SLOP_CLUSTER_MIN_BURST) return 0
  let bursts = 0
  let i = 0
  while (i < positions.length) {
    let j = i + 1
    while (
      j < positions.length &&
      positions[j] - positions[i] <= SLOP_CLUSTER_WINDOW_CHARS
    ) {
      j++
    }
    const run = j - i
    if (run >= SLOP_CLUSTER_MIN_BURST) {
      bursts++
      i += run
    } else {
      i++
    }
  }
  return bursts
}

/** 收集 tier 命中 (词库版) */
function collectTierHits(text: string, lexicon: readonly string[]): SlopHit[] {
  const hits: SlopHit[] = []
  for (const kw of lexicon) {
    const count = countOccurrences(text, kw)
    if (count > 0) hits.push({ kw, count })
  }
  return hits
}

/** 收集 tier 命中 (正则版, TIER3) */
function collectTierRegexHits(text: string, patterns: readonly RegExp[]): SlopHit[] {
  const hits: SlopHit[] = []
  for (const re of patterns) {
    const matches = text.match(new RegExp(re.source, "g"))
    if (matches && matches.length > 0) {
      hits.push({ kw: re.source, count: matches.length })
    }
  }
  return hits
}

/** 按句号/问号/叹号分句, 返回每句长度数组 (字符数) */
function splitSentences(text: string): number[] {
  if (!text || text.trim().length === 0) return []
  // 中文句末标点 + 英文句号
  const sentences = text.split(/[。！？.?!]/).map((s) => s.trim()).filter((s) => s.length > 0)
  return sentences.map((s) => s.length)
}

/** 计算句长变异系数 CV = stddev / mean (越低越机械) */
function coefficientOfVariation(lengths: number[]): number {
  if (lengths.length === 0) return 0
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length
  /* v8 ignore next */
  if (mean === 0) return 0
  const variance = lengths.reduce((sum, l) => sum + (l - mean) ** 2, 0) / lengths.length
  const stddev = Math.sqrt(variance)
  /* v8 ignore next */
  return mean > 0 ? stddev / mean : 0
}

/** 统计段落开头转折词占比 */
function transitionOpenerRatio(text: string): number {
  if (!text || text.trim().length === 0) return 0
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0)
  /* v8 ignore next */
  if (paragraphs.length === 0) return 0
  let openerCount = 0
  for (const p of paragraphs) {
    if (PARAGRAPH_TRANSITION_OPENERS.some((op) => p.startsWith(op))) openerCount++
  }
  return openerCount / paragraphs.length
}

/**
 * 机械 slop 检测 (零 LLM 纯算术)。
 * 入口走 normalizeSourceText (NFKC + 零宽 + soft-hyphen) 得归一化文本, 再统计 ——
 * A4 检测视图: 只读归一化副本, 不写存储字节。
 *
 * A3 默认 density 制（质检公平性窗口）:
 *   density_i  = tierCount_i / words * SLOP_DENSITY_PER    (每千字命中密度)
 *   severity   = Σ_tier max(0, density_i - target_i) * weight_i
 *              + Σ_sameTypeBurst * SLOP_CLUSTER_PENALTY
 *              + structural (CV 过齐 / 转折开头过多)
 *   slopPenalty = clamp(severity, 0, 10)
 *
 * RAW_COUNT_FALLBACK = true 时回退旧裸计数制。
 */
export function slopScore(rawText: string): SlopReport {
  const { text, zeroWidthCount, homoglyphCount } = normalizeSourceText(rawText)
  const bypassCount = zeroWidthCount + homoglyphCount
  const tier1Hits = collectTierHits(text, TIER1_BANNED)
  const tier2Hits = collectTierHits(text, TIER2_SUSPICIOUS)
  const tier3Hits = collectTierRegexHits(text, TIER3_FILLER)

  const tier1Count = tier1Hits.reduce((s, h) => s + h.count, 0)
  const tier2Count = tier2Hits.reduce((s, h) => s + h.count, 0)
  const tier3Count = tier3Hits.reduce((s, h) => s + h.count, 0)

  const sentenceLengths = splitSentences(text)
  const sentenceLengthCV = coefficientOfVariation(sentenceLengths)
  const transRatio = transitionOpenerRatio(text)

let penalty: number
  if (RAW_COUNT_FALLBACK) {
    // 旧裸计数制 (A/B 比对 / 发版降级)。
    penalty =
      tier1Count * RAW_COUNT_WEIGHTS.tier1 +
      tier2Count * RAW_COUNT_WEIGHTS.tier2 +
      tier3Count * RAW_COUNT_WEIGHTS.tier3
  } else {
    // A3 density 制 (篇幅归一)。
    const words = Math.max(1, text.replace(/\s+/g, '').length)
    const density1 = (tier1Count / words) * SLOP_DENSITY_PER
    const density2 = (tier2Count / words) * SLOP_DENSITY_PER
    const density3 = (tier3Count / words) * SLOP_DENSITY_PER

    const severity =
      Math.max(0, density1 - SLOP_DENSITY_TARGETS.tier1) * SLOP_DENSITY_WEIGHTS.tier1 +
      Math.max(0, density2 - SLOP_DENSITY_TARGETS.tier2) * SLOP_DENSITY_WEIGHTS.tier2 +
      Math.max(0, density3 - SLOP_DENSITY_TARGETS.tier3) * SLOP_DENSITY_WEIGHTS.tier3

    // 同类型连击 (同 tier 短窗集中命中)。
    const tier1Bursts = countSameTypeBursts(collectTierPositions(text, TIER1_BANNED, []))
    const tier2Bursts = countSameTypeBursts(collectTierPositions(text, TIER2_SUSPICIOUS, []))
    const tier3Bursts = countSameTypeBursts(collectTierPositions(text, [], TIER3_FILLER))

    penalty = severity + (tier1Bursts + tier2Bursts + tier3Bursts) * SLOP_CLUSTER_PENALTY
  }

  // 结构罚 (与篇幅无关，保留): CV 过齐 / 转折开头过多。
  if (
    sentenceLengths.length >= SENTENCE_MIN_FOR_CV_PENALTY &&
    sentenceLengthCV < SENTENCE_CV_LOW_THRESHOLD
  ) {
    penalty += STRUCTURAL_PENALTY_CV
  }
  if (transRatio > TRANSITION_OPENER_THRESHOLD) {
    penalty += STRUCTURAL_PENALTY_TRANSITION
  }
  if (penalty > SLOP_PENALTY_MAX) penalty = SLOP_PENALTY_MAX
  /* v8 ignore next */
  if (penalty < 0) penalty = 0

  return {
    tier1Hits,
    tier2Hits,
    tier3Hits,
    sentenceLengthCV,
    transitionOpenerRatio: transRatio,
    slopPenalty: penalty,
    bypassCount,
    zeroWidthCount,
    homoglyphCount,
  }
}

/**
 * slop 分级判定 (DD-3): >=8 阻断 Anti-AI / 5-8 warning 注入 / <5 不注入。
 * 返回 verdict: 'block' | 'warn' | 'clean', 供 dimension-review-adapter 前置门控。
 */
export function classifySlop(report: SlopReport): "block" | "warn" | "clean" {
  if (report.slopPenalty >= 8) return "block"
  if (report.slopPenalty >= 5) return "warn"
  return "clean"
}

/**
 * 文本化 slop 报告供 LLM 参考 (与 emotionLedgerToContextText 同款 bullet 模式)。
 * A19 零 LLM: slop 由机械算术判定, LLM 只读本报告作审查参考不参与计算。
 * 空 report (无任何命中) 返回 ""。
 */
export function slopReportToText(report: SlopReport): string {
  const hasHits =
    report.tier1Hits.length > 0 ||
    report.tier2Hits.length > 0 ||
    report.tier3Hits.length > 0
  if (!hasHits && report.slopPenalty < 5) return ""

  const lines: string[] = []
  lines.push(`机械 slop 检测 (penalty ${report.slopPenalty.toFixed(1)}/10)`)
  if (report.bypassCount && report.bypassCount > 0) {
    lines.push(`- 防绕过痕迹: ${report.bypassCount} 个零宽/同形字字符已被归一 (humanizer 旁路信号)`)
  }
  if (report.tier1Hits.length > 0) {
    lines.push(`- 强禁用词: ${report.tier1Hits.map((h) => `${h.kw}×${h.count}`).join("、")}`)
  }
  if (report.tier2Hits.length > 0) {
    lines.push(`- 可疑词: ${report.tier2Hits.map((h) => `${h.kw}×${h.count}`).join("、")}`)
  }
  if (report.tier3Hits.length > 0) {
    lines.push(`- 机械句式: ${report.tier3Hits.map((h) => `${h.kw}×${h.count}`).join("、")}`)
  }
  if (report.sentenceLengthCV < SENTENCE_CV_LOW_THRESHOLD) {
    lines.push(`- 句长过于一致 (CV ${report.sentenceLengthCV.toFixed(2)})`)
  }
  if (report.transitionOpenerRatio > TRANSITION_OPENER_THRESHOLD) {
    lines.push(`- 段落转折词开头过多 (${(report.transitionOpenerRatio * 100).toFixed(0)}%)`)
  }
  return lines.join("\n")
}

// ============================================================================
// P0: Structural Pattern Detector (角色-动作绑定 + 重复模式统计)
// ============================================================================

/** 角色名单 (用于角色-动作关联分析) */
const CHARACTER_NAMES = [
  "白砚", "王迦", "陈烬", "李昭然", "苏未晞", "陆织锦", "周棠", "白鹭",
  "01 号", "02 号", "03 号", "04 号", "05 号", "06 号", "07 号", "08 号",
] as const

/** 角色行为模式定义 */
const CHARACTER_ACTION_PATTERNS = [
  { action: "推眼镜", regex: /推了推眼镜|推眼镜|扶了扶镜架|扶镜架/g, type: "mannerism" as const, suggest: "建议 ≤3 次/角色，用其他微动作替代" },
  { action: "嘴角上扬", regex: /嘴角上扬|嘴角带着一丝微笑|嘴角微微上扬/g, type: "expression" as const, suggest: "建议 ≤2 次/角色，用其他表情替代" },
  { action: "转动戒指", regex: /戒指[在指间缓缓转]*转动|戒指在指间/g, type: "mannerism" as const, suggest: "白砚标志性动作，全章 ≤3 次" },
  { action: "抠指甲", regex: /抠指甲/g, type: "mannerism" as const, suggest: "苏未晞标志性动作，全章 ≤3 次" },
  { action: "低下头", regex: /低下头|低头/g, type: "reaction" as const, suggest: "建议 ≤3 次，用其他反应替代" },
  { action: "后退", regex: /后退了一步|后退/g, type: "reaction" as const, suggest: "王迦后退仅保留 1 次最有冲击力的" },
  { action: "波形图", regex: /波形图/g, type: "imagery" as const, suggest: "建议全章 ≤4 次" },
  { action: "安静了", regex: /安静了/g, type: "mood" as const, suggest: "建议全章 ≤5 次" },
  { action: "沉默了", regex: /沉默了|沉默/g, type: "mood" as const, suggest: "建议全章 ≤3 次" },
  // QF-v1 E6: generic mannerisms (not project-specific)
  { action: "深吸一口气", regex: /深吸一口气|深吸了口气/g, type: "mannerism" as const, suggest: "通用 AI 腔动作，全章建议 ≤2 次" },
  { action: "握紧拳头", regex: /握紧拳头|攥紧拳头/g, type: "mannerism" as const, suggest: "建议 ≤2 次，换具体肢体细节" },
  { action: "咬紧牙关", regex: /咬紧牙关|咬了咬牙/g, type: "mannerism" as const, suggest: "建议 ≤2 次" },
] as const

/** 单个角色-动作检测结果 */
export interface CharacterActionHit {
  action: string
  type: "mannerism" | "expression" | "reaction" | "imagery" | "mood"
  totalCount: number
  suggest: string
  perCharacter: Record<string, number>
}

/**
 * 检测角色-动作关联：在文本中找到动作，并判断由哪个角色执行。
 * 零 LLM，纯正则 + 上下文窗口匹配。
 */
export function detectCharacterActions(rawText: string): CharacterActionHit[] {
  // A4 检测视图统一归一: 走 normalizeSourceText (NFKC + 零宽 + soft-hyphen + 同形字还原),
  // 与模块内 slopScore 同一归一口径; 返回的归一副本仅用于匹配, 不回写正文存储。
  const { text } = normalizeSourceText(rawText)
  const results: CharacterActionHit[] = []

  for (const pattern of CHARACTER_ACTION_PATTERNS) {
    const matches = [...text.matchAll(pattern.regex)]
    if (matches.length === 0) continue

    const charCounts: Record<string, number> = {}

    for (const match of matches) {
      const actionPos = match.index
      const contextStart = Math.max(0, actionPos - 80)
      const contextEnd = Math.min(text.length, actionPos + 80)
      const context = text.slice(contextStart, contextEnd)

      let nearestChar = "未知"
      let nearestDist = Infinity
      for (const char of CHARACTER_NAMES) {
        const charIdx = context.indexOf(char)
        if (charIdx !== -1) {
          const dist = Math.abs(charIdx - 80)
          if (dist < nearestDist) {
            nearestDist = dist
            nearestChar = char
          }
        }
      }

      charCounts[nearestChar] = (charCounts[nearestChar] || 0) + 1
    }

    results.push({
      action: pattern.action,
      type: pattern.type,
      totalCount: matches.length,
      suggest: pattern.suggest,
      perCharacter: charCounts,
    })
  }

  return results
}

/**
 * 文本化行为模式报告 (与 slopReportToText 同款 bullet 模式)。
 * 空结果返回空字符串。
 */
export function characterActionsToText(hits: CharacterActionHit[]): string {
  if (hits.length === 0) return ""

  const lines: string[] = []
  lines.push("角色行为模式检测:")

  for (const hit of hits) {
    if (hit.totalCount < 2) continue
    const warn = hit.totalCount >= 3 ? "⚠️" : "ℹ️"
    lines.push(`- ${warn} "${hit.action}" 共 ${hit.totalCount} 次 (${hit.suggest})`)

    // 按角色展示
    const charEntries = Object.entries(hit.perCharacter).sort((a, b) => b[1] - a[1])
    for (const [char, count] of charEntries) {
      if (count < 2) continue
      lines.push(`  - ${char}: ${count} 次`)
    }
  }

  return lines.join("\n")
}

// ============================================================================
// P0-1: Humanizer Cavity Guard — 反「改写器腔」检测 (2026 前沿共识)
//
// aigc.md / untell 双向启示: humanizer 越追指标越收敛成「humanizer 腔」—
// 句长异常齐整、假口语堆砌 (呃/嗯/那个 密度异常)、填充词泛滥、标点密度
// 从过低跳到过高。深度分类器 (Pangram4 humanizer 头 / EditLens) 直接抓此信号。
//
// 本 guard 为 A19 机械层 (零 LLM), 输出 overCorrection 报告:
//   - 句长 CV 过高 (改写器常制造超不均匀分布) 或过低 (过度齐整)
//   - 假口语密度 (呃/嗯/那个/emm 等填充) — 超过阈值 = 假口语腔
//   - 自然度 delta: 与 de-ai-intensity 的 cavitySkipUpper 联动 (>=0.7 跳过改写)
// ============================================================================

/** 假口语填充词 (humanizer 过度注入信号) */
const CAVITY_FILLER_WORDS = [
  "呃", "嗯", "那个", "emm", "emmm", "额", "唔", "嘛", "啊这个",
] as const

/** 过度齐整阈值: CV 低于此 = 机械齐整; 高于此 = 人为造不规则 (改写器腔) */
export const CAVITY_CV_LOW = 0.08
/** 过度不规则阈值: 正常中文叙事 CV 峰值 ~0.5, 改写器腔常 >0.75 */
export const CAVITY_CV_HIGH = 0.75
/** 假口语密度阈值: 每千字填充词 > 此值 = 假口语腔 */
export const CAVITY_FILLER_PER_1000 = 3.0
/** 假口语连击窗口内最少个数 (与 SLOP_CLUSTER 同思路) */
export const CAVITY_BURST_MIN = 3

/** overCorrection 报告 */
export interface OverCorrectionReport {
  sentenceLengthCV: number
  fillerDensityPer1000: number
  fillerCount: number
  /** 0-1 改写痕迹得分: 齐整/过不规则/假口语 加权 */
  humanizerCavityScore: number
  /** 触发原因列表 (空 = 无改写痕迹) */
  flags: string[]
}

/**
 * 反改写器腔检测 (零 LLM)。
 * 输入 slopScore 已算出的 CV 可复用 (text 归一化在 slopScore 内完成,
 * 本函数独立归一化以保证可独立调用)。
 */
export function overCorrectionReport(rawText: string): OverCorrectionReport {
  const { text } = normalizeSourceText(rawText)
  const flags: string[] = []

  const sentenceLengths = splitSentences(text)
  const cv = coefficientOfVariation(sentenceLengths)

  // 假口语密度
  const words = Math.max(1, text.replace(/\s+/g, "").length)
  let fillerCount = 0
  for (const w of CAVITY_FILLER_WORDS) fillerCount += countOccurrences(text, w)
  const fillerDensity = (fillerCount / words) * 1000

  if (sentenceLengths.length >= SENTENCE_MIN_FOR_CV_PENALTY && cv < CAVITY_CV_LOW) {
    flags.push(`句长过度齐整 (CV ${cv.toFixed(2)}) — 机械模板嫌疑`)
  }
  if (sentenceLengths.length >= SENTENCE_MIN_FOR_CV_PENALTY && cv > CAVITY_CV_HIGH) {
    flags.push(`句长过度不规则 (CV ${cv.toFixed(2)}) — 人为造差异的改写器腔嫌疑`)
  }
  if (fillerDensity > CAVITY_FILLER_PER_1000) {
    flags.push(`假口语填充词密度异常 (${fillerDensity.toFixed(1)}/千字) — humanizer 腔嫌疑`)
  }
  // 假口语连击: 同句内 >=3 个填充词
  const burstRe = new RegExp(
    `[^。！？.?!]{1,80}(?:${CAVITY_FILLER_WORDS.join("|")})[^。！？.?!]{1,80}`,
    "g",
  )
  const burstMatches = text.match(burstRe)
  if (burstMatches && burstMatches.some((m) => {
    let n = 0
    for (const w of CAVITY_FILLER_WORDS) {
      n += m.split(w).length - 1
    }
    return n >= CAVITY_BURST_MIN
  })) {
    flags.push("同句假口语连击 (单句 ≥3 填充词) — 假口语腔")
  }

  // 0-1 得分: 各 flag 贡献 0.3~0.4
  let score = 0
  if (flags.length > 0) {
    const cvFlag = flags.some((f) => f.includes("齐整") || f.includes("不规则"))
    const fillerFlag = flags.some((f) => f.includes("填充词") || f.includes("连击"))
    if (cvFlag) score += 0.4
    if (fillerFlag) score += 0.3
    if (flags.length >= 2) score += 0.2
  }

  return {
    sentenceLengthCV: cv,
    fillerDensityPer1000: fillerDensity,
    fillerCount,
    humanizerCavityScore: Math.min(1, score),
    flags,
  }
}

/** 文本化 overCorrection 报告 (供 LLM prompt / 审计)。空 flags 返回 ""。 */
export function overCorrectionToText(report: OverCorrectionReport): string {
  if (report.flags.length === 0) return ""
  const lines: string[] = ["改写痕迹检测 (humanizer 腔):"]
  for (const f of report.flags) lines.push(`- ⚠️ ${f}`)
  lines.push(`- 综合改写痕迹分 ${report.humanizerCavityScore.toFixed(2)} (>=0.7 建议跳过改写)` )
  return lines.join("\n")
}

// ============================================================================
// P1-5: 规则补漏 — 2026 检测侧强信号模式 (humanizer 参考 patterns 吸收)
//
// 从 reference/humanizer (Wikipedia Signs of AI writing 35 patterns) 提取
// 中文网文适用模式, 以正则为机械层信号 (LLM 语义层已由 de-ai-rules 覆盖):
//   - 夸大腔 (inflated claims): 里程碑/革命性/史无前例 等绝对化
//   - 格言腔 (aphorism): "XX 才是 Y" / "从来如此" / 总结式格言
//   - 二选一/二元对立 (binary): "要么 A 要么 B" / "非此即彼"
//   - 三连排比 (triad): "A、B、C" 机械三连
//   - 稻草人/反驳腔 (objection): "有人说…" 自设靶子
// ============================================================================

/** TIER3 补漏正则 (新增强信号) — 独立导出, 不影响既有 TIER3_FILLER
 * 注意: normalizeSourceText NFKC 会把全角逗号「，」转半角「,」, 字符类须双写兼容。 */
export const TIER3_CAVITY_PATTERNS: readonly RegExp[] = [
  // 夸大腔
  /(?:史无前例|前所未有|划时代|里程碑|革命性|开创性|颠覆性|独一无二|绝无仅有)/,
  // 格言腔 (NFKC 后逗号可变半角, 只排除句末标点)
  /[^。.]{2,12}(?:才是|不过是|终究是|不外乎)[^。.]{2,12}/,
  // 二选一
  /要么[^，。,.]{1,10}要么/,
  /(?:非此即彼|非A即B|不是[^，。,.]{1,8}就是[^，。,.]{1,8})/,
  // 三连排比 (顿号三连 + 名动结构)
  /[^，。,.]{1,6}、[^，。,.]{1,6}、[^，。,.]{1,6}(?:[，,]|[。.])/,
  // 稻草人
  /(?:有人说|有人会说|总有人说|有人认为)(?:[，,]|[。.])/,
  // 反驳腔 (自问自答)
  /(?:难道|岂不|何尝)[^，。,.]{1,12}(?:吗|呢|[？?])/,
  // 抽象总结 (AI 概括癖)
  /(?:归根结底|说到底|说白了|说到底)(?:[，,]|[。.])/,
]

/** 补漏检测: 在 slopScore 基础上叠加新信号, 返回追加的 penalty (0-10 内) */
export function cavityPatternPenalty(rawText: string): { penalty: number; hits: SlopHit[] } {
  const { text } = normalizeSourceText(rawText)
  const hits = collectTierRegexHits(text, TIER3_CAVITY_PATTERNS)
  const count = hits.reduce((s, h) => s + h.count, 0)
  const words = Math.max(1, text.replace(/\s+/g, "").length)
  const density = (count / words) * SLOP_DENSITY_PER
  // 0.5/千字容忍, 超出每千字 +1.0 (上限 4)
  const penalty = Math.min(4, Math.max(0, density - 0.5))
  return { penalty, hits }
}

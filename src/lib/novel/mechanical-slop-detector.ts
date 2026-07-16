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
  // AI 特征词 (过度使用即 slop, 合理语境由中低 penalty + LLM 复核兜底)
  "似乎", "仿佛", "如同", "宛如", "犹如",
] as const

/** TIER2_SUSPICIOUS: 模板句首/空洞形容/转折滥用 — 命中计中 penalty (可疑) */
const TIER2_SUSPICIOUS = [
  // 模板句首
  "与此同时", "紧接着", "就在这时", "恰在此时", "正当此刻",
  // 空洞形容
  "复杂", "微妙", "深刻", "独特", "特殊", "某种程度",
  // 转折滥用 (每段都用即 slop)
  "然而", "但是", "不过", "可是",
] as const

/** TIER3_FILLER: 机械句式正则 (prose cliché) — de-ai-rules.ts 已列的机械句式转正则 */
const TIER3_FILLER: readonly RegExp[] = [
  /目光交汇的瞬间/,
  /空气仿佛凝固/,
  /心中五味杂陈/,
  /眼神变得坚定/,
  /时间一分一秒过去/,
  /双方陷入僵持/,
  /既[^，。]{1,8}又[^，。]{1,8}/, // 机械排比 既...又...
  /不仅[^，。]{1,8}还[^，。]{1,8}/, // 机械排比 不仅...还...
]

// ============================================================================
// slopScore: 机械算术 (零 LLM)
// ============================================================================

/** 段落转折词开头比阈值 (超此 → +2 密度惩罚) */
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
const SLOP_PENALTY_MAX = 10

/** 段落开头转折词集合 (用于 transitionOpenerRatio 统计) */
const PARAGRAPH_TRANSITION_OPENERS = [
  "然而", "但是", "不过", "可是", "与此同时", "紧接着", "此外", "因此",
] as const

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
}

/** 统计某词在文本中的出现次数 (indexOf 遍历, 中文无词界) */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
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
  if (mean === 0) return 0
  const variance = lengths.reduce((sum, l) => sum + (l - mean) ** 2, 0) / lengths.length
  const stddev = Math.sqrt(variance)
  return mean > 0 ? stddev / mean : 0
}

/** 统计段落开头转折词占比 */
function transitionOpenerRatio(text: string): number {
  if (!text || text.trim().length === 0) return 0
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0)
  if (paragraphs.length === 0) return 0
  let openerCount = 0
  for (const p of paragraphs) {
    if (PARAGRAPH_TRANSITION_OPENERS.some((op) => p.startsWith(op))) openerCount++
  }
  return openerCount / paragraphs.length
}

/**
 * 机械 slop 检测 (零 LLM 纯算术)。
 * penalty = tier1命中次数*1.5 + tier2*0.8 + tier3*1.0 + 密度惩罚
 *   (sentenceLengthCV < 0.3 → +2, transitionOpenerRatio > 0.4 → +2),
 * clamp 0-10。
 */
export function slopScore(text: string): SlopReport {
  const tier1Hits = collectTierHits(text, TIER1_BANNED)
  const tier2Hits = collectTierHits(text, TIER2_SUSPICIOUS)
  const tier3Hits = collectTierRegexHits(text, TIER3_FILLER)

  const tier1Count = tier1Hits.reduce((s, h) => s + h.count, 0)
  const tier2Count = tier2Hits.reduce((s, h) => s + h.count, 0)
  const tier3Count = tier3Hits.reduce((s, h) => s + h.count, 0)

  const sentenceLengths = splitSentences(text)
  const sentenceLengthCV = coefficientOfVariation(sentenceLengths)
  const transRatio = transitionOpenerRatio(text)

  let penalty =
    tier1Count * 1.5 + tier2Count * 0.8 + tier3Count * 1.0
  // CV 密度惩罚: 句长极度一致 (CV<0.1) 且句数够多 (>=5) 才罚 — 中文短句 CV 天然低,
  // 短文本偶然 CV 低不罚 (避免误伤正常叙事)。
  if (
    sentenceLengths.length >= SENTENCE_MIN_FOR_CV_PENALTY &&
    sentenceLengthCV < SENTENCE_CV_LOW_THRESHOLD
  ) {
    penalty += 2
  }
  if (transRatio > TRANSITION_OPENER_THRESHOLD) {
    penalty += 2
  }

  if (penalty > SLOP_PENALTY_MAX) penalty = SLOP_PENALTY_MAX
  if (penalty < 0) penalty = 0

  return {
    tier1Hits,
    tier2Hits,
    tier3Hits,
    sentenceLengthCV,
    transitionOpenerRatio: transRatio,
    slopPenalty: penalty,
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

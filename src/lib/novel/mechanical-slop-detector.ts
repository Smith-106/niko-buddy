/**
 * mechanical-slop-detector.ts — A19 机械层零 LLM 中文 slop 检测器
 *
 * 借鉴点 #1 (ANL-20260715-16proj-selrev F-007): Niko Buddy 现有 Anti-AI 全靠 LLM 语义
 * 审查 (de-ai-rules.ts 是 Markdown prompt 喂 LLM, dimension-review-adapter 是 LLM
 * 六维审查), 缺机械层正则这一整层。本模块补这一层: 融合 autonovel evaluate.py 的
 * 三级架构 (TIER1_BANNED/TIER2_SUSPICIOUS/TIER3_FILLER + slop_score 密度统计) 与
 * Niko Buddy de-ai-rules.ts 已有中文 slop 词库, 产出零 LLM 中文机械 slop 检测。
 *
 * A19 机械层零 LLM: slopScore 纯正则+算术, 不调 streamChat/llm/invoke。门控优先级
 * '机械层先于语义层': slop 属 Anti-AI(P1), 机械检测在 LLM 六维审查前前置门控,
 * penalty 超阈值直接阻断 Anti-AI (跳过 LLM 省 token + 防 LLM 自我纵容)。
 * Consistency(P0) 不被 slop 覆盖 (一致性由 LLM consistency 维度管)。
 *
 * 参考 (只读, 不改上游):
 *   - autonovel/evaluate.py: TIER1/2/3 英文词库 + slop_score 密度统计架构
 *   - Niko Buddy/src/lib/novel/de-ai-rules.ts: CHINESE_NOVEL_DE_AI_RULES 中文词库来源
 *   - Niko Buddy/src/lib/novel/emotion-ledger.ts: A19 机械层正则+算术+文本化注入范式
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
// M12-1 增量切片：slopScore 核心块前移至 ./mechanical-slop-core（零逻辑变更）。
// 对外 ABI 由以下重导出保持（符号名/签名不变）；二级检测器经同模块 import 复用。
// ============================================================================
import {
  coefficientOfVariation,
  collectTierRegexHits,
  countOccurrences,
  SENTENCE_CV_LOW_THRESHOLD,
  SENTENCE_MIN_FOR_CV_PENALTY,
  SLOP_CLASSIFY_BLOCK_THRESHOLD,
  SLOP_DENSITY_MIN_WORDS,
  SLOP_DENSITY_PER,
  slopScore,
  splitSentences,
  TRANSITION_OPENER_THRESHOLD,
  type SlopHit,
  type SlopReport,
} from "./mechanical-slop-core"
export {
  RAW_COUNT_FALLBACK,
  RAW_COUNT_WEIGHTS,
  SLOP_CLASSIFY_BLOCK_THRESHOLD,
  SLOP_CLASSIFY_WARN_THRESHOLD,
  SLOP_CLUSTER_MIN_BURST,
  SLOP_CLUSTER_PENALTY,
  SLOP_CLUSTER_WINDOW_CHARS,
  SLOP_DENSITY_MIN_WORDS,
  SLOP_DENSITY_PER,
  SLOP_DENSITY_TARGETS,
  SLOP_DENSITY_WEIGHTS,
  SLOP_PENALTY_MAX,
  TIER3_EXTENDED_PATTERN_COUNT,
  classifySlop,
  slopScore,
} from "./mechanical-slop-core"
export type { SlopHit, SlopReport } from "./mechanical-slop-core"


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
/** 过度不规则阈值: 正常中文叙事 CV 峰值 ~0.5, 改写器腔常 >0.9。
 * 36 号真实语料标定: 《8人》6 章真实 human CV=0.648-0.809 (ch2=0.809 最高),
 * 旧 0.75 误报 ch1/ch2/ch5 三章 (FPR=3/6); 上调至 0.85 (真实 P95 0.809 + 裕量),
 * 6 章零误报且保留改写器腔 (CV>0.9) 检测空间。 */
export const CAVITY_CV_HIGH = 0.85
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

  // 假口语密度 (S4: 密度分母也保底, 短文本不放大)
  const words = Math.max(SLOP_DENSITY_MIN_WORDS, text.replace(/\s+/g, "").length)
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

// ============================================================================
// §GAP-90-04 全书级 style_stats rollup（ainovel stylestat.Compute 模式吸收）
//
// 单章 slopScore 只见树木：审阅窗口内每处都正常、全书章均几十次就是病
// （温水煮青蛙式文体退化）。本函数把各章 SlopReport rollup 为全书级数字，
// 模型只做裁定不做统计：
//   - topPatterns：tier1+tier2 命中词全书聚合（总数+章均，子串去重取 top 8，
//     对应 ainovel TopPhrases）；
//   - repeatedSentences：跨 ≥3 章逐字重复的 ≥12 字长句（复读交代直接证据，
//     取 top 5，对应 ainovel RepeatedSentences）；
//   - shortEndingRatio：章末短结尾（≤30 字）占比（对应 ainovel EndingStat）；
//   - degraded：章均≥4 或任一章触 block 线（初值，待真实语料校准）。
// 章数 < STYLE_STATS_MIN_CHAPTERS（ainovel minChapters=5）返回 null。
// 纯函数零 LLM；输入为正文数组（调用方从快照/章节文件组装，本模块不读盘）。
// ============================================================================

/** 全书级风格统计（rollupStyleStats 产出，供 editor 审美维 + 诊断面板消费）。 */
export interface BookStyleStats {
  chapters: number
  avgPenalty: number
  maxPenalty: number
  degraded: boolean
  topPatterns: Array<{ kw: string; total: number; perChapter: number }>
  repeatedSentences: Array<{ text: string; chapters: number; count: number }>
  shortEndingRatio: number
}

/** 最少章节数（ainovel minChapters=5：样本太小频率无意义）。 */
export const STYLE_STATS_MIN_CHAPTERS = 5
/** 高频模式上限（ainovel 取 top 8）。 */
export const STYLE_STATS_TOP_PATTERNS = 8
/** 重复长句最短字数（ainovel ≥12 字）。 */
export const STYLE_STATS_MIN_REPEAT_CHARS = 12
/** 章末短结尾阈值（ainovel shortEndingRunes=30）。 */
export const STYLE_STATS_SHORT_ENDING_RUNES = 30
/** 全书退化均值初值（待真实语料校准；单章 warn=5/block=8 见 SLOP_CLASSIFY_*）。 */
export const STYLE_STATS_DEGRADED_AVG = 4

function round1Stat(n: number): number {
  return Math.round(n * 10) / 10
}

function splitLongSentences(text: string): string[] {
  const { text: norm } = normalizeSourceText(text)
  return norm
    .split(/[。！？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= STYLE_STATS_MIN_REPEAT_CHARS)
}

/**
 * 全书文体统计 rollup。null = 章数不足（非失败，调用方跳过注入即可）。
 */
export function rollupStyleStats(chapterTexts: readonly string[]): BookStyleStats | null {
  if (chapterTexts.length < STYLE_STATS_MIN_CHAPTERS) return null
  const n = chapterTexts.length
  const reports = chapterTexts.map((t) => slopScore(t))
  const penalties = reports.map((r) => r.slopPenalty)
  const avgPenalty = round1Stat(penalties.reduce((a, b) => a + b, 0) / n)
  const maxPenalty = Math.max(...penalties)

  const totals = new Map<string, number>()
  for (const r of reports) {
    for (const h of [...r.tier1Hits, ...r.tier2Hits]) {
      totals.set(h.kw, (totals.get(h.kw) ?? 0) + h.count)
    }
  }
  const ranked = [...totals.entries()].sort(
    (a, b) => b[1] - a[1] || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1),
  )
  const topPatterns: BookStyleStats["topPatterns"] = []
  for (const [kw, total] of ranked) {
    if (topPatterns.length >= STYLE_STATS_TOP_PATTERNS) break
    if (topPatterns.some((p) => p.kw.includes(kw) || kw.includes(p.kw))) continue
    topPatterns.push({ kw, total, perChapter: round1Stat(total / n) })
  }

  const sentCount = new Map<string, number>()
  const sentChapters = new Map<string, Set<number>>()
  chapterTexts.forEach((t, idx) => {
    for (const s of new Set(splitLongSentences(t))) {
      sentCount.set(s, (sentCount.get(s) ?? 0) + 1)
      const set = sentChapters.get(s) ?? new Set<number>()
      set.add(idx)
      sentChapters.set(s, set)
    }
  })
  const repeatedSentences: BookStyleStats["repeatedSentences"] = [...sentCount.entries()]
    .filter(([s]) => (sentChapters.get(s)?.size ?? 0) >= 3)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 5)
    .map(([text, count]) => ({ text, chapters: sentChapters.get(text)?.size ?? 0, count }))

  let shortEndings = 0
  for (const t of chapterTexts) {
    const lines = t.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 0)
    const last = lines.length > 0 ? (lines[lines.length - 1] ?? "") : ""
    if (last.length > 0 && last.length <= STYLE_STATS_SHORT_ENDING_RUNES) shortEndings++
  }

  return {
    chapters: n,
    avgPenalty,
    maxPenalty,
    degraded: avgPenalty >= STYLE_STATS_DEGRADED_AVG || maxPenalty >= SLOP_CLASSIFY_BLOCK_THRESHOLD,
    topPatterns,
    repeatedSentences,
    shortEndingRatio: Math.round((shortEndings / n) * 100) / 100,
  }
}

/** 文本化全书统计（供 editor 审美维 prompt 注入；null 返回 ""）。 */
export function bookStyleStatsToText(stats: BookStyleStats | null): string {
  if (!stats) return ""
  const lines = [
    `全书文体统计（${stats.chapters} 章，章均 penalty ${stats.avgPenalty}/10，最高 ${stats.maxPenalty}/10${stats.degraded ? "：文体退化，需干预" : ""}）`,
  ]
  if (stats.topPatterns.length > 0) {
    lines.push(`- 全书高频短语：${stats.topPatterns.map((p) => `${p.kw}×${p.total}（章均${p.perChapter}）`).join("、")}`)
  }
  for (const s of stats.repeatedSentences) {
    lines.push(`- 跨章重复句（${s.chapters} 章×${s.count} 次）：${s.text.slice(0, 40)}`)
  }
  lines.push(`- 章末短结尾占比 ${(stats.shortEndingRatio * 100).toFixed(0)}%`)
  return lines.join("\n")
}

// ============================================================================
// §R24 结构层机械信号三件套（RCP-20261014-1311 落地）
//
// 单章轮唱/复读家族/角色静默是 R21→R23 三轮微改都抓不住的结构层缺口——
// LLM 评审能感知（pull/character 扣分）但机械层此前无对应信号。
// 本三件套全部纯函数零 LLM，warn 态建议，不阻断、不参与 slopPenalty（正交职责）。
// ============================================================================

/** 轮唱命中：窗口内相邻喊话段。 */
export interface ChorusHit {
  /** 1-based 起始段号。 */
  para: number
  /** 窗口内喊话段数。 */
  shouts: number
}

/** 喊话行判定：以中文引号包裹的短句（≤24 字，R24 轮唱均为短促喊话）。 */
const SHOUT_MAX_CHARS = 24

function isShoutPara(para: string): boolean {
  const t = para.trim()
  if (!t.startsWith("\u201c")) return false
  const end = t.indexOf("\u201d")
  if (end < 0) return false
  return end - 1 <= SHOUT_MAX_CHARS
}

/**
 * 轮唱检测：连续段落中喊话段 ≥ minShouts（默认 3）即命中。
 * 对应 R24 E1/E3：103-107 三连轮唱、139-143 四人轮唱×3。
 * 空文本/不足窗口返回 []。
 */
export function detectChorusSing(rawText: string, minShouts = 3): ChorusHit[] {
  const paras = rawText.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0)
  const hits: ChorusHit[] = []
  let run = 0
  let runStart = 0
  for (let i = 0; i <= paras.length; i += 1) {
    const shout = i < paras.length && isShoutPara(paras[i] ?? "")
    if (shout) {
      if (run === 0) runStart = i + 1
      run += 1
    } else {
      if (run >= minShouts) hits.push({ para: runStart, shouts: run })
      run = 0
    }
  }
  return hits
}

/** 复读家族计数：同族短语出现次数。 */
export interface EchoFamilyCount {
  family: string
  count: number
}

/**
 * 复读家族计数：同一语义家族（如"一个都不…"）出现 ≥ minCount（默认 3）即上报。
 * 对应 R24："一个都不" 4→1、"子时见" 2→1、"跟我一起" 1→0。
 * families 为调用方传入的家族正则源（本模块不内置语料，防词库膨胀）。
 */
export function countEchoFamily(rawText: string, families: readonly string[], minCount = 3): EchoFamilyCount[] {
  const { text } = normalizeSourceText(rawText)
  const out: EchoFamilyCount[] = []
  for (const fam of families) {
    const m = text.match(new RegExp(fam, "g"))
    if (m && m.length >= minCount) out.push({ family: fam, count: m.length })
  }
  return out
}

/** 角色静默段：起止段号 + 占比。 */
export interface SilentStretch {
  fromPara: number
  toPara: number
  /** 静默段数占全文段数比（0-1）。 */
  ratio: number
}

const SILENT_STRETCH_MIN_PARAS = 8

/**
 * 角色静默段检测：names 中任一名字连续缺席 ≥ minParas（默认 8）段即命中。
 * 对应 R24 E2：中段三友静默 13 段（约 16.7%）——三处手术之一即补在场锚。
 * 出场判定为纯字面包含（机械信号，具体指代由 LLM 语义层裁定）。
 */
export function detectSilentStretch(rawText: string, names: readonly string[], minParas = SILENT_STRETCH_MIN_PARAS): SilentStretch[] {
  const paras = rawText.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0)
  if (paras.length === 0 || names.length === 0) return []
  const hits: SilentStretch[] = []
  let runStart = -1
  const flush = (end: number) => {
    if (runStart < 0) return
    const len = end - runStart
    if (len >= minParas) {
      hits.push({ fromPara: runStart + 1, toPara: end, ratio: Math.round((len / paras.length) * 100) / 100 })
    }
    runStart = -1
  }
  for (let i = 0; i < paras.length; i += 1) {
    const p = paras[i] ?? ""
    const present = names.some((n) => p.includes(n))
    if (!present) {
      if (runStart < 0) runStart = i
    } else {
      flush(i)
    }
  }
  flush(paras.length)
  return hits
}

/**
 * self-assessment.ts — 长篇章节自评估闭环原语（Roadmap 批次 C8 / write 模式）。
 *
 * ## 背景
 *   长篇生成后需要一个"自评 → 找差距 → 给修复"的闭环，供上层编排（如多轮
 *   rewrite 收敛、章节门控、生成后自检）调用。本模块交付三个纯函数原语：
 *     score（六维机械打分）→ gap（低于阈值维度清单）→ fix（每 gap 一条修复文案）。
 *   组装入口：assessChapter(input) → { scores, gaps, fixes, overall, degraded }。
 *
 * ## 六维打分（零 LLM 启发式）
 *   - length           篇幅             chars / targetLength 达标度
 *   - dialogueRatio    对话-叙事平衡    对话字符占比落 [0.15, 0.5] 得满分
 *   - paragraphRhythm  段落节奏        平均段长落 [60, 220] 字符区间得满分
 *   - sentenceVariety  句式变化        句长变异系数 CV 越大越有长短变化
 *   - sceneBreaks      场景分段        场景断点密度（约每 600 字一个断点）
 *   - openingHook      开篇钩子        首句含对话/强调标点/简短
 *
 *   每维输出 0-100 分 + 可审计证据（evidence 含抽样统计值）。
 *
 * ## gap / fix 对齐
 *   gap = score < threshold 的维度；fixes 与 gaps **按维度一一对应**，每条为
 *   可执行建议文案（buildFix）。默认阈值集中于 45~55，可经 input.goals 覆盖。
 *
 * ## LLM 扩展缝（同 canon-precision-filter 模式）
 *   assessChapter 第二参 options.llm 允许注入 LLM 评估器，对所有维度做一次
 *   覆盖打分（evaluate 返回 Partial<Record<dim, number>>）。未注入 => degraded=true
 *   （仅机械层）。注入后对所有维度取 LLM 覆盖值且 degraded=false（LLM 抛错则回退
 *   机械打分并保持 degraded）。本模块不直接依赖 llm-client——LLM 只经注入器进入，
 *   保持零副作用、纯函数、可离线单测。
 *
 * > 模式借鉴 canon-precision-filter（degraded 降级 + 注入 verify 缝）与
 * > dimension-review-adapter 六维拆解思想；只借模式不抄码，为全独立 TS 实现。
 *
 * 遵循 QMAI/CLAUDE.md：零 LLM 机械层 + 可注入扩展，纯函数无副作用。
 */

/** 六维维度标识。 */
export type SelfAssessmentDimensionKey =
  | "length"
  | "dialogueRatio"
  | "paragraphRhythm"
  | "sentenceVariety"
  | "sceneBreaks"
  | "openingHook"

/** 六维可读标签。 */
export const DIMENSION_LABELS: Record<SelfAssessmentDimensionKey, string> = {
  length: "篇幅",
  dialogueRatio: "对话节奏",
  paragraphRhythm: "段落节奏",
  sentenceVariety: "句式变化",
  sceneBreaks: "场景分段",
  openingHook: "开篇钩子",
}

/** 六维稳定顺序。 */
export const DIMENSION_KEYS: SelfAssessmentDimensionKey[] = [
  "length",
  "dialogueRatio",
  "paragraphRhythm",
  "sentenceVariety",
  "sceneBreaks",
  "openingHook",
]

/** 单维评估结果。 */
export interface DimensionAssessment {
  key: SelfAssessmentDimensionKey
  label: string
  /** 0-100 分。 */
  score: number
  /** 是否 gap（score < threshold）。 */
  gap: boolean
  /** 触发 gap 的阈值。 */
  threshold: number
  /** 可审计证据（含统计值）。 */
  evidence: string
}

/** 单条修复建议（与 gap 一一对齐）。 */
export interface FixSuggestion {
  dimension: SelfAssessmentDimensionKey
  label: string
  /** 当前(低)分。 */
  currentScore: number
  /** 阈值。 */
  threshold: number
  /** 可执行修复文案。 */
  text: string
}

/** assessChapter 输入：章节文本 + 可选目标锚点。 */
export interface SelfAssessmentInput {
  text: string
  /** 可选目标锚点：按维度覆盖阈值(0-100)与目标篇幅(字符)。 */
  goals?: {
    thresholds?: Partial<Record<SelfAssessmentDimensionKey, number>>
    targetLength?: number
  }
}

/** 可选注入的 LLM 评估器（扩展缝）。 */
export interface LlmEvaluator {
  /** 对六维做一次覆盖打分；返回部分维度覆盖分（未覆盖维保持机械分）。 */
  evaluate: (
    input: SelfAssessmentInput,
    mechanical: DimensionAssessment[]
  ) => Promise<Partial<Record<SelfAssessmentDimensionKey, number>>>
}

/** assessChapter 可选项。 */
export interface SelfAssessmentOptions {
  /** 可选 LLM 评估器。未注入 => degraded。 */
  llm?: LlmEvaluator | null
}

/** assessChapter 输出：scores + gaps + fixes。 */
export interface SelfAssessmentResult {
  scores: DimensionAssessment[]
  gaps: DimensionAssessment[]
  fixes: FixSuggestion[]
  /** 全部维度均分。 */
  overall: number
  /** true=仅机械层（未注入 LLM 或注入后抛错）；false=已 LLM 覆盖。 */
  degraded: boolean
}

/** 从原文抽取的可观测量（供评分函数消费）。 */
export interface ChapterSignals {
  /** 去空白字符数。 */
  charCount: number
  /** 句子总数。 */
  sentenceCount: number
  /** 对话字符数。 */
  dialogueChars: number
  /** 对话字符占比 0-1。 */
  dialogueRatio: number
  /** 平均段长（字符/段）。 */
  avgParagraphLength: number
  /** 句长变异系数。 */
  sentenceLengthCv: number
  /** 场景断点数。 */
  sceneBreakCount: number
  /** 首段首句长度。 */
  openingSentenceLength: number
  /** 首句是否含对话。 */
  openingHasDialogue: boolean
  /** 首句是否钩子（强调/短句）。 */
  openingHasEmphatic: boolean
}

/** 默认目标篇幅（字符）。 */
export const DEFAULT_TARGET_LENGTH = 3000

/** 各维默认 gap 阈值。 */
export const DEFAULT_THRESHOLDS: Record<SelfAssessmentDimensionKey, number> = {
  length: 50,
  dialogueRatio: 55,
  paragraphRhythm: 55,
  sentenceVariety: 50,
  sceneBreaks: 50,
  openingHook: 45,
}

/** 句末标点（中英文）。句末标点用于切分句子。 */
const SENTENCE_END_RE = /[。！？!?…;；]+/g

/** 对话引号（中英文双引号）。 */
const DIALOGUE_QUOTE_RE = /[“”"「」『』]/

/** 场景分隔行（单独成行的 ---、*** 等）。 */
const SCENE_SEPARATOR_RE = /^\s*(?:---|-{3,}|\*{3,}|＿{3,}|…{3,})\s*$/

/** 从纯文本抽取可度量信号（无副作用、纯函数）。 */
export function extractSignals(text: string): ChapterSignals {
  const content = text ?? ""
  const charCount = content.replace(/\s+/g, "").length
  const rawLines = content.split(/\r?\n/)

  // 段落：忽略空行与分隔行。
  const paragraphs: string[] = []
  for (const line of rawLines) {
    const t = line.trim()
    if (t && !SCENE_SEPARATOR_RE.test(t)) paragraphs.push(t)
  }
  const paragraphCount = Math.max(paragraphs.length, 1)
  const avgParagraphLength = charCount / paragraphCount

  // 句子与句长。
  const sentences = content
    .split(SENTENCE_END_RE)
    .map((s) => s.replace(/\s+/g, ""))
    .filter((s) => s.length > 0)
  const sentLens = sentences.map((s) => s.length)
  const sentMean = sentLens.length ? sentLens.reduce((a, b) => a + b, 0)
 / sentLens.length : 0
  const sentVar =
    sentLens.length > 1
      ? Math.sqrt(sentLens.reduce((a, l) => a + (l - sentMean) ** 2, 0) / sentLens.length)
      : 0
  const sentenceLengthCv = sentMean > 0 ? sentVar / sentMean : 0

  // 对话字符：引号配对内累计。
  let dialogueChars = 0
  let inQuote = false
  let buf = 0
  for (const ch of content) {
    if (DIALOGUE_QUOTE_RE.test(ch)) {
      if (inQuote) {
        dialogueChars += buf
        buf = 0
        inQuote = false
      } else {
        inQuote = true
        buf = 0
      }
    } else if (inQuote && !/\s/.test(ch)) {
      buf += 1
    }
  }
  const dialogueRatio = charCount > 0 ? dialogueChars / charCount : 0

  // 场景断点：空白行夹在两个非空段之间 => 计一个；连续空白只计一次。
  let sceneBreakCount = 0
  {
    let prevPara = false
    let pendingBreak = false
    for (const line of rawLines) {
      const t = line.trim()
      const isPara = t.length > 0 && !SCENE_SEPARATOR_RE.test(t)
      if (isPara) {
        if (pendingBreak) sceneBreakCount += 1
        pendingBreak = false
        prevPara = true
      } else {
        if (prevPara) pendingBreak = true
        prevPara = false
      }
    }
  }

  // 开篇特征：首段首句。
  const firstSentence = paragraphs[0] ?? ""
  const openingSentenceLength = firstSentence.replace(/\s+/g, "").length
  const openingHasDialogue = DIALOGUE_QUOTE_RE.test(firstSentence)
  const openingHasEmphatic =
    /[！？!?…]$/.test(firstSentence) || openingSentenceLength < 30

  return {
    charCount,
    sentenceCount: sentences.length,
    dialogueChars,
    dialogueRatio,
    avgParagraphLength,
    sentenceLengthCv,
    sceneBreakCount,
    openingSentenceLength,
    openingHasDialogue,
    openingHasEmphatic: openingHasEmphatic || openingHasDialogue,
  }
}

/** 把分值界为 0-100 的钳制。 */
function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

/**
 * 单维机械打分（零 LLM）。返回该维 0-100 分 + evidence。
 * 纯函数：输入 signals + 目标长度，输出稳定分数与可审计理由。
 */
export function scoreDimension(
  key: SelfAssessmentDimensionKey,
  signals: ChapterSignals,
  goals: SelfAssessmentInput["goals"] = {}
): { score: number; evidence: string } {
  const targetLength = goals.targetLength ?? DEFAULT_TARGET_LENGTH
  if (signals.charCount <= 0) {
    return { score: 0, evidence: "empty text → 0/100" }
  }
  switch (key) {
    case "length": {
      const ratio = targetLength > 0 ? signals.charCount / targetLength : 0
      const score = clamp(ratio * 100)
      return {
        score,
        evidence: `chars=${signals.charCount} target=${targetLength} → ${score}/100`,
      }
    }
    case "dialogueRatio": {
      const d = signals.dialogueRatio
      let score: number
      if (d >= 0.15 && d <= 0.5) score = 100
      else if (d < 0.15) score = clamp((d / 0.15) * 100)
      else score = clamp(((0.7 - d) / 0.2) * 100)
      const pct = (d * 100).toFixed(1)
      return { score, evidence: `dialogue=${pct}% → ${score}/100` }
    }
    case "paragraphRhythm": {
      const a = signals.avgParagraphLength
      let score: number
      if (a >= 60 && a <= 220) score = 100
      else if (a < 60) score = clamp(30 + (a / 60) * 70)
      else score = clamp(100 - ((a - 220) / 180) * 100)
      return { score, evidence: `avgPara=${a.toFixed(1)} → ${score}/100` }
    }
    case "sentenceVariety": {
      const cv = signals.sentenceLengthCv
      const score = clamp(cv * 100)
      return { score, evidence: `sentCv=${cv.toFixed(2)} → ${score}/100` }
    }
    case "sceneBreaks": {
      const n = signals.sceneBreakCount
      const expected = Math.max(1, Math.round(signals.charCount / 600))
      const score = clamp((n / expected) * 100)
      return { score, evidence: `breaks=${n} expect=${expected} → ${score}/100` }
    }
    case "openingHook": {
      if (signals.openingHasEmphatic) {
        return { score: 100, evidence: "opening hook present → 100/100" }
      }
      const score = clamp(100 - (signals.openingSentenceLength - 30) * 2)
      return {
        score,
        evidence: `openingLen=${signals.openingSentenceLength} no-hook → ${score}/100`,
      }
    }
  }
}

/** 组装单维评估（带 gap 判定与证据）。 */
export function assessDimension(
  key: SelfAssessmentDimensionKey,
  signals: ChapterSignals,
  goals: SelfAssessmentInput["goals"] = {}
): DimensionAssessment {
  const label = DIMENSION_LABELS[key]
  const threshold = goals.thresholds?.[key] ?? DEFAULT_THRESHOLDS[key]
  const { score, evidence } = scoreDimension(key, signals, goals)
  return {
    key,
    label,
    score,
    gap: score < threshold,
    threshold,
    evidence: `[${label}] ${evidence}`,
  }
}

/**
 * 为某个 gap 维度生成一条可执行修复建议文案。
 * 与 gap 的来源维度一一对应（dimension = 该维 key）。
 */
export function buildFix(assessment: DimensionAssessment): FixSuggestion {
  const { key, label, score, threshold } = assessment
  const head = `「${label}」得分 ${score}/100，低于阈值 ${threshold}/100。`
  let tail = ""
  switch (key) {
    case "length":
      tail = " 请扩写主事件、补强环境与人物细节，使章节接近目标篇幅；或调低目标长度。"
      break
    case "dialogueRatio":
      tail = " 若对话过少请补人物对话交锋，若过多请补叙事段与心理描写，使对话占比落 15%~50%。"
      break
    case "paragraphRhythm":
      tail = " 将超长段拆分成短段制造节拍，或合并过碎短段，使平均段长接近 60~220 字。"
      break
    case "sentenceVariety":
      tail = " 穿插长短句：关键情绪用短促句收束，描述推进用长句延展，提升句长变异系数。"
      break
    case "sceneBreaks":
      tail = " 在时间/地点/视角切换处用空行或分隔符切断场景，约每 600 字制造一个断点。"
      break
    case "openingHook":
      tail = " 用设问、对话引语或酷烈冲突作首句，收束短促有力，避免长篇静态铺陈开头。"
      break
  }
  return {
    dimension: key,
    label,
    currentScore: score,
    threshold,
    text: head + tail,
  }
}

/**
 * 全闭环入口：score → gap → fix。
 * 零 LLM 默认；options.llm 注入时对所有维度做一次覆盖打分并置 degraded=false。
 */
export async function assessChapter(
  input: SelfAssessmentInput,
  options: SelfAssessmentOptions = {}
): Promise<SelfAssessmentResult> {
  const goals = input.goals ?? {}
  const signals = extractSignals(input.text ?? "")

  // score（机械六维）。
  const mechanical: DimensionAssessment[] = DIMENSION_KEYS.map((k) =>
    assessDimension(k, signals, goals)
  )

  // 可选 LLM 覆盖。
  let degraded = true
  let scores: DimensionAssessment[] = mechanical
  if (options.llm) {
    try {
      const coverage = await options.llm.evaluate(input, mechanical)
      scores = mechanical.map((m) => {
        const v = coverage?.[m.key]
        const score = typeof v === "number" && Number.isFinite(v) ? clamp(v) : m.score
        return { ...m, score, gap: score < m.threshold }
      })
      degraded = false
    } catch {
      // LLM 抛错 => 回退机械并维持 degraded。
      degraded = true
      scores = mechanical
    }
  }

  // gap + fix。
  const gaps = scores.filter((s) => s.gap)
  const fixes = gaps.map((g) => buildFix(g))

  return {
    scores,
    gaps,
    fixes,
    overall: Math.round(scores.reduce((a, s) => a + s.score, 0) / scores.length),
    degraded,
  }
}

import { parseFrontmatter } from "@/lib/frontmatter"
import { parseChineseInteger } from "./chapter-import"
import {
  OUTLINE_MODEL_SCHEMA_VERSION,
  flattenOutlineChapters,
  normalizeOutlineModel,
  normalizeOutlinePov,
  outlineChapterId,
  type OutlineModel,
  type OutlineModelChapter,
  type OutlineModelVolume,
} from "./outline-model"

/**
 * Markdown → 大纲模型解析器。
 *
 * 两级策略（结构优先、正则回退）：
 *   1. **结构化**：frontmatter 带 `outline_model` 整对象，或带 `volume`/`chapter`
 *      等字段 → 直接采信。
 *   2. **回退**：按 heading / 粗体 / 列表 / 裸文本四类前缀识别「第N卷 / 第N章」
 *      与固定小节（本章目标/场景/情绪/登场/伏笔/约束）。
 *
 * 回退解析必然有损（作者自由写法无法穷举），因此结果始终带 warnings，供导入流程
 * 提示人工确认；解析器本身不写盘、不猜测不存在的结构。
 *
 * confidence 契约（D2）：三档 high/medium/low + 数值 `confidenceScore`(0..1) +
 * `signals` 明细。硬不变量：**最高档 ⇒ warnings 为空且 filledSections > 0** ——
 * 只凭「看到了卷/章标题」就判 high 会让「标题全对、字段全丢」拿到假高置信。
 */

export type OutlineModelParseSource = "frontmatter" | "heading"

/** confidence 量化的原始信号（可复算、可单测，不是黑箱分数）。 */
export interface OutlineModelParseSignals {
  volumeHeadings: number
  chapterHeadings: number
  /**
   * 真实章数（`flattenOutlineChapters(model).length`）—— titleRate / fillRate 的分母。
   * R-07/R-21：分母必须是真实章数，不能用 heading 出现次数（结构化复用不自增 heading，
   * 重复章号会让 heading 数 ≠ 章数，两种情形都会把分数算错）。
   */
  chapterCount: number
  nonEmptyTitles: number
  filledSections: number
  warnings: number
}

export interface ParsedOutlineModel {
  model: OutlineModel
  confidence: "high" | "medium" | "low"
  confidenceScore: number
  signals: OutlineModelParseSignals
  warnings: string[]
  source: OutlineModelParseSource
}

export interface ParseOutlineModelOptions {
  /** 无 frontmatter 时间戳时的回填值；调用方通常传 utils.todayStamp()。 */
  updatedAt?: string
}

const VOLUME_HEADING_RE =
  /^#{1,6}\s*(?:第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*卷|卷\s*([0-9零〇一二两三四五六七八九十百千万]+)|Volume\s*(\d+))[:：\s]*(.*)$/i
const CHAPTER_HEADING_RE =
  /^#{1,6}\s*(?:第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*[章回]|Chapter\s*(\d+))[:：\s]*(.*)$/i
const SECTION_HEADING_RE = /^#{2,6}\s*(.+?)\s*$/
const LIST_PREFIX_RE = /^\s*(?:[-*+]|\d+\.)\s+/
const FORESHADOW_ID_RE = /[A-Z]{2,}-\d+/

// 不带 `#` 的同类形态（粗体 / 列表 / 裸文本）：孵化器真实产出会写成这样。
const VOLUME_TEXT_RE =
  /^(?:第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*卷|卷\s*([0-9零〇一二两三四五六七八九十百千万]+)|Volume\s*(\d+))[:：\s]*(.*)$/i
const CHAPTER_TEXT_RE =
  /^(?:第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*[章回]|Chapter\s*(\d+))[:：\s]*(.*)$/i
/** 粗体行内标签：`**本章目标**：内容`（孵化器 prompt 常见的紧凑写法）。 */
const INLINE_SECTION_RE = /^\*\*(.+?)\*\*\s*[:：]\s*(.*)$/

/**
 * 无编号章标题（R-10 / N-01）：序章/序幕/楔子/引子/终章/尾声/番外。
 * 这类章没有可解析的章号 → 只做合成编号，绝不夺走显式「第N章」的 N（BG-1）。
 *
 * N-01：旧写法把「楔子」写成「榉子」（U+6989 ≠ U+6954），最常用的序章别名整章静默
 * 丢失。此处同时接受单字「楔」（`楔子` 必须排在 `楔` 之前，否则 `$` 锚点会因余下「子」失败）。
 */
const SPECIAL_CHAPTER_RE =
  /^#{1,6}\s*(序章|序幕|楔子|楔|引子|终章|尾声|番外)(?:[:：\s]+(.*))?$/
const SPECIAL_CHAPTER_TEXT_RE = /^(序章|序幕|楔子|楔|引子|终章|尾声|番外)(?:[:：\s]+(.*))?$/

/**
 * 小节标签黑名单：这些标签语义上**不是**大纲字段，必须整体丢弃。
 * 不加这层会因 matchKey 的 startsWith 后缀匹配把「目标读者」误吞进 prose.goal
 * （`目标读者`.startsWith(`目标`) === true），让读者定位污染本章目标。
 */
const LABEL_BLACKLIST = ["目标读者", "场景地点", "情绪基调", "人物表"]

const GOAL_KEYS = ["本章目标", "目标", "章节目标", "章节定位", "核心事件"]
const ARC_KEYS = ["弧线", "所属弧线", "arc", "章尾钩子"]
const POV_KEYS = ["视角", "POV", "pov", "叙事视角"]
const SCENE_KEYS = ["场景", "场景序列", "分场", "场景顺序"]
const EMOTION_KEYS = ["情绪", "情绪线", "情绪曲线", "情绪变化"]
const ENTITY_KEYS = ["登场", "登场角色", "实体", "出场角色", "人物状态"]
const FORESHADOW_KEYS = ["伏笔", "伏笔引用", "伏笔与追踪"]
const CONSTRAINT_KEYS = ["约束", "禁止", "限制", "约束与禁止"]
/** 卷级目标：OutlineModel 无独立字段（用户锁定「只加 pov」），只能写 volume.arc。 */
const VOLUME_GOAL_KEYS = ["本卷目标"]

const ALL_SECTION_KEYS = [
  GOAL_KEYS,
  ARC_KEYS,
  POV_KEYS,
  SCENE_KEYS,
  EMOTION_KEYS,
  ENTITY_KEYS,
  FORESHADOW_KEYS,
  CONSTRAINT_KEYS,
  VOLUME_GOAL_KEYS,
]

/** 剥离小节标签的排版噪声（有序前缀 / 括号序号 / 【】 / 粗体），顺序固定。 */
function normalizeLabel(value: string): string {
  let text = value.trim()
  text = text.replace(/^\d+[.、)]\s*/, "")
  text = text.replace(/^[（(][一二三四五六七八九十百千万0-9]+[）)]\s*/, "")
  const bracketed = /^【(.+)】$/.exec(text)
  if (bracketed) text = bracketed[1]
  const bolded = /^\*\*(.+)\*\*$/.exec(text)
  if (bolded) text = bolded[1]
  return text.replace(/[\s:：]/g, "")
}

function matchKey(label: string, keys: string[]): boolean {
  const normalized = normalizeLabel(label)
  // 黑名单先判：否则 startsWith 后缀匹配会让「目标读者」命中原目标。
  if (LABEL_BLACKLIST.some((blocked) => normalized === blocked || normalized.startsWith(blocked))) {
    return false
  }
  return keys.some((key) => normalized === normalizeLabel(key) || normalized.startsWith(normalizeLabel(key)))
}

function isSectionLabel(label: string): boolean {
  return ALL_SECTION_KEYS.some((keys) => matchKey(label, keys))
}

/**
 * 剥离行内排版标记，并告知「是否带前缀」（粗体 / 列表 / 有序序号）。
 * prefixed=true 说明作者明确把它当条目写，可以放宽裸文本护栏。
 */
function stripLineMarkup(line: string): { text: string; prefixed: boolean } {
  const trimmed = line.trim()
  const bolded = /^\*\*(.+)\*\*$/.exec(trimmed)
  if (bolded) return { text: bolded[1].trim(), prefixed: true }
  if (/^[-*+]\s+/.test(trimmed)) {
    return { text: trimmed.replace(/^[-*+]\s+/, "").trim(), prefixed: true }
  }
  if (/^\d+[.、)]\s+/.test(trimmed)) {
    return { text: trimmed.replace(/^\d+[.、)]\s+/, "").trim(), prefixed: true }
  }
  return { text: trimmed, prefixed: false }
}

/**
 * 章后裸摘要行判定（N-02）：④'' 只接「章标题后紧邻的第一个非空行」，且该行必须是散文。
 * 表格行 / 代码围栏 / 分隔线 / 单级 `#` 标题 / 引用块都不是散文 —— 台词、表格、引用、
 * 结构标记一旦被吸进 prose.goal，既污染字段又把 confidence 抬成假 high。
 */
function isBareSummaryLine(text: string): boolean {
  if (/^\|/.test(text)) return false
  if (/^(?:`{3,}|~{3,})/.test(text)) return false
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(text)) return false
  if (/^#(?!#)/.test(text)) return false
  if (/^>/.test(text)) return false
  // 行内粗体台词（`**苏七**：你真的要走？`）：整行不是粗体，stripLineMarkup 判不出
  // prefixed，必须在这里拦 —— 否则台词会被写成章节目标。
  if (/^\*\*.+\*\*\s*[:：]/.test(text)) return false
  return true
}

function numberFromLabel(raw: string | undefined): number | null {
  if (!raw) return null
  if (/^\d+$/.test(raw)) {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  return parseChineseInteger(raw)
}

function splitInlineList(raw: string): string[] {
  return raw
    .split(/[、,，;；]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function collectListItems(lines: string[]): string[] {
  const items: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (LIST_PREFIX_RE.test(trimmed)) {
      const item = trimmed.replace(LIST_PREFIX_RE, "").trim()
      if (item) items.push(item)
      continue
    }
    items.push(...splitInlineList(trimmed))
  }
  return items
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
  }
  if (typeof value === "string") return splitInlineList(value)
  return []
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") return numberFromLabel(value.trim())
  return null
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function createChapter(
  volume: number,
  chapter: number,
  title: string,
  updatedAt: string,
): OutlineModelChapter {
  return {
    id: outlineChapterId(volume, chapter),
    volume,
    chapter,
    title,
    pov: "",
    arc: "",
    entities: [],
    foreshadow: { plant: [], payoff: [] },
    constraints: [],
    prose: { goal: "", scenes: [], emotion: "" },
    updatedAt,
  }
}

function readStructuredChapter(
  fm: Record<string, unknown>,
  fallbackTitle: string,
  updatedAt: string,
): OutlineModelChapter | null {
  const volume = readNumber(fm.volume)
  const chapter = readNumber(fm.chapter)
  if (volume === null || chapter === null) return null
  const built = createChapter(volume, chapter, readString(fm.title) || fallbackTitle, updatedAt)
  built.arc = readString(fm.arc)
  built.pov = normalizeOutlinePov(readString(fm.pov))
  built.entities = readStringArray(fm.entities)
  built.constraints = readStringArray(fm.constraints)
  built.foreshadow = {
    plant: readStringArray(fm.foreshadow_plant ?? fm.foreshadowPlant),
    payoff: readStringArray(fm.foreshadow_payoff ?? fm.foreshadowPayoff),
  }
  return built
}

function sectionText(body: string[]): string {
  return body.map((line) => line.trim()).filter(Boolean).join("\n")
}

/**
 * 同一章可能同时有「弧线」与「章尾钩子」两节，直接覆盖会丢内容 → 追加。
 * 同理卷级「本卷目标」只能写 volume.arc（OutlineModel 无独立字段）。
 */
function appendText(existing: string, next: string): string {
  const current = existing.trim()
  if (!current) return next
  if (!next) return current
  return `${current}\n${next}`
}

/**
 * 列表类字段合并去重（R-08）：别名同时命中时不得互相覆盖，也不得重复堆同一项。
 * 保序：先既有项、后新项，首个出现的顺序即最终顺序。
 */
function mergeList(existing: string[], next: string[]): string[] {
  const merged: string[] = []
  for (const item of [...existing, ...next]) {
    const trimmed = item.trim()
    /* v8 ignore next -- 台账 outline-model-parse.ts L291：mergeList 两侧输入都不可能含空串。next 来自 collectListItems（L198/L201 与 splitInlineList 均 .filter(Boolean)）；existing 只可能来自 [] 初值（L240-243）、readStringArray（.filter(Boolean)）、或上一次 mergeList 的结果。fm.outline_model 的 JSON 路径运行时不可达（frontmatter normalize 恒 stringify 化，spec 已钉死该守卫） */
    if (!trimmed) continue
    if (merged.includes(trimmed)) continue
    merged.push(trimmed)
  }
  return merged
}

function applySection(chapter: OutlineModelChapter, label: string, body: string[]): void {
  if (matchKey(label, ARC_KEYS)) {
    chapter.arc = appendText(chapter.arc, sectionText(body))
    return
  }
  if (matchKey(label, POV_KEYS)) {
    // R-08：别名（视角 / POV / 叙事视角）同时命中时不得互相覆盖。
    chapter.pov = appendText(chapter.pov, sectionText(body))
    return
  }
  if (matchKey(label, GOAL_KEYS)) {
    chapter.prose.goal = appendText(chapter.prose.goal, sectionText(body))
    return
  }
  if (matchKey(label, SCENE_KEYS)) {
    chapter.prose.scenes = mergeList(chapter.prose.scenes, collectListItems(body))
    return
  }
  if (matchKey(label, EMOTION_KEYS)) {
    chapter.prose.emotion = appendText(chapter.prose.emotion, sectionText(body))
    return
  }
  if (matchKey(label, ENTITY_KEYS)) {
    chapter.entities = mergeList(chapter.entities, collectListItems(body))
    return
  }
  if (matchKey(label, CONSTRAINT_KEYS)) {
    chapter.constraints = mergeList(chapter.constraints, collectListItems(body))
    return
  }
  if (matchKey(label, FORESHADOW_KEYS)) {
    for (const line of body) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const ids = trimmed.match(new RegExp(FORESHADOW_ID_RE.source, "g")) ?? []
      const target = /埋|plant/i.test(trimmed)
        ? chapter.foreshadow.plant
        : /收|回收|payoff/i.test(trimmed)
          ? chapter.foreshadow.payoff
          : null
      if (target && ids.length > 0) {
        for (const id of ids) {
          if (!target.includes(id)) target.push(id)
        }
      }
    }
  }
}

/**
 * 字段填充计数：八类结构字段（含 pov）里非空的项数（foreshadow 任一方向即算填充）。
 * R-20：pov 是一等结构字段，不计数会让「只填了 POV」的章拿到假低置信。
 */
function countFilledSections(chapter: OutlineModelChapter): number {
  let filled = 0
  if (chapter.arc.trim()) filled += 1
  if (chapter.pov.trim()) filled += 1
  if (chapter.prose.goal.trim()) filled += 1
  if (chapter.prose.scenes.length > 0) filled += 1
  if (chapter.prose.emotion.trim()) filled += 1
  if (chapter.entities.length > 0) filled += 1
  if (chapter.foreshadow.plant.length > 0 || chapter.foreshadow.payoff.length > 0) filled += 1
  if (chapter.constraints.length > 0) filled += 1
  return filled
}

function buildSignals(
  model: OutlineModel,
  input: { volumeHeadings: number; chapterHeadings: number; warnings: number },
): OutlineModelParseSignals {
  const chapters = flattenOutlineChapters(model)
  return {
    volumeHeadings: input.volumeHeadings,
    chapterHeadings: input.chapterHeadings,
    chapterCount: chapters.length,
    nonEmptyTitles: chapters.filter((chapter) => chapter.title.trim().length > 0).length,
    filledSections: chapters.reduce((sum, chapter) => sum + countFilledSections(chapter), 0),
    warnings: input.warnings,
  }
}

function clamp01(value: number): number {
  /* v8 ignore next -- 台账 outline-model-parse.ts L380：clamp01 是模块私有函数，仅 3 个调用点（L396/L397/L405），实参恒有限——chapterCount 经 Math.max(...,1) ≥ 1，两个分子是计数且被分母上界约束，故 !Number.isFinite 永不成立 */
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * 量化打分（权重固定、可复算）：基线 0.2 + 有章标题 0.25 + 有卷标题 0.2 +
 * 标题非空率 0.2 + 字段填充率 0.25 - 每条 warning 0.05。
 *
 * R-07/R-21：titleRate/fillRate 的分母用**真实章数** chapterCount（不是 heading 出现次数），
 * 两个比率显式 clamp01 —— 旧写法用「heading 数 × 7」做分母，且分母下限取 1，
 * 零 heading 时分母饱和，两个字段就能拿满分（假 high）。
 */
function scoreConfidence(signals: OutlineModelParseSignals): number {
  const chapterCount = Math.max(signals.chapterCount, 1)
  const titleRate = clamp01(signals.nonEmptyTitles / chapterCount)
  const fillRate = clamp01(signals.filledSections / (chapterCount * 8))
  const raw =
    0.2 +
    0.25 * (signals.chapterCount > 0 ? 1 : 0) +
    0.2 * (signals.volumeHeadings > 0 ? 1 : 0) +
    0.2 * titleRate +
    0.25 * fillRate -
    0.05 * signals.warnings
  return Math.round(clamp01(raw) * 1000) / 1000
}

/**
 * 量化分 → 三档。硬不变量：最高档必须同时满足 warnings 为空且字段填充数 > 0，
 * 否则「标题全对、字段全丢」会拿到假高置信。
 */
function gradeConfidence(
  signals: OutlineModelParseSignals,
  warnings: string[],
): { confidence: ParsedOutlineModel["confidence"]; confidenceScore: ParsedOutlineModel["confidenceScore"] } {
  const confidenceScore = scoreConfidence(signals)
  const filledSections = signals.filledSections
  if (confidenceScore >= 0.8 && warnings.length === 0 && filledSections > 0) {
    return { confidence: "high", confidenceScore }
  }
  if (confidenceScore >= 0.5) return { confidence: "medium", confidenceScore }
  return { confidence: "low", confidenceScore }
}

/** 解析 Markdown 大纲为模型。 */
export function parseOutlineMarkdownToModel(
  content: string,
  options: ParseOutlineModelOptions = {},
): ParsedOutlineModel {
  const { frontmatter, body } = parseFrontmatter(content)
  const fm = (frontmatter ?? {}) as Record<string, unknown>
  const updatedAt = readString(fm.outline_updated_at) || options.updatedAt || ""
  const warnings: string[] = []

  const inlineModel = fm.outline_model
  if (inlineModel && typeof inlineModel === "object" && !Array.isArray(inlineModel)) {
    const model = readModelObject(inlineModel as Record<string, unknown>, updatedAt)
    const inlineWarnings =
      model.volumes.length > 0 ? [] : ["frontmatter.outline_model 未包含任何卷"]
    const signals = buildSignals(model, {
      volumeHeadings: model.volumes.length,
      chapterHeadings: flattenOutlineChapters(model).length,
      warnings: inlineWarnings.length,
    })
    // 该分支无 heading 信号：字段全空只能是 low（分数固定 1 或 0.3）。
    const confident = signals.filledSections > 0 && inlineWarnings.length === 0
    return {
      model,
      confidence: confident ? "high" : "low",
      confidenceScore: confident ? 1 : 0.3,
      signals,
      warnings: inlineWarnings,
      source: "frontmatter",
    }
  }

  const lines = body.split(/\r?\n/)
  const titleFromBody = lines.find((line) => /^#\s+\S/.test(line.trim()))?.replace(/^#\s+/, "").trim()
  const structured = readStructuredChapter(fm, titleFromBody ?? "", updatedAt)

  const volumes: OutlineModelVolume[] = []
  let currentVolume: OutlineModelVolume | null = null
  let currentChapter: OutlineModelChapter | null = null
  let currentSection: { label: string; body: string[] } | null = null
  // 用持有对象而非裸 let：裸 let 在闭包内赋值会被 TS 的 CFA 窄化成 never。
  const pendingTitle: { volume: OutlineModelVolume | null } = { volume: null }
  let volumeHeadings = 0
  let chapterHeadings = 0
  /** 合成编号章（无编号/非法编号）：被显式「第N章」夺回号时让位重编号（R-02/BG-1）。 */
  const syntheticChapters = new Set<OutlineModelChapter>()
  /**
   * 章后裸摘要槽（N-02 / N-04）：只对「章标题后紧邻的第一个非空行」开放，
   * 任何非空行都会先用掉它（无论最终落进 goal、小节还是被丢弃）。
   */
  const summarySlot = { open: false }

  const flushSection = (): void => {
    if (currentSection) {
      if (currentChapter) {
        applySection(currentChapter, currentSection.label, currentSection.body)
      } else if (currentVolume && matchKey(currentSection.label, ARC_KEYS)) {
        currentVolume.arc = appendText(currentVolume.arc, sectionText(currentSection.body))
      } else if (currentVolume && matchKey(currentSection.label, VOLUME_GOAL_KEYS)) {
        // 卷级目标在 OutlineModel 里无独立字段（用户锁定「只加 pov」）→ 只能进 volume.arc。
        currentVolume.arc = appendText(currentVolume.arc, sectionText(currentSection.body))
      }
    }
    currentSection = null
  }

  const ensureVolume = (number: number, title: string): OutlineModelVolume => {
    const existing = volumes.find((volume) => volume.number === number)
    if (existing) return existing
    const created: OutlineModelVolume = { number, title, arc: "", chapters: [] }
    volumes.push(created)
    return created
  }

  /** 卷号/章号夹取：0 与超大值都会造出不可寻址的锚点，回落并记 warning。 */
  const clampNumber = (raw: number | null, fallback: number, kind: string): number => {
    if (raw === null) return fallback
    if (raw <= 0 || raw > 999) {
      warnings.push(`${kind}非法：${raw}，已回落为 ${fallback}`)
      return fallback
    }
    return raw
  }

  /** R-24：同一卷标题缺陷只扣一次 0.05（openChapter 与末尾分支共用一条文案）。 */
  const volumeFallback = { warned: false }
  const warnVolumeFallback = (): void => {
    if (volumeFallback.warned) return
    volumeFallback.warned = true
    warnings.push("未识别到卷标题，全部章节归入第 1 卷")
  }

  const openVolume = (numberRaw: number | null, rawTitle: string): void => {
    flushSection()
    pendingTitle.volume = null
    const number = clampNumber(numberRaw, volumes.length + 1, "卷号")
    const title = rawTitle.trim()
    currentVolume = ensureVolume(number, title || `第${number}卷`)
    // 卷标题为空时记下待续行：孵化器会把卷名写在 heading 的下一行。
    if (!title) pendingTitle.volume = currentVolume
    currentChapter = null
    volumeHeadings += 1
  }

  /**
   * 开章（R-02 + R-10 + BG-1）：显式编号与合成编号两态。
   *
   * 「第N章」的字面 N 永远拿 N（显式号）；无编号（序章/楔子…）与非法编号（0 / >999）
   * 只拿合成号。合成章被后续显式编号夺回时自动让位重编号，不再静默合并同号章。
   */
  const openChapter = (
    numberRaw: number | null,
    rawTitle: string,
    options: { special?: string } = {},
  ): void => {
    flushSection()
    pendingTitle.volume = null
    const title = rawTitle.trim()
    if (!currentVolume) {
      currentVolume = ensureVolume(1, "第1卷")
      warnVolumeFallback()
    }
    const volume = currentVolume
    const maxChapter = volume.chapters.reduce((max, item) => Math.max(max, item.chapter), 0)
    const explicit =
      numberRaw !== null && Number.isInteger(numberRaw) && numberRaw > 0 && numberRaw <= 999

    if (!explicit) {
      const number = maxChapter + 1
      warnings.push(
        options.special
          ? `未识别到章号：${options.special}，已按顺序编号为 ${number}`
          : `章号非法：${String(numberRaw)}，已按顺序编号为 ${number}`,
      )
      const created = createChapter(volume.number, number, title, updatedAt)
      syntheticChapters.add(created)
      volume.chapters.push(created)
      currentChapter = created
      chapterHeadings += 1
      return
    }

    const sameNumber = volume.chapters.find((item) => item.chapter === numberRaw)
    if (sameNumber && sameNumber === structured) {
      // 单章文件既有 frontmatter 卷章字段又有「第N章」标题：复用已挂载的章，
      // 避免同一章被解析成两份。**不增 chapterHeadings**（R-09：结构化复用不是新 heading）。
      // 只对 structured 成立：正文里重复出现的同号章属于 (c) 重复，必须重编号而不是合并。
      currentChapter = sameNumber
      if (title && !sameNumber.title.trim()) sameNumber.title = title
      return
    }

    if (sameNumber && syntheticChapters.has(sameNumber)) {
      // 合成章占了显式号 → 合成章让位重编号（BG-1：第N章 ⇒ chapter === N 永不被合成章夺走）。
      // N-03：让位后**保留** synthetic 身份。旧写法在这里 delete，合成章就只让位一次：
      // 其后的显式章把它当成普通同号章，走「重复」分支逐章 +1 位移（第2章→3、第3章→4）。
      const renumber = volume.chapters.reduce((max, item) => Math.max(max, item.chapter), 0) + 1
      sameNumber.chapter = renumber
      sameNumber.id = outlineChapterId(volume.number, renumber)
      warnings.push(`章号冲突：合成章已重编号为 ${sameNumber.id}（${numberRaw} 归显式章）`)
    }

    const duplicated = volume.chapters.find((item) => item.chapter === numberRaw)
    if (duplicated) {
      // 显式号重复：后一章让位到 max+1，不再与同号章合并（R-02：静默合并会销毁正文）。
      const renumber = volume.chapters.reduce((max, item) => Math.max(max, item.chapter), 0) + 1
      warnings.push(`章号重复：第${numberRaw}章 重复出现，后一章重编号为 ${renumber}`)
      const created = createChapter(volume.number, renumber, title, updatedAt)
      volume.chapters.push(created)
      currentChapter = created
      chapterHeadings += 1
      return
    }

    const created = createChapter(volume.number, numberRaw, title, updatedAt)
    volume.chapters.push(created)
    currentChapter = created
    chapterHeadings += 1
  }

  /** 卷标题续行判定：短、不成句、不是 heading / 卷章标题 / 小节标签 / 台词 / 引用。 */
  const isVolumeTitleContinuation = (line: string): boolean => {
    if (line.length > 30) return false
    if (line.endsWith("。") || line.endsWith("；")) return false
    /* v8 ignore next -- 台账 outline-model-parse.ts：被上游遮蔽 —— isVolumeTitleContinuation 唯一调用点 L674 的行，在到达前已被 L644 VOLUME_HEADING_RE / L653 CHAPTER_HEADING_RE 的 exec 分支命中并 continue（两分支已消费所有卷/章 heading），故此处恒 false */
    if (VOLUME_HEADING_RE.test(line) || CHAPTER_HEADING_RE.test(line)) return false
    if (SECTION_HEADING_RE.test(line)) return false
    // R-12：不得把粗体台词 / 引用块 / 表格 / 列表条目 / 行内标签写进 volumes[].title。
    if (/^\*\*.+\*\*\s*[:：]/.test(line)) return false
    if (/^[>|]/.test(line)) return false
    if (/^[-*+]\s+/.test(line) || /^\d+[.、)]\s+/.test(line)) return false
    /* v8 ignore next -- 台账 outline-model-parse.ts：被同函数上方 /^\*\*.+\*\*\s*[:：]/ 遮蔽 —— 该式无 $ 锚点，匹配范围严格包含 INLINE_SECTION_RE(/^\*\*(.+?)\*\*\s*[:：]\s*(.*)$/) 的同一前缀，能走到本行的行必已在上方 return false */
    if (INLINE_SECTION_RE.test(line)) return false
    const stripped = stripLineMarkup(line)
    if (VOLUME_TEXT_RE.test(stripped.text) || CHAPTER_TEXT_RE.test(stripped.text)) return false
    if (isSectionLabel(stripped.text)) return false
    if (/[：:]/.test(stripped.text)) return false
    return true
  }

  // 单章文件（frontmatter 带 volume/chapter）：先挂载，让正文小节能附着到它。
  if (structured) {
    const volumeTitle = readString(fm.volume_title) || `第${structured.volume}卷`
    currentVolume = ensureVolume(structured.volume, volumeTitle)
    currentVolume.chapters.push(structured)
    currentChapter = structured
    summarySlot.open = true
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (currentSection) currentSection.body.push("")
      continue
    }
    // 槽只对「紧邻章标题的第一个非空行」开放：先取快照再用掉（N-02）。
    const summarySlotWasOpen = summarySlot.open
    summarySlot.open = false

    // ① heading 优先（`# 第N卷` / `# 第N章`）
    const volumeMatched = VOLUME_HEADING_RE.exec(trimmed)
    if (volumeMatched) {
      openVolume(
        numberFromLabel(volumeMatched[1] ?? volumeMatched[2] ?? volumeMatched[3]),
        volumeMatched[4] ?? "",
      )
      continue
    }

    const chapterMatched = CHAPTER_HEADING_RE.exec(trimmed)
    if (chapterMatched) {
      openChapter(numberFromLabel(chapterMatched[1] ?? chapterMatched[2]), chapterMatched[3] ?? "")
      summarySlot.open = true
      continue
    }

    // ①' 无编号章标题（序章/楔子…）：合成编号，不夺走显式「第N章」的 N（R-10 / N-01）。
    const specialChapterMatched = SPECIAL_CHAPTER_RE.exec(trimmed)
    if (specialChapterMatched) {
      openChapter(null, specialChapterMatched[2] ?? specialChapterMatched[1], {
        special: specialChapterMatched[1],
      })
      summarySlot.open = true
      continue
    }

    // 卷标题续行：只在卷标题为空时生效，取首个合格行，不合格就放弃（不向后漂）。
    if (pendingTitle.volume) {
      const target = pendingTitle.volume
      pendingTitle.volume = null
      if (isVolumeTitleContinuation(trimmed)) {
        target.title = stripLineMarkup(trimmed).text || trimmed
        continue
      }
    }

    // ② / ③ 非 heading 形态：粗体 / 列表 / 有序序号（prefixed）直接试，
    // 裸文本必须先过护栏（与 outline-chapter-unpack.ts:99 同款），否则正文散文会被切成章。
    const strippedLine = stripLineMarkup(trimmed)
    const textCandidate =
      strippedLine.prefixed ||
      (trimmed.length <= 50 && !trimmed.endsWith("。") && !trimmed.endsWith("；"))
    if (textCandidate) {
      const volumeText = VOLUME_TEXT_RE.exec(strippedLine.text)
      if (volumeText) {
        openVolume(
          numberFromLabel(volumeText[1] ?? volumeText[2] ?? volumeText[3]),
          volumeText[4] ?? "",
        )
        continue
      }
      const chapterText = CHAPTER_TEXT_RE.exec(strippedLine.text)
      if (chapterText) {
        openChapter(numberFromLabel(chapterText[1] ?? chapterText[2]), chapterText[3] ?? "")
        summarySlot.open = true
        continue
      }
      const specialChapterText = SPECIAL_CHAPTER_TEXT_RE.exec(strippedLine.text)
      // N-04：裸文本（无粗体/列表前缀）的「引子/番外/楔子」只有站在结构位（尚无章，
      // 或它就是章标题后首个非空行）时才当章 —— 否则正文里单独成段的一行会截断当前小节。
      if (specialChapterText && (currentChapter === null || summarySlotWasOpen)) {
        openChapter(null, specialChapterText[2] ?? specialChapterText[1], {
          special: specialChapterText[1],
        })
        summarySlot.open = true
        continue
      }
    }

    // ④ 小节（`### 本章目标` 等）
    const sectionMatched = SECTION_HEADING_RE.exec(trimmed)
    if (sectionMatched && (currentChapter || currentVolume)) {
      flushSection()
      currentSection = { label: sectionMatched[1], body: [] }
      continue
    }

    // ④' 粗体行内标签（`**本章目标**：内容`）：只在标签命中已知字段时才采信，
    // 避免把任意「**人名**：台词」误当字段。
    const inlineSection = INLINE_SECTION_RE.exec(trimmed)
    if (inlineSection && currentChapter && isSectionLabel(inlineSection[1])) {
      flushSection()
      applySection(currentChapter, inlineSection[1], [inlineSection[2]])
      continue
    }

    // ④'' 章标题后的无键摘要（R-10 + N-02）：孵化器真实形态是「### 第N章 标题」下一行直接写
    // 剧情摘要，没有字段标签。只消费「紧邻章标题的第一个非空行」，并排除表格行/代码围栏/
    // 分隔线/单级标题/引用块 —— 不设界就会把台词、引用、多行正文全吸进 prose.goal，
    // 顺带把 confidence 抬成假 high。
    if (
      summarySlotWasOpen &&
      currentChapter &&
      !currentSection &&
      !strippedLine.prefixed &&
      strippedLine.text &&
      isBareSummaryLine(trimmed)
    ) {
      currentChapter.prose.goal = appendText(currentChapter.prose.goal, strippedLine.text)
      continue
    }

    if (currentSection) currentSection.body.push(line)
  }
  flushSection()

  if (chapterHeadings === 0 && !structured) {
    warnings.push("未识别到任何章标题，模型为空")
  }

  if (!structured && volumeHeadings === 0 && chapterHeadings > 0) {
    warnVolumeFallback()
  }

  const model = normalizeOutlineModel({
    schemaVersion: OUTLINE_MODEL_SCHEMA_VERSION,
    volumes: volumes.sort((a, b) => a.number - b.number),
    updatedAt,
  })

  const signals = buildSignals(model, {
    volumeHeadings,
    chapterHeadings,
    warnings: warnings.length,
  })
  const { confidence, confidenceScore } = gradeConfidence(signals, warnings)

  return { model, confidence, confidenceScore, signals, warnings, source: "heading" }
}

function readModelObject(raw: Record<string, unknown>, updatedAt: string): OutlineModel {
  const rawVolumes = Array.isArray(raw.volumes) ? raw.volumes : []
  const volumes: OutlineModelVolume[] = rawVolumes.map((item) => {
    const volume = (item ?? {}) as Record<string, unknown>
    const number = readNumber(volume.number) ?? 1
    const rawChapters = Array.isArray(volume.chapters) ? volume.chapters : []
    const chapters: OutlineModelChapter[] = rawChapters.map((chapterItem) => {
      const chapter = (chapterItem ?? {}) as Record<string, unknown>
      const chapterNumber = readNumber(chapter.chapter) ?? 1
      const built = createChapter(number, chapterNumber, readString(chapter.title), updatedAt)
      built.arc = readString(chapter.arc)
      built.pov = normalizeOutlinePov(readString(chapter.pov))
      built.entities = readStringArray(chapter.entities)
      built.constraints = readStringArray(chapter.constraints)
      const foreshadow = (chapter.foreshadow ?? {}) as Record<string, unknown>
      built.foreshadow = {
        plant: readStringArray(foreshadow.plant),
        payoff: readStringArray(foreshadow.payoff),
      }
      const prose = (chapter.prose ?? {}) as Record<string, unknown>
      built.prose = {
        goal: readString(prose.goal),
        scenes: readStringArray(prose.scenes),
        emotion: readString(prose.emotion),
      }
      built.updatedAt = readString(chapter.updatedAt) || updatedAt
      return built
    })
    return {
      number,
      title: readString(volume.title) || `第${number}卷`,
      arc: readString(volume.arc),
      chapters,
    }
  })
  return {
    schemaVersion: OUTLINE_MODEL_SCHEMA_VERSION,
    volumes: volumes.sort((a, b) => a.number - b.number),
    updatedAt: readString(raw.updatedAt) || updatedAt,
  }
}

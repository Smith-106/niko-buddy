import { parseFrontmatter } from "@/lib/frontmatter"
import { parseChineseInteger } from "./chapter-import"
import {
  OUTLINE_MODEL_SCHEMA_VERSION,
  flattenOutlineChapters,
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
  built.pov = readString(fm.pov)
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

function applySection(chapter: OutlineModelChapter, label: string, body: string[]): void {
  if (matchKey(label, ARC_KEYS)) {
    chapter.arc = appendText(chapter.arc, sectionText(body))
    return
  }
  if (matchKey(label, POV_KEYS)) {
    chapter.pov = sectionText(body)
    return
  }
  if (matchKey(label, GOAL_KEYS)) {
    chapter.prose.goal = sectionText(body)
    return
  }
  if (matchKey(label, SCENE_KEYS)) {
    chapter.prose.scenes = collectListItems(body)
    return
  }
  if (matchKey(label, EMOTION_KEYS)) {
    chapter.prose.emotion = sectionText(body)
    return
  }
  if (matchKey(label, ENTITY_KEYS)) {
    chapter.entities = collectListItems(body)
    return
  }
  if (matchKey(label, CONSTRAINT_KEYS)) {
    chapter.constraints = collectListItems(body)
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

/** 字段填充计数：七类结构字段里非空的项数（foreshadow 任一方向即算填充）。 */
function countFilledSections(chapter: OutlineModelChapter): number {
  let filled = 0
  if (chapter.arc.trim()) filled += 1
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
    nonEmptyTitles: chapters.filter((chapter) => chapter.title.trim().length > 0).length,
    filledSections: chapters.reduce((sum, chapter) => sum + countFilledSections(chapter), 0),
    warnings: input.warnings,
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * 量化打分（权重固定、可复算）：基线 0.2 + 有章标题 0.25 + 有卷标题 0.2 +
 * 标题非空率 0.2 + 字段填充率 0.25 - 每条 warning 0.05。
 */
function scoreConfidence(signals: OutlineModelParseSignals): number {
  const titleRate = signals.nonEmptyTitles / Math.max(signals.chapterHeadings, 1)
  const fillRate = signals.filledSections / Math.max(signals.chapterHeadings * 7, 1)
  const raw =
    0.2 +
    0.25 * (signals.chapterHeadings > 0 ? 1 : 0) +
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

  const openChapter = (numberRaw: number | null, rawTitle: string): void => {
    flushSection()
    pendingTitle.volume = null
    const title = rawTitle.trim()
    if (!currentVolume) {
      currentVolume = ensureVolume(1, "第1卷")
      warnings.push("未识别到卷标题，已归入第 1 卷")
    }
    const number = clampNumber(numberRaw, currentVolume.chapters.length + 1, "章号")
    chapterHeadings += 1
    const existing = currentVolume.chapters.find((item) => item.chapter === number)
    if (existing) {
      // 单章文件既有 frontmatter 卷章字段又有「第N章」标题时，复用已挂载的章，
      // 避免同一章被解析成两份（也顺带收掉旧文本里的重复章号）。
      currentChapter = existing
      if (title && !existing.title.trim()) existing.title = title
      return
    }
    currentChapter = createChapter(currentVolume.number, number, title, updatedAt)
    currentVolume.chapters.push(currentChapter)
  }

  /** 卷标题续行判定：短、不成句、不是 heading / 卷章标题 / 小节标签。 */
  const isVolumeTitleContinuation = (line: string): boolean => {
    if (line.length > 30) return false
    if (line.endsWith("。") || line.endsWith("；")) return false
    if (VOLUME_HEADING_RE.test(line) || CHAPTER_HEADING_RE.test(line)) return false
    if (SECTION_HEADING_RE.test(line)) return false
    const stripped = stripLineMarkup(line)
    if (VOLUME_TEXT_RE.test(stripped.text) || CHAPTER_TEXT_RE.test(stripped.text)) return false
    if (isSectionLabel(stripped.text)) return false
    return true
  }

  // 单章文件（frontmatter 带 volume/chapter）：先挂载，让正文小节能附着到它。
  if (structured) {
    const volumeTitle = readString(fm.volume_title) || `第${structured.volume}卷`
    currentVolume = ensureVolume(structured.volume, volumeTitle)
    currentVolume.chapters.push(structured)
    currentChapter = structured
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (currentSection) currentSection.body.push("")
      continue
    }

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

    if (currentSection) currentSection.body.push(line)
  }
  flushSection()

  if (chapterHeadings === 0 && !structured) {
    warnings.push("未识别到任何章标题，模型为空")
  }

  if (volumeHeadings === 0 && chapterHeadings > 0) {
    warnings.push("正文未识别到卷标题，全部章节归入第 1 卷")
  }

  const model: OutlineModel = {
    schemaVersion: OUTLINE_MODEL_SCHEMA_VERSION,
    volumes: volumes.sort((a, b) => a.number - b.number),
    updatedAt,
  }

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
      built.pov = readString(chapter.pov)
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

import { parseFrontmatter } from "@/lib/frontmatter"
import { parseChineseInteger } from "./chapter-import"
import {
  OUTLINE_MODEL_SCHEMA_VERSION,
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
 *      等字段 → 直接采信（confidence=high）。
 *   2. **回退**：按 heading 识别「第N卷 / 第N章」与固定小节（本章目标/场景/情绪/
 *      登场/伏笔/约束）→ confidence=high（卷章齐全）或 low（缺卷/缺章，已记 warning）。
 *
 * 回退解析必然有损（作者自由写法无法穷举），因此结果始终带 warnings，供导入流程
 * 提示人工确认；解析器本身不写盘、不猜测不存在的结构。
 */

export type OutlineModelParseSource = "frontmatter" | "heading"

export interface ParsedOutlineModel {
  model: OutlineModel
  confidence: "high" | "low"
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

const GOAL_KEYS = ["本章目标", "目标", "章节目标"]
const ARC_KEYS = ["弧线", "所属弧线", "arc"]
const SCENE_KEYS = ["场景", "场景序列", "分场"]
const EMOTION_KEYS = ["情绪", "情绪线", "情绪曲线"]
const ENTITY_KEYS = ["登场", "登场角色", "实体", "出场角色"]
const FORESHADOW_KEYS = ["伏笔", "伏笔引用"]
const CONSTRAINT_KEYS = ["约束", "禁止", "限制", "约束与禁止"]

function normalizeLabel(value: string): string {
  return value.replace(/[\s:：]/g, "")
}

function matchKey(label: string, keys: string[]): boolean {
  const normalized = normalizeLabel(label)
  return keys.some((key) => normalized === normalizeLabel(key) || normalized.startsWith(normalizeLabel(key)))
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
  built.entities = readStringArray(fm.entities)
  built.constraints = readStringArray(fm.constraints)
  built.foreshadow = {
    plant: readStringArray(fm.foreshadow_plant ?? fm.foreshadowPlant),
    payoff: readStringArray(fm.foreshadow_payoff ?? fm.foreshadowPayoff),
  }
  return built
}

function applySection(chapter: OutlineModelChapter, label: string, body: string[]): void {
  if (matchKey(label, ARC_KEYS)) {
    chapter.arc = body.map((line) => line.trim()).filter(Boolean).join("\n")
    return
  }
  if (matchKey(label, GOAL_KEYS)) {
    chapter.prose.goal = body.map((line) => line.trim()).filter(Boolean).join("\n")
    return
  }
  if (matchKey(label, SCENE_KEYS)) {
    chapter.prose.scenes = collectListItems(body)
    return
  }
  if (matchKey(label, EMOTION_KEYS)) {
    chapter.prose.emotion = body.map((line) => line.trim()).filter(Boolean).join("\n")
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
    return {
      model,
      confidence: model.volumes.length > 0 ? "high" : "low",
      warnings: model.volumes.length > 0 ? [] : ["frontmatter.outline_model 未包含任何卷"],
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
  let sawVolumeHeading = false
  let sawChapterHeading = false

  const flushSection = (): void => {
    if (currentSection) {
      if (currentChapter) {
        applySection(currentChapter, currentSection.label, currentSection.body)
      } else if (currentVolume && matchKey(currentSection.label, ARC_KEYS)) {
        currentVolume.arc = currentSection.body.map((line) => line.trim()).filter(Boolean).join("\n")
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

    const volumeMatched = VOLUME_HEADING_RE.exec(trimmed)
    if (volumeMatched) {
      flushSection()
      const number = numberFromLabel(volumeMatched[1] ?? volumeMatched[2] ?? volumeMatched[3]) ?? volumes.length + 1
      const title = (volumeMatched[4] ?? "").trim() || `第${number}卷`
      currentVolume = ensureVolume(number, title)
      currentChapter = null
      sawVolumeHeading = true
      continue
    }

    const chapterMatched = CHAPTER_HEADING_RE.exec(trimmed)
    if (chapterMatched) {
      flushSection()
      const number = numberFromLabel(chapterMatched[1] ?? chapterMatched[2]) ?? 1
      const title = (chapterMatched[3] ?? "").trim()
      if (!currentVolume) {
        currentVolume = ensureVolume(1, "第1卷")
        warnings.push("未识别到卷标题，已归入第 1 卷")
      }
      const existing = currentVolume.chapters.find((item) => item.chapter === number)
      if (existing) {
        // 单章文件既有 frontmatter 卷章字段又有「第N章」标题时，复用已挂载的章，
        // 避免同一章被解析成两份（也顺带收掉旧文本里的重复章号）。
        currentChapter = existing
        if (title && !existing.title.trim()) existing.title = title
        continue
      }
      currentChapter = createChapter(currentVolume.number, number, title, updatedAt)
      currentVolume.chapters.push(currentChapter)
      sawChapterHeading = true
      continue
    }

    const sectionMatched = SECTION_HEADING_RE.exec(trimmed)
    if (sectionMatched && (currentChapter || currentVolume)) {
      flushSection()
      currentSection = { label: sectionMatched[1], body: [] }
      continue
    }

    if (currentSection) currentSection.body.push(line)
  }
  flushSection()

  if (!sawChapterHeading && !structured) {
    warnings.push("未识别到任何章标题，模型为空")
  }

  if (!sawVolumeHeading && sawChapterHeading) {
    warnings.push("正文未识别到卷标题，全部章节归入第 1 卷")
  }

  const model: OutlineModel = {
    schemaVersion: OUTLINE_MODEL_SCHEMA_VERSION,
    volumes: volumes.sort((a, b) => a.number - b.number),
    updatedAt,
  }

  const confidence: ParsedOutlineModel["confidence"] =
    sawChapterHeading && sawVolumeHeading ? "high" : "low"

  return { model, confidence, warnings, source: "heading" }
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

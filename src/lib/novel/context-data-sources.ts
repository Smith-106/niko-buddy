/**
 * 具体数据源实现
 * 将原有的数据获取函数重构为数据源对象
 */

import yaml from "js-yaml"
import { listDirectory, readFile } from "@/commands/fs"
import { searchWiki } from "@/lib/search"
import { parseFrontmatter } from "@/lib/frontmatter"
import { normalizePath } from "@/lib/path-utils"
import { parseChapterMeta } from "./chapter-meta"
import { extractChapterNumber, flattenMdFiles } from "./chapter-utils"
import { listSnapshots, loadSnapshot, type ChapterSnapshot } from "./chapter-ingest"
import { loadChapterSummaries, chapterSummariesToContextText } from "./chapter-summaries"
import { loadRevisionFeedbackForContext, createEmptyRevisionFeedback, type NovelRevisionFeedback } from "./revision-feedback"
import { readCognitionStatesText } from "./context-derived-stores"
import { getChapterVolumes } from "./volume"
import { readSoulDoc } from "./soul-doc"
import { buildWritingStyleContext } from "./writing-style-store"
import type { DataSource, ContextLoadContext } from "./context-data-source"
import { loadBinding } from "./story-simulation/framework-binding"
import { loadFrameworks } from "./story-simulation/framework-store"

// ISS-20260709-031: 单向依赖 —— 直接引用各 helper 的定义源模块，
// 不再经由 ./context-engine 中转（后者聚合 getAllDataSources，本模块再
// 回引它即构成 context-engine ↔ context-data-sources 运行时双向 import）。
// 定义源：大纲读取 ← context-engine-outline；检索 ← context-retrieval；
// 纯组装（join/select） ← context-task-brief-builders。三者均零运行时
// 回引 context-engine / context-data-sources（仅 type-only import）。
import {
  readOutlineContent,
  readChapterOutlineContent,
} from "./context-engine-outline"
import {
  searchRelevantContentUnified,
  searchGraphRelevantContent,
} from "./context-retrieval"
import {
  selectLookbackChapterNumbers,
  joinNonEmpty,
} from "./context-task-brief-builders"

const RECENT_CHAPTER_CONTENT_MAX_CHARS = 6000
const RECENT_CHAPTER_CONTENT_HEAD_CHARS = 2200
const RECENT_CHAPTER_CONTENT_TAIL_CHARS = 3200
/** Tail chars used as previousChapterEnding when only draft.md is available (no snapshot/wiki). */
const DRAFT_ENDING_TAIL_CHARS = 1200
/** Head chars used as a fact-style pseudo-summary when snapshots are missing. */
const DRAFT_SUMMARY_HEAD_CHARS = 400

function selectRecentChapterNumbersForContent(chapterNumber: number | undefined, count: number): number[] {
  if (!chapterNumber || chapterNumber <= 1) return []
  const start = Math.max(1, chapterNumber - Math.max(1, count))
  const numbers: number[] = []
  for (let current = start; current < chapterNumber; current += 1) {
    numbers.push(current)
  }
  return numbers
}

function stripFrontmatterBody(content: string): string {
  return parseFrontmatter(content).body.trim()
}

type FormalChapterRead =
  | { chapterNumber: number | null; content: string }
  | { chapterNumber: number | null; error: unknown }

async function readFormalChapterContents(
  projectPath: string,
  chapterNumbers: number[],
): Promise<{ contents: Map<number, string>; errors: unknown[] }> {
  const contents = new Map<number, string>()
  const errors: unknown[] = []
  const targets = new Set<number>()
  for (const chapterNumber of chapterNumbers) {
    if (Number.isSafeInteger(chapterNumber) && chapterNumber > 0) targets.add(chapterNumber)
    else errors.push(new Error(`Invalid chapter number: ${chapterNumber}`))
  }
  if (targets.size === 0) return { contents, errors }

  // 目录与本次原文只在当前 load 内保留；逻辑 wiki 路径由现有 FS 合同映射。
  const chapterRoot = `${normalizePath(projectPath).replace(/\/+$/, "")}/wiki/chapters`
  let files: ReturnType<typeof flattenMdFiles>
  try {
    files = flattenMdFiles(await listDirectory(chapterRoot))
  } catch (error) {
    errors.push(error)
    return { contents, errors }
  }
  const candidates = files
    .map((file) => ({ ...file, byName: extractChapterNumber(file.name.replace(/\.md$/, "")) }))
    .filter((file) => file.byName === null || targets.has(file.byName))
  const reads = await Promise.all(candidates.map(async (file): Promise<FormalChapterRead> => {
    try {
      const path = normalizePath(file.path)
      if (!path.startsWith(`${chapterRoot}/`) || path.split("/").some((part) => part === "." || part === "..")
        || path.slice(path.lastIndexOf("/") + 1) !== file.name) {
        throw new Error(`Invalid chapter path: ${file.path}`)
      }
      const content = await readFile(file.path)
      const parsed = parseFrontmatter(content)
      const frontmatter = parsed.frontmatter
      // null 同时表示空元数据和解析失败；仅检查 parser 已定位的 YAML 块，
      // 合法空块与没有 frontmatter 的旧正文继续按文件名识别。
      if (!frontmatter && parsed.rawBlock) {
        const lines = parsed.rawBlock.split(/\r?\n/)
        const closingFence = lines.map((line) => line.trim()).lastIndexOf("---")
        yaml.load(lines.slice(1, closingFence).join("\n"), { schema: yaml.JSON_SCHEMA })
      }
      const hasChapterNumber = Object.prototype.hasOwnProperty.call(frontmatter ?? {}, "chapter_number")
      const meta = hasChapterNumber ? parseChapterMeta(frontmatter ?? {}) : null
      if (hasChapterNumber && (!meta || !Number.isSafeInteger(meta.chapterNumber) || meta.chapterNumber <= 0)) {
        throw new Error(`Invalid chapter identity: ${file.path}`)
      }
      if (file.byName !== null && (!Number.isSafeInteger(file.byName) || file.byName <= 0
        || (meta && meta.chapterNumber !== file.byName))) {
        throw new Error(`Conflicting chapter identity: ${file.path}`)
      }
      return { chapterNumber: file.byName ?? meta?.chapterNumber ?? null, content }
    } catch (error) {
      return { chapterNumber: file.byName, error }
    }
  }))

  const failedChapters = new Set<number>()
  for (const result of reads) {
    if ("error" in result) {
      errors.push(result.error)
      // 无数字名候选的失败无法定位章号，保留其他已验正文但必须留下总 gap。
      if (result.chapterNumber !== null) failedChapters.add(result.chapterNumber)
      continue
    }
    if (result.chapterNumber === null || !targets.has(result.chapterNumber)) continue
    if (contents.has(result.chapterNumber)) {
      failedChapters.add(result.chapterNumber)
      errors.push(new Error(`Ambiguous chapter number: ${result.chapterNumber}`))
    } else {
      contents.set(result.chapterNumber, result.content)
    }
  }
  for (const chapterNumber of failedChapters) contents.delete(chapterNumber)
  return { contents, errors }
}

function excerptChapterContent(body: string): string {
  const normalized = body.trim()
  if (normalized.length <= RECENT_CHAPTER_CONTENT_MAX_CHARS) return normalized
  const head = normalized.slice(0, RECENT_CHAPTER_CONTENT_HEAD_CHARS).trimEnd()
  const tail = normalized.slice(-RECENT_CHAPTER_CONTENT_TAIL_CHARS).trimStart()
  return `${head}\n\n[章节正文中段已按上下文预算省略]\n\n${tail}`
}

/**
 * Draft-first prior-pack fallback (knowhow tip-20260808-6a2d3059f753c4a8):
 * mid-chapter Track A review must not ship an empty previousChapterEnding /
 * recentSummaries / recentChapterContents when snapshots or wiki pages are
 * missing. Formal body lives at `.novel/chapters/{n}/draft.md`.
 */
function novelDraftPath(projectPath: string, chapterNumber: number): string {
  const pp = normalizePath(projectPath)
  return `${pp}/.novel/chapters/${chapterNumber}/draft.md`
}

async function readNovelDraftBody(projectPath: string, chapterNumber: number): Promise<string> {
  /* v8 ignore next */
  if (!chapterNumber || chapterNumber < 1) return ""
  try {
    const raw = await readFile(novelDraftPath(projectPath, chapterNumber))
    return stripFrontmatterBody(raw)
  } catch {
    return ""
  }
}

function draftEndingExcerpt(body: string): string {
  const lines = body.trim().split("\n")
  return lines.slice(-30).join("\n").slice(-DRAFT_ENDING_TAIL_CHARS)
}

function draftSummaryLine(chapterNumber: number, body: string): string {
  const head = body.trim().replace(/\s+/g, " ").slice(0, DRAFT_SUMMARY_HEAD_CHARS)
  return head ? `第${chapterNumber}章（draft 节选）：${head}` /* v8 ignore start */ /* v8 ignore stop */ : ""
}

/**
 * 大纲数据源
 */
export const outlineDataSource: DataSource<string> = {
  name: "outline",
  priority: 1,
  async load(context: ContextLoadContext): Promise<string> {
    return await readOutlineContent(context.projectPath)
  },
}

/**
 * 章节大纲数据源
 */
export const chapterOutlineDataSource: DataSource<string> = {
  name: "chapterOutline",
  priority: 2,
  async load(context: ContextLoadContext): Promise<string> {
    if (!context.chapterNumber) return ""
    return await readChapterOutlineContent(context.projectPath, context.chapterNumber)
  },
}

/**
 * 卷信息数据源
 */
export const volumeContextDataSource: DataSource<string> = {
  name: "volumeContext",
  priority: 3,
  async load(context: ContextLoadContext): Promise<string> {
    if (!context.chapterNumber) return ""
    try {
      const volumes = await getChapterVolumes(context.projectPath, context.chapterNumber)
      if (volumes.length === 0) return ""
      return volumes
        .map(v => {
          const parts = [`第${v.volumeNumber}卷：${v.title}`]
          if (v.summary) parts.push(`概要：${v.summary}`)
          if (v.chapterRangeStart !== undefined && v.chapterRangeEnd !== undefined) {
            parts.push(`章节范围：第${v.chapterRangeStart}章 - 第${v.chapterRangeEnd}章`)
          }
          return parts.join("\n")
        })
        .join("\n\n")
    } catch (err) {
      context.recordGap?.("volumeContext", "datasource_error")
      return ""
    }
  },
}

/**
 * 快照上下文数据源
 */
export const snapshotDataSource: DataSource<{
  recentSummaries: string[]
  previousChapterEnding: string
  characterStates: string
  foreshadowingSignals: string[]
  timeline: string
  /**
   * P2-IMP-10 (M2): stateDelta additive 字段 — chapter_summaries 投影键控子表文本。
   * 由 chapterSummariesToContextText 渲染（近 N 章摘要 + 状态变更行）；空 store / 无快照
   * 降级路径缺失（undefined）→ 消费方不渲染该段（字节级不变）。
   */
  recentStateDeltas?: string
}> = {
  name: "snapshots",
  priority: 4,
  async load(context: ContextLoadContext) {
    const { projectPath, chapterNumber, config } = context
    const snapshotNumbers = await listSnapshots(projectPath)
    
    if (snapshotNumbers.length === 0) {
      return {
        recentSummaries: [],
        previousChapterEnding: "",
        characterStates: "",
        foreshadowingSignals: [],
        timeline: "",
      }
    }

    const lookbackNumbers = chapterNumber
      ? selectLookbackChapterNumbers(chapterNumber, config.snapshotLookback)
      : [...snapshotNumbers].sort((a, b) => b - a).slice(0, config.snapshotLookback)
    
    const summaryNumbers = chapterNumber
      ? snapshotNumbers.filter((n) => n < chapterNumber).slice(-config.recentSummaryWindow)
      : snapshotNumbers.slice(-config.recentSummaryWindow)

    const [lookbackSnapshots, summarySnapshots] = await Promise.all([
      Promise.all(lookbackNumbers.map((n) => loadSnapshot(projectPath, n))),
      Promise.all(summaryNumbers.map((n) => loadSnapshot(projectPath, n))),
    ])

    const validLookback = lookbackSnapshots.filter((snapshot): snapshot is ChapterSnapshot => Boolean(snapshot))
    const validSummarySnapshots = summarySnapshots.filter((snapshot): snapshot is ChapterSnapshot => Boolean(snapshot))

    const previousSnapshot = validLookback[0]
    const recentSummaries = validSummarySnapshots.map((snapshot) => `第${snapshot.chapterNumber}章：${snapshot.summary}`)
    // P2-IMP-10 (M2): stateDelta additive — chapter_summaries 投影 store 渲染。
    // chapterSummariesToContextText 近 N 章键控子表（空 store → ''）；加载失败
    // 降级空 store（投影 fold_rebuildable，缺失不阻断主链）。窗口与
    // recentSummaryWindow 对齐（无效/缺省回退函数默认 3）。
    const summariesStore = await loadChapterSummaries(projectPath).catch(() => null)
    const summariesBeforeChapter = summariesStore && chapterNumber
      ? {
        ...summariesStore,
        entries: summariesStore.entries.filter((entry) => entry.chapter < chapterNumber),
      }
      : summariesStore
    const recentStateDeltas = summariesBeforeChapter
      ? chapterSummariesToContextText(summariesBeforeChapter, config.recentSummaryWindow > 0 ? config.recentSummaryWindow : 3)
      : ""
    const characterStates = joinNonEmpty(
      validLookback
        .flatMap((snapshot) => snapshot.characterStateChanges.map((change) => `第${snapshot.chapterNumber}章：${change}`)),
      "\n",
    )
    const foreshadowingSignals = validLookback.flatMap((snapshot) => snapshot.foreshadowingChanges)
    const timeline = joinNonEmpty(
      validLookback
        .flatMap((snapshot) => snapshot.timelineEvents.map((event) => `第${snapshot.chapterNumber}章：${event}`)),
      "\n",
    )

    return {
      recentSummaries,
      previousChapterEnding: previousSnapshot?.endingHook || "",
      characterStates,
      foreshadowingSignals,
      timeline,
      recentStateDeltas,
    }
  },
}

/**
 * 降级：近期章节摘要数据源
 */
export const recentChapterContentsDataSource: DataSource<string[]> = {
  name: "recentChapterContents",
  priority: 5,
  async load(context: ContextLoadContext): Promise<string[]> {
    const chapterNumbers = selectRecentChapterNumbersForContent(
      context.chapterNumber,
      context.config.recentSummaryWindow,
    )
    if (chapterNumbers.length === 0) return []

    // 按真实文件身份读前情，避免普通 token OR 搜索首项冒充指定章节。
    // 各章回退独立并行且按窗口保序，任何正式或 draft 失败只记录一次 gap。
    const { contents, errors } = await readFormalChapterContents(context.projectPath, chapterNumbers)
    const results = await Promise.all(
      chapterNumbers.map(async (chapterNumber) => {
        if (!Number.isSafeInteger(chapterNumber) || chapterNumber <= 0) return null
        const content = contents.get(chapterNumber)
        if (content !== undefined) {
          const body = stripFrontmatterBody(content)
          if (body) return `## 第${chapterNumber}章正文片段\n${excerptChapterContent(body)}`
        }
        try {
          const draftBody = stripFrontmatterBody(await readFile(novelDraftPath(context.projectPath, chapterNumber)))
          if (!draftBody) return null
          return `## 第${chapterNumber}章正文片段（draft）\n${excerptChapterContent(draftBody)}`
        } catch (error) {
          errors.push(error)
          return null
        }
      }),
    )
    if (errors.length > 0) context.recordGap?.("recentChapterContents", "datasource_error")
    return results.filter((r): r is string => r !== null)
  },
}

export const fallbackRecentSummariesDataSource: DataSource<string[]> = {
  name: "fallbackRecentSummaries",
  priority: 5,
  async load(context: ContextLoadContext): Promise<string[]> {
    const summaries: string[] = []
    try {
      const results = await searchWiki(context.projectPath, "type:chapter")
      // PAT-T1 (odyssey sibling): parallelize the per-chapter read+parse —
      // the fallback twin of recentChapterContentsDataSource (PERF-NEW-03
      // fixed the primary; this fallback was still serial). Each iteration is
      // independent (own file path + own parse), so Promise.all + filter
      // preserves order without serial N IPC round-trips.
      // IC-02: per-item read failures must surface exactly once. The outer
      // searchWiki catch (below) covers index-level failure; this flag covers
      // item-level drops without double-counting when both fire (the outer
      // throw path never sets the flag).
      let itemLoadFailed = false
      const candidates = context.chapterNumber && context.config.recentSummaryWindow > 0
        ? results
        : results.slice(0, context.config.recentSummaryWindow)
      const fetched = await Promise.all(
        candidates.map(async (r) => {
          try {
            const content = await readFile(r.path)
            const parsed = parseFrontmatter(content)
            const fm = parsed.frontmatter as Record<string, unknown> | null
            const meta = fm ? parseChapterMeta(fm) : null
            if (meta && (!context.chapterNumber || meta.chapterNumber < context.chapterNumber)) {
              const bodyStart = content.indexOf("---", 4)
              /* v8 ignore next */
              const body = bodyStart >= 0 ? content.slice(bodyStart + 3).trim() : content
              return { chapter: meta.chapterNumber, text: `第${meta.chapterNumber}章 (${meta.status}): ${body.slice(0, 800)}` }
            }
            return null
          } catch {
            itemLoadFailed = true
            return null
          }
        }),
      )
      if (itemLoadFailed) context.recordGap?.("fallbackRecentSummaries", "datasource_error")
      const eligible = fetched.filter((s): s is { chapter: number; text: string } => s !== null)
      // 指定目标章时，先过滤历史章，再截取最近 N 章并按章号升序渲染。
      const selected = context.chapterNumber
        ? eligible.sort((a, b) => b.chapter - a.chapter).slice(0, context.config.recentSummaryWindow).reverse()
        : eligible
      for (const s of selected) summaries.push(s.text)
    } catch (err) {
      context.recordGap?.("fallbackRecentSummaries", "datasource_error")
    }
    // Draft-first prior pack: if wiki chapter pages are empty, synthesize
    // short summaries from previous draft.md bodies so mid-chapter Track A
    // review is not empty (knowhow tip-20260808-6a2d3059f753c4a8).
    if (summaries.length === 0 && context.chapterNumber && context.chapterNumber > 1) {
      const nums = selectRecentChapterNumbersForContent(
        context.chapterNumber,
        Math.min(2, context.config.recentSummaryWindow || 2),
      )
      const draftSummaries = await Promise.all(
        nums.map(async (n) => {
          const body = await readNovelDraftBody(context.projectPath, n)
          return body ? draftSummaryLine(n, body) : ""
        }),
      )
      for (const s of draftSummaries) {
        if (s) summaries.push(s)
      }
    }
    return summaries
  },
}

export const fallbackPreviousEndingDataSource: DataSource<string> = {
  name: "fallbackPreviousEnding",
  priority: 6,
  async load(context: ContextLoadContext): Promise<string> {
    if (!context.chapterNumber || context.chapterNumber <= 1) return ""
    const chapterNumber = context.chapterNumber - 1
    const { contents, errors } = await readFormalChapterContents(context.projectPath, [chapterNumber])
    const content = contents.get(chapterNumber)
    let ending = ""
    if (content !== undefined) {
      const bodyStart = content.indexOf("---", 4)
      const body = bodyStart >= 0 ? content.slice(bodyStart + 3).trim() : content
      const lines = body.split("\n")
      ending = lines.slice(-30).join("\n").slice(-DRAFT_ENDING_TAIL_CHARS)
    }
    if (!ending && Number.isSafeInteger(chapterNumber) && chapterNumber > 0) {
      try {
        const draftBody = stripFrontmatterBody(await readFile(novelDraftPath(context.projectPath, chapterNumber)))
        if (draftBody) ending = draftEndingExcerpt(draftBody)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) context.recordGap?.("fallbackPreviousEnding", "datasource_error")
    return ending
  },
}

export const fallbackCharacterStatesDataSource: DataSource<string> = {
  name: "fallbackCharacterStates",
  priority: 7,
  async load(context: ContextLoadContext): Promise<string> {
    const beforeChapter = context.chapterNumber
    if (beforeChapter !== undefined && (!Number.isInteger(beforeChapter) || beforeChapter <= 0)) {
      context.recordGap?.("fallbackCharacterStates", "temporal_history_unavailable")
      return ""
    }
    // Prefer structured character-states.json (non-empty after seed/ingest) before wiki search.
    try {
      // ISS-20260709-048: character-state 为显式懒加载依赖（首屏不进主 chunk）。
      // CharacterStateModule 类型别名向类型系统声明依赖边；运行时 dynamic
      // import 保持懒加载。反向无环由 p1-decouple.spec 断言。
      type CharacterStateModule = typeof import("./character-state")
      const stateModule: CharacterStateModule = await import("./character-state")
      const { loadCharacterStates, characterStatesToContextText } = stateModule
      const store = await loadCharacterStates(context.projectPath)
      if (beforeChapter !== undefined) {
        // 整条状态必须已有可信章号；过滤为空也不能回落到混合了未来事实的 wiki 正文。
        const characters = store.characters.filter((character) =>
          Number.isInteger(character.lastUpdatedChapter)
          && character.lastUpdatedChapter > 0
          && character.lastUpdatedChapter < beforeChapter,
        )
        if (characters.length === 0 || characters.length < store.characters.length) {
          context.recordGap?.("fallbackCharacterStates", "temporal_history_unavailable")
        }
        return characterStatesToContextText({ ...store, characters }).slice(0, 3000)
      }
      const structured = characterStatesToContextText(store)
      if (structured.trim()) return structured.slice(0, 3000)
    } catch {
      if (beforeChapter !== undefined) {
        context.recordGap?.("fallbackCharacterStates", "datasource_error")
        return ""
      }
      // 未指定章号时保持原有 structured → wiki 读取顺序。
    }
    try {
      const results = await searchWiki(context.projectPath, "type:entity character")
      if (results.length > 0) {
        const contents = await Promise.all(results.slice(0, 5).map(r => readFile(r.path).catch(() => "")))
        return contents.filter(Boolean).join("\n---\n").slice(0, 3000)
      }
    } catch {
      context.recordGap?.("fallbackCharacterStates", "datasource_error")
    }
    return ""
  },
}

/**
 * 降级：伏笔状态数据源
 */
export const fallbackForeshadowingStatesDataSource: DataSource<string> = {
  name: "fallbackForeshadowingStates",
  priority: 8,
  async load(context: ContextLoadContext): Promise<string> {
    try {
      const results = await searchWiki(context.projectPath, "伏笔 foreshadowing")
      if (results.length > 0) {
        const contents = await Promise.all(results.slice(0, 3).map(r => readFile(r.path).catch(() => "")))
        return contents.filter(Boolean).join("\n---\n").slice(0, 2000)
      }
    } catch {
      context.recordGap?.("fallbackForeshadowingStates", "datasource_error")
    }
    return ""
  },
}

/**
 * 降级：时间线数据源
 */
export const fallbackTimelineDataSource: DataSource<string> = {
  name: "fallbackTimeline",
  priority: 9,
  async load(context: ContextLoadContext): Promise<string> {
    try {
      const results = await searchWiki(context.projectPath, "timeline 时间线")
      if (results.length > 0) {
        const content = await readFile(results[0].path)
        return content.slice(0, 2000)
      }
    } catch {
      context.recordGap?.("fallbackTimeline", "datasource_error")
    }
    return ""
  },
}

/**
 * 相关设定数据源
 */
export const relatedSettingsDataSource: DataSource<string> = {
  name: "relatedSettings",
  priority: 10,
  async load(context: ContextLoadContext): Promise<string> {
    try {
      const results = await searchWiki(context.projectPath, "setting 设定 location 地点")
      if (results.length > 0) {
        const contents = await Promise.all(results.slice(0, 3).map(r => readFile(r.path).catch(() => "")))
        return contents.filter(Boolean).join("\n---\n").slice(0, 2000)
      }
    } catch {
      context.recordGap?.("relatedSettings", "datasource_error")
    }
    return ""
  },
}

/**
 * 正史规则数据源
 */
export const canonRulesDataSource: DataSource<string> = {
  name: "canonRules",
  priority: 11,
  async load(context: ContextLoadContext): Promise<string> {
    try {
      const results = await searchWiki(context.projectPath, "canon 正史 rule 规则")
      if (results.length > 0) {
        const content = await readFile(results[0].path)
        return content.slice(0, 2000)
      }
    } catch {
      context.recordGap?.("canonRules", "datasource_error")
    }
    return ""
  },
}

/**
 * 写作风格数据源
 */
export const writingStyleDataSource: DataSource<string> = {
  name: "writingStyle",
  priority: 12,
  async load(context: ContextLoadContext): Promise<string> {
    try {
      const enabledStyle = await buildWritingStyleContext(context.projectPath)
      if (enabledStyle.trim()) return enabledStyle
    } catch (err) {
      context.recordGap?.("writingStyle", "datasource_error")
    }

    try {
      const results = await searchWiki(context.projectPath, "style 风格 writing 写作")
      if (results.length > 0) {
        const content = await readFile(results[0].path)
        return content.slice(0, 1000)
      }
    } catch (err) {
      context.recordGap?.("writingStyle", "datasource_error")
    }
    return ""
  },
}

/**
 * 搜索结果数据源
 */
export const searchResultsDataSource: DataSource<string> = {
  name: "searchResults",
  priority: 13,
  async load(context: ContextLoadContext): Promise<string> {
    return await searchRelevantContentUnified(
      context.projectPath,
      context.task,
      context.chapterNumber,
      context.config.searchTopK
    )
  },
}

/**
 * 图谱搜索结果数据源
 */
export const graphSearchResultsDataSource: DataSource<string> = {
  name: "graphSearchResults",
  priority: 14,
  async load(context: ContextLoadContext): Promise<string> {
    return await searchGraphRelevantContent(
      context.projectPath,
      context.task,
      context.chapterNumber
    )
  },
}

/**
 * 修订反馈数据源
 */
export const revisionFeedbackDataSource: DataSource<NovelRevisionFeedback> = {
  name: "revisionFeedback",
  priority: 15,
  async load(context: ContextLoadContext): Promise<NovelRevisionFeedback> {
    if (!context.chapterNumber) return createEmptyRevisionFeedback()
    return await loadRevisionFeedbackForContext(
      context.projectPath,
      context.chapterNumber,
      context.config.revisionFeedbackWindowConfig
    )
  },
}

/**
 * 认知状态数据源
 */
export const cognitionTextDataSource: DataSource<string> = {
  name: "cognitionText",
  priority: 16,
  async load(context: ContextLoadContext): Promise<string> {
    return readCognitionStatesText(context.projectPath, {
      beforeChapter: context.chapterNumber,
      recordGap: context.recordGap,
    })
  },
}

/**
 * 灵魂文档数据源
 */
export const soulDocDataSource: DataSource<string> = {
  name: "soulDoc",
  priority: 17,
  async load(context: ContextLoadContext): Promise<string> {
    return await readSoulDoc(context.projectPath)
  },
}

/**
 * 角色氛围数据源（依赖其他数据源的结果，需要后处理）
 */
export const characterAurasDataSource: DataSource<string> = {
  name: "characterAuras",
  priority: 18,
  async load(_context: ContextLoadContext): Promise<string> {
    // 这个数据源需要依赖其他数据，将在主函数中单独处理
    return ""
  },
}

/**
 * 故事模拟框架绑定数据源
 * 读取当前激活的起承转合故事框架绑定，将当前章节所属节点的冲突、目标与走向注入上下文
 */
export const storySimulationBindingDataSource: DataSource<string> = {
  name: "storySimulationBinding",
  priority: 19,
  async load(context: ContextLoadContext): Promise<string> {
    try {
      const binding = await loadBinding(context.projectPath)
      if (!binding || !binding.chapterAllocation || binding.chapterAllocation.length === 0) {
        return ""
      }
      const chNum = context.chapterNumber
      if (typeof chNum !== "number" || chNum <= 0) {
        return ""
      }
      const matched = binding.chapterAllocation.find(
        (a) => chNum >= a.startChapter && chNum <= a.endChapter,
      )
      if (!matched) return ""

      let nodeDetail = ""
      try {
        const frameworks = await loadFrameworks(context.projectPath)
        const fw = frameworks.find((f) => f.id === binding.frameworkId)
        if (fw) {
          const node = fw.nodes.find((n) => n.index === matched.nodeIndex)
          if (node) {
            nodeDetail = [
              `- 故事阶段：【${node.phase}】`,
              `- 节点任务：${node.title}`,
              `- 核心冲突：${node.coreConflict}`,
              node.involvedCharacters && node.involvedCharacters.length > 0
                ? `- 涉及角色：${node.involvedCharacters.join("、")}`
                : "",
              node.goal ? `- 阶段目标：${node.goal}` : "",
              node.causeFromPrev ? `- 承接前因：${node.causeFromPrev}` : "",
              node.expectedOutcome ? `- 预期结果：${node.expectedOutcome}` : "",
            ].filter(Boolean).join("\n")
          }
        }
      } catch {
        // 容错降级
      }

      const lines = [
        "## 故事模拟框架指引 (Story Framework Guidance)",
        `- 激活框架：${binding.frameworkTitle}`,
        `- 章节分配：第${matched.startChapter}-${matched.endChapter}章 → 【${matched.nodeTitle}】`,
      ]
      if (nodeDetail) {
        lines.push(nodeDetail)
      }
      return lines.join("\n")
    } catch {
      // IC-02: whole-source load failure with no other recorder on this path
      // (load() resolves "", so the registry adds nothing) — record exactly once.
      // Reason reuses the existing ContextGapReason union; no new member.
      context.recordGap?.("storySimulationBinding", "datasource_error")
      return ""
    }
  },
}

/**
 * 获取所有数据源
 */
export function getAllDataSources(): DataSource<unknown>[] {
  return [
    outlineDataSource,
    chapterOutlineDataSource,
    volumeContextDataSource,
    snapshotDataSource,
    recentChapterContentsDataSource,
    fallbackRecentSummariesDataSource,
    fallbackPreviousEndingDataSource,
    fallbackCharacterStatesDataSource,
    fallbackForeshadowingStatesDataSource,
    fallbackTimelineDataSource,
    relatedSettingsDataSource,
    canonRulesDataSource,
    writingStyleDataSource,
    searchResultsDataSource,
    graphSearchResultsDataSource,
    revisionFeedbackDataSource,
    cognitionTextDataSource,
    soulDocDataSource,
    characterAurasDataSource,
    storySimulationBindingDataSource,
  ]
}

/**
 * R-inkos-6 (23-inkos-coverage roadmap P1): TranslationWorkbench — 翻译术语一致性工作台.
 *
 * 吸收来源：reference/inkos packages/core/skills/inkos-translation（多语种
 * 互译并保持文风一致）+ packages/core/src/translation — 23 号覆盖审计终裁
 * roadmap P1 后本 goal 落地。
 *
 * 定位：长篇翻译的核心工程痛点是**术语/人名/地名跨章一致性**与**进度状态**。
 * LLM 翻译调用属产品层；本模块为确定性引擎层：
 *  - 术语表（Glossary）：source→target 权威映射，供翻译 prompt 注入与译文核查
 *  - 残留检测：译文中残留未翻译的 source 词（除"允许直用"标注外）→ warn
 *  - 章节翻译状态机：pending→drafted→reviewed→finalized（非法迁移拒绝）
 *
 * 不做机器翻译、不联网（桌面单机本地优先纪律）。
 */

import { createAtomicJsonStore } from "./projection-store"

export type GlossaryKind = "name" | "place" | "term" | "org"

export interface GlossaryEntry {
  /** 原文术语（源语言）。 */
  source: string
  /** 权威译文。 */
  target: string
  kind: GlossaryKind
  /** 该术语是否允许在译文中保留原文（如专有名词、咒语）。 */
  allowDirectUse?: boolean
  note?: string
}

export interface TranslationGlossary {
  entries: GlossaryEntry[]
  lastUpdated: string
}

export function createEmptyTranslationGlossary(): TranslationGlossary {
  return { entries: [], lastUpdated: new Date().toISOString() }
}

const glossaryStore = createAtomicJsonStore<TranslationGlossary>(
  "translation-glossary.json",
  createEmptyTranslationGlossary,
)

export async function saveTranslationGlossary(
  projectPath: string,
  store: TranslationGlossary,
): Promise<void> {
  await glossaryStore.save(projectPath, store)
}

export async function loadTranslationGlossary(
  projectPath: string,
): Promise<TranslationGlossary> {
  return glossaryStore.load(projectPath)
}

/** 按 source upsert 术语（source 为唯一键）。纯函数语义。 */
export function upsertGlossaryEntry(
  store: TranslationGlossary,
  entry: GlossaryEntry,
): TranslationGlossary {
  const idx = store.entries.findIndex((e) => e.source === entry.source)
  const entries =
    idx >= 0
      ? store.entries.map((e, i) => (i === idx ? entry : e))
      : [...store.entries, entry]
  return { entries, lastUpdated: new Date().toISOString() }
}

/** 渲染术语表为翻译 prompt 片段（空表返回 ""）。 */
export function glossaryToPromptFragment(store: TranslationGlossary): string {
  if (store.entries.length === 0) return ""
  const lines = store.entries.map((e) => {
    const direct = e.allowDirectUse ? "（允许保留原文）" : ""
    return `- ${e.source} → ${e.target}${direct}`
  })
  return ["## 翻译术语表（必须遵守）", ...lines].join("\n")
}

export interface GlossaryViolation {
  source: string
  expectedTarget: string
  severity: "warn" | "info"
  message: string
}

/**
 * 译文术语一致性核查（确定性子串检测）：
 *  - 非允许直用术语：译文出现 source 原文 → warn（疑似漏译）
 *  - 允许直用术语：译文出现原文 → info（合规提示）
 * 多字术语优先（避免短词误报被长词包含放大）：按 source 长度降序处理，
 * 已命中位置不再参与后续匹配。
 */
export function checkGlossaryConsistency(
  store: TranslationGlossary,
  translatedText: string,
): GlossaryViolation[] {
  const violations: GlossaryViolation[] = []
  const occupied: Array<[number, number]> = []
  const overlaps = (start: number, end: number): boolean =>
    occupied.some(([s, e]) => start < e && end > s)

  const sorted = [...store.entries].sort(
    (a, b) => [...b.source].length - [...a.source].length,
  )
  for (const entry of sorted) {
    if (entry.source === "") continue
    let from = 0
    for (;;) {
      const at = translatedText.indexOf(entry.source, from)
      if (at === -1) break
      const end = at + entry.source.length
      from = end
      if (overlaps(at, end)) continue
      occupied.push([at, end])
      violations.push({
        source: entry.source,
        expectedTarget: entry.target,
        severity: entry.allowDirectUse ? "info" : "warn",
        message: entry.allowDirectUse
          ? `术语「${entry.source}」按登记保留原文（合规）`
          : `术语「${entry.source}」未翻译，应为「${entry.target}」`,
      })
    }
  }
  return violations
}

// ── 章节翻译状态机 ──

export type TranslationChapterStatus =
  | "pending"
  | "drafted"
  | "reviewed"
  | "finalized"

const TRANSITION_ORDER: Record<TranslationChapterStatus, number> = {
  pending: 0,
  drafted: 1,
  reviewed: 2,
  finalized: 3,
}

export interface TranslationProgress {
  chapterStatuses: Record<number, TranslationChapterStatus>
  lastUpdated: string
}

export function createEmptyTranslationProgress(): TranslationProgress {
  return { chapterStatuses: {}, lastUpdated: new Date().toISOString() }
}

/**
 * 推进章节翻译状态：仅允许沿 pending→drafted→reviewed→finalized 单向前进
 * （可跳级；不可回退——回退语义由调用方显式 reset 到 pending 实现）。
 * 非法迁移返回 null（不抛错，确定性）。
 */
export function advanceTranslationStatus(
  progress: TranslationProgress,
  chapter: number,
  to: TranslationChapterStatus,
): TranslationProgress | null {
  const current = progress.chapterStatuses[chapter] ?? "pending"
  if (TRANSITION_ORDER[to] <= TRANSITION_ORDER[current]) return null
  return {
    chapterStatuses: { ...progress.chapterStatuses, [chapter]: to },
    lastUpdated: new Date().toISOString(),
  }
}

/** 显式回退到 pending（重译场景；finalized 章回退视为危险操作仍允许，由调用方审）。 */
export function resetTranslationStatus(
  progress: TranslationProgress,
  chapter: number,
): TranslationProgress {
  const next = { ...progress.chapterStatuses }
  delete next[chapter]
  return { chapterStatuses: next, lastUpdated: new Date().toISOString() }
}

/** 进度摘要：各状态章数（供 UI/审计）。 */
export function translationProgressSummary(progress: TranslationProgress): {
  pending: number
  drafted: number
  reviewed: number
  finalized: number
} {
  const counts = { pending: 0, drafted: 0, reviewed: 0, finalized: 0 }
  for (const s of Object.values(progress.chapterStatuses)) counts[s]++
  return counts
}

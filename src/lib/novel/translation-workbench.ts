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

// ============================================================================
// 64 号实施（63 号共识 §6 P0-4）：TranslationRunner — LLM 翻译执行链
// ============================================================================
// LLM 关在注入端口外（TranslationLlmPort）；引擎层保持零 LLM 导入。分段续跑
// 复用 budget-resume 预算机（每章一个 BudgetTask，崩溃跳过已完成段）；
// 幂等键 = 段 digest（computeCheckpointDigestOf）。Draft-first：译文写
// `.novel/translation-drafts/{chapter}.md`，finalized 才可导出正式包。

import { createDirectory, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { computeCheckpointDigestOf } from "./checkpoint-digest"
import type { BudgetRunState } from "./budget-resume"

/** LLM 翻译端口（生产适配器由调用方包 ModelPort.execute，本文件不 import llm-client）。 */
export interface TranslationLlmPort {
  translate(input: { system: string; user: string; signal?: AbortSignal }): Promise<string>
}

export interface TranslationProject {
  version: 1
  sourceLang: string
  targetLang: string
  chapterNumbers: number[]
  glossary: TranslationGlossary
  progress: TranslationProgress
  budgetRunId: string
}

export interface TranslationSegment {
  chapter: number
  sourceText: string
  digest: string
}

export interface TranslationDraftArtifact {
  chapter: number
  targetText: string
  violations: GlossaryViolation[]
  status: TranslationChapterStatus
}

export interface TranslationRunResult {
  project: TranslationProject
  artifacts: TranslationDraftArtifact[]
  budget: BudgetRunState
  stopped: "done" | "suspended" | "aborted"
}

/** 构建翻译 prompt（system 语言指令 + user 术语表与原文）。确定性零 LLM。 */
export function buildTranslationPrompt(
  glossary: TranslationGlossary,
  source: string,
  langs: { source: string; target: string },
): { system: string; user: string } {
  const glossaryFragment = glossaryToPromptFragment(glossary)
  return {
    system: `你是一位资深小说翻译。将${langs.source}原文翻译为${langs.target}，保持文风、语气与人称。只输出译文正文，不要解释。`,
    user: [glossaryFragment, `\n原文：\n${source}`].filter(Boolean).join("\n"),
  }
}

/** 翻译单章（fake port 可测；violations 由 checkGlossaryConsistency 机械判定）。 */
export async function runTranslationSegment(
  port: TranslationLlmPort,
  project: TranslationProject,
  segment: TranslationSegment,
  signal?: AbortSignal,
): Promise<TranslationDraftArtifact> {
  const { system, user } = buildTranslationPrompt(project.glossary, segment.sourceText, {
    source: project.sourceLang,
    target: project.targetLang,
  })
  const targetText = await port.translate({ system, user, signal })
  const violations = checkGlossaryConsistency(project.glossary, targetText)
  return {
    chapter: segment.chapter,
    targetText,
    violations,
    status: "drafted",
  }
}

/** 翻译项目（分段续跑：completed 跳过；预算不足 suspended；abort 保留已完成）。 */
export async function runTranslationProject(
  port: TranslationLlmPort,
  project: TranslationProject,
  loadSource: (chapter: number) => Promise<string>,
  budget: BudgetRunState,
  signal?: AbortSignal,
): Promise<TranslationRunResult> {
  const artifacts: TranslationDraftArtifact[] = []
  let currentBudget = budget
  let stopped: TranslationRunResult["stopped"] = "done"

  for (const chapter of project.chapterNumbers) {
    if (currentBudget.completedTaskIds.includes(`translate-${chapter}`)) continue
    if (currentBudget.status === "suspended") {
      stopped = "suspended"
      break
    }
    if (signal?.aborted) {
      stopped = "aborted"
      break
    }
    const task = currentBudget.tasks.find((t) => t.taskId === `translate-${chapter}`)
    if (!task || currentBudget.remainingBudget < task.cost) {
      stopped = "suspended"
      break
    }
    try {
      const sourceText = await loadSource(chapter)
      const digest = await computeCheckpointDigestOf({
        chapter,
        source: sourceText,
        glossaryStamp: project.glossary.lastUpdated,
      })
      const segment: TranslationSegment = { chapter, sourceText, digest }
      const artifact = await runTranslationSegment(port, project, segment, signal)
      artifacts.push(artifact)
      const completedTaskIds = [...currentBudget.completedTaskIds, task.taskId]
      const remainingBudget = currentBudget.remainingBudget - task.cost
      currentBudget = {
        ...currentBudget,
        completedTaskIds,
        remainingBudget,
        status:
          currentBudget.tasks.every((t) => completedTaskIds.includes(t.taskId))
            ? "done"
            : "in_progress",
        lastUpdatedAt: new Date().toISOString(),
      }
      project.progress = advanceTranslationStatus(project.progress, chapter, "drafted") ?? project.progress
    } catch {
      stopped = "aborted"
      break
    }
  }

  return { project, artifacts, budget: currentBudget, stopped }
}

/** 落 draft 工件（Draft-first：.novel/translation-drafts/{chapter}.md，非 wiki/chapters）。 */
export async function saveTranslationDraft(
  projectPath: string,
  artifact: TranslationDraftArtifact,
): Promise<void> {
  const dir = `${normalizePath(projectPath)}/.novel/translation-drafts`
  await createDirectory(dir)
  await writeFileAtomic(`${dir}/${artifact.chapter}.md`, artifact.targetText)
}

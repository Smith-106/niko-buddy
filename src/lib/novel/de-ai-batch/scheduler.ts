/**
 * Wave 4 (v2.5.0): 批量去AI味 — 调度编排。
 *
 * 流程：章节枚举 → 状态装载（恢复 or 新建）→ worker-pool 逐章
 * （机械双遍 → LLM 改写 → 草稿工件）→ 进度回调 → 摘要。
 * accept-all / 逐章 accept / reject 回填走 replaceWholeChapterBody
 * （保留 frontmatter + 标题，仅替换正文）。
 */

import { listDirectory, readFile, writeFile } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { ChatMessage } from "@/lib/llm-providers"
import { normalizePath } from "@/lib/path-utils"
import { replaceWholeChapterBody } from "@/lib/chapter-selection"
import {
  buildUserAwareDeAiPrompt,
  getAvoidWords,
  hasUserDeAiWeights,
  loadUserMemoryForProject,
} from "@/lib/user-memory"
import { extractChapterNumber, findChapterFileByNumber, flattenMdFiles } from "../chapter-utils"
import { buildDeAiRewriteMessages, BUILTIN_DE_AI_SKILL_VERSION } from "../de-ai-adapter"
import { runDeAiDualPass, formatDualPassPromptFragment } from "../de-ai-dual-pass"
import { classifyIntervention } from "../de-ai-intensity"
import { lockProtectedSpans, buildPreserveDirective } from "../de-ai-preserve-lock"
import { runDeAiSelfCheck } from "../de-ai-selfcheck"
import { overCorrectionReport } from "../mechanical-slop-detector"
import { loadNovelProjectMeta } from "../project-meta"
import { isTransientLlmError, runBatch, runWithBackoff } from "./concurrency"
import { deleteDeAiBatchDraft, loadDeAiBatchDraft, saveDeAiBatchDraft } from "./drafts"
import {
  createDeAiBatchState,
  deriveRemainingQueue,
  loadDeAiBatchState,
  resumeDeAiBatchState,
  saveDeAiBatchState,
} from "./resume"
import {
  DE_AI_BATCH_DEFAULT_CONCURRENCY,
  DE_AI_BATCH_MAX_CONCURRENCY,
  DE_AI_BATCH_MIN_CONCURRENCY,
  DE_AI_BATCH_SCHEMA,
  type ChapterFailure,
  type DeAiBatchDraftArtifact,
  type DeAiBatchOptions,
  type DeAiBatchProgress,
  type DeAiBatchState,
  type DeAiBatchSummary,
  type DeAiChapterState,
} from "./types"

function nowIso(): string {
  return new Date().toISOString()
}

function clampConcurrency(value: number | undefined): number {
  if (value === undefined) return DE_AI_BATCH_DEFAULT_CONCURRENCY
  return Math.min(DE_AI_BATCH_MAX_CONCURRENCY, Math.max(DE_AI_BATCH_MIN_CONCURRENCY, Math.floor(value)))
}

function isAbortError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /abort|request cancelled|request canceled/i.test(message)
}

/** 廉价子串扫描：用户避用词命中 (Wave 4 additive; 小词表, 批量可控)。 */
function scanAvoidWords(
  text: string,
  avoidWords: readonly string[],
): Array<{ word: string; count: number }> {
  const hits: Array<{ word: string; count: number }> = []
  for (const word of avoidWords) {
    const trimmed = word.trim()
    if (!trimmed) continue
    let count = 0
    let index = text.indexOf(trimmed)
    while (index !== -1) {
      count += 1
      index = text.indexOf(trimmed, index + trimmed.length)
    }
    if (count > 0) hits.push({ word: trimmed, count })
  }
  return hits
}

async function resolveGenre(projectPath: string): Promise<string | undefined> {
  const meta = await loadNovelProjectMeta(projectPath)
  return meta?.genre?.trim() || undefined
}

async function listAllChapterNumbers(projectPath: string): Promise<number[]> {
  const tree = await listDirectory(`${normalizePath(projectPath)}/wiki/chapters`)
  const files = flattenMdFiles(tree)
  const numbers = files
    .map((file) => extractChapterNumber(file.name.replace(/\.md$/, "")))
    .filter((value): value is number => value !== null)
  return [...new Set(numbers)].sort((a, b) => a - b)
}

/** streamChat 错误走 onError 回调后 resolve（不 reject）→ 包装为 reject。 */
async function streamChatToText(
  config: DeAiBatchOptions["llmConfig"],
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  let result = ""
  let failure: Error | null = null
  await streamChat(
    config,
    messages,
    {
      onToken: (token) => {
        result += token
      },
      onDone: () => {},
      onError: (error) => {
        failure = error
      },
    },
    signal,
  )
  if (failure) throw failure
  return result
}

function countByStatus(state: DeAiBatchState, status: DeAiChapterState["status"]): number {
  let count = 0
  for (const chapter of Object.values(state.perChapter)) {
    if (chapter.status === status) count += 1
  }
  return count
}

function countSettled(state: DeAiBatchState): number {
  return countByStatus(state, "ready")
    + countByStatus(state, "failed")
    + countByStatus(state, "skipped")
    + countByStatus(state, "accepted")
    + countByStatus(state, "rejected")
}

/**
 * 一键批量去AI味：全书（或指定子集）逐章机械双遍 + LLM 改写，
 * 候选落草稿工件，accept 后才回填正式正文（Draft-first）。
 */
export async function runDeAiBatch(
  projectPath: string,
  options: DeAiBatchOptions,
): Promise<DeAiBatchSummary> {
  const startedAt = nowIso()
  const startedMs = Date.now()
  const concurrency = clampConcurrency(options.concurrency)
  const genre = options.genre ?? (await resolveGenre(projectPath))
  const userMemory = await loadUserMemoryForProject(projectPath)
  const userPrompt = options.userPrompt
    ?? (hasUserDeAiWeights(userMemory) ? buildUserAwareDeAiPrompt(userMemory, genre) : undefined)
  const avoidWords = options.avoidWords ?? getAvoidWords(userMemory)
  const customSkill = options.customSkill ?? undefined

  const chapterNumbers = options.chapterNumbers ?? (await listAllChapterNumbers(projectPath))
  if (chapterNumbers.length === 0) {
    throw new Error("未找到可处理的章节（wiki/chapters 为空）")
  }

  // 状态：显式子集 → 新批次；否则恢复未完成批次
  const existing = options.chapterNumbers ? null : await loadDeAiBatchState(projectPath)
  const state = existing && existing.phase !== "completed" && existing.phase !== "idle"
    ? resumeDeAiBatchState(existing)
    : createDeAiBatchState({
        batchId: `de-ai-${Date.now()}`,
        queue: chapterNumbers,
        concurrency,
        genre,
      })
  state.concurrency = concurrency
  const remaining = deriveRemainingQueue(state)
  if (remaining.length === 0) {
    state.phase = "completed"
    state.updatedAt = nowIso()
    await saveDeAiBatchState(projectPath, state)
    return buildSummary(state, startedAt, startedMs)
  }

  // 状态持久化串行化（读-改-写竞态防护：并发 worker 不交错 save）
  let saveChain: Promise<unknown> = Promise.resolve()
  const persistState = (): void => {
    saveChain = saveChain.then(() => saveDeAiBatchState(projectPath, state)).catch(() => {})
  }

  const progress: DeAiBatchProgress = {
    phase: "running",
    done: 0,
    total: chapterNumbers.length,
    processed: 0,
    failed: 0,
    skipped: 0,
    current: null,
    updatedAt: startedAt,
  }
  const emitProgress = (patch: Partial<DeAiBatchProgress>): void => {
    const next = { ...progress, ...patch, updatedAt: nowIso() }
    Object.assign(progress, next)
    try {
      options.onProgress?.(next)
    } catch {
      // fire-and-forget：进度回调异常不中断批次
    }
  }

  const updateChapter = async (chapterNumber: number, patch: Partial<DeAiChapterState>): Promise<void> => {
    const prev = state.perChapter[chapterNumber] ?? { status: "pending" as const, attempts: 0 }
    state.perChapter[chapterNumber] = { ...prev, ...patch }
    state.updatedAt = nowIso()
    persistState()
  }

  const worker = async (chapterNumber: number): Promise<void> => {
    const attempts = (state.perChapter[chapterNumber]?.attempts ?? 0) + 1
    await updateChapter(chapterNumber, { status: "running", attempts, updatedAt: nowIso() })
    emitProgress({ current: { chapterNumber, status: "running" } })
    try {
      const filePath = await findChapterFileByNumber(projectPath, chapterNumber)
      if (!filePath) throw new Error("章节文件不存在")
      const content = await readFile(filePath)
      if (!content.trim()) throw new Error("章节内容为空")

      const report = runDeAiDualPass(content)
      const avoidWordsHits = scanAvoidWords(content, avoidWords ?? [])
      const mechanicallyClean = report.pass1.hits.length === 0 && avoidWordsHits.length === 0
      if (options.skipCleanChapters && mechanicallyClean) {
        await updateChapter(chapterNumber, {
          status: "skipped",
          dualPassScore: report.pass1.weightedScore,
          updatedAt: nowIso(),
        })
        emitProgress({
          skipped: countByStatus(state, "skipped"),
          done: countSettled(state),
          current: null,
        })
        return
      }

      // P1-2 preserve-lock: 改写前锁定关键内容（URL/数字/引号/角色名/时间词/对白标签）
      const lock = lockProtectedSpans(content)
      // 介入分级 (P0-2): light/medium/rewrite + cavitySkip 防过度改写
      const cavityBefore = overCorrectionReport(content)
      const triage = classifyIntervention({
        slopPenalty: report.pass1.highCount > 0 ? Math.min(10, report.pass1.highCount) : 0,
        weightedScore: report.pass1.weightedScore,
        humanizerCavityScore: cavityBefore.humanizerCavityScore,
        sentenceLengthCV: cavityBefore.sentenceLengthCV,
      })

      const messages = buildDeAiRewriteMessages(lock.maskedText, customSkill, {
        userPrompt,
        dualPassFragment: formatDualPassPromptFragment(report, avoidWordsHits),
        cavityGuard: true,
        preserveDirective: buildPreserveDirective(lock.spans),
      })
      const candidate = await runWithBackoff(
        () => streamChatToText(options.llmConfig, messages, options.signal),
        { shouldRetry: (error) => !isAbortError(error) && isTransientLlmError(error) },
      )

      // P1-2 还原占位符 + P1-3 自检（Track B soft 诊断，非门）
      const restored = lock.restore(candidate)
      const restoreCheck = lock.verify(restored)
      const selfcheck = runDeAiSelfCheck(content, restored)
      const cavityAfter = overCorrectionReport(restored)

      const artifact: DeAiBatchDraftArtifact = {
        schemaVersion: DE_AI_BATCH_SCHEMA,
        batchId: state.batchId,
        chapterNumber,
        sourcePath: filePath,
        originalContent: content,
        candidateContent: restored,
        dualPassScore: report.pass1.weightedScore,
        avoidWordsHits,
        skillVersion: BUILTIN_DE_AI_SKILL_VERSION,
        interventionTier: triage.tier,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      const draftPath = await saveDeAiBatchDraft(projectPath, artifact)
      await updateChapter(chapterNumber, {
        status: "ready",
        draftPath,
        dualPassScore: report.pass1.weightedScore,
        selfCheckSummary: `${selfcheck.summary} | cavityAfter=${cavityAfter.humanizerCavityScore.toFixed(2)}`,
        preserveMissing: restoreCheck.missing,
        updatedAt: nowIso(),
      })
      emitProgress({
        processed: countByStatus(state, "ready")
          + countByStatus(state, "accepted")
          + countByStatus(state, "rejected"),
        done: countSettled(state),
        current: null,
      })
    } catch (error) {
      if (isAbortError(error)) {
        // 中止：中断残留回 pending，复跑时重新入队
        await updateChapter(chapterNumber, { status: "pending", updatedAt: nowIso() })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      await updateChapter(chapterNumber, {
        status: "failed",
        lastError: message,
        updatedAt: nowIso(),
      })
      emitProgress({
        failed: countByStatus(state, "failed"),
        done: countSettled(state),
        current: null,
      })
    }
  }

  await runBatch(remaining, worker, { concurrency, signal: options.signal })
  state.phase = options.signal?.aborted ? "paused" : "completed"
  state.updatedAt = nowIso()
  persistState()
  await saveChain
  emitProgress({ phase: state.phase, current: null })
  return buildSummary(state, startedAt, startedMs)
}

function buildSummary(state: DeAiBatchState, startedAt: string, startedMs: number): DeAiBatchSummary {
  const failed: ChapterFailure[] = []
  for (const [key, chapter] of Object.entries(state.perChapter)) {
    if (chapter.status === "failed") {
      failed.push({
        chapterNumber: Number(key),
        error: chapter.lastError ?? "未知错误",
        retries: Math.max(0, chapter.attempts - 1),
        lastAttemptAt: chapter.updatedAt ?? state.updatedAt,
      })
    }
  }
  return {
    schemaVersion: DE_AI_BATCH_SCHEMA,
    batchId: state.batchId,
    phase: state.phase,
    total: state.queue.length,
    processed: countByStatus(state, "ready")
      + countByStatus(state, "accepted")
      + countByStatus(state, "rejected"),
    failed,
    skipped: countByStatus(state, "skipped"),
    durationMs: Date.now() - startedMs,
    startedAt,
    finishedAt: nowIso(),
  }
}

/**
 * 一键回填：仅 ready 状态的草稿写回章节文件（保留 frontmatter/标题）。
 * 返回 { accepted, skipped }（skipped = 非 ready / 工件缺失 / 文件缺失）。
 */
export async function acceptAllDeAiBatchDrafts(
  projectPath: string,
  options: { chapterNumbers?: number[] } = {},
): Promise<{ accepted: number; skipped: number }> {
  const state = await loadDeAiBatchState(projectPath)
  if (!state) return { accepted: 0, skipped: 0 }
  const targets = options.chapterNumbers ?? Object.keys(state.perChapter).map(Number)
  let accepted = 0
  let skipped = 0
  for (const chapterNumber of targets) {
    const chapter = state.perChapter[chapterNumber]
    if (!chapter || chapter.status !== "ready") {
      skipped += 1
      continue
    }
    const artifact = await loadDeAiBatchDraft(projectPath, chapterNumber)
    if (!artifact) {
      skipped += 1
      continue
    }
    const filePath = await findChapterFileByNumber(projectPath, chapterNumber)
    if (!filePath) {
      skipped += 1
      continue
    }
    const merged = replaceWholeChapterBody(artifact.originalContent, artifact.candidateContent)
    await writeFile(filePath, merged)
    chapter.status = "accepted"
    chapter.updatedAt = nowIso()
    accepted += 1
  }
  state.updatedAt = nowIso()
  await saveDeAiBatchState(projectPath, state)
  return { accepted, skipped }
}

/** 逐章 accept（单章兜底）。 */
export async function acceptDeAiBatchDraft(projectPath: string, chapterNumber: number): Promise<boolean> {
  const result = await acceptAllDeAiBatchDrafts(projectPath, { chapterNumbers: [chapterNumber] })
  return result.accepted === 1
}

/** 逐章 reject：仅标记不删源文件（工件保留供审计）。 */
export async function rejectDeAiBatchDraft(projectPath: string, chapterNumber: number): Promise<boolean> {
  const state = await loadDeAiBatchState(projectPath)
  if (!state) return false
  const chapter = state.perChapter[chapterNumber]
  if (!chapter || chapter.status !== "ready") return false
  chapter.status = "rejected"
  chapter.updatedAt = nowIso()
  state.updatedAt = nowIso()
  await saveDeAiBatchState(projectPath, state)
  return true
}

/** 丢弃批次（清状态 + 清草稿工件）。 */
export async function discardDeAiBatch(projectPath: string): Promise<boolean> {
  const state = await loadDeAiBatchState(projectPath)
  if (!state) return false
  for (const chapterNumber of Object.keys(state.perChapter)) {
    await deleteDeAiBatchDraft(projectPath, Number(chapterNumber))
  }
  state.phase = "idle"
  state.perChapter = {}
  state.queue = []
  state.updatedAt = nowIso()
  await saveDeAiBatchState(projectPath, state)
  return true
}

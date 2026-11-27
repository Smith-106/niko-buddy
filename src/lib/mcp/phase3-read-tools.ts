// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * phase3-read-tools.ts — Phase 3 两项零 LLM / 零写盘 / 零外网只读 MCP 工具门面（P3-B3）。
 *
 * 严格依赖与安全边界：
 * 1. 所有 novel 域符号均经 `@/lib/novel` 顶层 barrel 导入（零深导入，ESLint `boundaries/dependencies` 强制）；
 * 2. 严格零 LLM 调用、零磁盘写入、零外网请求（`runContinuityMechanicalPreflight` 强制 `readOnly: true`）；
 * 3. 与 Rust 侧 `tools.rs` 1:1 参数校验对齐：
 *    - `draft.diff` (`draft-diff`)
 *    - `audit.longform_health` (`audit-longform-health`)
 * 4. 严守门控优先级 `Consistency(P0) > Anti-AI(P1) > Quality(P2)` 与 Draft-first 只读契约。
 */

import { readFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import {
  DRAFTS_DIR,
  EMOTION_CB_THRESHOLD,
  analyzeForeshadowingDebt,
  checkEmotionCircuitBreaker,
  computeCheckpointDigest,
  computeMyersDiff,
  diffLines,
  draftNeedsGateReview,
  flattenOutlineChapters,
  formalChapterPathForDraft,
  getCircuitBreakerStatus,
  getDraftGateStatus,
  getForeshadowingWatermark,
  getTopEmotionalDebt,
  isDraftChapterFile,
  listChapterDrafts,
  listScopeFiles,
  loadEmotionLedger,
  loadEmotionalArcs,
  loadForeshadowingTracker,
  loadNovelSessionStatus,
  loadOutlineModel,
  loadSubplotBoard,
  parseChapterOrdinal,
  readDraftChapterNumber,
  runContinuityMechanicalPreflight,
  type ChapterDraft,
  type ChaseDebt,
  type ChaseDebtStatus,
  type ChaseDebtType,
  type DiffChange,
  type EmotionLedgerEntry,
  type EmotionLedgerStore,
  type EmotionalArcBeat,
  type EmotionalArcStore,
  type ForeshadowingDebtItem,
  type ForeshadowingDebtReport,
  type ForeshadowingStore,
  type NovelReviewResult,
  type NovelSessionStatus,
  type OutlineModel,
  type Subplot,
  type SubplotBoardStore,
  type SubplotStatus,
} from "@/lib/novel"
import { normalizePath } from "@/lib/path-utils"

const READ_ONLY_META = {
  readOnly: true as const,
  llmCalls: 0 as const,
  diskWrites: 0 as const,
}

const DRAFT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/
const MAX_CHAPTER_NUMBER = 100_000
const MAX_VOLUME_NUMBER = 1_000

const DRAFT_DIFF_DEFAULT_CONTEXT_LINES = 2
const DRAFT_DIFF_MAX_CONTEXT_LINES = 10
const DRAFT_DIFF_DEFAULT_MAX_HUNKS = 50
const DRAFT_DIFF_MAX_HUNKS = 200
const DRAFT_DIFF_MIN_MAX_CHARS = 500
const DRAFT_DIFF_DEFAULT_MAX_CHARS = 16_000
const DRAFT_DIFF_MAX_MAX_CHARS = 50_000
/** Myers 矩阵预算上限（remOld * remNew <= 2,500,000 走 Myers，超限平滑回退行索引 diffLines）。 */
export const DRAFT_DIFF_MYERS_CELL_LIMIT = 2_500_000

const DRAFT_DIFF_KEYS = new Set([
  "baseDraftId",
  "targetDraftId",
  "draftId",
  "chapterNumber",
  "compareToFormal",
  "contextLines",
  "maxHunks",
  "maxChars",
])

export const LONGFORM_HEALTH_SECTIONS = [
  "foreshadowing",
  "chaseDebt",
  "emotion",
  "drafts",
  "canonRisk",
] as const

export type LongformHealthSection = (typeof LONGFORM_HEALTH_SECTIONS)[number]

const LONGFORM_HEALTH_SECTION_SET: ReadonlySet<string> = new Set(LONGFORM_HEALTH_SECTIONS)
const AUDIT_LONGFORM_HEALTH_KEYS = new Set([
  "currentChapter",
  "chapterStart",
  "chapterEnd",
  "volume",
  "sections",
  "topK",
  "includeDetails",
  "emotionBreakerThreshold",
])
const AUDIT_DEFAULT_TOP_K = 10
const AUDIT_MAX_TOP_K = 50
const AUDIT_MIN_BREAKER = -10.0
const AUDIT_MAX_BREAKER = 0.0
const SUBPLOT_DORMANT_CHAPTER_GAP = 5

function projectRoot(projectPath: string): string {
  return normalizePath(projectPath).replace(/\/+$/, "")
}

function assertProjectPath(projectPath: string, toolName: string): string {
  const root = projectRoot(projectPath)
  if (!root) throw new Error(`${toolName} 需要已打开的项目`)
  return root
}

function assertObjectParams(
  params: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  toolName: string,
): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`${toolName} 的 params 必须是对象`)
  }
  for (const key of Object.keys(params)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${toolName} 的参数未知：${key}`)
    }
  }
  return params
}

function readOptionalBoolean(
  params: Record<string, unknown>,
  field: string,
  toolName: string,
): boolean | undefined {
  const raw = params[field]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "boolean") {
    throw new Error(`${toolName} 的 ${field} 必须是 boolean，收到 ${typeof raw}`)
  }
  return raw
}

function readOptionalIntInRange(
  params: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  toolName: string,
): number | undefined {
  const raw = params[field]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new Error(`${toolName} 的 ${field} 必须是 ${min}..${max} 的整数`)
  }
  return raw
}

function readOptionalDraftId(
  params: Record<string, unknown>,
  field: string,
  toolName: string,
): string | undefined {
  const raw = params[field]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "string" || !DRAFT_ID_PATTERN.test(raw)) {
    throw new Error(`${toolName} 的 ${field} 非法（仅允许 1-128 位字母、数字、下划线或连字符）`)
  }
  return raw
}

function readOptionalFiniteNumberInRange(
  params: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  toolName: string,
): number | undefined {
  const raw = params[field]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max) {
    throw new Error(`${toolName} 的 ${field} 必须是 ${min}..${max} 的有限数字`)
  }
  return Object.is(raw, -0) ? 0 : raw
}

function resolveChapterFileNumber(name: string): number | undefined {
  const stem = name.replace(/\.md$/i, "")
  const ordinal = parseChapterOrdinal(stem)
  if (ordinal !== null && Number.isSafeInteger(ordinal) && ordinal > 0) return ordinal
  const fromDraft = readDraftChapterNumber(stem)
  if (fromDraft !== undefined) return fromDraft
  const digits = /(\d+)/.exec(stem)
  if (!digits) return undefined
  const num = Number(digits[1])
  return Number.isSafeInteger(num) && num > 0 ? num : undefined
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ============================================================================
// 1. draft.diff（零 LLM / 零写盘行级差异比对）
// ============================================================================

export type DraftDiffMode = "draft_vs_draft" | "draft_vs_formal"
export type DraftDiffAlgorithm = "myers" | "line_index_fallback"
export type DraftDiffTruncatedReason = "max_hunks_exceeded" | "max_chars_exceeded" | null

export interface DraftDiffSideMeta {
  kind: "draft" | "formal"
  exists: boolean
  draftId?: string
  chapterName?: string
  chapterNumber: number | null
  status?: ChapterDraft["status"]
  revisionRound?: number
  path: string
  sha256: string
  lineCount: number
  charCount: number
}

export interface DraftDiffHunk {
  baseStart: number
  baseCount: number
  targetStart: number
  targetCount: number
  header: string
  lines: string[]
}

export interface DraftDiffStats {
  addedLines: number
  removedLines: number
  unchangedLines: number
  baseLineCount: number
  targetLineCount: number
  baseCharCount: number
  targetCharCount: number
  charDelta: number
  totalHunks: number
  returnedHunks: number
}

export interface DraftDiffResult {
  projectPath: string
  mode: DraftDiffMode
  algorithm: DraftDiffAlgorithm
  identical: boolean
  base: DraftDiffSideMeta
  target: DraftDiffSideMeta
  baseSha256: string
  targetSha256: string
  stats: DraftDiffStats
  hunks: DraftDiffHunk[]
  unifiedDiff: string
  truncated: boolean
  truncatedReason: DraftDiffTruncatedReason
  contextLines: number
  maxHunks: number
  maxChars: number
  meta: typeof READ_ONLY_META
}

export interface DraftDiffDeps {
  listDrafts: (projectPath: string) => Promise<ChapterDraft[]>
  listChapters: (projectPath: string) => Promise<Array<{ name: string; path: string }>>
  readFileText: (path: string) => Promise<string>
  /** 可选注入矩阵单元格阈值（单测验证 fallback 路径用，默认 2,500,000）。 */
  myersCellLimit?: number
}

interface LineDiffOp {
  type: "equal" | "delete" | "insert"
  text: string
  baseLine: number | null
  targetLine: number | null
}

function splitNormalizedLines(text: string): string[] {
  if (text === "") return []
  return text.replace(/\r\n/g, "\n").split("\n")
}

function expandDiffChanges(changes: readonly DiffChange[]): Array<{ type: "equal" | "delete" | "insert"; text: string }> {
  const ops: Array<{ type: "equal" | "delete" | "insert"; text: string }> = []
  for (const change of changes) {
    const lines = change.text.split("\n")
    for (const line of lines) {
      ops.push({ type: change.type, text: line })
    }
  }
  return ops
}

function computeMiddleOps(
  remBase: string[],
  remTarget: string[],
  myersCellLimit: number,
): { algorithm: DraftDiffAlgorithm; ops: Array<{ type: "equal" | "delete" | "insert"; text: string }> } {
  if (remBase.length === 0 && remTarget.length === 0) {
    return { algorithm: "myers", ops: [] }
  }
  if (remBase.length === 0) {
    return {
      algorithm: "myers",
      ops: remTarget.map((text) => ({ type: "insert", text })),
    }
  }
  if (remTarget.length === 0) {
    return {
      algorithm: "myers",
      ops: remBase.map((text) => ({ type: "delete", text })),
    }
  }

  // 防御 diff.ts 对单空行 `[""]` join 后变 `""` 被视作 0 行的边界
  if (remBase.length === 1 && remBase[0] === "") {
    const matchIdx = remTarget.indexOf("")
    if (matchIdx >= 0) {
      return {
        algorithm: "myers",
        ops: [
          ...remTarget.slice(0, matchIdx).map((text) => ({ type: "insert" as const, text })),
          { type: "equal" as const, text: "" },
          ...remTarget.slice(matchIdx + 1).map((text) => ({ type: "insert" as const, text })),
        ],
      }
    }
    return {
      algorithm: "myers",
      ops: [
        { type: "delete", text: "" },
        ...remTarget.map((text) => ({ type: "insert" as const, text })),
      ],
    }
  }
  if (remTarget.length === 1 && remTarget[0] === "") {
    const matchIdx = remBase.indexOf("")
    if (matchIdx >= 0) {
      return {
        algorithm: "myers",
        ops: [
          ...remBase.slice(0, matchIdx).map((text) => ({ type: "delete" as const, text })),
          { type: "equal" as const, text: "" },
          ...remBase.slice(matchIdx + 1).map((text) => ({ type: "delete" as const, text })),
        ],
      }
    }
    return {
      algorithm: "myers",
      ops: [
        ...remBase.map((text) => ({ type: "delete" as const, text })),
        { type: "insert", text: "" },
      ],
    }
  }

  if (remBase.length * remTarget.length <= myersCellLimit) {
    const changes = computeMyersDiff(remBase.join("\n"), remTarget.join("\n"))
    return { algorithm: "myers", ops: expandDiffChanges(changes) }
  }

  // 超限回退：利用 barrel 导出的 diffLines 做 O(N) 按行索引对比，杜绝 O(NM) 内存爆涨。
  const changed = diffLines(remBase.join("\n"), remTarget.join("\n"))
  const changedLines = new Set<number>(changed.map((entry) => entry.line))
  const ops: Array<{ type: "equal" | "delete" | "insert"; text: string }> = []
  const maxLen = Math.max(remBase.length, remTarget.length)
  for (let i = 0; i < maxLen; i += 1) {
    if (!changedLines.has(i + 1) && i < remBase.length && i < remTarget.length) {
      ops.push({ type: "equal", text: remBase[i]! })
    } else {
      if (i < remBase.length) ops.push({ type: "delete", text: remBase[i]! })
      if (i < remTarget.length) ops.push({ type: "insert", text: remTarget[i]! })
    }
  }
  return { algorithm: "line_index_fallback", ops }
}

function buildLineDiffHunks(
  baseLines: string[],
  targetLines: string[],
  contextLines: number,
  myersCellLimit: number,
): {
  algorithm: DraftDiffAlgorithm
  hunks: DraftDiffHunk[]
  addedLines: number
  removedLines: number
  unchangedLines: number
} {
  let prefixLen = 0
  const minLen = Math.min(baseLines.length, targetLines.length)
  while (prefixLen < minLen && baseLines[prefixLen] === targetLines[prefixLen]) {
    prefixLen += 1
  }
  let suffixLen = 0
  while (
    suffixLen < minLen - prefixLen
    && baseLines[baseLines.length - 1 - suffixLen] === targetLines[targetLines.length - 1 - suffixLen]
  ) {
    suffixLen += 1
  }

  const remBase = baseLines.slice(prefixLen, baseLines.length - suffixLen)
  const remTarget = targetLines.slice(prefixLen, targetLines.length - suffixLen)
  const middle = computeMiddleOps(remBase, remTarget, myersCellLimit)

  const numbered: LineDiffOp[] = []
  let baseLine = 1
  let targetLine = 1
  let addedLines = 0
  let removedLines = 0
  let unchangedLines = 0

  for (let i = 0; i < prefixLen; i += 1) {
    numbered.push({ type: "equal", text: baseLines[i]!, baseLine, targetLine })
    baseLine += 1
    targetLine += 1
    unchangedLines += 1
  }
  for (const op of middle.ops) {
    if (op.type === "equal") {
      numbered.push({ type: "equal", text: op.text, baseLine, targetLine })
      baseLine += 1
      targetLine += 1
      unchangedLines += 1
    } else if (op.type === "delete") {
      numbered.push({ type: "delete", text: op.text, baseLine, targetLine: null })
      baseLine += 1
      removedLines += 1
    } else {
      numbered.push({ type: "insert", text: op.text, baseLine: null, targetLine })
      targetLine += 1
      addedLines += 1
    }
  }
  const suffixStart = baseLines.length - suffixLen
  for (let i = 0; i < suffixLen; i += 1) {
    numbered.push({ type: "equal", text: baseLines[suffixStart + i]!, baseLine, targetLine })
    baseLine += 1
    targetLine += 1
    unchangedLines += 1
  }

  // 收集变化区段并按 contextLines 扩展合并
  const ranges: Array<{ start: number; end: number }> = []
  for (let i = 0; i < numbered.length; i += 1) {
    if (numbered[i]!.type === "equal") continue
    const start = Math.max(0, i - contextLines)
    const end = Math.min(numbered.length, i + contextLines + 1)
    const last = ranges[ranges.length - 1]
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end)
    } else {
      ranges.push({ start, end })
    }
  }

  const hunks: DraftDiffHunk[] = []
  for (const range of ranges) {
    const slice = numbered.slice(range.start, range.end)
    let firstBase: number | null = null
    let firstTarget: number | null = null
    let baseCount = 0
    let targetCount = 0
    const lines: string[] = []
    for (const op of slice) {
      if (op.type === "equal") {
        if (firstBase === null) firstBase = op.baseLine
        if (firstTarget === null) firstTarget = op.targetLine
        baseCount += 1
        targetCount += 1
        lines.push(` ${op.text}`)
      } else if (op.type === "delete") {
        if (firstBase === null) firstBase = op.baseLine
        baseCount += 1
        lines.push(`-${op.text}`)
      } else {
        if (firstTarget === null) firstTarget = op.targetLine
        targetCount += 1
        lines.push(`+${op.text}`)
      }
    }
    // 纯插入或纯删除且 contextLines=0 时推算邻接 1-based 行起点
    let baseStart = firstBase ?? 0
    let targetStart = firstTarget ?? 0
    if (firstBase === null) {
      let prevBase = 0
      for (let k = range.start - 1; k >= 0; k -= 1) {
        if (numbered[k]!.baseLine !== null) {
          prevBase = numbered[k]!.baseLine!
          break
        }
      }
      baseStart = prevBase
    }
    if (firstTarget === null) {
      let prevTarget = 0
      for (let k = range.start - 1; k >= 0; k -= 1) {
        if (numbered[k]!.targetLine !== null) {
          prevTarget = numbered[k]!.targetLine!
          break
        }
      }
      targetStart = prevTarget
    }
    const header = `@@ -${baseStart},${baseCount} +${targetStart},${targetCount} @@`
    hunks.push({ baseStart, baseCount, targetStart, targetCount, header, lines })
  }

  return {
    algorithm: middle.algorithm,
    hunks,
    addedLines,
    removedLines,
    unchangedLines,
  }
}

function serializeBoundedHunks(
  allHunks: readonly DraftDiffHunk[],
  maxHunks: number,
  maxChars: number,
): {
  hunks: DraftDiffHunk[]
  unifiedDiff: string
  truncated: boolean
  truncatedReason: DraftDiffTruncatedReason
} {
  const included: DraftDiffHunk[] = []
  const chunks: string[] = []
  let usedChars = 0
  let truncated = false
  let truncatedReason: DraftDiffTruncatedReason = null

  for (let i = 0; i < allHunks.length; i += 1) {
    if (i >= maxHunks) {
      truncated = true
      truncatedReason = "max_hunks_exceeded"
      break
    }
    const hunk = allHunks[i]!
    const text = [hunk.header, ...hunk.lines].join("\n")
    const sepLen = chunks.length > 0 ? 1 : 0
    if (usedChars + sepLen + text.length > maxChars) {
      truncated = true
      truncatedReason = "max_chars_exceeded"
      if (chunks.length === 0) {
        // 首个 hunk 本身即超过 maxChars：按行预算截断并保证总长度 <= maxChars
        const partialLines: string[] = []
        let budget = maxChars - hunk.header.length
        if (budget > 1) {
          for (const line of hunk.lines) {
            if (budget < line.length + 1) break
            partialLines.push(line)
            budget -= line.length + 1
          }
          const clippedText = [hunk.header, ...partialLines].join("\n")
          chunks.push(clippedText.slice(0, maxChars))
          included.push({ ...hunk, lines: partialLines })
        } else {
          chunks.push(hunk.header.slice(0, maxChars))
          included.push({ ...hunk, lines: [] })
        }
      }
      break
    }
    included.push(hunk)
    chunks.push(text)
    usedChars += sepLen + text.length
  }

  return {
    hunks: included,
    unifiedDiff: chunks.join("\n"),
    truncated,
    truncatedReason,
  }
}

export async function runDraftDiff(
  projectPath: string,
  params: Record<string, unknown> = {},
  depsOverrides?: Partial<DraftDiffDeps>,
): Promise<DraftDiffResult> {
  const toolName = "draft.diff"
  const root = assertProjectPath(projectPath, toolName)
  assertObjectParams(params, DRAFT_DIFF_KEYS, toolName)

  const baseDraftId = readOptionalDraftId(params, "baseDraftId", toolName)
  const targetDraftId = readOptionalDraftId(params, "targetDraftId", toolName)
  const draftId = readOptionalDraftId(params, "draftId", toolName)
  const chapterNumber = readOptionalIntInRange(params, "chapterNumber", 1, MAX_CHAPTER_NUMBER, toolName)
  const compareToFormal = readOptionalBoolean(params, "compareToFormal", toolName)
  const contextLines =
    readOptionalIntInRange(params, "contextLines", 0, DRAFT_DIFF_MAX_CONTEXT_LINES, toolName)
    ?? DRAFT_DIFF_DEFAULT_CONTEXT_LINES
  const maxHunks =
    readOptionalIntInRange(params, "maxHunks", 1, DRAFT_DIFF_MAX_HUNKS, toolName)
    ?? DRAFT_DIFF_DEFAULT_MAX_HUNKS
  const maxChars =
    readOptionalIntInRange(params, "maxChars", DRAFT_DIFF_MIN_MAX_CHARS, DRAFT_DIFF_MAX_MAX_CHARS, toolName)
    ?? DRAFT_DIFF_DEFAULT_MAX_CHARS

  let mode: DraftDiffMode
  if (baseDraftId !== undefined || targetDraftId !== undefined) {
    if (baseDraftId === undefined || targetDraftId === undefined) {
      throw new Error(`${toolName}: 草稿对比模式必须同时提供 baseDraftId 与 targetDraftId`)
    }
    if (draftId !== undefined) {
      throw new Error(`${toolName}: baseDraftId/targetDraftId 与 draftId 互斥`)
    }
    if (chapterNumber !== undefined) {
      throw new Error(`${toolName}: baseDraftId/targetDraftId 模式下不得传入 chapterNumber`)
    }
    if (compareToFormal === true) {
      throw new Error(`${toolName}: baseDraftId/targetDraftId 模式下不得设置 compareToFormal: true`)
    }
    mode = "draft_vs_draft"
  } else if (draftId !== undefined) {
    if (compareToFormal === false) {
      throw new Error(`${toolName}: draftId 与正式章对比模式下不得设置 compareToFormal: false`)
    }
    mode = "draft_vs_formal"
  } else {
    throw new Error(`${toolName}: 必须提供 baseDraftId+targetDraftId（双草稿对比）或 draftId（草稿与正式章对比）`)
  }

  const deps: DraftDiffDeps = {
    listDrafts: listChapterDrafts,
    listChapters: (pp) => listScopeFiles(pp, "chapters"),
    readFileText: readFile,
    ...depsOverrides,
  }
  const myersCellLimit = deps.myersCellLimit ?? DRAFT_DIFF_MYERS_CELL_LIMIT

  const drafts = await deps.listDrafts(projectPath)
  let baseText: string
  let targetText: string
  let baseMetaInput: Omit<DraftDiffSideMeta, "sha256" | "lineCount" | "charCount">
  let targetMetaInput: Omit<DraftDiffSideMeta, "sha256" | "lineCount" | "charCount">

  if (mode === "draft_vs_draft") {
    const baseDraft = drafts.find((d) => d.id === baseDraftId)
    if (!baseDraft) throw new Error(`找不到基准草稿：${baseDraftId}`)
    const targetDraft = drafts.find((d) => d.id === targetDraftId)
    if (!targetDraft) throw new Error(`找不到目标草稿：${targetDraftId}`)
    baseText = baseDraft.content
    targetText = targetDraft.content
    baseMetaInput = {
      kind: "draft",
      exists: true,
      draftId: baseDraft.id,
      chapterName: baseDraft.chapterName,
      chapterNumber: readDraftChapterNumber(baseDraft.chapterName) ?? null,
      status: baseDraft.status,
      revisionRound: baseDraft.revisionRound ?? 0,
      path: `${root}/${DRAFTS_DIR}/${baseDraft.id}.md`,
    }
    targetMetaInput = {
      kind: "draft",
      exists: true,
      draftId: targetDraft.id,
      chapterName: targetDraft.chapterName,
      chapterNumber: readDraftChapterNumber(targetDraft.chapterName) ?? null,
      status: targetDraft.status,
      revisionRound: targetDraft.revisionRound ?? 0,
      path: `${root}/${DRAFTS_DIR}/${targetDraft.id}.md`,
    }
  } else {
    const targetDraft = drafts.find((d) => d.id === draftId)
    if (!targetDraft) throw new Error(`找不到草稿：${draftId}`)
    const inferredChapter = readDraftChapterNumber(targetDraft.chapterName)
    const formalChapterNumber = chapterNumber ?? inferredChapter
    if (formalChapterNumber === undefined) {
      throw new Error(`${toolName}: 无法从草稿 "${targetDraft.chapterName}" 推断正式章号，请显式传入 chapterNumber`)
    }

    const chapters = await deps.listChapters(projectPath).catch(() => [] as Array<{ name: string; path: string }>)
    const formalFiles = chapters.filter((ch) => !isDraftChapterFile(ch.name))
    const matchedFormal = formalFiles.find((ch) => resolveChapterFileNumber(ch.name) === formalChapterNumber)
    const fallbackFormalPath =
      chapterNumber === undefined
        ? normalizePath(formalChapterPathForDraft(projectPath, targetDraft.chapterName, null, true))
        : `${root}/wiki/chapters/chapter-${String(formalChapterNumber).padStart(3, "0")}.md`
    const candidateFormalPath = matchedFormal ? normalizePath(matchedFormal.path) : fallbackFormalPath

    let formalExists = false
    let formalBody = ""
    try {
      const rawFormal = await deps.readFileText(candidateFormalPath)
      formalBody = parseFrontmatter(rawFormal).body
      formalExists = true
    } catch {
      // 正式章尚未落盘时按不存在处理，与空串 "" 比对，不抛错。
      formalExists = false
      formalBody = ""
    }

    baseText = formalBody
    targetText = targetDraft.content
    baseMetaInput = {
      kind: "formal",
      exists: formalExists,
      chapterNumber: formalChapterNumber,
      path: candidateFormalPath,
    }
    targetMetaInput = {
      kind: "draft",
      exists: true,
      draftId: targetDraft.id,
      chapterName: targetDraft.chapterName,
      chapterNumber: inferredChapter ?? formalChapterNumber,
      status: targetDraft.status,
      revisionRound: targetDraft.revisionRound ?? 0,
      path: `${root}/${DRAFTS_DIR}/${targetDraft.id}.md`,
    }
  }

  const [baseSha256, targetSha256] = await Promise.all([
    computeCheckpointDigest(baseText),
    computeCheckpointDigest(targetText),
  ])
  const baseLines = splitNormalizedLines(baseText)
  const targetLines = splitNormalizedLines(targetText)

  const diffComputed = buildLineDiffHunks(baseLines, targetLines, contextLines, myersCellLimit)
  const bounded = serializeBoundedHunks(diffComputed.hunks, maxHunks, maxChars)
  const identical = baseText === targetText || diffComputed.hunks.length === 0

  return {
    projectPath,
    mode,
    algorithm: diffComputed.algorithm,
    identical,
    base: {
      ...baseMetaInput,
      sha256: baseSha256,
      lineCount: baseLines.length,
      charCount: baseText.length,
    },
    target: {
      ...targetMetaInput,
      sha256: targetSha256,
      lineCount: targetLines.length,
      charCount: targetText.length,
    },
    baseSha256,
    targetSha256,
    stats: {
      addedLines: diffComputed.addedLines,
      removedLines: diffComputed.removedLines,
      unchangedLines: diffComputed.unchangedLines,
      baseLineCount: baseLines.length,
      targetLineCount: targetLines.length,
      baseCharCount: baseText.length,
      targetCharCount: targetText.length,
      charDelta: targetText.length - baseText.length,
      totalHunks: diffComputed.hunks.length,
      returnedHunks: bounded.hunks.length,
    },
    hunks: bounded.hunks,
    unifiedDiff: bounded.unifiedDiff,
    truncated: bounded.truncated,
    truncatedReason: bounded.truncatedReason,
    contextLines,
    maxHunks,
    maxChars,
    meta: READ_ONLY_META,
  }
}

// ============================================================================
// 2. audit.longform_health（零 LLM / 零写盘长篇健康诊断）
// ============================================================================

export type LongformHealthOverallStatus = "at_risk" | "watch" | "healthy"

export interface LongformDegradedSignal {
  source: string
  section: LongformHealthSection | "scope"
  error: string
}

export interface ForeshadowingHealthSummary {
  total: number
  totalUnresolved: number
  criticalCount: number
  warningCount: number
  debtScore: number
  topItems: Array<{
    id: string
    name: string
    status: ForeshadowingDebtItem["status"]
    plantedChapter: number
    chaptersSincePlanted: number
    debtLevel: ForeshadowingDebtItem["debtLevel"]
    description?: string
  }>
}

export interface ChaseDebtHealthSummary {
  activeDebts: number
  overdueDebts: number
  totalDebtAmount: number
  activeSubplots: number
  pausedSubplots: number
  overdueSubplots: number
  dormantSubplots: number
  topDebts: Array<{
    id: string
    debtType: ChaseDebtType
    status: ChaseDebtStatus
    sourceChapter: number
    dueChapter: number
    currentAmount: number
    ref?: string
  }>
  topSubplots: Array<{
    id: string
    title: string
    status: SubplotStatus
    startChapter: number
    lastSeenChapter?: number
    targetResolutionChapter?: number
    overdue: boolean
    dormant: boolean
    summary?: string
  }>
}

export interface EmotionHealthSummary {
  trackedCharacters: number
  arcBeatCount: number
  breakerThreshold: number
  breakerStatus: "tripped" | "armed" | "open"
  breakerTripped: boolean
  breakerReason: string
  lowestNetValue: number | null
  topDebtCharacters: Array<{
    characterName: string
    netValue: number
    valence: number
    arousal: number
    dominance: number
    lastUpdatedChapter: number
    historyCount: number
  }>
  recentArcBeats?: EmotionalArcBeat[]
}

export interface DraftsHealthSummary {
  totalDrafts: number
  activeDrafts: number
  needsGateReviewCount: number
  partialCount: number
  blockedCount: number
  manualReviewCount: number
  unassessedCount: number
  maxRevisionRound: number
  topDrafts: Array<{
    draftId: string
    chapterName: string
    chapterNumber: number | null
    status: ChapterDraft["status"]
    gateStatus: string
    needsGateReview: boolean
    partial: boolean
    revisionRound: number
    chars?: number
  }>
}

export interface CanonRiskHealthSummary {
  checkedChapter: number | null
  p0Blocked: boolean
  errorCount: number
  warningCount: number
  infoCount: number
  dataGapCount: number
  topFindings: Array<{
    severity: NovelReviewResult["severity"]
    type: string
    message: string
    chapter?: number
    subtype?: string
    evidence?: string
    suggestion?: string
  }>
}

export interface AuditLongformHealthResult {
  projectPath: string
  overallStatus: LongformHealthOverallStatus
  priorityOrder: readonly ["P0:consistency", "P1:anti_ai", "P2:quality"]
  riskTriggers: string[]
  currentChapter: number
  scope: {
    volume: number | null
    chapterStart: number | null
    chapterEnd: number | null
    matchedChapters: number | null
  }
  sectionsRequested: LongformHealthSection[]
  topK: number
  includeDetails: boolean
  emotionBreakerThreshold: number
  sections: {
    foreshadowing?: ForeshadowingHealthSummary
    chaseDebt?: ChaseDebtHealthSummary
    emotion?: EmotionHealthSummary
    drafts?: DraftsHealthSummary
    canonRisk?: CanonRiskHealthSummary
  }
  degradedSignals: LongformDegradedSignal[]
  meta: typeof READ_ONLY_META
}

export interface AuditLongformHealthDeps {
  loadForeshadowing: (projectPath: string) => Promise<ForeshadowingStore>
  loadStatus: (projectPath: string) => Promise<NovelSessionStatus | null>
  loadSubplotBoard: (projectPath: string) => Promise<SubplotBoardStore>
  loadEmotionLedger: (projectPath: string) => Promise<EmotionLedgerStore>
  loadEmotionalArcs: (projectPath: string) => Promise<EmotionalArcStore>
  listDrafts: (projectPath: string) => Promise<ChapterDraft[]>
  listChapters: (projectPath: string) => Promise<Array<{ name: string; path: string }>>
  loadOutlineModel: (projectPath: string) => Promise<{ model: OutlineModel | null }>
  runContinuityPreflight: (
    projectPath: string,
    chapterNumber?: number,
    options?: { readOnly?: boolean; includeNonBlockingAudit?: boolean },
  ) => Promise<NovelReviewResult[]>
}

function parseHealthSections(raw: unknown, toolName: string): LongformHealthSection[] {
  if (raw === undefined || raw === null) return [...LONGFORM_HEALTH_SECTIONS]
  if (!Array.isArray(raw)) {
    throw new Error(`${toolName} 的 sections 必须是非空数组`)
  }
  if (raw.length === 0) {
    throw new Error(`${toolName} 的 sections 不能为空数组`)
  }
  if (raw.length > LONGFORM_HEALTH_SECTIONS.length) {
    throw new Error(`${toolName} 的 sections 最多包含 ${LONGFORM_HEALTH_SECTIONS.length} 项`)
  }
  const deduped: LongformHealthSection[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i]
    if (typeof item !== "string" || !LONGFORM_HEALTH_SECTION_SET.has(item)) {
      throw new Error(
        `${toolName} 的 sections[${i}] 非法：${String(item)}（合法值：${LONGFORM_HEALTH_SECTIONS.join(" / ")}）`,
      )
    }
    if (!seen.has(item)) {
      seen.add(item)
      deduped.push(item as LongformHealthSection)
    }
  }
  return deduped
}

const DEBT_RANK: Record<ForeshadowingDebtItem["debtLevel"], number> = {
  critical: 0,
  warning: 1,
  normal: 2,
}

const SEVERITY_RANK: Record<NovelReviewResult["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
}

export async function runAuditLongformHealth(
  projectPath: string,
  params: Record<string, unknown> = {},
  depsOverrides?: Partial<AuditLongformHealthDeps>,
): Promise<AuditLongformHealthResult> {
  const toolName = "audit.longform_health"
  assertProjectPath(projectPath, toolName)
  assertObjectParams(params, AUDIT_LONGFORM_HEALTH_KEYS, toolName)

  const explicitCurrentChapter = readOptionalIntInRange(params, "currentChapter", 1, MAX_CHAPTER_NUMBER, toolName)
  const chapterStart = readOptionalIntInRange(params, "chapterStart", 1, MAX_CHAPTER_NUMBER, toolName)
  const chapterEnd = readOptionalIntInRange(params, "chapterEnd", 1, MAX_CHAPTER_NUMBER, toolName)
  const volume = readOptionalIntInRange(params, "volume", 1, MAX_VOLUME_NUMBER, toolName)

  if (volume !== undefined && (chapterStart !== undefined || chapterEnd !== undefined)) {
    throw new Error(`${toolName}: volume 与 chapterStart/chapterEnd 互斥`)
  }
  if (chapterStart !== undefined && chapterEnd !== undefined && chapterStart > chapterEnd) {
    throw new Error(`${toolName}: chapterStart (${chapterStart}) 不能大于 chapterEnd (${chapterEnd})`)
  }

  const sectionsRequested = parseHealthSections(params.sections, toolName)
  const topK = readOptionalIntInRange(params, "topK", 1, AUDIT_MAX_TOP_K, toolName) ?? AUDIT_DEFAULT_TOP_K
  const includeDetails = readOptionalBoolean(params, "includeDetails", toolName) ?? false
  const emotionBreakerThreshold =
    readOptionalFiniteNumberInRange(params, "emotionBreakerThreshold", AUDIT_MIN_BREAKER, AUDIT_MAX_BREAKER, toolName)
    ?? EMOTION_CB_THRESHOLD

  const deps: AuditLongformHealthDeps = {
    loadForeshadowing: loadForeshadowingTracker,
    loadStatus: loadNovelSessionStatus,
    loadSubplotBoard,
    loadEmotionLedger,
    loadEmotionalArcs,
    listDrafts: listChapterDrafts,
    listChapters: (pp) => listScopeFiles(pp, "chapters"),
    loadOutlineModel: async (pp) => {
      const loaded = await loadOutlineModel(pp)
      return { model: loaded.model }
    },
    runContinuityPreflight: (pp, ch, opts) => runContinuityMechanicalPreflight(pp, ch, opts),
    ...depsOverrides,
  }

  const wanted = new Set<LongformHealthSection>(sectionsRequested)
  const degradedSignals: LongformDegradedSignal[] = []
  const safeLoad = async <T>(
    source: string,
    section: LongformHealthSection | "scope",
    fn: () => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      degradedSignals.push({ source, section, error: errorMessageOf(err) })
      return fallback
    }
  }

  // 解析卷范围（若指定 volume）与基线章号所需只读数据
  const [
    chapters,
    outlineLoaded,
    foreshadowingStore,
    sessionStatus,
    subplotBoard,
    emotionLedger,
    emotionalArcs,
    drafts,
  ] = await Promise.all([
    explicitCurrentChapter === undefined
      ? safeLoad("chapters", "scope", () => deps.listChapters(projectPath), [] as Array<{ name: string; path: string }>)
      : Promise.resolve([] as Array<{ name: string; path: string }>),
    volume !== undefined
      ? safeLoad("outlineModel", "scope", () => deps.loadOutlineModel(projectPath), { model: null })
      : Promise.resolve({ model: null as OutlineModel | null }),
    wanted.has("foreshadowing") || explicitCurrentChapter === undefined
      ? safeLoad<ForeshadowingStore>(
          "foreshadowingTracker",
          "foreshadowing",
          () => deps.loadForeshadowing(projectPath),
          { items: [], lastUpdated: "" },
        )
      : Promise.resolve<ForeshadowingStore>({ items: [], lastUpdated: "" }),
    wanted.has("chaseDebt") || explicitCurrentChapter === undefined
      ? safeLoad<NovelSessionStatus | null>("sessionStatus", "chaseDebt", () => deps.loadStatus(projectPath), null)
      : Promise.resolve<NovelSessionStatus | null>(null),
    wanted.has("chaseDebt")
      ? safeLoad<SubplotBoardStore>(
          "subplotBoard",
          "chaseDebt",
          () => deps.loadSubplotBoard(projectPath),
          { items: [], lastUpdated: "" },
        )
      : Promise.resolve<SubplotBoardStore>({ items: [], lastUpdated: "" }),
    wanted.has("emotion")
      ? safeLoad<EmotionLedgerStore>(
          "emotionLedger",
          "emotion",
          () => deps.loadEmotionLedger(projectPath),
          { entries: [], lastUpdated: "" },
        )
      : Promise.resolve<EmotionLedgerStore>({ entries: [], lastUpdated: "" }),
    wanted.has("emotion")
      ? safeLoad<EmotionalArcStore>(
          "emotionalArcs",
          "emotion",
          () => deps.loadEmotionalArcs(projectPath),
          { beats: [], lastUpdated: "" },
        )
      : Promise.resolve<EmotionalArcStore>({ beats: [], lastUpdated: "" }),
    wanted.has("drafts") || explicitCurrentChapter === undefined
      ? safeLoad<ChapterDraft[]>("chapterDrafts", "drafts", () => deps.listDrafts(projectPath), [])
      : Promise.resolve<ChapterDraft[]>([]),
  ])

  let volumeChapterSet: Set<number> | null = null
  if (volume !== undefined) {
    volumeChapterSet = new Set<number>()
    if (outlineLoaded.model) {
      const flat = flattenOutlineChapters(outlineLoaded.model)
      for (const ch of flat) {
        if (ch.volume === volume && Number.isSafeInteger(ch.chapter) && ch.chapter > 0) {
          volumeChapterSet.add(ch.chapter)
        }
      }
    } else {
      degradedSignals.push({
        source: "outlineModel",
        section: "scope",
        error: `volume=${volume} 过滤所需的大纲模型缺失，无法映射卷内章节`,
      })
    }
  }

  const hasWindowFilter = volume !== undefined || chapterStart !== undefined || chapterEnd !== undefined
  const chapterInWindow = (chapter: number | null | undefined): boolean => {
    if (!hasWindowFilter) return true
    if (chapter === null || chapter === undefined || !Number.isFinite(chapter)) return false
    if (volumeChapterSet !== null) {
      return volumeChapterSet.has(chapter)
    }
    if (chapterStart !== undefined && chapter < chapterStart) return false
    if (chapterEnd !== undefined && chapter > chapterEnd) return false
    return true
  }

  let effectiveCurrentChapter = explicitCurrentChapter ?? 0
  if (explicitCurrentChapter === undefined) {
    let maxFormal = 0
    for (const ch of chapters) {
      if (isDraftChapterFile(ch.name)) continue
      const num = resolveChapterFileNumber(ch.name)
      if (num !== undefined && num > maxFormal) maxFormal = num
    }
    const watermark = getForeshadowingWatermark(Array.isArray(foreshadowingStore.items) ? foreshadowingStore.items : [])
    const statusChapter = sessionStatus?.current_task?.chapter_number ?? 0
    let maxDraftChapter = 0
    for (const draft of drafts) {
      const num = readDraftChapterNumber(draft.chapterName) ?? 0
      if (num > maxDraftChapter) maxDraftChapter = num
    }
    effectiveCurrentChapter = Math.max(maxFormal, watermark, statusChapter, maxDraftChapter)
    if (volumeChapterSet && volumeChapterSet.size > 0) {
      effectiveCurrentChapter = Math.max(effectiveCurrentChapter, ...volumeChapterSet)
    }
    if (chapterEnd !== undefined) {
      effectiveCurrentChapter = Math.max(effectiveCurrentChapter, chapterEnd)
    }
  }

  const sections: AuditLongformHealthResult["sections"] = {}
  const p0Triggers: string[] = []
  const p1Triggers: string[] = []
  const p2Triggers: string[] = []
  const degradedTriggers: string[] = []

  // ── 1. foreshadowing ────────────────────────────────────────────────────────
  if (wanted.has("foreshadowing")) {
    const allItems = Array.isArray(foreshadowingStore.items) ? foreshadowingStore.items : []
    const scopedItems = hasWindowFilter
      ? allItems.filter(
          (item) =>
            chapterInWindow(item.plantedChapter)
            || (Array.isArray(item.advancedChapters) && item.advancedChapters.some((ch) => chapterInWindow(ch)))
            || chapterInWindow(item.resolvedChapter),
        )
      : allItems
    const report: ForeshadowingDebtReport = analyzeForeshadowingDebt(
      { items: scopedItems, lastUpdated: foreshadowingStore.lastUpdated ?? "" },
      effectiveCurrentChapter,
    )
    const sorted = [...report.items].sort((a, b) => {
      const rankDiff = DEBT_RANK[a.debtLevel] - DEBT_RANK[b.debtLevel]
      if (rankDiff !== 0) return rankDiff
      if (b.chaptersSincePlanted !== a.chaptersSincePlanted) {
        return b.chaptersSincePlanted - a.chaptersSincePlanted
      }
      return a.id.localeCompare(b.id)
    })
    sections.foreshadowing = {
      total: scopedItems.length,
      totalUnresolved: report.totalUnresolved,
      criticalCount: report.criticalCount,
      warningCount: report.warningCount,
      debtScore: report.debtScore,
      topItems: sorted.slice(0, topK).map((item) => ({
        id: item.id,
        name: item.name,
        status: item.status,
        plantedChapter: item.plantedChapter,
        chaptersSincePlanted: item.chaptersSincePlanted,
        debtLevel: item.debtLevel,
        ...(includeDetails ? { description: item.description } : {}),
      })),
    }
    if (report.criticalCount > 0) {
      p0Triggers.push(`P0:foreshadowing_critical(${report.criticalCount})`)
    } else if (report.warningCount > 0) {
      p2Triggers.push(`P2:foreshadowing_warning(${report.warningCount})`)
    }
  }

  // ── 2. chaseDebt ────────────────────────────────────────────────────────────
  if (wanted.has("chaseDebt")) {
    const rawDebts: ChaseDebt[] = Array.isArray(sessionStatus?.chase_debt?.debts)
      ? sessionStatus!.chase_debt!.debts
      : []
    const scopedDebts = hasWindowFilter
      ? rawDebts.filter((d) => chapterInWindow(d.source_chapter) || chapterInWindow(d.due_chapter))
      : rawDebts
    const activeDebtItems = scopedDebts.filter((d) => d.status === "active" || d.status === "overdue")
    const overdueDebtItems = scopedDebts.filter(
      (d) => d.status === "overdue" || (d.status === "active" && effectiveCurrentChapter > 0 && d.due_chapter < effectiveCurrentChapter),
    )
    const totalDebtAmount = Math.round(
      activeDebtItems.reduce((sum, d) => sum + (Number.isFinite(d.current_amount) ? d.current_amount : 0), 0) * 100,
    ) / 100

    const rawSubplots: Subplot[] = Array.isArray(subplotBoard.items) ? subplotBoard.items : []
    const scopedSubplots = hasWindowFilter
      ? rawSubplots.filter(
          (s) =>
            chapterInWindow(s.startChapter)
            || chapterInWindow(s.lastSeenChapter)
            || chapterInWindow(s.targetResolutionChapter),
        )
      : rawSubplots
    const activeSubplots = scopedSubplots.filter((s) => s.status === "active" && !s.abandoned)
    const pausedSubplots = scopedSubplots.filter((s) => s.status === "paused" && !s.abandoned)
    const enrichedSubplots = scopedSubplots
      .filter((s) => s.status !== "resolved" && !s.abandoned)
      .map((s) => {
        const overdue = Boolean(
          s.targetResolutionChapter !== undefined
          && effectiveCurrentChapter > 0
          && effectiveCurrentChapter > s.targetResolutionChapter,
        )
        const lastSeen = s.lastSeenChapter ?? s.startChapter
        const dormant = Boolean(
          s.status === "active"
          && effectiveCurrentChapter > 0
          && effectiveCurrentChapter - lastSeen >= SUBPLOT_DORMANT_CHAPTER_GAP,
        )
        return { subplot: s, overdue, dormant }
      })
    const overdueSubplotCount = enrichedSubplots.filter((x) => x.overdue).length
    const dormantSubplotCount = enrichedSubplots.filter((x) => x.dormant).length

    const isDebtOverdue = (d: ChaseDebt) =>
      d.status === "overdue"
      || (d.status === "active" && effectiveCurrentChapter > 0 && d.due_chapter < effectiveCurrentChapter)
    const sortedDebts = [...activeDebtItems].sort((a, b) => {
      const aOver = isDebtOverdue(a) ? 0 : 1
      const bOver = isDebtOverdue(b) ? 0 : 1
      if (aOver !== bOver) return aOver - bOver
      if (b.current_amount !== a.current_amount) return b.current_amount - a.current_amount
      return a.id.localeCompare(b.id)
    })
    const sortedSubplots = [...enrichedSubplots].sort((a, b) => {
      const aScore = (a.overdue ? 0 : 2) + (a.dormant ? 0 : 1)
      const bScore = (b.overdue ? 0 : 2) + (b.dormant ? 0 : 1)
      if (aScore !== bScore) return aScore - bScore
      return a.subplot.startChapter - b.subplot.startChapter || a.subplot.id.localeCompare(b.subplot.id)
    })

    sections.chaseDebt = {
      activeDebts: activeDebtItems.length,
      overdueDebts: overdueDebtItems.length,
      totalDebtAmount,
      activeSubplots: activeSubplots.length,
      pausedSubplots: pausedSubplots.length,
      overdueSubplots: overdueSubplotCount,
      dormantSubplots: dormantSubplotCount,
      topDebts: sortedDebts.slice(0, topK).map((d) => ({
        id: d.id,
        debtType: d.debt_type,
        status: d.status,
        sourceChapter: d.source_chapter,
        dueChapter: d.due_chapter,
        currentAmount: d.current_amount,
        ...(includeDetails && d.ref ? { ref: d.ref } : {}),
      })),
      topSubplots: sortedSubplots.slice(0, topK).map(({ subplot, overdue, dormant }) => ({
        id: subplot.id,
        title: subplot.title,
        status: subplot.status,
        startChapter: subplot.startChapter,
        ...(subplot.lastSeenChapter !== undefined ? { lastSeenChapter: subplot.lastSeenChapter } : {}),
        ...(subplot.targetResolutionChapter !== undefined
          ? { targetResolutionChapter: subplot.targetResolutionChapter }
          : {}),
        overdue,
        dormant,
        ...(includeDetails ? { summary: subplot.summary } : {}),
      })),
    }
    if (overdueDebtItems.length > 0 || overdueSubplotCount > 0 || dormantSubplotCount > 0) {
      p2Triggers.push(
        `P2:chase_or_subplot_debt(overdueDebts=${overdueDebtItems.length},overdueSubplots=${overdueSubplotCount},dormantSubplots=${dormantSubplotCount})`,
      )
    }
  }

  // ── 3. emotion ──────────────────────────────────────────────────────────────
  if (wanted.has("emotion")) {
    const rawEntries: EmotionLedgerEntry[] = Array.isArray(emotionLedger.entries) ? emotionLedger.entries : []
    const scopedEntries = hasWindowFilter
      ? rawEntries.filter(
          (e) =>
            chapterInWindow(e.lastUpdatedChapter)
            || (Array.isArray(e.history) && e.history.some((h) => chapterInWindow(h.chapter))),
        )
      : rawEntries
    const scopedLedger: EmotionLedgerStore = {
      entries: scopedEntries,
      lastUpdated: emotionLedger.lastUpdated ?? "",
    }
    const rawBeats: EmotionalArcBeat[] = Array.isArray(emotionalArcs.beats) ? emotionalArcs.beats : []
    const scopedBeats = hasWindowFilter
      ? rawBeats.filter((b) => chapterInWindow(b.chapterNumber))
      : rawBeats

    const breakerStatus = getCircuitBreakerStatus(scopedLedger, emotionBreakerThreshold)
    const breakerCheck = checkEmotionCircuitBreaker(scopedLedger, emotionBreakerThreshold)
    const topDebt = getTopEmotionalDebt(scopedLedger, topK)
    const lowestNetValue = topDebt.length > 0 ? topDebt[0]!.netValue : null

    sections.emotion = {
      trackedCharacters: scopedEntries.length,
      arcBeatCount: scopedBeats.length,
      breakerThreshold: emotionBreakerThreshold,
      breakerStatus: breakerStatus.status,
      breakerTripped: breakerCheck.tripped,
      breakerReason: breakerStatus.reason,
      lowestNetValue,
      topDebtCharacters: topDebt.map((e) => ({
        characterName: e.characterName,
        netValue: e.netValue,
        valence: e.valence,
        arousal: e.arousal,
        dominance: e.dominance,
        lastUpdatedChapter: e.lastUpdatedChapter,
        historyCount: Array.isArray(e.history) ? e.history.length : 0,
      })),
      ...(includeDetails
        ? {
            recentArcBeats: [...scopedBeats]
              .sort((a, b) => b.chapterNumber - a.chapterNumber)
              .slice(0, topK),
          }
        : {}),
    }
    if (breakerCheck.tripped) {
      p0Triggers.push(`P0:emotion_circuit_breaker_tripped(threshold=${emotionBreakerThreshold})`)
    } else if (breakerStatus.status === "armed") {
      p2Triggers.push(`P2:emotion_circuit_breaker_armed(threshold=${emotionBreakerThreshold})`)
    }
  }

  // ── 4. drafts ───────────────────────────────────────────────────────────────
  if (wanted.has("drafts")) {
    const scopedDrafts = hasWindowFilter
      ? drafts.filter((d) => chapterInWindow(readDraftChapterNumber(d.chapterName)))
      : drafts
    const activeDrafts = scopedDrafts.filter((d) => d.status === "draft")
    let needsGateReviewCount = 0
    let partialCount = 0
    let blockedCount = 0
    let manualReviewCount = 0
    let unassessedCount = 0
    let maxRevisionRound = 0

    const enrichedDrafts = activeDrafts.map((d) => {
      const gateStatus = getDraftGateStatus(d)
      const needsReview = draftNeedsGateReview(d)
      const isPartial = d.partial === true || d.adoptionGate?.status === "partial"
      const revisionRound = d.revisionRound ?? 0
      if (needsReview) needsGateReviewCount += 1
      if (isPartial) partialCount += 1
      if (gateStatus === "blocked") blockedCount += 1
      if (gateStatus === "manual_review") manualReviewCount += 1
      if (gateStatus === "unassessed") unassessedCount += 1
      if (revisionRound > maxRevisionRound) maxRevisionRound = revisionRound
      return {
        draft: d,
        chapterNumber: readDraftChapterNumber(d.chapterName) ?? null,
        gateStatus,
        needsGateReview: needsReview,
        partial: isPartial,
        revisionRound,
      }
    })

    enrichedDrafts.sort((a, b) => {
      const aUrgency = a.gateStatus === "blocked" || a.gateStatus === "manual_review" ? 0 : a.partial || a.needsGateReview ? 1 : 2
      const bUrgency = b.gateStatus === "blocked" || b.gateStatus === "manual_review" ? 0 : b.partial || b.needsGateReview ? 1 : 2
      if (aUrgency !== bUrgency) return aUrgency - bUrgency
      return b.draft.createdAt - a.draft.createdAt || a.draft.id.localeCompare(b.draft.id)
    })

    sections.drafts = {
      totalDrafts: scopedDrafts.length,
      activeDrafts: activeDrafts.length,
      needsGateReviewCount,
      partialCount,
      blockedCount,
      manualReviewCount,
      unassessedCount,
      maxRevisionRound,
      topDrafts: enrichedDrafts.slice(0, topK).map((entry) => ({
        draftId: entry.draft.id,
        chapterName: entry.draft.chapterName,
        chapterNumber: entry.chapterNumber,
        status: entry.draft.status,
        gateStatus: entry.gateStatus,
        needsGateReview: entry.needsGateReview,
        partial: entry.partial,
        revisionRound: entry.revisionRound,
        ...(includeDetails ? { chars: entry.draft.content.length } : {}),
      })),
    }

    if (blockedCount > 0 || manualReviewCount > 0) {
      p0Triggers.push(`P0:drafts_halted(blocked=${blockedCount},manualReview=${manualReviewCount})`)
    } else if (partialCount > 0 || needsGateReviewCount > 0) {
      p1Triggers.push(`P1:drafts_attention(partial=${partialCount},needsGateReview=${needsGateReviewCount})`)
    }
  }

  // ── 5. canonRisk（强制 readOnly: true，绝不落盘）──────────────────────────
  if (wanted.has("canonRisk")) {
    const checkedChapter = effectiveCurrentChapter >= 1 ? effectiveCurrentChapter : null
    const rawFindings: NovelReviewResult[] = checkedChapter !== null
      ? await safeLoad(
          "continuityPreflight",
          "canonRisk",
          () => deps.runContinuityPreflight(projectPath, checkedChapter, {
            readOnly: true,
            includeNonBlockingAudit: true,
          }),
          [],
        )
      : []

    const filteredFindings: NovelReviewResult[] = []
    for (const f of rawFindings) {
      if (f.evidence === "engine_error" || f.evidence === "audit_error") {
        degradedSignals.push({
          source: f.evidence,
          section: "canonRisk",
          error: f.message,
        })
        continue
      }
      const findingChapter = f.continuityMeta?.chapter
      if (hasWindowFilter && findingChapter !== undefined && !chapterInWindow(findingChapter)) {
        continue
      }
      filteredFindings.push(f)
    }

    const errorCount = filteredFindings.filter((f) => f.severity === "error").length
    const warningCount = filteredFindings.filter((f) => f.severity === "warning").length
    const infoCount = filteredFindings.filter((f) => f.severity === "info").length
    const dataGapCount = filteredFindings.filter(
      (f) => f.evidence === "data_gap" || f.continuityMeta?.subtype === "data_gap",
    ).length

    const sortedFindings = [...filteredFindings].sort((a, b) => {
      const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
      if (rankDiff !== 0) return rankDiff
      return a.message.localeCompare(b.message)
    })

    sections.canonRisk = {
      checkedChapter,
      p0Blocked: errorCount > 0,
      errorCount,
      warningCount,
      infoCount,
      dataGapCount,
      topFindings: sortedFindings.slice(0, topK).map((f) => ({
        severity: f.severity,
        type: f.type,
        message: f.message,
        ...(f.continuityMeta?.chapter !== undefined ? { chapter: f.continuityMeta.chapter } : {}),
        ...(f.continuityMeta?.subtype ? { subtype: f.continuityMeta.subtype } : {}),
        ...(includeDetails
          ? {
              evidence: f.evidence,
              suggestion: f.suggestion,
            }
          : {}),
      })),
    }

    if (errorCount > 0) {
      p0Triggers.push(`P0:canon_risk_errors(${errorCount})`)
    } else if (warningCount > 0) {
      p1Triggers.push(`P1:canon_risk_warnings(${warningCount})`)
    }
  }

  if (degradedSignals.length > 0) {
    degradedTriggers.push(`degraded_sources(${degradedSignals.length})`)
  }

  // 严格遵守 P0 > P1 > P2 优先级裁决总体健康状态与触发器排序
  const watchTriggers = [...p1Triggers, ...p2Triggers, ...degradedTriggers]
  const riskTriggers = [...p0Triggers, ...watchTriggers]
  const overallStatus: LongformHealthOverallStatus =
    p0Triggers.length > 0
      ? "at_risk"
      : watchTriggers.length > 0
        ? "watch"
        : "healthy"

  return {
    projectPath,
    overallStatus,
    priorityOrder: ["P0:consistency", "P1:anti_ai", "P2:quality"],
    riskTriggers,
    currentChapter: effectiveCurrentChapter,
    scope: {
      volume: volume ?? null,
      chapterStart: chapterStart ?? null,
      chapterEnd: chapterEnd ?? null,
      matchedChapters: volumeChapterSet !== null ? volumeChapterSet.size : null,
    },
    sectionsRequested,
    topK,
    includeDetails,
    emotionBreakerThreshold,
    sections,
    degradedSignals,
    meta: READ_ONLY_META,
  }
}

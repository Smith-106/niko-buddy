import { createDirectory, listDirectory, readFile, writeFile } from "@/commands/fs"
import type { LintResult } from "@/lib/lint"
import { normalizePath } from "@/lib/path-utils"
import { moveFileToTrash } from "@/lib/trash"
import { pad } from "@/lib/utils"
import type { NovelReviewResult } from "./review-adapter"
import type { DimensionReviewResult, SixReviewDimensionKey } from "./dimension-review-adapter"

/**
 * 生成历史 kind（63 号共识 §6 缺口 18 扩展）：lint/review 之外增加跨形态
 * snapshot——story（推演报告）、translation（翻译结果）、screenplay（剧本）、
 * fanfic（同人）、cover（封面题图 brief）、film（影游流程）。snapshot 条目
 * 只存「形态名 + 产物摘要引用」（results 空数组 + meta），不复制正文
 * （Draft-first：正式正文仍由各自流水线文件系统真源持有）。
 */
export type GenerationHistoryKind =
  | "lint"
  | "review"
  | "snapshot-story"
  | "snapshot-translation"
  | "snapshot-screenplay"
  | "snapshot-fanfic"
  | "snapshot-cover"
  | "snapshot-film"

export type GenerationHistoryResult = LintResult | NovelReviewResult

export interface GenerationHistoryEntry {
  id: string
  kind: GenerationHistoryKind
  title: string
  chapterNumber?: number
  sourcePath?: string
  results: GenerationHistoryResult[]
  dimensionResults?: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>
  createdAt: string
  filePath: string
  /** 53 号报告 P1-3 additive: 审查绑定章节 hash (防伪 STALE_ARTIFACT 判定)。 */
  chapterHash?: string
  /** 53 号报告 P1-3 additive: 完成门状态 (completed/incomplete/suspect)。 */
  gateStatus?: "completed" | "incomplete" | "suspect"
  /** 64 号实施 additive: 跨形态 snapshot 元数据（snapshot-* kind 使用）。 */
  snapshotMeta?: {
    /** 形态标识（story/translation/screenplay/fanfic/cover/film）。 */
    shape: string
    /** 产物相对引用（文件路径或 store id，供溯源）。 */
    artifactRef?: string
    /** 快照时形态流水线状态摘要（不复制正文）。 */
    summary?: string
  }
}

export interface SaveGenerationHistoryInput {
  kind: GenerationHistoryKind
  title: string
  chapterNumber?: number
  sourcePath?: string
  results: GenerationHistoryResult[]
  dimensionResults?: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>
  /** 53 号报告 P1-3 additive。 */
  chapterHash?: string
  /** 53 号报告 P1-3 additive。 */
  gateStatus?: "completed" | "incomplete" | "suspect"
  /** 64 号实施 additive: 跨形态 snapshot 元数据。 */
  snapshotMeta?: GenerationHistoryEntry["snapshotMeta"]
}

function formatDateTime(value: number): string {
  const date = new Date(value)
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "-",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("")
}

function makeHistoryId(now: number): string {
  return `${formatDateTime(now)}-${Math.random().toString(36).slice(2, 8)}`
}

function historyRoot(projectPath: string): string {
  return `${normalizePath(projectPath)}/.qmai/generation-history`
}

function historyKindDir(projectPath: string, kind: GenerationHistoryKind): string {
  return `${historyRoot(projectPath)}/${kind}`
}

async function ensureHistoryDirs(projectPath: string, kind: GenerationHistoryKind): Promise<void> {
  const pp = normalizePath(projectPath)
  await createDirectory(`${pp}/.qmai`)
  await createDirectory(historyRoot(pp))
  await createDirectory(historyKindDir(pp, kind))
}

function isHistoryEntry(value: unknown): value is GenerationHistoryEntry {
  const entry = value as Partial<GenerationHistoryEntry>
  return Boolean(
    entry &&
      typeof entry.id === "string" &&
      (entry.kind === "lint" ||
        entry.kind === "review" ||
        entry.kind === "snapshot-story" ||
        entry.kind === "snapshot-translation" ||
        entry.kind === "snapshot-screenplay" ||
        entry.kind === "snapshot-fanfic" ||
        entry.kind === "snapshot-cover" ||
        entry.kind === "snapshot-film") &&
      typeof entry.title === "string" &&
      Array.isArray(entry.results) &&
      typeof entry.createdAt === "string" &&
      typeof entry.filePath === "string",
  )
}

export async function saveGenerationHistoryEntry(
  projectPath: string,
  input: SaveGenerationHistoryInput,
): Promise<GenerationHistoryEntry> {
  const pp = normalizePath(projectPath)
  const now = Date.now()
  const id = makeHistoryId(now)
  const filePath = `${historyKindDir(pp, input.kind)}/${id}.json`
  const entry: GenerationHistoryEntry = {
    id,
    kind: input.kind,
    title: input.title,
    chapterNumber: input.chapterNumber,
    sourcePath: input.sourcePath ? normalizePath(input.sourcePath) : undefined,
    results: input.results,
    dimensionResults: input.dimensionResults,
    snapshotMeta: input.snapshotMeta,
    createdAt: new Date(now).toISOString(),
    filePath,
  }

  await ensureHistoryDirs(pp, input.kind)
  await writeFile(filePath, JSON.stringify(entry, null, 2))
  return entry
}

export async function listGenerationHistory(
  projectPath: string,
  kind: GenerationHistoryKind,
): Promise<GenerationHistoryEntry[]> {
  const dir = historyKindDir(projectPath, kind)
  let files: Awaited<ReturnType<typeof listDirectory>>
  try {
    files = await listDirectory(dir)
  } catch {
    return []
  }

  const entries: GenerationHistoryEntry[] = []
  for (const file of files) {
    if (file.is_dir || !file.name.endsWith(".json")) continue
    try {
      const parsed = JSON.parse(await readFile(file.path))
      if (isHistoryEntry(parsed) && parsed.kind === kind) {
        entries.push({ ...parsed, filePath: normalizePath(parsed.filePath) })
      }
    } catch {
    }
  }

  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function deleteGenerationHistoryEntry(
  projectPath: string,
  filePath: string,
): Promise<void> {
  await moveFileToTrash(projectPath, normalizePath(filePath), "history")
}

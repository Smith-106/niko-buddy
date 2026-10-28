/**
 * chapter-ingest 拆分 W1：快照持久化原语。
 *
 * 本模块只承载「叶子级」IO 原语 —— 每个函数只依赖 `@/commands/fs` 与
 * `./snapshot-paths` / `./chapter-snapshot-normalize` 等纯工具，**不反向依赖
 * chapter-ingest.ts 的任何编排逻辑**，因此可以独立测试与复用。
 *
 * 保留在母文件的同类函数（`deleteChapterSnapshots`）依赖 rebuild / drift 自愈
 * 编排，属 W3/W4 范畴，不在本模块。
 *
 * `chapter-ingest.ts` 通过 re-export 保持既有 import 面，70 个消费方零改动。
 */
import {
  createDirectory,
  deleteFile,
  fileExists,
  listDirectory,
  readFile,
  writeFileAtomic,
  writeFilesAtomic,
} from "@/commands/fs"
import { logger, toErrorMessage } from "@/lib/utils"
import { normalizePath } from "@/lib/path-utils"
import { listEntityFiles } from "./entity-subdir-resolver"
import {
  ensureSnapshotIdentity,
  normalizeChapterSnapshot,
} from "./chapter-snapshot-normalize"
import { buildChapterIngestOutput, type ChapterIngestOutput } from "./chapter-ingest-output"
import { canonicalizeSnapshotCharacters } from "./graph-adapter"
import { mergeSnapshotTimeline } from "./timeline"
import {
  hasSnapshotSourceReference,
  isOnlyCurrentChapterSource,
  snapshotHistoryDir,
  snapshotHistoryFileName,
  snapshotJsonPath,
  snapshotMarkdownPath,
  snapshotSourceFileNameCandidates,
  snapshotToMarkdown,
} from "./snapshot-paths"
import type { ChapterSnapshot } from "./chapter-ingest"

export async function saveSnapshot(projectPath: string, snapshot: ChapterSnapshot): Promise<void> {
  const canonicalSnapshot = ensureSnapshotIdentity(canonicalizeSnapshotCharacters(snapshot))
  const normalizedSnapshot = normalizeChapterSnapshot(canonicalSnapshot, {
    chapterId: snapshot.chapterId,
    chapterNumber: snapshot.chapterNumber,
  })
  /* v8 ignore next */
  if (!normalizedSnapshot) {
    throw new Error("Invalid snapshot data.")
  }
  const snapshotDir = `${projectPath}/.novel/snapshots`
  const jsonPath = snapshotJsonPath(projectPath, normalizedSnapshot.chapterNumber)
  const mdPath = snapshotMarkdownPath(projectPath, normalizedSnapshot.chapterNumber)

  await createDirectory(snapshotDir)
  // S4-R4：json+md 改走 writeFilesAtomic 单次批量事务。两文件同属一次快照，
  // prepare 阶段任一 temp 失败即零落盘；提交阶段为顺序 rename（微秒窗口）。
  // mergeSnapshotTimeline 为幂等第三写，崩溃后重跑收敛。
  await writeFilesAtomic([
    [jsonPath, JSON.stringify(normalizedSnapshot, null, 2)],
    [mdPath, snapshotToMarkdown(normalizedSnapshot)],
  ])

  await mergeSnapshotTimeline(projectPath, normalizedSnapshot.chapterNumber, normalizedSnapshot.timelineEvents)
}

export async function saveChapterIngestOutput(
  projectPath: string,
  snapshot: ChapterSnapshot,
  options: { title?: string } = {},
): Promise<ChapterIngestOutput> {
  const output = buildChapterIngestOutput(snapshot, options)
  const outputDir = `${projectPath}/.novel/chapter-ingest-output`
  const prefix = `${outputDir}/${String(snapshot.chapterNumber).padStart(3, "0")}`

  await createDirectory(outputDir)
  // PERF-NEW-09 (odyssey-improve DC-3): parallelize the 4 independent ingest
  // output writes. All four files derive from the already-built `output`
  // object (no cross-file dependency) and target distinct paths, so
  // writeFileAtomic invocations are safe to run concurrently. Drops 4 serial
  // IPC round-trips to ~1 concurrent batch.
  await Promise.all([
    writeFileAtomic(`${prefix}.output.json`, JSON.stringify(output, null, 2)),
    writeFileAtomic(`${prefix}.wiki-patch.json`, JSON.stringify(output.wikiUpdatePatch, null, 2)),
    writeFileAtomic(`${prefix}.search-index.json`, JSON.stringify(output.searchIndexText, null, 2)),
    writeFileAtomic(`${prefix}.vector-index.json`, JSON.stringify(output.vectorIndexText, null, 2)),
  ])

  return output
}

export async function loadSnapshot(
  projectPath: string,
  chapterNumber: number,
): Promise<ChapterSnapshot | null> {
  const pp = normalizePath(projectPath)
  const prefix = chapterNumber < 0
    ? `outline-${String(Math.abs(chapterNumber)).padStart(3, "0")}`
    : String(chapterNumber).padStart(3, "0")
  const jsonPath = `${pp}/.novel/snapshots/${prefix}.snapshot.json`
  try {
    const raw = await readFile(jsonPath)
    return normalizeChapterSnapshot(JSON.parse(raw), {
      chapterId: `chapter-${chapterNumber}`,
      chapterNumber,
    })
  } catch {
    logger.warn("Chapter Ingest", "silent-degrade: 降级返回空值（吞错已标记）", { line: 3003 })
    return null
  }
}

/**
 * 列出章节快照对应章号（大纲为负数）。
 *
 * `failLoud`（默认 false）仅放行「目录不存在」→ []，其它 IO 异常继续抛出：
 * 章节目录等需要诚实错误态的调用方应传 true，否则权限/IO 失败会被显示成「暂无章节」。
 */
export async function listSnapshots(
  projectPath: string,
  opts?: { failLoud?: boolean },
): Promise<number[]> {
  const pp = normalizePath(projectPath)
  const snapshotDir = `${pp}/.novel/snapshots`
  try {
    const tree = await listDirectory(snapshotDir)
    return tree
      .filter(f => f.name.endsWith(".snapshot.json"))
      .map(f => {
        const stem = f.name.split(".")[0]
        // outline-001 → -1, outline-002 → -2
        const outlineMatch = stem.match(/^outline-(\d+)$/)
        if (outlineMatch) return -parseInt(outlineMatch[1], 10)
        return parseInt(stem, 10)
      })
      .filter(n => !isNaN(n))
      .sort((a, b) => a - b)
  } catch (err) {
    if (opts?.failLoud && !isNotFoundError(err)) throw err
    logger.warn("Chapter Ingest", "silent-degrade: 降级返回空值（吞错已标记）", { line: 3024 })
    return []
  }
}

/** 目录不存在（首次打开尚未生成快照）与真正的 IO 失败的区分。 */
export function isNotFoundError(err: unknown): boolean {
  const message = toErrorMessage(err)
  return /not found|no such file|does not exist|cannot find the (file|path)/i.test(message)
}

export async function backupSnapshotBeforeOverwrite(
  projectPath: string,
  chapterNumber: number,
): Promise<void> {
  const currentJsonPath = snapshotJsonPath(projectPath, chapterNumber)
  if (!(await fileExists(currentJsonPath))) return
  const currentRaw = await readFile(currentJsonPath)
  const normalizedCurrent = normalizeChapterSnapshot(JSON.parse(currentRaw), {
    chapterId: `chapter-${chapterNumber}`,
    chapterNumber,
  })
  const currentJson = normalizedCurrent
    ? JSON.stringify(ensureSnapshotIdentity(normalizedCurrent, { isHistorical: true }), null, 2)
    : currentRaw
  const historyDir = snapshotHistoryDir(projectPath, chapterNumber)
  await createDirectory(historyDir)
  await writeFileAtomic(`${historyDir}/${snapshotHistoryFileName()}`, currentJson)
}

/**
 * ISS-20260712-MAINT-4: 已删章节的 truth store 残留兜底清扫。
 * 列出 entities/ 下 .md，其 snapshot token 全部命中被删章节候选则删除
 * （exact 口径，跨章节子串不误伤；混引保留）。best-effort：读删失败记 warn。
 */
export async function cleanupDeletedChapterResidualEntities(
  projectPath: string,
  chapterNumber: number,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const candidates = new Set(snapshotSourceFileNameCandidates(chapterNumber))
  let oldFiles: string[] = []
  try {
    oldFiles = (await listEntityFiles(pp)).map((f) => `${f.name}.md`)
  } catch (err) {
    logger.warn("Chapter Ingest", "residual sweep list failed (non-fatal)", { error: toErrorMessage(err) })
    return []
  }
  const deleted: string[] = []
  const entitiesDir = `${pp}/wiki/entities`
  for (const oldFile of oldFiles) {
    const filePath = `${entitiesDir}/${oldFile}`
    let content: string
    try {
      content = await readFile(filePath)
    } catch (err) {
      logger.warn("Chapter Ingest", "residual sweep read failed (non-fatal)", { path: filePath, error: toErrorMessage(err) })
      continue
    }
    if (!hasSnapshotSourceReference(content, candidates)) continue
    if (!isOnlyCurrentChapterSource(content, candidates)) continue
    try {
      await deleteFile(filePath)
      deleted.push(filePath)
    } catch (err) {
      logger.warn("Chapter Ingest", "residual sweep delete failed (non-fatal)", { path: filePath, error: toErrorMessage(err) })
    }
  }
  return deleted
}

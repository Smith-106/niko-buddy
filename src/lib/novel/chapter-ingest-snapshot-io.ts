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
import { isMissingFile } from "./chapter-ingest-utils"
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
import { withProjectLock } from "./novel-locks"
import type { ChapterSnapshot } from "./chapter-ingest"

export { isMissingFile, isNotFoundError } from "./chapter-ingest-utils"

/**
 * 章级快照写临界区（read-current → archive → save 的同一把锁）。
 * 键含 normalizePath 归一后的 project + 章号；canonicalLockKey 再做尾斜杠归一。
 */
export function withSnapshotWriteLock<T>(projectPath: string, chapterNumber: number, run: () => Promise<T>): Promise<T> {
  return withProjectLock(`snapshot:${normalizePath(projectPath).replace(/\/+$/, "")}:${chapterNumber}`, run)
}

/**
 * 提交点严格读当前快照：真缺失返回 null；存在但损坏/章号不符/revision
 * 不可安全自增 → 抛错（绝不带病覆写）。revision 必须可 +1 仍安全整数。
 */
export async function readSnapshotForReplacement(
  projectPath: string,
  chapterNumber: number,
): Promise<{ raw: string; snapshot: ChapterSnapshot } | null> {
  const path = snapshotJsonPath(projectPath, chapterNumber)
  let raw: string
  try {
    raw = await readFile(path)
  } catch (err) {
    if (await isMissingFile(path, err)) return null
    throw err
  }
  const value: unknown = JSON.parse(raw)
  const snapshot = normalizeChapterSnapshot(value, {
    chapterId: `chapter-${chapterNumber}`,
    chapterNumber,
  })
  // 严格 current 读取：历史归档、章号不符、或显式 revision 被归一化丢失
  // （损坏身份）一律拒绝——绝不把损坏的 r2 静默当 r1 覆写。
  const rawFields = typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
  if (!snapshot
    || Object.keys(rawFields).length === 0
    || snapshot.chapterNumber !== chapterNumber
    || rawFields.isHistorical === true
    || (rawFields.revision != null && snapshot.revision === undefined)) {
    throw new Error("Invalid current snapshot data.")
  }
  const current = ensureSnapshotIdentity(snapshot)
  if (!Number.isSafeInteger(current.revision) || (current.revision ?? 0) >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Invalid current snapshot data.")
  }
  // 显式 `-rN` 后缀的 snapshotId 必须与可信 revision 一致（无后缀/无 id 仍允许）。
  const idSuffix = typeof current.snapshotId === "string"
    ? current.snapshotId.match(/-r(\d+)$/)?.[1]
    : undefined
  if (idSuffix !== undefined && Number(idSuffix) !== current.revision) {
    throw new Error("Invalid current snapshot data.")
  }
  return { raw, snapshot: current }
}

/**
 * 归档一份已序列化的快照 JSON 到本章 history 目录，返回实际落盘路径。
 * 同戳文件存在时追加 `-N` 后缀选首个空位（不覆盖已有历史）。
 */
export async function archiveSnapshotJson(projectPath: string, chapterNumber: number, json: string): Promise<string> {
  const historyDir = snapshotHistoryDir(projectPath, chapterNumber)
  await createDirectory(historyDir)
  const fileName = snapshotHistoryFileName()
  let path = `${historyDir}/${fileName}`
  for (let suffix = 1; await fileExists(path); suffix++) {
    path = `${historyDir}/${fileName.replace(/\.snapshot\.json$/, `-${suffix}.snapshot.json`)}`
  }
  await writeFileAtomic(path, json)
  return path
}

/**
 * 落盘快照（JSON+MD 原子批写）并合并 timeline。
 *
 * 返回值是**本次实际序列化的 normalized snapshot**（identity 已完成）：提交点
 * 的 output/Canon/receipt 复用它，不再二次 normalize/identity，也不新增持久字段。
 * 既有调用方忽略返回值不受影响。
 */
export async function saveSnapshot(projectPath: string, snapshot: ChapterSnapshot): Promise<ChapterSnapshot> {
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

  return normalizedSnapshot
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
  // 单次摄取的写入全部落定后才释放章锁，失败的旧写入不能越过下一轮。
  const writes = await Promise.allSettled([
    writeFileAtomic(`${prefix}.output.json`, JSON.stringify(output, null, 2)),
    writeFileAtomic(`${prefix}.wiki-patch.json`, JSON.stringify(output.wikiUpdatePatch, null, 2)),
    writeFileAtomic(`${prefix}.search-index.json`, JSON.stringify(output.searchIndexText, null, 2)),
    writeFileAtomic(`${prefix}.vector-index.json`, JSON.stringify(output.vectorIndexText, null, 2)),
  ])
  const failure = writes.find((write): write is PromiseRejectedResult => write.status === "rejected")
  if (failure) throw failure.reason

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
    if (opts?.failLoud && !(await isMissingFile(snapshotDir, err))) throw err
    logger.warn("Chapter Ingest", "silent-degrade: 降级返回空值（吞错已标记）", { line: 3024 })
    return []
  }
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
  await archiveSnapshotJson(projectPath, chapterNumber, currentJson)
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
    oldFiles = (await listEntityFiles(pp)).map((f) => normalizePath(f.path))
  } catch (err) {
    logger.warn("Chapter Ingest", "residual sweep list failed (non-fatal)", { error: toErrorMessage(err) })
    return []
  }
  const deleted: string[] = []
  for (const filePath of oldFiles) {
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

/**
 * chapter-ingest 拆分 W2：快照历史与当前快照物化。
 *
 * 本模块承载「当前快照读写 / 版本物化 / 历史列表 / 编辑落盘」这一簇，
 * 依赖 W1 的 `chapter-ingest-snapshot-io`，**不依赖 rebuild / drift 编排**
 * （那部分留在母文件，属 W3/W4）。
 *
 * 注意：`restoreSnapshotHistory` 不在此模块 —— 它的依赖图出边指向
 * `rebuildDerivedMemoryFromSnapshots`(W3) 与 `autoRepairTruthFoldDrift`(W4)，
 * 必须等 W3/W4 落地后才能搬出（见波次计划）。
 */
import { listDirectory, readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { logger, toErrorMessage } from "@/lib/utils"
import { parseFrontmatter } from "@/lib/frontmatter"
import { isChapterPage, parseChapterNumber } from "./chapter-meta"
import { isDraftChapterFile } from "./chapter-utils"
import {
  buildSnapshotRevisionId,
  ensureSnapshotIdentity,
  inferSnapshotSourceSequence,
  inferSnapshotSourceType,
  normalizeChapterSnapshot,
} from "./chapter-snapshot-normalize"
import { isValidMemorySnapshot } from "./memory-rebuild"
import { isMissingFile } from "./chapter-ingest-utils"
import { analyzeEditImpact } from "./edit-impact-analyzer"
import { projectSnapshotForImpact, projectSnapshotToImpactStores } from "./snapshot-preview"
import { clearTemporalFactsCache } from "./context-engine"
import { snapshotHistoryDir, snapshotJsonPath } from "./snapshot-paths"
import {
  backupSnapshotBeforeOverwrite,
  listSnapshots,
  readSnapshotForReplacement,
  saveSnapshot,
  withSnapshotWriteLock,
} from "./chapter-ingest-snapshot-io"
import type { ChapterSnapshot } from "./chapter-ingest"

export interface SnapshotHistoryEntry {
  fileName: string
  path: string
  createdAt: string
}

export async function readCurrentSnapshot(
  projectPath: string,
  chapterNumber: number,
): Promise<ChapterSnapshot | null> {
  const path = snapshotJsonPath(projectPath, chapterNumber)
  let raw: string
  try {
    raw = await readFile(path)
  } catch (err) {
    if (await isMissingFile(path, err)) return null
    throw err
  }
  if (!raw.trim()) return null
  const parsed = normalizeChapterSnapshot(JSON.parse(raw), {
    chapterId: `chapter-${chapterNumber}`,
    chapterNumber,
  })
  return parsed ? ensureSnapshotIdentity(parsed) : null
}

export function materializeNextCurrentSnapshot(
  snapshot: ChapterSnapshot,
  currentSnapshot: ChapterSnapshot | null,
): ChapterSnapshot {
  const existing = currentSnapshot ? ensureSnapshotIdentity(currentSnapshot) : null
  const nextRevisionBase = Math.max(existing?.revision ?? 0, snapshot.revision ?? 0)
  const nextRevision = nextRevisionBase > 0 ? nextRevisionBase + 1 : 1
  return ensureSnapshotIdentity(snapshot, {
    sourceType: snapshot.sourceType ?? existing?.sourceType ?? inferSnapshotSourceType(snapshot),
    sourceSequence: snapshot.sourceSequence ?? existing?.sourceSequence ?? inferSnapshotSourceSequence(snapshot),
    revision: nextRevision,
    snapshotId: buildSnapshotRevisionId(snapshot, nextRevision),
    supersedes: existing?.snapshotId ?? snapshot.snapshotId,
    isHistorical: false,
  })
}

export function materializeRestoredCurrentSnapshot(
  archivedSnapshot: ChapterSnapshot,
  currentSnapshot: ChapterSnapshot | null,
): ChapterSnapshot {
  const archived = ensureSnapshotIdentity(archivedSnapshot, { isHistorical: true })
  const current = currentSnapshot ? ensureSnapshotIdentity(currentSnapshot) : null
  /* v8 ignore start */
  const nextRevision = Math.max(archived.revision ?? 1, current?.revision ?? 0) + 1
  /* v8 ignore stop */
  return ensureSnapshotIdentity(archived, {
    revision: nextRevision,
    snapshotId: buildSnapshotRevisionId(archived, nextRevision),
    supersedes: current?.snapshotId ?? archived.snapshotId,
    isHistorical: false,
  })
}

const snapshotHistorySuffix = (name: string) => Number(name.match(/Z-(\d+)\.snapshot\.json$/)?.[1] ?? 0)

export async function listSnapshotHistory(
  projectPath: string,
  chapterNumber: number,
): Promise<SnapshotHistoryEntry[]> {
  const pp = normalizePath(projectPath)
  const historyDir = snapshotHistoryDir(pp, chapterNumber)
  try {
    const nodes = await listDirectory(historyDir)
    return nodes
      .filter(node => !node.is_dir && node.name.endsWith(".snapshot.json"))
      .map(node => ({
        fileName: node.name,
        path: node.path,
        createdAt: node.name.replace(/\.snapshot\.json$/, "").replace(/Z-\d+$/, "Z").replace(/-(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z$/, ":$1:$2.$3Z"),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || snapshotHistorySuffix(b.fileName) - snapshotHistorySuffix(a.fileName))
  } catch {
    logger.warn("Chapter Ingest", "silent-degrade: 降级返回空值（吞错已标记）", { line: 1242 })
    return []
  }
}

async function collectChapterMdFiles(
  nodes: Awaited<ReturnType<typeof listDirectory>>,
): Promise<Array<{ name: string; path: string }>> {
  const files: Array<{ name: string; path: string }> = []
  for (const node of nodes) {
    if (node.is_dir) {
      let children: Awaited<ReturnType<typeof listDirectory>>
      if (node.children !== undefined) {
        children = node.children
      } else {
        try {
          children = await listDirectory(node.path)
        } catch (error) {
          throw new Error(`Cannot list chapter subdirectory ${node.path}: ${toErrorMessage(error)}`)
        }
      }
      files.push(...(await collectChapterMdFiles(children)))
      continue
    }
    if (node.name.endsWith(".md") && !isDraftChapterFile(node.name)) {
      files.push({ name: node.name, path: node.path })
    }
  }
  return files
}

export async function listActualChapterNumbers(
  projectPath: string,
  options?: { failOnUnreadableChapter?: boolean },
): Promise<number[]> {
  const pp = normalizePath(projectPath)
  const chaptersDir = `${pp}/wiki/chapters`
  let nodes: Awaited<ReturnType<typeof listDirectory>>
  try {
    nodes = await listDirectory(chaptersDir)
  } catch (error) {
    if (await isMissingFile(chaptersDir, error)) return []
    throw new Error(`Cannot list chapter sources: ${toErrorMessage(error)}`)
  }
  // M2-02: 递归展开分卷子目录并排除草稿文件；子目录读错 fail-loud 上抛，
  // 防止不完整的章号集合收窄快照范围、错误重写派生记忆。
  const mdFiles = await collectChapterMdFiles(nodes)
  const chapterNumbers = await Promise.all(
    mdFiles.map(async node => {
      try {
        const raw = await readFile(node.path, { exactUtf8: true })
        const { frontmatter } = parseFrontmatter(raw.replace(/^\uFEFF/, ""))
        return frontmatter && isChapterPage(frontmatter) ? parseChapterNumber(frontmatter.chapter_number) : null
      } catch (error) {
        if (options?.failOnUnreadableChapter) {
          throw new Error(`Cannot read chapter source ${node.path}: ${toErrorMessage(error)}`)
        }
        logger.warn("Chapter Ingest", "Skipping unreadable chapter source during listing", { path: node.path, error: toErrorMessage(error) })
        return null
      }
    }),
  )
  return chapterNumbers.filter((chapterNumber): chapterNumber is number => Number.isFinite(chapterNumber))
}

export async function loadValidMemorySnapshots(
  projectPath: string,
  latestSnapshot?: ChapterSnapshot,
  options?: { failOnUnreadableChapter?: boolean },
): Promise<ChapterSnapshot[]> {
  const pp = normalizePath(projectPath)
  const actualChapterNumbers = await listActualChapterNumbers(pp, options)
  const snapshotNumbers = await listSnapshots(pp, { failLoud: true })
  const snapshotMap = new Map<number, ChapterSnapshot>()

  // Rebuilding from a partial set would overwrite last-good derived memory.
  const loadedSnapshots = await Promise.all(snapshotNumbers.filter(chapterNumber => chapterNumber > 0).map(async chapterNumber => {
    try {
      const current = await readSnapshotForReplacement(pp, chapterNumber)
      if (!current) throw new Error("Snapshot disappeared after listing.")
      return current.snapshot
    } catch (error) {
      throw new Error(`Cannot rebuild memory from chapter ${chapterNumber}: ${toErrorMessage(error)}`)
    }
  }))
  for (const loadedSnapshot of loadedSnapshots) {
    if (isValidMemorySnapshot(loadedSnapshot, actualChapterNumbers)) {
      snapshotMap.set(loadedSnapshot.chapterNumber, loadedSnapshot)
    }
  }

  if (latestSnapshot && !snapshotMap.has(latestSnapshot.chapterNumber)
    && isValidMemorySnapshot(latestSnapshot, actualChapterNumbers)) {
    snapshotMap.set(latestSnapshot.chapterNumber, latestSnapshot)
  }

  return [...snapshotMap.values()].sort((a, b) => a.chapterNumber - b.chapterNumber)
}

// P2-IMP-08 登记：saveEditedSnapshot 为死导出（无调用方；仅 context-engine.ts:1307
// 注释引用）。处置随 Q8 族产品裁决（与 syncSnapshotToMemory 的彻底层重建同族，pending）。
export async function saveEditedSnapshot(
  projectPath: string,
  snapshot: ChapterSnapshot,
): Promise<{ requireConfirmation: boolean }> {
  const pp = normalizePath(projectPath)
  return withSnapshotWriteLock(pp, snapshot.chapterNumber, () => saveEditedSnapshotUnlocked(pp, snapshot))
}

async function saveEditedSnapshotUnlocked(
  pp: string,
  snapshot: ChapterSnapshot,
): Promise<{ requireConfirmation: boolean }> {
  const currentSnapshot = await readCurrentSnapshot(pp, snapshot.chapterNumber)
  const normalizedSnapshot = normalizeChapterSnapshot(snapshot, {
    chapterId: snapshot.chapterId,
    chapterNumber: snapshot.chapterNumber,
  })
  if (!normalizedSnapshot) {
    throw new Error("Invalid snapshot data.")
  }
  // 51 号报告 G4: 编辑影响分析（事前冲击面预测，非阻断 trace）。
  // 在覆写前对 before/after 快照投影做影响分析；异常吞掉，绝不阻断保存链路（守 ADR-19/29 additive）。
  // riskLevel==='high' 时置 requireConfirmation 标志交调用方（52 号报告终验补全）。
  let requireConfirmation = false
  try {
    const beforeText = projectSnapshotForImpact(currentSnapshot)
    const afterText = projectSnapshotForImpact(normalizedSnapshot)
    const impactStores = projectSnapshotToImpactStores(normalizedSnapshot)
    if (beforeText || afterText) {
      const impact = analyzeEditImpact({ before: beforeText, after: afterText }, impactStores)
      requireConfirmation = impact.riskLevel === "high"
      logger.info("Chapter Ingest", `Edit impact (ch${snapshot.chapterNumber}): risk=${impact.riskLevel}, affected=${impact.affectedEntities.length}`, {
        chapterNumber: snapshot.chapterNumber,
        riskLevel: impact.riskLevel,
        affectedEntities: impact.affectedEntities,
        rationale: impact.rationale,
      })
    }
  } catch (impactError) {
    logger.warn("Chapter Ingest", "Edit impact analysis failed (non-fatal)", { error: impactError })
  }
  await backupSnapshotBeforeOverwrite(pp, snapshot.chapterNumber)
  await saveSnapshot(pp, materializeNextCurrentSnapshot(normalizedSnapshot, currentSnapshot))
  // ARCH-006 (REG-001 sibling): overwriting the current snapshot changes its
  // content/mtime, so the mtime-keyed temporalFactsCache may hold stale facts
  // from the pre-edit version — clear it for this project (same root cause as
  // delete/restore; saveEdited was missed).
  clearTemporalFactsCache(pp)
  return { requireConfirmation }
}

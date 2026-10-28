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
import { logger } from "@/lib/utils"
import { parseFrontmatter } from "@/lib/frontmatter"
import { isChapterPage, parseChapterNumber } from "./chapter-meta"
import {
  buildSnapshotRevisionId,
  ensureSnapshotIdentity,
  inferSnapshotSourceSequence,
  inferSnapshotSourceType,
  normalizeChapterSnapshot,
} from "./chapter-snapshot-normalize"
import { isValidMemorySnapshot } from "./memory-rebuild"
import { analyzeEditImpact } from "./edit-impact-analyzer"
import { projectSnapshotForImpact, projectSnapshotToImpactStores } from "./snapshot-preview"
import { clearTemporalFactsCache } from "./context-engine"
import { snapshotHistoryDir, snapshotJsonPath } from "./snapshot-paths"
import {
  backupSnapshotBeforeOverwrite,
  listSnapshots,
  loadSnapshot,
  saveSnapshot,
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
  try {
    const raw = await readFile(snapshotJsonPath(projectPath, chapterNumber))
    const parsed = normalizeChapterSnapshot(JSON.parse(raw), {
      chapterId: `chapter-${chapterNumber}`,
      chapterNumber,
    })
    return parsed ? ensureSnapshotIdentity(parsed) : null
  } catch {
    logger.warn("Chapter Ingest", "silent-degrade: 降级返回空值（吞错已标记）", { line: 218 })
    return null
  }
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
        createdAt: node.name.replace(/\.snapshot\.json$/, "").replace(/-(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z$/, ":$1:$2.$3Z"),
      }))
      .sort((a, b) => b.fileName.localeCompare(a.fileName))
  } catch {
    logger.warn("Chapter Ingest", "silent-degrade: 降级返回空值（吞错已标记）", { line: 1242 })
    return []
  }
}

export async function listActualChapterNumbers(projectPath: string): Promise<number[]> {
  const pp = normalizePath(projectPath)
  const chaptersDir = `${pp}/wiki/chapters`
  try {
    const nodes = await listDirectory(chaptersDir)
    const chapterNumbers = await Promise.all(
      nodes
        .filter((node) => !node.is_dir && node.name.endsWith(".md"))
        .map(async (node) => {
          try {
            const parsed = parseFrontmatter(await readFile(node.path))
            const frontmatter = parsed.frontmatter as Record<string, unknown> | null
            if (!frontmatter || !isChapterPage(frontmatter)) {
              return null
            }
            return parseChapterNumber(frontmatter.chapter_number)
          } catch {
            logger.warn("Chapter Ingest", "silent-degrade: 降级返回空值（吞错已标记）", { line: 1425 })
            return null
          }
        }),
    )
    return chapterNumbers.filter((chapterNumber): chapterNumber is number => Number.isFinite(chapterNumber))
  } catch {
    logger.warn("Chapter Ingest", "silent-degrade: 降级返回空值（吞错已标记）", { line: 1431 })
    return []
  }
}

export async function loadValidMemorySnapshots(
  projectPath: string,
  latestSnapshot?: ChapterSnapshot,
): Promise<ChapterSnapshot[]> {
  const pp = normalizePath(projectPath)
  const actualChapterNumbers = await listActualChapterNumbers(pp)
  const snapshotNumbers = await listSnapshots(pp)
  const snapshotMap = new Map<number, ChapterSnapshot>()

  const loadedSnapshots = await Promise.all(snapshotNumbers.map((chapterNumber) => loadSnapshot(pp, chapterNumber)))
  for (const loadedSnapshot of loadedSnapshots) {
    if (isValidMemorySnapshot(loadedSnapshot, actualChapterNumbers)) {
      snapshotMap.set(loadedSnapshot.chapterNumber, loadedSnapshot)
    }
  }

  if (isValidMemorySnapshot(latestSnapshot ?? null, actualChapterNumbers)) {
    snapshotMap.set(latestSnapshot!.chapterNumber, latestSnapshot!)
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

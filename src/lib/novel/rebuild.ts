/**
 * 索引和图谱重建模块
 * 支持一键重建所有章节快照、图谱节点和搜索索引
 */

import { readFile, listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { parseFrontmatter } from "@/lib/frontmatter"
import { isChapterPage, isFinalChapter, parseChapterNumber } from "./chapter-meta"
import { ingestChapter, type ChapterSnapshot, type IngestProjectionReceipt, type IngestResult } from "./chapter-ingest"
import type { IngestCommitReceipt } from "./chapter-ingest-commit"
import { defaultCanonDualWriteDeps } from "./canon-dual-write"
import { computeCheckpointDigest } from "./checkpoint-digest"
import { flattenMdFilesBase } from "./chapter-utils"
import { snapshotHistoryDir, snapshotJsonPath } from "./snapshot-paths"
import { LEDGER_SCHEMA_VERSION, loadProjectionStatusLedger } from "./projection-status-ledger"
import { useWikiStore, type EmbeddingConfig } from "@/stores/wiki-store"
import { toErrorMessage } from "@/lib/utils"

export interface RebuildProgress {
  total: number
  completed: number
  current: string
  errors: string[]
}

export type RebuildProgressCallback = (progress: RebuildProgress) => void

export interface VerifiedRebuildReceipt {
  receipt: IngestCommitReceipt
  projectionReceipt: IngestProjectionReceipt
}

/** 批量重建单章结果：verified = 收据链回读全过；skipped/failed 保留实际证据引用。 */
export type RebuildSnapshotOutcome =
  | ({ path: string; chapterNumber: number; status: "verified" } & VerifiedRebuildReceipt)
  | { path: string; chapterNumber: number | null; status: "skipped" | "failed"; reason: string; receipt?: IngestCommitReceipt; projectionReceipt?: IngestProjectionReceipt }

/**
 * verified 门：receipt 链 + 投影/Canon 对账 + 源 SHA + 归档一致性 + current
 * 物化链，全部回读复核。不凭 snapshot/memorySyncedAt 计 verified。
 */
export async function verifyRebuildOutcome(
  pp: string,
  chapter: { path: string; chapterNumber: number },
  result: IngestResult,
): Promise<VerifiedRebuildReceipt> {
  if (result.projectionError) {
    throw new Error(`Snapshot projections are not verified (${result.projectionError.stage}).`)
  }
  const { receipt, projectionReceipt } = result
  if (!receipt
    || !receipt.snapshotIdAtExtractionCommit
    || receipt.snapshotRevisionAtExtractionCommit === null
    || receipt.readPath !== chapter.path
    || receipt.chapterNumber !== chapter.chapterNumber) {
    throw new Error("Missing or mismatched ingest receipt.")
  }
  if (!projectionReceipt
    || result.ledgerSaveFailed !== false
    || result.factsStoreFailed !== false
    || !result.failedProjections
    || result.failedProjections.length !== 0
    || result.pendingProjections?.length !== 0
    || !result.committedProjections?.includes("sync_snapshot_to_memory")) {
    throw new Error("Snapshot projections are not verified.")
  }
  const canon = receipt.canonOutcome
  if (canon.status === "failed"
    || (canon.status === "skipped" && canon.reason !== "no_facts")
    || (canon.status === "completed" && (canon.report.queued > 0 || !canon.report.reconcile.consistent))) {
    throw new Error("Canon write did not reconcile.")
  }
  const historyDir = snapshotHistoryDir(pp, chapter.chapterNumber)
  const historyName = projectionReceipt.extractionHistoryPath.slice(historyDir.length + 1)
  if (!projectionReceipt.extractionHistoryPath.startsWith(`${historyDir}/`)
    || !/^[^/\\]+\.snapshot\.json$/.test(historyName)
    || historyName.includes("..")) {
    throw new Error("Projection receipt path out of scope.")
  }
  const content = await readFile(chapter.path, { exactUtf8: true })
  if (await computeCheckpointDigest(content) !== receipt.contentSha256
    || await computeCheckpointDigest(parseFrontmatter(content.replace(/^\uFEFF/, "")).body) !== receipt.bodySha256) {
    throw new Error("Chapter source changed after ingest.")
  }
  const history = JSON.parse(await readFile(projectionReceipt.extractionHistoryPath)) as ChapterSnapshot
  if (history.chapterNumber !== chapter.chapterNumber
    || history.snapshotId !== receipt.snapshotIdAtExtractionCommit
    || history.revision !== receipt.snapshotRevisionAtExtractionCommit
    || history.isHistorical !== true
    || await computeCheckpointDigest(JSON.stringify({ ...history, isHistorical: false }, null, 2)) !== receipt.snapshotJsonSha256AtExtractionCommit) {
    throw new Error("Extraction archive does not match the ingest receipt.")
  }
  const raw = await readFile(snapshotJsonPath(pp, chapter.chapterNumber))
  const current = JSON.parse(raw) as ChapterSnapshot
  if (current.chapterNumber !== chapter.chapterNumber
    || current.isHistorical !== false
    || current.snapshotId !== projectionReceipt.snapshotId
    || current.revision !== projectionReceipt.revision
    || current.revision !== receipt.snapshotRevisionAtExtractionCommit + 1
    || current.supersedes !== receipt.snapshotIdAtExtractionCommit
    || await computeCheckpointDigest(raw) !== projectionReceipt.snapshotJsonSha256) {
    throw new Error("Projected snapshot does not match the ingest receipt chain.")
  }
  const ledger = await loadProjectionStatusLedger(pp)
  if (ledger.schemaVersion !== LEDGER_SCHEMA_VERSION
    || result.committedProjections.some(id => ledger.chapters?.[String(chapter.chapterNumber)]?.[id]?.status !== "committed")) {
    throw new Error("Projection ledger does not record committed projections.")
  }
  return { receipt, projectionReceipt }
}

/**
 * 重建所有正式章节的快照和图谱
 * 会按章节号顺序依次重新摄取
 */
export async function rebuildAllSnapshots(
  projectPath: string,
  onProgress?: RebuildProgressCallback,
  options: { novelMode?: boolean } = {},
): Promise<{ success: number; failed: number; errors: string[]; outcomes: RebuildSnapshotOutcome[] }> {
  const pp = normalizePath(projectPath)
  const novelMode = options.novelMode ?? useWikiStore.getState().novelMode
  if (!novelMode) {
    return { success: 0, failed: 0, errors: ["小说模式未开启"], outcomes: [] }
  }

  // 找到所有章节文件（仅扫描 wiki/chapters，读错不再回退扫全 wiki/）
  const chaptersDir = `${pp}/wiki/chapters`
  let files: { name: string; path: string }[] = []
  try {
    const tree = await listDirectory(chaptersDir)
    files = flattenMdFilesBase(tree)
  } catch (err) {
    void err
    return { success: 0, failed: 0, errors: ["无法读取章节目录"], outcomes: [] }
  }

  // 筛选正式章节并排序
  // PAT-IM: 独立项并行 —— 并发 readFile（Promise.all 保序回填），再按 files 原序串行解析/push，排序后顺序不变。
  const chapters: { path: string; chapterNumber: number }[] = []
  const outcomes: RebuildSnapshotOutcome[] = []
  const rebuildContents = await Promise.all(
    files.map((file) => readFile(file.path, { exactUtf8: true }).then(
      (content) => ({ ok: true as const, content }),
      () => ({ ok: false as const, content: "" }),
    )),
  )
  for (let rebuildIndex = 0; rebuildIndex < files.length; rebuildIndex += 1) {
    const file = files[rebuildIndex]
    const read = rebuildContents[rebuildIndex]
    if (!read.ok) {
      outcomes.push({ path: file.path, chapterNumber: null, status: "skipped", reason: "source_unavailable" })
      continue
    }
    try {
      const parsed = parseFrontmatter(read.content.replace(/^\uFEFF/, ""))
      const fm = parsed.frontmatter as Record<string, unknown> | null
      if (!fm || !isChapterPage(fm)) {
        outcomes.push({ path: file.path, chapterNumber: null, status: "skipped", reason: "not_chapter" })
        continue
      }
      if (!isFinalChapter(fm)) {
        outcomes.push({ path: file.path, chapterNumber: parseChapterNumber(fm.chapter_number) ?? null, status: "skipped", reason: "not_final" })
        continue
      }
      const num = parseChapterNumber(fm.chapter_number) ?? 0
      chapters.push({ path: file.path, chapterNumber: num })
    } catch (err) {
      void err
      outcomes.push({ path: file.path, chapterNumber: null, status: "skipped", reason: "not_chapter" })
    }
  }

  chapters.sort((a, b) => a.chapterNumber - b.chapterNumber)
  // 歧义重号：同号多路径时两组全部拒绝（不递任一给 ingest，避免 receipt 歧义归属）。
  const duplicateNumbers = new Set(
    chapters
      .filter((chapter, i) => i > 0 && chapter.chapterNumber > 0 && chapter.chapterNumber === chapters[i - 1]?.chapterNumber)
      .map(chapter => chapter.chapterNumber),
  )

  const errors: string[] = []
  let success = 0
  let failed = 0

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]
    onProgress?.({
      total: chapters.length,
      completed: i,
      current: `第${chapter.chapterNumber}章`,
      errors,
    })

    if (duplicateNumbers.has(chapter.chapterNumber)) {
      failed++
      errors.push(`第${chapter.chapterNumber}章：duplicate chapter number`)
      outcomes.push({ ...chapter, status: "failed", reason: "duplicate_chapter_number" })
      continue
    }

    let ingest: IngestResult | undefined
    try {
      ingest = await ingestChapter(pp, chapter.path, undefined, undefined, {
        canonDualWriteDeps: defaultCanonDualWriteDeps(),
        awaitCommunitySummary: true,
        requireUniqueFinalChapter: true,
      })
      if (ingest.snapshot) {
        const evidence = await verifyRebuildOutcome(pp, chapter, ingest)
        success++
        outcomes.push({ path: chapter.path, chapterNumber: chapter.chapterNumber, status: "verified", ...evidence })
      } else {
        const reason =
          ingest.failReason === "invalid_chapter_number"
            ? "章节编号无效"
            : ingest.failReason === "no_llm"
              ? "LLM 未配置"
              : ingest.failReason === "duplicate_chapter_number"
                ? "duplicate chapter number"
                : "摄取返回空结果"
        const skipped = ingest.failReason === "not_chapter" || ingest.failReason === "not_final"
        if (!skipped) failed++
        errors.push(`第${chapter.chapterNumber}章：${reason}`)
        outcomes.push({
          path: chapter.path, chapterNumber: chapter.chapterNumber,
          status: skipped ? "skipped" : "failed",
          reason: ingest.failReason ?? "empty_ingest_result",
          ...(ingest.receipt ? { receipt: ingest.receipt } : {}),
          ...(ingest.projectionReceipt ? { projectionReceipt: ingest.projectionReceipt } : {}),
        })
      }
    } catch (err) {
      failed++
      const msg = toErrorMessage(err)
      const isDuplicate = /Multiple final chapter files share chapter number|duplicate_chapter_number/i.test(msg)
      errors.push(`第${chapter.chapterNumber}章：${isDuplicate ? "duplicate chapter number" : msg}`)
      outcomes.push({
        path: chapter.path, chapterNumber: chapter.chapterNumber, status: "failed",
        reason: isDuplicate ? "duplicate_chapter_number" : msg,
        ...(ingest?.receipt ? { receipt: ingest.receipt } : {}),
        ...(ingest?.projectionReceipt ? { projectionReceipt: ingest.projectionReceipt } : {}),
      })
    }
  }

  onProgress?.({
    total: chapters.length,
    completed: chapters.length,
    current: "完成",
    errors,
  })

  return { success, failed, errors, outcomes }
}

/**
 * 重建向量索引
 * 重新嵌入所有 wiki 页面
 */
export async function rebuildVectorIndex(
  projectPath: string,
  onProgress?: RebuildProgressCallback,
  embCfg?: EmbeddingConfig,
): Promise<{ indexed: number; errors: string[] }> {
  const pp = normalizePath(projectPath)
  const embCfgResolved = embCfg ?? useWikiStore.getState().embeddingConfig

  if (!embCfgResolved.enabled || !embCfgResolved.model) {
    return { indexed: 0, errors: ["向量嵌入未启用或未配置模型"] }
  }

  const wikiDir = `${pp}/wiki`
  let files: { name: string; path: string }[] = []
  try {
    const tree = await listDirectory(wikiDir)
    files = flattenMdFilesBase(tree)
  } catch {
    return { indexed: 0, errors: ["无法读取 wiki 目录"] }
  }

  const errors: string[] = []
  let indexed = 0

  const { embedPage } = await import("@/lib/embedding")

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    onProgress?.({
      total: files.length,
      completed: i,
      current: file.name,
      errors,
    })

    try {
      const content = await readFile(file.path)
      const pageId = file.name.replace(/\.md$/, "")
      const titleMatch = content.match(/^#\s+(.+)/m)
      const title = titleMatch?.[1]?.trim() ?? pageId
      await embedPage(pp, pageId, title, content, embCfgResolved)
      indexed++
    } catch (err) {
      const msg = toErrorMessage(err)
      errors.push(`${file.name}：${msg}`)
    }
  }

  onProgress?.({
    total: files.length,
    completed: files.length,
    current: "完成",
    errors,
  })

  return { indexed, errors }
}

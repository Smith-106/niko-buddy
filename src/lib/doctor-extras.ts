import { listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { getCanonRevision } from "@/lib/novel/canon-dual-write"
import { loadFtsIndex } from "@/lib/novel/fts-index"
import { loadFanficMergeProposal } from "@/lib/novel/fanfic-canon-import"
import { loadInteractiveGraph } from "@/lib/novel/interactive-io"
import { validateInteractiveGraph } from "@/lib/novel/interactive-film-graph"
import { loadNovelSessionStatus } from "@/lib/novel/novel-session-status"
import {
  allocateVolumeArc,
  arcSegmentForChapter,
  getChapterVolumes,
} from "@/lib/novel/volume"
import { toErrorMessage } from "@/lib/utils"

export interface DoctorExtrasCollected extends Record<string, unknown> {
  canonDualWriteEnabled: boolean
  ftsIndexReady: boolean
  budgetTasks: ReadonlyArray<{ taskId: string }>
  budgetCompleted: string[]
  /** 累计台账：stage_metrics tokenCost/latencyMs 求和（真源 status.json）。 */
  budgetTotals: { tokenCost: number; latencyMs: number; entries: number }
  volumeArc: { volumeNumber: number; segment: string | null; completedInVolume: number } | null
  fanficMergePending: { sourceBookId: string; mode: string } | null
  translationDraftCount: number
  playGraphErrors: number
}

export async function collectDoctorExtras(projectPath: string): Promise<DoctorExtrasCollected> {
  const pp = normalizePath(projectPath)
  // 首 tick 并行派发全部 IO：避免串行 await 把读盘拖到测试 mockClear() 之后（dashboard-view 竞态）且更快。
  const [canonRev, ftsIdx, status, proposal, drafts, graph] = await Promise.all([
    getCanonRevision(pp).catch(() => 0),
    loadFtsIndex(pp).catch(() => null),
    loadNovelSessionStatus(pp).catch(() => null),
    loadFanficMergeProposal(pp).catch(() => null),
    listDirectory(`${pp}/.novel/translation-drafts`)
      .then((tree) => tree.filter((n) => !n.is_dir).length)
      .catch(() => 0),
    loadInteractiveGraph(pp).catch(() => null),
  ])
  const canonDualWriteEnabled = canonRev > 0
  const ftsIndexReady = ftsIdx !== null
  let budgetTasks: DoctorExtrasCollected["budgetTasks"] = []
  let budgetCompleted: string[] = []
  let budgetTotals: DoctorExtrasCollected["budgetTotals"] = { tokenCost: 0, latencyMs: 0, entries: 0 }
  let volumeArc: DoctorExtrasCollected["volumeArc"] = null
  if (status?.current_task?.task_id) {
    budgetTasks = [{ taskId: status.current_task.task_id }]
    if (status.current_task.status === "completed") budgetCompleted = [status.current_task.task_id]
  }
  // budget 完整台账真源：status.json stage_metrics 累计（tokenCost/latencyMs/条数）。
  if (Array.isArray(status?.stage_metrics)) {
    let tokenCost = 0
    let latencyMs = 0
    for (const entry of status.stage_metrics) {
      if (typeof entry?.tokenCost === "number" && Number.isFinite(entry.tokenCost)) tokenCost += entry.tokenCost
      if (typeof entry?.latencyMs === "number" && Number.isFinite(entry.latencyMs)) latencyMs += entry.latencyMs
    }
    budgetTotals = { tokenCost, latencyMs, entries: status.stage_metrics.length }
  }
  // volumeArc 真源：卷纲 frontmatter（chapter_range_*）定位当前卷 + allocateVolumeArc 派段。
  if (typeof status?.current_task?.chapter_number === "number") {
    const chapterNumber = status.current_task.chapter_number
    try {
      const volumes = await getChapterVolumes(pp, chapterNumber)
      const current = volumes.length > 0 ? volumes[0] : undefined
      if (current) {
        const start = current.chapterRangeStart ?? chapterNumber
        const end = current.chapterRangeEnd ?? chapterNumber
        const allocations = allocateVolumeArc(current.volumeNumber, start, end)
        const segment = arcSegmentForChapter(allocations, chapterNumber)
        volumeArc = {
          volumeNumber: current.volumeNumber,
          segment,
          completedInVolume: Math.max(0, chapterNumber - start + 1),
        }
      }
    } catch {
      volumeArc = null
    }
  }
  const fanficMergePending = proposal
    ? { sourceBookId: proposal.sourceBookId, mode: proposal.mode }
    : null
  const playGraphErrors = graph
    ? validateInteractiveGraph(graph).filter((d) =>
        ["missing_start", "dangling_edge", "empty_choice"].includes(d.code),
      ).length
    : 0
  return {
    canonDualWriteEnabled,
    ftsIndexReady,
    budgetTasks,
    budgetCompleted,
    budgetTotals,
    volumeArc,
    fanficMergePending,
    translationDraftCount: drafts,
    playGraphErrors,
  }
}

export async function safeRebuildFtsIndex(projectPath: string): Promise<{ indexed: number; errors: string[] }> {
  try {
    const mod = await import("@/lib/novel/fts-index")
    return await mod.rebuildWikiFtsIndex(projectPath)
  } catch (err) {
    return { indexed: 0, errors: [toErrorMessage(err)] }
  }
}

export async function safeTriggerVectorCompaction(projectPath: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const mod = await import("@/lib/embedding")
    const r = await mod.triggerIdleCompaction(projectPath)
    return { ok: true, detail: r ? "ok" : "no report" }
  } catch (err) {
    return { ok: false, detail: toErrorMessage(err) }
  }
}

export async function safeRunVectorReconcile(projectPath: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const core = await import("@tauri-apps/api/core")
    const report = await core.invoke<{ deleted_pages: string[]; upserted_pages: string[]; failed_pages: string[] }>(
      "vector_run_startup_reconcile",
      { projectPath: normalizePath(projectPath), expected: [] },
    )
    return { ok: true, detail: "deleted=" + report.deleted_pages.length }
  } catch (err) {
    return { ok: false, detail: toErrorMessage(err) }
  }
}

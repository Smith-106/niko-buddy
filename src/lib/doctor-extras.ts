import { listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { getCanonRevision } from "@/lib/novel/canon-dual-write"
import { loadFtsIndex } from "@/lib/novel/fts-index"
import { loadFanficMergeProposal } from "@/lib/novel/fanfic-canon-import"
import { loadInteractiveGraph } from "@/lib/novel/interactive-io"
import { validateInteractiveGraph } from "@/lib/novel/interactive-film-graph"
import { loadNovelSessionStatus } from "@/lib/novel/novel-session-status"
import { toErrorMessage } from "@/lib/utils"

export interface DoctorExtrasCollected extends Record<string, unknown> {
  canonDualWriteEnabled: boolean
  ftsIndexReady: boolean
  budgetTasks: ReadonlyArray<{ taskId: string }>
  budgetCompleted: string[]
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
  let volumeArc: DoctorExtrasCollected["volumeArc"] = null
  if (status?.current_task?.task_id) {
    budgetTasks = [{ taskId: status.current_task.task_id }]
    if (status.current_task.status === "completed") budgetCompleted = [status.current_task.task_id]
  }
  if (typeof status?.current_task?.chapter_number === "number") {
    volumeArc = {
      volumeNumber: 1,
      segment: null,
      completedInVolume: Math.max(0, status.current_task.chapter_number),
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

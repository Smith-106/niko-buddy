// Canon revision 修订历史查看器 —— P1-1（设计文档 15-p1-1 §3.2）。
//
// 职责：展示当前 canon revision 徽标 + 按 `recorded_revision` 分组倒序的边变更
// 时间线（只读）。跨 revision 的 diff 算法明确延后到 P2。数据只经投影封装
// （`queryCanonEdges` → `CanonFact[]`，已剥离 `known_by`/`digest`），无句柄外泄。
//
// 三态：loading / empty / error。`refreshSignal`（父组件 maxRevision bump）与
// 手动刷新按钮均触发重查。

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { getCanonRevision } from "@/lib/novel/canon-dual-write"
import { queryCanonEdges, type CanonFact } from "@/lib/novel/canon-graph-client"

/** 时间线边拉取上限（倒序分组只读列表，无需 offset/total）。 */
const REVISION_EDGE_LIMIT = 500

export interface CanonRevisionViewerProps {
  /** 项目 id（canon_commands 首参；对应 Rust project_id）。 */
  projectId: string
  /** 父组件 maxRevision 变化时 bump → 触发重查。 */
  refreshSignal?: number
}

interface RevisionGroup {
  revision: number | null
  facts: CanonFact[]
}

/** 按 recorded_revision 分组，数值倒序，null 组（旧数据无戳）排最后。 */
export function groupByRecordedRevision(facts: CanonFact[]): RevisionGroup[] {
  const map = new Map<number | null, CanonFact[]>()
  for (const f of facts) {
    const key = f.recordedRevision ?? null
    const arr = map.get(key)
    if (arr) arr.push(f)
    else map.set(key, [f])
  }
  const groups = [...map.entries()].map(([revision, fs]) => ({ revision, facts: fs }))
  groups.sort((a, b) => {
    if (a.revision === null) return 1
    if (b.revision === null) return -1
    return b.revision - a.revision
  })
  return groups
}

function formatChapter(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return String(value)
}

export function CanonRevisionViewer({
  projectId,
  refreshSignal = 0,
}: CanonRevisionViewerProps) {
  const { t } = useTranslation()

  const [maxRevision, setMaxRevision] = useState<number | null>(null)
  const [edges, setEdges] = useState<CanonFact[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [rev, e] = await Promise.all([
        getCanonRevision(projectId),
        queryCanonEdges(projectId, { limit: REVISION_EDGE_LIMIT }),
      ])
      setMaxRevision(rev)
      setEdges(e)
    } catch (err) {
      setError(err instanceof Error ? err.message : "canon 修订历史加载失败")
      setMaxRevision(null)
      setEdges([])
    } finally {
      setLoading(false)
    }
  }, [projectId, refreshSignal])

  useEffect(() => {
    void load()
  }, [load])

  const groups = useMemo(() => groupByRecordedRevision(edges), [edges])

  return (
    <section
      className="rounded-lg border bg-card p-4 shadow-sm"
      aria-label="canon 修订历史"
      data-testid="canon-revision-viewer"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold" data-testid="canon-revision-title">
          {t("canon.revisionViewer.title")}
        </h2>
        <div className="flex items-center gap-2">
          <span
            className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
            data-testid="revision-badge"
          >
            {t("canon.revisionViewer.currentRevision")}:{" "}
            <span data-testid="revision-badge-value">
              {maxRevision === null ? "—" : String(maxRevision)}
            </span>
          </span>
          <button
            type="button"
            className="h-8 rounded-md border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => void load()}
            disabled={loading}
            data-testid="revision-refresh"
          >
            {t("canon.common.refresh")}
          </button>
        </div>
      </div>

      {error && (
        <div
          className="mb-3 rounded-md border border-red-300 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:text-red-300"
          role="alert"
          data-testid="revision-error"
        >
          {error}
        </div>
      )}

      {loading && (
        <div
          className="rounded-md border bg-muted/20 px-4 py-3 text-sm text-muted-foreground"
          data-testid="revision-loading"
        >
          {t("canon.common.loading")}
        </div>
      )}

      {!loading && !error && edges.length === 0 && (
        <p className="px-1 py-3 text-sm text-muted-foreground" data-testid="revision-empty">
          {t("canon.revisionViewer.empty")}
        </p>
      )}

      {!loading && !error && groups.length > 0 && (
        <ol className="space-y-4">
          {groups.map((group) => (
            <li
              key={group.revision === null ? "legacy" : String(group.revision)}
              data-testid={
                group.revision === null
                  ? "revision-group-legacy"
                  : `revision-group-${group.revision}`
              }
            >
              <div className="mb-1 flex items-center gap-2">
                <span className="text-xs font-semibold text-muted-foreground">
                  {group.revision === null
                    ? t("canon.revisionViewer.noStampGroup")
                    : t("canon.revisionViewer.groupLabel", { rev: group.revision })}
                </span>
                <span className="text-xs text-muted-foreground/70">
                  {t("canon.revisionViewer.factCount", { count: group.facts.length })}
                </span>
              </div>
              <ul className="divide-y rounded-md border bg-muted/20 text-sm">
                {group.facts.map((fact) => (
                  <li key={fact.id} className="px-3 py-2">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium">{fact.predicate}</span>
                      <span className="text-muted-foreground">
                        {fact.sourceId} → {fact.targetId}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      valid_at: {formatChapter(fact.validAt)} · invalid_at:{" "}
                      {formatChapter(fact.invalidAt)}
                      {fact.modality ? ` · modality: ${fact.modality}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

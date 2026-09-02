// Canon 已知事实（POV 视角）面板 —— P1-1（设计文档 15-p1-1 §3.1）。
//
// 职责：以 POV 视角浏览某角色「已知事实」，支持章节截点 + 已失效窗口边开关
// + 服务端分页（offset/limit/total，limit=200）。只读；不绕过 projectEdge 投影层
// （数据仅经 `getFactsKnownByPaged` → `projectEdges` → `assertNoHandleLeak`，
// 组件只渲染 `CanonFact` 的 camelCase 安全字段，绝不触碰 `known_by`/`digest`）。
//
// 三态：loading / empty（区分「未选 POV」与「有 POV 无事实」）/ error。
// 自动重查：POV 切换 / 章节截点变化 / includeInvalidated 切换 / 翻页 /
// `refreshSignal` 变化（父组件在 post-supersede 重载后 bump）。

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { getFactsKnownByPaged, type CanonFact } from "@/lib/novel/canon-graph-client"

/** 服务端分页页大小（limit）。 */
const FACTS_PAGE_SIZE = 200

export interface CanonFactsKnownByPanelProps {
  /** 项目 id（canon_commands 首参；对应 Rust project_id）。 */
  projectId: string
  /** POV 白名单（项目角色注册表投影），作 POV <select> 选项。 */
  povAllowlist?: readonly string[]
  /** 父组件 maxRevision 变化时 bump → 触发重查。 */
  refreshSignal?: number
}

function formatChapter(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return String(value)
}

export function CanonFactsKnownByPanel({
  projectId,
  povAllowlist = [],
  refreshSignal = 0,
}: CanonFactsKnownByPanelProps) {
  const { t } = useTranslation()

  const [pov, setPov] = useState("")
  const [atChapter, setAtChapter] = useState("")
  const [appliedChapter, setAppliedChapter] = useState<number | null>(null)
  const [includeInvalidated, setIncludeInvalidated] = useState(false)
  const [facts, setFacts] = useState<CanonFact[]>([])
  const [total, setTotal] = useState(0)
  const [maxRevision, setMaxRevision] = useState<number | null>(null)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await getFactsKnownByPaged(
        projectId,
        pov,
        appliedChapter ?? undefined,
        includeInvalidated,
        { offset: (page - 1) * FACTS_PAGE_SIZE, limit: FACTS_PAGE_SIZE },
      )
      setFacts(r.facts)
      setTotal(r.total)
      setMaxRevision(r.maxRevision)
    } catch (err) {
      setError(err instanceof Error ? err.message : "canon_facts_known_by 调用失败")
      setFacts([])
      setTotal(0)
      setMaxRevision(null)
    } finally {
      setLoading(false)
    }
  }, [projectId, pov, appliedChapter, includeInvalidated, page, refreshSignal])

  useEffect(() => {
    if (!pov.trim()) {
      setFacts([])
      setTotal(0)
      setMaxRevision(null)
      setError(null)
      return
    }
    void load()
  }, [load, pov])

  const pageCount = Math.max(1, Math.ceil(total / FACTS_PAGE_SIZE))

  const handlePovChange = useCallback((value: string) => {
    setPov(value)
    setPage(1)
  }, [])

  const handleChapterChange = useCallback(
    (value: string) => {
      setAtChapter(value)
      const parsed = Number.parseInt(value.trim(), 10)
      if (Number.isFinite(parsed)) {
        if (parsed !== appliedChapter) {
          setAppliedChapter(parsed)
          setPage(1)
        }
      } else {
        setAppliedChapter(null)
        setPage(1)
      }
    },
    [appliedChapter],
  )

  const handleIncludeInvalidatedChange = useCallback((value: boolean) => {
    setIncludeInvalidated(value)
    setPage(1)
  }, [])

  const noPov = !pov.trim()
  const emptyWithPov = !noPov && !loading && !error && facts.length === 0

  const list = useMemo(() => facts, [facts])

  return (
    <section
      className="rounded-lg border bg-card p-4 shadow-sm"
      aria-label="canon 已知事实（POV 视角）"
      data-testid="canon-facts-panel"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold" data-testid="canon-facts-title">
          {t("canon.factsPanel.title")}
        </h2>
        <button
          type="button"
          className="h-8 rounded-md border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => void load()}
          disabled={loading || noPov}
          data-testid="canon-facts-refresh"
        >
          {t("canon.common.refresh")}
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">{t("canon.factsPanel.povLabel")}</span>
          <select
            className="h-8 min-w-44 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={pov}
            onChange={(e) => handlePovChange(e.target.value)}
            data-testid="canon-facts-pov"
          >
            <option value="">{t("canon.factsPanel.povPlaceholder")}</option>
            {povAllowlist.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">{t("canon.factsPanel.chapterLabel")}</span>
          <input
            type="number"
            className="h-8 w-32 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder={t("canon.factsPanel.chapterPlaceholder")}
            value={atChapter}
            onChange={(e) => handleChapterChange(e.target.value)}
            data-testid="canon-facts-chapter"
          />
        </label>

        <label className="flex items-center gap-2 pb-1.5 text-sm">
          <input
            type="checkbox"
            checked={includeInvalidated}
            onChange={(e) => handleIncludeInvalidatedChange(e.target.checked)}
            data-testid="canon-facts-include-invalidated"
          />
          <span className="text-xs text-muted-foreground">
            {t("canon.factsPanel.includeInvalidated")}
          </span>
        </label>
      </div>

      {error && (
        <div
          className="mb-3 rounded-md border border-red-300 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:text-red-300"
          role="alert"
          data-testid="canon-facts-error"
        >
          {error}
        </div>
      )}

      {loading && (
        <div
          className="rounded-md border bg-muted/20 px-4 py-3 text-sm text-muted-foreground"
          data-testid="canon-facts-loading"
        >
          {t("canon.common.loading")}
        </div>
      )}

      {noPov && !loading && !error && (
        <p
          className="px-1 py-3 text-sm text-muted-foreground"
          data-testid="canon-facts-empty-no-pov"
        >
          {t("canon.factsPanel.emptyNoPov")}
        </p>
      )}

      {emptyWithPov && (
        <p
          className="px-1 py-3 text-sm text-muted-foreground"
          data-testid="canon-facts-empty"
        >
          {t("canon.factsPanel.empty")}
        </p>
      )}

      {!noPov && !loading && !error && list.length > 0 && (
        <div className="overflow-x-auto">
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span data-testid="canon-facts-total">
              {t("canon.factsPanel.total", { count: total })}
            </span>
            {maxRevision !== null && (
              <span data-testid="canon-facts-max-revision">revision: {maxRevision}</span>
            )}
          </div>
          <ul className="divide-y text-sm">
            {list.map((fact) => (
              <li
                key={fact.id}
                className="py-2"
                data-testid={`canon-facts-row-${fact.id}`}
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{fact.predicate}</span>
                  <span className="text-muted-foreground">
                    {fact.sourceId} → {fact.targetId}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span data-testid={`canon-facts-valid-at-${fact.id}`}>
                    valid_at: {formatChapter(fact.validAt)}
                  </span>
                  <span data-testid={`canon-facts-invalid-at-${fact.id}`}>
                    invalid_at: {formatChapter(fact.invalidAt)}
                  </span>
                  {fact.revealedAt != null && <span>revealed_at: {fact.revealedAt}</span>}
                  {fact.modality && <span>modality: {fact.modality}</span>}
                  {fact.recordedRevision != null && (
                    <span data-testid={`canon-facts-recorded-rev-${fact.id}`}>
                      recorded_revision: {fact.recordedRevision}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!noPov && total > 0 && (
        <div
          className="mt-3 flex items-center justify-between gap-3 border-t px-1 py-2 text-xs text-muted-foreground"
          data-testid="canon-facts-pagination"
        >
          <button
            type="button"
            className="h-7 rounded-md border bg-background px-3 text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            data-testid="canon-facts-page-prev"
          >
            {t("canon.factsPanel.pagePrev")}
          </button>
          <span data-testid="canon-facts-page-info">
            {t("canon.factsPanel.pageInfo", { page, pages: pageCount, total })}
          </span>
          <button
            type="button"
            className="h-7 rounded-md border bg-background px-3 text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            disabled={page >= pageCount || loading}
            data-testid="canon-facts-page-next"
          >
            {t("canon.factsPanel.pageNext")}
          </button>
        </div>
      )}
    </section>
  )
}

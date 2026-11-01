// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * StatusDashboardView — 统一状态总览（只读聚合页，F-DASH-001..008）。
 *
 * 五维只读派生，零写回（不调任何 save / setActiveView / preset 写路径）：
 * - 关系：buildWikiGraph 全量边 + NOVEL_RELATION_LABELS 中文分组（F-DASH-001）
 * - 场景：全量 location/chapter 节点 + parseChapterNumber 章节水位（F-DASH-002）
 * - 人物状态：loadCharacterStates 单次加载 + dataVersion 订阅，characterName → character: 节点内存 join（F-DASH-003）
 * - 伏笔：foreshadowing-tracker 读路径 + analyzeForeshadowingDebt，列表 60 行截断（F-DASH-004）
 * - 正史：canon_query_batch 分页（单批 ≤100，总量 ≤500）；非 Tauri 宿主 degraded-empty（F-DASH-005）
 *
 * 口径（Q1/R3）：主行数字一律全量集合；view-filtered（dashboard hiddenTypes 经
 * applyGraphFilters，与 graph-view effectiveFilters 同语义）只作次行标注。
 * 时间锚（Q5）：valid_at_chapter = 全量 chapter 节点 maxChapter；查询经
 * buildCanonEdgeFilter 搭载。
 * 新鲜度（Q2/R2）：挂载加载 + dataVersion 变化重载，cancelled-flag 防竞态
 * （graph-view.tsx:192-210 同模式）。
 *
 * Q2 provenance（T3.0 验证结论，entity-pages 投影源）：
 * - character/location/organization/item/event/chapter ← snapshotToGraphNodes
 *   （graph-adapter.ts:164；快照投影）
 * - foreshadowing ← foreshadowingChanges → `foreshadowing:` entity pages
 *   （chapter-ingest-output.ts:211）+ foreshadowing-tracker.json
 * - secret ← knowledgeChanges → `secret:` entity pages（:217）
 * - conflict ← conflicts → `conflict:` entity pages（:222）
 * - canon-rule ← newCanonFacts → `canon-rule:` entity pages（:236）+ canon DB
 * - timeline-point ← timelineEvents → `timeline:` entity pages（:229；
 *   detectNodeType 把 timeline-point:/时间点 归一为 timeline-point）
 * 以上十类全部有源，故 DASHBOARD_DIM_TYPES 全启用；未知类型渲染“待验证”态，
 * 永不伪造 0（Q2 ruling）。
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useWikiStore } from "@/stores/wiki-store"
import { applyGraphFilters, DEFAULT_GRAPH_FILTERS } from "@/lib/graph-filters"
import type { GraphEdge, GraphNode } from "@/lib/wiki-graph"
import { buildWikiGraph } from "@/lib/wiki-graph"
import {
  analyzeForeshadowingDebt,
  buildCanonEdgeFilter,
  getForeshadowingWatermark,
  loadCharacterStates,
  loadForeshadowingTracker,
  NOVEL_RELATION_LABELS,
  queryCanonEdges,
} from "@/lib/novel"
import type { CanonFact, CharacterState, ForeshadowingStore } from "@/lib/novel"
import { isTauri } from "@/lib/platform"

/** Q2 已验证计数类型（十类，见文件头 provenance）。 */
export const DASHBOARD_DIM_TYPES = [
  "character",
  "organization",
  "event",
  "location",
  "chapter",
  "foreshadowing",
  "secret",
  "conflict",
  "canon-rule",
  "timeline-point",
] as const

export type DashboardDimType = (typeof DASHBOARD_DIM_TYPES)[number]

/** 维度开关持久化键（dashboard 私有；绝不碰 mode preset / allowedNodeTypes）。 */
export const DASHBOARD_FILTER_KEY = "niko.statusDashboard.hiddenTypes.v1"

/** 同 tab 即时同步事件（storage 事件只跨 tab 触发）。 */
export const DASHBOARD_FILTERS_EVENT = "niko:dashboard-filters-changed"

/** 伏笔列表截断（foreshadowing-panel GANTT_MAX_ROWS=60 同口径）。 */
export const FORESHADOWING_LIST_LIMIT = 60

/** canon 单批上限（plan R6：limit≤100）。 */
export const CANON_QUERY_LIMIT = 100

/** canon 总量上限（plan R6：总量≤500，超量截断+标注）。 */
export const CANON_TOTAL_CAP = 500

export function loadDashboardHiddenTypes(): Set<string> {
  try {
    if (typeof localStorage === "undefined") return new Set()
    const raw = localStorage.getItem(DASHBOARD_FILTER_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((v): v is string => typeof v === "string"))
  } catch {
    return new Set()
  }
}

/** additive 写：只增删单个 type，永不写 allowedNodeTypes/hideStructural/hideIsolated。 */
export function saveDashboardHiddenTypes(next: ReadonlySet<string>): void {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.setItem(DASHBOARD_FILTER_KEY, JSON.stringify([...next]))
  } catch {
    // 配额/隐私模式失败时静默：开关本次会话仍有效，只是不持久化。
  }
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(DASHBOARD_FILTERS_EVENT))
    }
  } catch {
    // 非 DOM 环境（单测）无事件总线，忽略。
  }
}

/** additive 切换单个类型（Q3 ruling：只写 hiddenTypes）。 */
export function toggleDashboardHiddenType(prev: ReadonlySet<string>, type: string): Set<string> {
  const next = new Set(prev)
  if (next.has(type)) next.delete(type)
  else next.add(type)
  return next
}

export function countNodesByType(nodes: readonly Pick<GraphNode, "type">[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const n of nodes) counts[n.type] = (counts[n.type] ?? 0) + 1
  return counts
}

export function groupEdgesByRelation(edges: readonly Pick<GraphEdge, "relation">[]): Record<string, number> {
  const groups: Record<string, number> = {}
  for (const e of edges) {
    const key = e.relation && e.relation.length > 0 ? e.relation : "AFFECTS"
    groups[key] = (groups[key] ?? 0) + 1
  }
  return groups
}

/**
 * 章节号解析（与 graph-view.tsx:51 parseChapterNumber 同源口径；
 * 本地复刻以避免聚合页直引 sigma 重型视图模块）。
 */
export function parseDashboardChapterNumber(node: Pick<GraphNode, "label" | "path">): number | null {
  const text = `${node.label} ${node.path}`
  const cn = text.match(/第\s*(\d+)\s*[章节回话]/)
  if (cn) return Number(cn[1])
  const en = text.match(/(?:ch(?:apter)?|c)[-_ ]?(\d+)/i)
  if (en) return Number(en[1])
  const file = node.path.split(/[/\\]/).pop() ?? ""
  const num = file.match(/^(\d+)[-_ ]/)
  if (num) return Number(num[1])
  return null
}

/** 全量 chapter 节点最大编号（Q5 默认锚；无章节节点时 null）。 */
export function maxChapterFromNodes(nodes: readonly Pick<GraphNode, "label" | "path" | "type">[]): number | null {
  const nums = nodes
    .filter((n) => n.type === "chapter")
    .map(parseDashboardChapterNumber)
    .filter((n): n is number => n !== null)
  if (nums.length === 0) return null
  return Math.max(...nums)
}

export function truncateRows<T>(rows: readonly T[], limit: number): { visible: T[]; hiddenCount: number } {
  if (rows.length <= limit) return { visible: [...rows], hiddenCount: 0 }
  return { visible: rows.slice(0, limit), hiddenCount: rows.length - limit }
}

/**
 * 人物状态展示行（与 character-state.ts characterStatesToContextText 同行格式；
 * plan 所指 characterStateToText helper 在该文件不存在，此处内联等价格式并记入 concerns）。
 */
export function formatCharacterStateLine(c: CharacterState): string {
  const location = c.currentLocation && c.currentLocation.length > 0 ? c.currentLocation : "—"
  const status = c.status && c.status.length > 0 ? c.status : "—"
  return `${c.characterName}：位于${location}，状态：${status}`
}

export interface StatusDashboardGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface StatusDashboardLoaders {
  loadGraph: (projectPath: string) => Promise<StatusDashboardGraph>
  loadCharacters: (projectPath: string) => Promise<CharacterState[]>
  loadForeshadowing: (projectPath: string) => Promise<ForeshadowingStore>
  loadCanonFacts: (projectId: string, anchor: number | null) => Promise<CanonFact[]>
}

async function defaultLoadGraph(projectPath: string): Promise<StatusDashboardGraph> {
  const result = await buildWikiGraph(projectPath)
  return { nodes: result.nodes, edges: result.edges }
}

async function defaultLoadCharacters(projectPath: string): Promise<CharacterState[]> {
  const store = await loadCharacterStates(projectPath)
  return store.characters
}

async function defaultLoadForeshadowing(projectPath: string): Promise<ForeshadowingStore> {
  return loadForeshadowingTracker(projectPath)
}

/** canon 分页拉取：单批 ≤100，总量封顶 500（R6）；超量截断由调用方按返回长度判定。 */
async function defaultLoadCanonFacts(projectId: string, anchor: number | null): Promise<CanonFact[]> {
  const facts: CanonFact[] = []
  for (let page = 0; page * CANON_QUERY_LIMIT < CANON_TOTAL_CAP; page += 1) {
    const batch = await queryCanonEdges(
      projectId,
      buildCanonEdgeFilter({
        edgeKinds: ["world_fact"],
        validAtChapter: anchor ?? undefined,
        limit: CANON_QUERY_LIMIT,
        offset: page * CANON_QUERY_LIMIT,
      }),
    )
    facts.push(...batch)
    if (batch.length < CANON_QUERY_LIMIT) break
    if (facts.length >= CANON_TOTAL_CAP) break
  }
  return facts.slice(0, CANON_TOTAL_CAP)
}

const defaultLoaders: StatusDashboardLoaders = {
  loadGraph: defaultLoadGraph,
  loadCharacters: defaultLoadCharacters,
  loadForeshadowing: defaultLoadForeshadowing,
  loadCanonFacts: defaultLoadCanonFacts,
}

export interface StatusDashboardViewProps {
  loaders?: Partial<StatusDashboardLoaders>
  /** 非 Tauri 宿主判定（默认 isTauri()；单测注入用）。 */
  hostIsTauri?: boolean
}

interface DashboardData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  characters: CharacterState[]
  foreshadowing: ForeshadowingStore
  canonFacts: CanonFact[]
  canonCapped: boolean
}

export function StatusDashboardView(props: StatusDashboardViewProps) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const dataVersion = useWikiStore((s) => s.dataVersion)

  const loaders = useMemo<StatusDashboardLoaders>(
    () => ({ ...defaultLoaders, ...(props.loaders ?? {}) }),
    [props.loaders],
  )
  const tauriHost = props.hostIsTauri ?? isTauri()

  const [dimHidden, setDimHidden] = useState<Set<string>>(() => loadDashboardHiddenTypes())
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    const onChange = () => setDimHidden(loadDashboardHiddenTypes())
    window.addEventListener(DASHBOARD_FILTERS_EVENT, onChange)
    window.addEventListener("storage", onChange)
    return () => {
      window.removeEventListener(DASHBOARD_FILTERS_EVENT, onChange)
      window.removeEventListener("storage", onChange)
    }
  }, [])

  useEffect(() => {
    if (!project) {
      setData(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    const projectPath = project.path
    const projectId = project.id
    void (async () => {
      try {
        const [graph, characters, foreshadowing] = await Promise.all([
          loaders.loadGraph(projectPath),
          loaders.loadCharacters(projectPath),
          loaders.loadForeshadowing(projectPath),
        ])
        const anchor = maxChapterFromNodes(graph.nodes)
        // canon 只读：非 Tauri 宿主直接 degraded-empty，不发起查询、不伪造零事实。
        const canonFacts = tauriHost ? await loaders.loadCanonFacts(projectId, anchor) : []
        if (cancelled) return
        setData({
          nodes: graph.nodes,
          edges: graph.edges,
          characters,
          foreshadowing,
          canonFacts,
          canonCapped: canonFacts.length >= CANON_TOTAL_CAP,
        })
      } catch (err) {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : String(err))
        setData(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.path, project?.id, dataVersion, tauriHost])

  const fullCounts = useMemo(() => (data ? countNodesByType(data.nodes) : {}), [data])
  const edgeGroups = useMemo(() => (data ? groupEdgesByRelation(data.edges) : {}), [data])
  const anchor = useMemo(() => (data ? maxChapterFromNodes(data.nodes) : null), [data])
  const viewFiltered = useMemo(() => {
    if (!data) return null
    if (dimHidden.size === 0) return null
    return applyGraphFilters(data.nodes, data.edges, { ...DEFAULT_GRAPH_FILTERS, hiddenTypes: dimHidden })
  }, [data, dimHidden])

  const characterRows = useMemo(() => {
    if (!data) return { matched: [], unmodeledCount: 0 }
    const nodeIds = new Set(data.nodes.map((n) => n.id))
    const matched: CharacterState[] = []
    let unmodeledCount = 0
    for (const c of data.characters) {
      if (nodeIds.has(`character:${c.characterName}`)) matched.push(c)
      else unmodeledCount += 1
    }
    return { matched, unmodeledCount }
  }, [data])

  const foreshadowingView = useMemo(() => {
    if (!data) return null
    const items = data.foreshadowing.items
    const statusCounts: Record<string, number> = {}
    for (const item of items) statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1
    const watermark = anchor ?? getForeshadowingWatermark(items)
    const debt = analyzeForeshadowingDebt(data.foreshadowing, watermark)
    const sorted = [...items].sort((a, b) => a.plantedChapter - b.plantedChapter)
    return { statusCounts, debt, ...truncateRows(sorted, FORESHADOWING_LIST_LIMIT), total: items.length }
  }, [data, anchor])

  const canonJoin = useMemo(() => {
    if (!data) return { ruleCount: 0, timelineCount: 0 }
    let ruleCount = 0
    let timelineCount = 0
    for (const n of data.nodes) {
      if (n.type === "canon-rule") ruleCount += 1
      else if (n.type === "timeline-point" || n.type === "timeline") timelineCount += 1
    }
    return { ruleCount, timelineCount }
  }, [data])

  if (!project) {
    return (
      <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
        <h1 className="text-lg font-semibold">{t("novel.statusDashboard.title", { defaultValue: "状态总览" })}</h1>
        <p data-testid="dashboard-no-project" className="text-sm text-muted-foreground">
          {t("novel.statusDashboard.noProject", { defaultValue: "未打开项目。" })}
        </p>
      </div>
    )
  }

  if (loading && !data) {
    return (
      <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
        <h1 className="text-lg font-semibold">{t("novel.statusDashboard.title", { defaultValue: "状态总览" })}</h1>
        <p role="status" className="text-sm text-muted-foreground">
          {t("novel.statusDashboard.loading", { defaultValue: "加载中..." })}
        </p>
      </div>
    )
  }

  const caliberFull = t("novel.statusDashboard.caliber.fullGraph", { defaultValue: "全图口径" })
  const caliberSecondary = t("novel.statusDashboard.caliber.viewFiltered", { defaultValue: "当前视图（次行）" })
  const emptyText = t("novel.statusDashboard.empty", { defaultValue: "暂无数据。" })

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <h1 className="text-lg font-semibold">{t("novel.statusDashboard.title", { defaultValue: "状态总览" })}</h1>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span data-testid="caliber-full-graph" className="rounded bg-muted px-1.5 py-0.5">
          {caliberFull}
        </span>
        <span data-testid="dashboard-time-anchor">
          {anchor !== null
            ? t("novel.statusDashboard.timeAnchor", { defaultValue: "时间锚：第 {{chapter}} 章", chapter: anchor })
            : t("novel.statusDashboard.timeAnchorUnknown", { defaultValue: "时间锚：—" })}
        </span>
        {viewFiltered && (
          <span data-testid="caliber-view-filtered" className="rounded bg-muted px-1.5 py-0.5">
            {caliberSecondary}：{viewFiltered.nodes.length}/{data?.nodes.length ?? 0}·{viewFiltered.edges.length}/{data?.edges.length ?? 0}
          </span>
        )}
      </div>
      {loadError && (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      )}

      <section aria-labelledby="dashboard-relations" className="rounded-md border bg-card p-3">
        <h2 id="dashboard-relations" className="mb-2 text-sm font-semibold">
          {t("novel.statusDashboard.dims.relations", { defaultValue: "关系" })}
        </h2>
        {data && data.edges.length > 0 ? (
          <div data-testid="dashboard-card-relations" className="space-y-1 text-sm">
            <p>边总数：{data.edges.length}</p>
            <ul className="list-inside list-disc text-muted-foreground">
              {Object.entries(edgeGroups).map(([relation, count]) => (
                <li key={relation}>
                  {NOVEL_RELATION_LABELS[relation] ?? relation}：{count}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">
              人物：{fullCounts["character"] ?? 0} · 组织：{fullCounts["organization"] ?? 0} · 事件：
              {fullCounts["event"] ?? 0}
            </p>
          </div>
        ) : (
          <p data-testid="dashboard-card-relations" className="text-sm text-muted-foreground">
            {emptyText}
          </p>
        )}
      </section>

      <section aria-labelledby="dashboard-scenes" className="rounded-md border bg-card p-3">
        <h2 id="dashboard-scenes" className="mb-2 text-sm font-semibold">
          {t("novel.statusDashboard.dims.scenes", { defaultValue: "场景" })}
        </h2>
        <div data-testid="dashboard-card-scenes" className="text-sm">
          <p>
            地点：{fullCounts["location"] ?? 0} · 章节：{fullCounts["chapter"] ?? 0}
          </p>
          {(fullCounts["location"] ?? 0) === 0 && (fullCounts["chapter"] ?? 0) === 0 && (
            <p className="text-muted-foreground">{emptyText}</p>
          )}
        </div>
      </section>

      <section aria-labelledby="dashboard-characters" className="rounded-md border bg-card p-3">
        <h2 id="dashboard-characters" className="mb-2 text-sm font-semibold">
          {t("novel.statusDashboard.dims.characters", { defaultValue: "人物状态" })}
        </h2>
        {characterRows.matched.length > 0 ? (
          <div data-testid="dashboard-card-characters" className="space-y-1 text-sm">
            <ul className="list-inside list-disc">
              {characterRows.matched.map((c) => (
                <li key={c.characterName} data-testid="dashboard-character-row">
                  {formatCharacterStateLine(c)}
                </li>
              ))}
            </ul>
            {characterRows.unmodeledCount > 0 && (
              <p className="text-muted-foreground">
                {t("novel.statusDashboard.charactersUnmodeled", {
                  defaultValue: "未建模 {{count}} 人",
                  count: characterRows.unmodeledCount,
                })}
              </p>
            )}
          </div>
        ) : (
          <p data-testid="dashboard-card-characters" className="text-sm text-muted-foreground">
            {emptyText}
          </p>
        )}
      </section>

      <section aria-labelledby="dashboard-foreshadowing" className="rounded-md border bg-card p-3">
        <h2 id="dashboard-foreshadowing" className="mb-2 text-sm font-semibold">
          {t("novel.statusDashboard.dims.foreshadowing", { defaultValue: "伏笔" })}
        </h2>
        {foreshadowingView && foreshadowingView.total > 0 ? (
          <div data-testid="dashboard-card-foreshadowing" className="space-y-1 text-sm">
            <p>
              已埋设：{foreshadowingView.statusCounts["planted"] ?? 0} · 推进中：
              {foreshadowingView.statusCounts["advanced"] ?? 0} · 已回收：
              {foreshadowingView.statusCounts["resolved"] ?? 0}
            </p>
            <p className="text-muted-foreground">
              债务分：{foreshadowingView.debt.debtScore}（严重 {foreshadowingView.debt.criticalCount} / 警告{" "}
              {foreshadowingView.debt.warningCount} / 未解决 {foreshadowingView.debt.totalUnresolved}）
            </p>
            <ul className="list-inside list-disc">
              {foreshadowingView.visible.map((item) => (
                <li key={item.id}>
                  {item.name}（第{item.plantedChapter}章）
                </li>
              ))}
            </ul>
            {foreshadowingView.hiddenCount > 0 && (
              <p data-testid="foreshadowing-truncated" className="text-xs text-muted-foreground">
                {t("novel.statusDashboard.foreshadowingMore", {
                  defaultValue: "…还有{{count}}条",
                  count: foreshadowingView.hiddenCount,
                })}
              </p>
            )}
          </div>
        ) : (
          <p data-testid="dashboard-card-foreshadowing" className="text-sm text-muted-foreground">
            {emptyText}
          </p>
        )}
      </section>

      <section aria-labelledby="dashboard-canon" className="rounded-md border bg-card p-3">
        <h2 id="dashboard-canon" className="mb-2 text-sm font-semibold">
          {t("novel.statusDashboard.dims.canon", { defaultValue: "正史" })}
        </h2>
        {!tauriHost ? (
          <p data-testid="canon-degraded" className="text-sm text-muted-foreground">
            {t("novel.statusDashboard.degraded.canonNonTauri", {
              defaultValue: "正史图谱仅桌面端可用；当前为降级空态。",
            })}
          </p>
        ) : data && data.canonFacts.length > 0 ? (
          <div data-testid="dashboard-card-canon" className="space-y-1 text-sm">
            <p>正史事实：{data.canonFacts.length}</p>
            <p className="text-muted-foreground">
              canon-rule 节点：{canonJoin.ruleCount} · timeline-point 节点：{canonJoin.timelineCount}
            </p>
            {data.canonCapped && (
              <p className="text-xs text-muted-foreground">
                {t("novel.statusDashboard.canonTruncated", {
                  defaultValue: "仅展示前 {{shown}} 条（已截断，上限 {{cap}} 条）",
                  shown: data.canonFacts.length,
                  cap: CANON_TOTAL_CAP,
                })}
              </p>
            )}
          </div>
        ) : (
          <p data-testid="dashboard-card-canon" className="text-sm text-muted-foreground">
            暂无正史事实
          </p>
        )}
      </section>
    </div>
  )
}

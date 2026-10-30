import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  MODULE_ATLAS,
  buildAtlasIndex,
  heatTotals,
  listUnwiredModules,
  moduleLabel,
  normalizeHeatLevel,
  stageCoverage,
  toHeatLog,
  type ModuleAtlasEntry,
} from "@/lib/novel"
import { shouldFlushHeat, useModuleHeatStore } from "@/stores/module-heat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { cn, pad } from "@/lib/utils"
import { Activity, CircleDot, ExternalLink, Flame, Layers, RefreshCw, Unplug } from "lucide-react"

/** 主链泳道（按写作流程顺序）。 */
const MAIN_LANES = [
  "bootstrap",
  "director",
  "incubate",
  "world",
  "outline",
  "plan",
  "draft",
  "gate",
  "accept",
  "memory",
  "review",
  "deliver",
] as const

/** 支撑泳道（默认折叠）。 */
const SUPPORT_LANES = [
  "agent",
  "knowledge",
  "simulation",
  "analysis",
  "ui",
  "state",
  "support",
  "other",
] as const

/** 返工回路：门控/审阅未过时回到上一段重做。 */
const REWORK_PAIRS: Array<readonly [string, string]> = [
  ["gate", "draft"],
  ["review", "gate"],
]

const MAIN_NODE_LIMIT = 12
const EXPANDED_NODE_LIMIT = 60

export interface ModuleHeatmapViewProps {
  /** 项目 id（与其它视图签名一致；遥测路径取 store 里的 project.path）。 */
  projectId?: string
}

function formatClock(at: number): string {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 运动热力图：把全仓模块按写作主链泳道摆开，用运行遥测点亮「走到哪一步 / 谁没接线」。
 *
 * 数据面：静态接线来自 `module-atlas.generated.json`（gen:atlas 生成、gen:check 门禁），
 * 运行热度来自 `module-heat-store`（编排层埋点）。视图只做投影，不写任何状态。
 */
export function ModuleHeatmapView(_props: ModuleHeatmapViewProps = {}) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const install = useModuleHeatStore((s) => s.install)
  const hits = useModuleHeatStore((s) => s.hits)
  const flush = useModuleHeatStore((s) => s.flush)
  const heatMap = useModuleHeatStore((s) => s.heatMap)
  const [selected, setSelected] = useState<string | null>(null)
  const [showSupport, setShowSupport] = useState(false)
  const [query, setQuery] = useState("")
  const [flushedAt, setFlushedAt] = useState<number | null>(null)

  useEffect(() => {
    install()
  }, [install])

  const projectPath = project?.path ?? null

  // 节流落盘：命中密集时不打断交互，窗口/批量阈值由纯函数判定。
  useEffect(() => {
    const timer = setInterval(() => {
      const state = useModuleHeatStore.getState()
      if (!projectPath) return
      if (!shouldFlushHeat(state, Date.now())) return
      void state.flush(projectPath).then(() => setFlushedAt(Date.now()))
    }, 5000)
    return () => clearInterval(timer)
  }, [projectPath])

  const heat = heatMap()
  const totals = useMemo(() => heatTotals(MODULE_ATLAS, heat), [heat])
  const coverage = useMemo(() => stageCoverage(MODULE_ATLAS, heat), [heat])
  const index = useMemo(() => buildAtlasIndex(MODULE_ATLAS), [])
  const reverse = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const entry of MODULE_ATLAS.modules) {
      for (const targetIndex of entry.i) {
        const target = MODULE_ATLAS.modules[targetIndex]
        if (!target) continue
        const list = map.get(target.p) ?? []
        list.push(entry.p)
        map.set(target.p, list)
      }
    }
    return map
  }, [])
  const unwired = useMemo(() => listUnwiredModules(MODULE_ATLAS), [])
  const log = useMemo(() => toHeatLog(hits, moduleLabel, 18), [hits])
  const maxCalls = useMemo(() => {
    let max = 1
    for (const value of heat.values()) max = Math.max(max, value.count)
    return max
  }, [heat])

  /** 泳道间流向边：上游→下游显式箭头；下游 60 秒内有命中才呼吸（零事件不伪造流动）。 */
  const renderFlow = (fromId: string, toId: string) => {
    const from = MODULE_ATLAS.stages.find((s) => s.id === fromId)
    const to = MODULE_ATLAS.stages.find((s) => s.id === toId)
    if (!from || !to) return null
    const flowing = activeLanes.has(toId)
    return (
      <div
        className="flex items-center gap-2 py-0.5 pl-24"
        data-testid={`heatmap-flow-${fromId}`}
        data-flowing={flowing ? "true" : "false"}
      >
        <span
          aria-hidden
          className={cn(
            "flex flex-col items-center",
            flowing ? "text-primary" : "text-muted-foreground",
          )}
        >
          <span className="h-2.5 w-px bg-current opacity-60" />
          <span className={cn("text-xs leading-none", flowing && "animate-pulse")}>▼</span>
        </span>
        <span className="text-xs text-muted-foreground">
          {from.label} → {to.label}
        </span>
      </div>
    )
  }

  /** 当前进行一句话：最新命中所在步 / 本步调用数 / 上一步（无命中时不渲染）。 */
  const nowStep = useMemo(() => {
    if (hits.length === 0) return null
    const stageOf = (path: string): string | null => {
      const entry = index.get(path)
      if (!entry) return null
      return MODULE_ATLAS.stages[entry.s]?.id ?? null
    }
    let cur: string | null = null
    let prev: string | null = null
    for (let i = hits.length - 1; i >= 0; i -= 1) {
      const s = stageOf(hits[i].path)
      if (!s) continue
      if (!cur) {
        cur = s
        continue
      }
      if (s !== cur) {
        prev = s
        break
      }
    }
    if (!cur) return null
    let calls = 0
    for (const h of hits) {
      if (stageOf(h.path) === cur) calls += 1
    }
    const mainIdx = (MAIN_LANES as readonly string[]).indexOf(cur)
    const label = MODULE_ATLAS.stages.find((s) => s.id === cur)?.label ?? cur
    const prevLabel = prev
      ? (MODULE_ATLAS.stages.find((s) => s.id === prev)?.label ?? prev)
      : t("heatmap.nowStepOrigin")
    return { mainIdx, total: MAIN_LANES.length, label, calls, prevLabel }
  }, [hits, index, t])

  // 最近 60 秒内被调用的泳道 = 「当前路径」（流向边呼吸与在跑叙事共用）。
  const activeLanes = useMemo(() => {
    const cutoff = Date.now() - 60_000
    const lanes = new Set<string>()
    for (const hit of hits) {
      if (hit.at < cutoff) continue
      const entry = index.get(hit.path)
      if (!entry) continue
      lanes.add(MODULE_ATLAS.stages[entry.s]?.id ?? "")
    }
    return lanes
  }, [hits, index])

  const modulesByLane = useMemo(() => {
    const grouped = new Map<string, ModuleAtlasEntry[]>()
    for (const entry of MODULE_ATLAS.modules) {
      const stageId = MODULE_ATLAS.stages[entry.s]?.id ?? "other"
      const list = grouped.get(stageId) ?? []
      list.push(entry)
      grouped.set(stageId, list)
    }
    return grouped
  }, [])

  const filter = query.trim().toLowerCase()
  const nodesOf = (stageId: string): ModuleAtlasEntry[] => {
    const limit = showSupport ? EXPANDED_NODE_LIMIT : MAIN_NODE_LIMIT
    return (modulesByLane.get(stageId) ?? [])
      .filter((entry) => (filter ? entry.p.toLowerCase().includes(filter) : true))
      .sort((a, b) => {
        const ah = heat.get(a.p)?.count ?? 0
        const bh = heat.get(b.p)?.count ?? 0
        if (ah !== bh) return bh - ah
        return b.l - a.l
      })
      .slice(0, limit)
  }

  const renderLane = (stageId: string) => {
    const stage = MODULE_ATLAS.stages.find((s) => s.id === stageId)
    if (!stage) return null
    const row = coverage.find((c) => c.stageId === stageId)
    const nodes = nodesOf(stageId)
    if (nodes.length === 0) return null
    const isActive = activeLanes.has(stageId)
    const rework = REWORK_PAIRS.some(([from]) => from === stageId)
    return (
      <div
        key={stageId}
        className={cn(
          "flex items-stretch gap-3 rounded-lg border p-2",
          isActive ? "border-accent/60 bg-accent/5" : "border-border/60",
        )}
        data-testid={`heatmap-lane-${stageId}`}
        data-active={isActive ? "true" : "false"}
      >
        <div className="flex w-28 shrink-0 flex-col justify-center gap-1 border-r pr-2">
          <span className={cn("text-xs font-semibold", isActive ? "text-primary" : "text-foreground")}>
            {stage.label}
          </span>
          <span className="text-xs text-muted-foreground">
            {t("heatmap.laneStats", {
              modules: row?.modules ?? 0,
              hit: row?.hitModules ?? 0,
              calls: row?.calls ?? 0,
            })}
          </span>
          {rework ? (
            <span className="text-xs text-destructive" data-testid={`heatmap-rework-${stageId}`}>
              {t("heatmap.reworkMark")}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {nodes.map((entry) => {
            const moduleHeat = heat.get(entry.p)
            const level = normalizeHeatLevel(moduleHeat?.count ?? 0, maxCalls)
            const unwiredFlag = entry.x || entry.o || !entry.r
            return (
              <button
                key={entry.p}
                type="button"
                onClick={() => setSelected(entry.p)}
                title={`${entry.p}${moduleHeat ? ` · ${moduleHeat.count} calls` : ""}`}
                data-testid={`heatmap-node-${moduleLabel(entry.p)}`}
                data-unwired={unwiredFlag ? "true" : "false"}
                className={cn(
                  "flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs transition-colors",
                  unwiredFlag ? "border-dashed border-muted-foreground/40 text-muted-foreground" : "border-border",
                  moduleHeat ? "text-foreground" : "text-muted-foreground",
                  selected === entry.p ? "ring-1 ring-accent" : "",
                )}
                style={
                  moduleHeat
                    ? { backgroundColor: `hsl(var(--accent) / ${0.08 + level * 0.42})` }
                    : undefined
                }
              >
                {moduleHeat && moduleHeat.errors > 0 ? (
                  <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
                ) : null}
                <span>{moduleLabel(entry.p)}</span>
                {moduleHeat ? (
                  <span className="text-xs text-muted-foreground">{moduleHeat.count}</span>
                ) : null}
                {entry.e && entry.e.length > 0 ? (
                  <ExternalLink className="h-2.5 w-2.5 text-warning" />
                ) : null}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  const selectedEntry = selected ? index.get(selected) : undefined
  const selectedHeat = selected ? heat.get(selected) : undefined
  const selectedLog = selected ? log.filter((row) => row.path === selected) : []

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4" data-testid="module-heatmap-view">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Flame className="h-5 w-5 text-primary" />
          <h2 className="text-base font-semibold">{t("heatmap.title")}</h2>
          <span className="text-xs text-muted-foreground">{t("heatmap.subtitle")}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-accent" /> {t("heatmap.legendCurrent")}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-warning" /> {t("heatmap.legendExternal")}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-destructive" /> {t("heatmap.legendRework")}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-muted-foreground/40" /> {t("heatmap.legendIdle")}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-6" data-testid="heatmap-stats">
        <Stat label={t("heatmap.statModules")} value={totals.modules} icon={Layers} />
        <Stat label={t("heatmap.statWired")} value={totals.wired} icon={CircleDot} />
        <Stat label={t("heatmap.statUnwired")} value={totals.unwired} icon={Unplug} tone="warning" />
        <Stat label={t("heatmap.statCalls")} value={totals.totalCalls} icon={Activity} />
        <Stat
          label={t("heatmap.statCoverage")}
          value={`${Math.round(totals.coverage * 100)}%`}
          icon={Flame}
        />
        <Stat label={t("heatmap.statErrors")} value={totals.errors} icon={CircleDot} tone="destructive" />
      </div>

      {nowStep ? (
        <div
          data-testid="heatmap-now"
          className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/5 px-3 py-1.5 text-xs"
        >
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
          <span>
            {nowStep.mainIdx >= 0
              ? t("heatmap.nowStep", {
                index: nowStep.mainIdx + 1,
                total: nowStep.total,
                stage: nowStep.label,
                calls: nowStep.calls,
                prev: nowStep.prevLabel,
              })
              : t("heatmap.nowStepSupport", {
                stage: nowStep.label,
                calls: nowStep.calls,
                prev: nowStep.prevLabel,
              })}
          </span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("heatmap.searchPlaceholder")}
          data-testid="heatmap-search"
          className="h-7 w-56 rounded-md border bg-transparent px-2 text-xs"
        />
        <button
          type="button"
          onClick={() => setShowSupport((v) => !v)}
          aria-label={showSupport ? t("heatmap.hideSupport") : t("heatmap.showSupport")}
          data-testid="heatmap-toggle-support"
          className="h-7 rounded-md border px-2 text-xs text-muted-foreground"
        >
          {showSupport ? t("heatmap.hideSupport") : t("heatmap.showSupport")}
        </button>
        <button
          type="button"
          onClick={() => {
            if (!projectPath) return
            void flush(projectPath).then(() => setFlushedAt(Date.now()))
          }}
          data-testid="heatmap-flush"
          className="flex h-7 items-center gap-1 rounded-md border px-2 text-xs text-muted-foreground"
        >
          <RefreshCw className="h-3 w-3" />
          {t("heatmap.flushNow")}
        </button>
        {flushedAt ? (
          <span className="text-xs text-muted-foreground" data-testid="heatmap-flushed">
            {t("heatmap.flushed", { time: formatClock(flushedAt) })}
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-1.5" data-testid="heatmap-lanes">
          {MAIN_LANES.map((stageId, i) => (
            <div key={stageId} className="flex flex-col gap-1">
              {renderLane(stageId)}
              {i < MAIN_LANES.length - 1 ? renderFlow(stageId, MAIN_LANES[i + 1]) : null}
            </div>
          ))}
          {showSupport ? (
            <div className="mt-2 flex flex-col gap-1.5" data-testid="heatmap-support-lanes">
              {SUPPORT_LANES.map(renderLane)}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <div className="rounded-lg border p-2" data-testid="heatmap-drill">
            <h3 className="mb-1 text-xs font-semibold">{t("heatmap.drillTitle")}</h3>
            {!selectedEntry ? (
              <p className="text-xs text-muted-foreground">{t("heatmap.drillHint")}</p>
            ) : (
              <div className="flex flex-col gap-1 text-xs">
                <code className="break-all text-xs">{selectedEntry.p}</code>
                <div className="flex flex-wrap gap-2 text-muted-foreground">
                  <span>
                    {t("heatmap.importsOut", { count: selectedEntry.i.length })}
                  </span>
                  <span>{t("heatmap.importsIn", { count: reverse.get(selectedEntry.p)?.length ?? 0 })}</span>
                  <span>{t("heatmap.loc", { count: selectedEntry.l })}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className={selectedHeat ? "text-primary" : "text-muted-foreground"}>
                    {selectedHeat
                      ? t("heatmap.calls", { count: selectedHeat.count })
                      : t("heatmap.never")}
                  </span>
                  {selectedHeat ? (
                    <span className="text-muted-foreground">
                      {t("heatmap.lastCall", { time: formatClock(selectedHeat.lastAt) })}
                    </span>
                  ) : null}
                  {selectedHeat && selectedHeat.errors > 0 ? (
                    <span className="text-destructive">
                      {t("heatmap.errors", { count: selectedHeat.errors })}
                    </span>
                  ) : null}
                </div>
                {selectedHeat?.lastDetail ? (
                  <p className="text-muted-foreground">{selectedHeat.lastDetail}</p>
                ) : null}
                <span className={selectedEntry.x || selectedEntry.o ? "text-warning-foreground" : "text-success-foreground"}>
                  {selectedEntry.x || selectedEntry.o ? t("heatmap.unwiredFlag") : t("heatmap.wiredFlag")}
                </span>
                {selectedLog.length > 0 ? (
                  <div className="mt-1 flex flex-col gap-0.5" data-testid="heatmap-drill-log">
                    {selectedLog.slice(0, 5).map((row, i) => (
                      <span key={`${row.at}-${i}`} className="text-muted-foreground">
                        {formatClock(row.at)} {row.ok ? "✓" : "✗"} {row.detail ?? ""}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <div className="rounded-lg border p-2" data-testid="heatmap-unwired">
            <h3 className="mb-1 text-xs font-semibold">{t("heatmap.unwiredTitle")}</h3>
            {unwired.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("heatmap.unwiredEmpty")}</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {unwired.slice(0, 10).map((row) => (
                  <li key={row.path}>
                    <button
                      type="button"
                      onClick={() => setSelected(row.path)}
                      className="flex w-full items-center justify-between gap-2 rounded px-1 text-left text-xs hover:bg-muted"
                    >
                      <span className="truncate text-muted-foreground">{moduleLabel(row.path)}</span>
                      <span className="shrink-0 text-xs text-warning-foreground">
                        {row.reason === "specOnly"
                          ? t("heatmap.unwiredReasonSpec")
                          : row.reason === "orphan"
                            ? t("heatmap.unwiredReasonOrphan")
                            : t("heatmap.unwiredReasonUnreachable")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-lg border p-2" data-testid="heatmap-session-log">
        <h3 className="mb-1 text-xs font-semibold">{t("heatmap.sessionLog")}</h3>
        {log.length === 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground">{t("heatmap.logEmpty")}</p>
            <button
              type="button"
              data-testid="heatmap-lightup"
              onClick={() => useWikiStore.getState().setActiveView("mainControl")}
              className="h-6 rounded-md border border-accent/50 bg-accent/10 px-2 text-xs text-foreground transition-colors hover:bg-accent/20"
            >
              {t("heatmap.lightUp")}
            </button>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5 font-mono text-xs">
            {log.map((row, i) => (
              <li key={`${row.at}-${row.path}-${i}`} className="flex gap-2">
                <span className="text-muted-foreground">{formatClock(row.at)}</span>
                <span className={row.ok ? "text-foreground" : "text-destructive"}>
                  {row.ok ? "✓" : "✗"}
                </span>
                <span className="w-40 shrink-0 truncate">{row.label}</span>
                {row.ms === undefined ? null : (
                  <span className="text-muted-foreground">{row.ms}ms</span>
                )}
                <span className="truncate text-muted-foreground">{row.detail ?? ""}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string
  value: number | string
  icon: typeof Layers
  tone?: "warning" | "destructive"
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border px-2 py-1.5">
      <Icon
        className={cn(
          "h-3.5 w-3.5",
          tone === "warning" ? "text-warning-foreground" : tone === "destructive" ? "text-destructive" : "text-primary",
        )}
      />
      <div className="flex flex-col leading-tight">
        <span className="text-xs font-semibold">{value}</span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
    </div>
  )
}

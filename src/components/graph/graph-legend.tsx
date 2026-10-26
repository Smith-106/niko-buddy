// Copyright (c) 2024 Niko-hub contributors. MIT License.
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { NODE_TYPE_COLORS, hexToRgba } from "@/lib/graph-style"
import type { CommunityInfo, GraphNode } from "@/lib/wiki-graph"
import { COMMUNITY_COLORS, type ColorMode } from "./sigma-graph-views"

export type GraphLegendDisplayMode = "graph" | "document" | "mindmap"

export interface GraphLegendProps {
  /** active coloring dimension: per node type or per community */
  colorMode: ColorMode
  /** only the main graph canvas shows the orphan-highlight toggle */
  displayMode: GraphLegendDisplayMode
  /** novel projects render grouped novel/base type sections */
  novelMode: boolean
  /** localized label per node type (i18n-resolved by the parent) */
  nodeTypeLabels: Record<string, string>
  /** visible node count per type, shown next to each label */
  typeCounts: Record<string, number>
  /** community clusters for the community-coloring mode */
  communities: CommunityInfo[]
  /** currently rendered nodes (used to resolve community membership) */
  displayNodes: GraphNode[]
  /** ids currently emphasized; drives the community active state */
  highlightedNodes: Set<string>
  /** types hidden by the filter panel; dimmed in the legend */
  hiddenTypes: ReadonlySet<string>
  /** orphan-highlight switch state (linkCount <= 1 nodes) */
  orphanHighlight: boolean
  /** orphan node ids, shown as a count next to the toggle */
  orphanNodeIds: string[]
  /** collapsed legend shows the header row only */
  legendCollapsed: boolean
  /** toggle orphan highlight on/off */
  onToggleOrphan: () => void
  /** clear all hidden types */
  onShowAllTypes: () => void
  /** collapse / expand the legend body */
  onToggleCollapsed: () => void
  /** double-click a type row toggles its visibility */
  onToggleType: (type: string) => void
  /** click a community row focuses / unfocuses its members */
  onSelectCommunity: (memberIds: string[], isActive: boolean) => void
}

/**
 * 图例面板（type / community 双模式）：从 graph-view 剥出的纯展示组件。
 * hover 高亮态内聚于此；过滤与高亮的写操作经回调回传，行为与剥离前一致。
 */
export function GraphLegend({
  colorMode,
  displayMode,
  novelMode,
  nodeTypeLabels,
  typeCounts,
  communities,
  displayNodes,
  highlightedNodes,
  hiddenTypes,
  orphanHighlight,
  orphanNodeIds,
  legendCollapsed,
  onToggleOrphan,
  onShowAllTypes,
  onToggleCollapsed,
  onToggleType,
  onSelectCommunity,
}: GraphLegendProps) {
  const { t } = useTranslation()
  const [hoveredType, setHoveredType] = useState<string | null>(null)
  return (
    <div className="absolute bottom-3 left-3 rounded-lg border bg-background/90 backdrop-blur-sm px-3 py-2 text-xs elevation-1 max-w-[260px]">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-semibold text-foreground">
          {colorMode === "type" ? t("graph.nodeTypesLabel") : t("graph.communitiesLabel")}
        </span>
        <div className="flex items-center gap-1">
          {displayMode === "graph" && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs px-1"
              data-testid="graph-orphan-filter-toggle"
              aria-pressed={orphanHighlight}
              title={t("graph.orphanHighlight")}
              onClick={onToggleOrphan}
            >
              {t("graph.orphanHighlight")}{orphanHighlight ? ` (${orphanNodeIds.length})` : ""}
            </Button>
          )}
          {colorMode === "type" && hiddenTypes.size > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs px-1"
              onClick={onShowAllTypes}
              title={t("graph.showAllTypes")}
            >
              {t("graph.showAll")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={onToggleCollapsed}
            title={legendCollapsed ? t("graph.expandLegend") : t("graph.collapseLegend")}
          >
            {legendCollapsed ? "▶" : "▼"}
          </Button>
        </div>
      </div>
      {!legendCollapsed && (
        colorMode === "type" ? (
          <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto legend-scroll" style={{ direction: "rtl" }}>
            <div className="flex flex-col gap-0.5" style={{ direction: "ltr" }}>
              {novelMode
                ? (() => {
                    const novelTypes = ["character", "location", "organization", "item", "event", "chapter", "outline", "foreshadowing", "secret", "conflict", "timeline-point", "canon-rule"]
                    const baseTypes = ["entity", "concept", "source", "query", "synthesis", "overview", "comparison", "other"]
                    const renderTypeItem = (type: string, label: string) => {
                      const isHidden = hiddenTypes.has(type)
                      /* v8 ignore next -- novelTypes/baseTypes 恒在 NODE_TYPE_COLORS */
                      const shadowColor = NODE_TYPE_COLORS[type] ?? "#94a3b8"
                      return (
                        <div
                          key={type}
                          className={`flex items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-accent/50 ${isHidden ? "opacity-40" : ""}`}
                          onMouseEnter={() => setHoveredType(type)}
                          onMouseLeave={() => setHoveredType(null)}
                          onDoubleClick={() => onToggleType(type)}
                          title={t("graph.doubleClickToggleVisibility")}
                        >
                          <span
                            className="inline-block h-3 w-3 rounded-full shrink-0 elevation-1"
                            style={{
                              backgroundColor: isHidden ? "#94a3b8" : NODE_TYPE_COLORS[type],
                              boxShadow: `0 0 4px ${hexToRgba(isHidden ? "#94a3b8" : shadowColor, 0.4)}`,
                            }}
                          />
                          <span className={hoveredType === type ? "text-foreground font-medium" : "text-muted-foreground"}>
                            {label}
                          </span>
                          <span className="text-muted-foreground ml-auto">{typeCounts[type]}</span>
                          {isHidden && <span className="text-muted-foreground text-xs">{t("graph.hidden")}</span>}
                        </div>
                      )
                    }
                    return (
                      <>
                        {novelTypes.some((t) => (typeCounts[t] ?? 0) > 0) && (
                          <>
                            <div className="text-muted-foreground text-xs font-semibold px-1 pt-1 border-t border-border/50 mt-0.5">
                              {t("novel.graph.novelNodeTypes")}
                            </div>
                            {/* v8 ignore start */}
                            {novelTypes.filter((t) => (typeCounts[t] ?? 0) > 0).map((type) =>
                              renderTypeItem(type, nodeTypeLabels[type] ?? type)
                            )}
                            {/* v8 ignore stop */}
                          </>
                        )}
                        {baseTypes.some((t) => (typeCounts[t] ?? 0) > 0) && (
                          <>
                            <div className="text-muted-foreground text-xs font-semibold px-1 pt-1 border-t border-border/50 mt-0.5">
                              {t("novel.graph.baseNodeTypes")}
                            </div>
                            {/* v8 ignore start */}
                            {baseTypes.filter((t) => (typeCounts[t] ?? 0) > 0).map((type) =>
                              renderTypeItem(type, nodeTypeLabels[type] ?? type)
                            )}
                            {/* v8 ignore stop */}
                          </>
                        )}
                      </>
                    )
                  })()
                : Object.entries(nodeTypeLabels)
                    .filter(([type]) => (typeCounts[type] ?? 0) > 0)
                    .map(([type, label]) => {
                      const isHidden = hiddenTypes.has(type)
                      /* v8 ignore next -- nodeTypeLabels 固定映射，type 恒在 NODE_TYPE_COLORS */
                      const shadowColor = NODE_TYPE_COLORS[type] ?? "#94a3b8"
                      return (
                        <div
                          key={type}
                          className={`flex items-center gap-2 rounded px-1 py-0.5 transition-colors hover:bg-accent/50 ${isHidden ? "opacity-40" : ""}`}
                          onMouseEnter={() => setHoveredType(type)}
                          onMouseLeave={() => setHoveredType(null)}
                          onDoubleClick={() => onToggleType(type)}
                          title={t("graph.doubleClickToggleVisibility")}
                        >
                          <span
                            className="inline-block h-3 w-3 rounded-full shrink-0 elevation-1"
                            style={{
                              backgroundColor: isHidden ? "#94a3b8" : NODE_TYPE_COLORS[type],
                              boxShadow: `0 0 4px ${hexToRgba(isHidden ? "#94a3b8" : shadowColor, 0.4)}`,
                            }}
                          />
                          <span className={hoveredType === type ? "text-foreground font-medium" : "text-muted-foreground"}>
                            {label}
                          </span>
                          <span className="text-muted-foreground ml-auto">{typeCounts[type]}</span>
                          {isHidden && <span className="text-muted-foreground text-xs">{t("graph.hidden")}</span>}
                        </div>
                      )
                    })}
            </div>
          </div>
        ) : (
          <div
            data-testid="graph-community-legend"
            className="flex flex-col gap-0.5 max-h-48 overflow-y-auto legend-scroll" style={{ direction: "rtl" }}>
            <div className="flex flex-col gap-0.5" style={{ direction: "ltr" }}>
              {communities.map((c) => {
              const memberIds = displayNodes.filter((n) => n.community === c.id).map((n) => n.id)
              const memberSet = new Set(memberIds)
              const isActive = memberSet.size > 0 && highlightedNodes.size === memberSet.size &&
                [...memberSet].every((id) => highlightedNodes.has(id))
              return (
              <button
                type="button"
                key={c.id}
                aria-pressed={isActive}
                title={t("graph.focusCommunity")}
                onClick={() => onSelectCommunity(memberIds, isActive)}
                className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-accent/50 ${isActive ? "bg-info/10" : ""}`}
              >
                <span
                  className="inline-block h-3 w-3 rounded-full shrink-0 elevation-1"
                  style={{
                    backgroundColor: COMMUNITY_COLORS[c.id % COMMUNITY_COLORS.length],
                    boxShadow: `0 0 4px ${hexToRgba(COMMUNITY_COLORS[c.id % COMMUNITY_COLORS.length], 0.4)}`,
                  }}
                />
                <span className="text-muted-foreground truncate min-w-0" title={c.topNodes.join(", ")}>
                  {c.topNodes[0] ?? `${t("graph.cluster", { id: c.id })}`}
                </span>
                <span className="text-muted-foreground ml-auto shrink-0">{c.nodeCount}</span>
                {c.cohesion < 0.15 && c.nodeCount >= 3 && (
                  <span className="text-warning shrink-0" role="img" aria-label={t("graph.lowCohesion", { value: c.cohesion.toFixed(2) })} title={t("graph.lowCohesion", { value: c.cohesion.toFixed(2) })}>!</span>
                )}
              </button>
              )
            })}
            </div>
          </div>
        )
      )}
    </div>
  )
}

import { useEffect, useCallback, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Pagination, PAGINATION_PAGE_SIZE } from "@/components/ui/pagination"
import { useWikiStore } from "@/stores/wiki-store"
import { writeFileAtomic } from "@/commands/fs"
import { type GraphNode, type GraphEdge } from "@/lib/wiki-graph"
import { normalizePath } from "@/lib/path-utils"
import { groupGraphDocumentNodes, buildGraphNodeRelationSummary, buildGraphRiskReport, buildGraphRiskSummaryItemsForGroup, filterGraphDocumentNodes, filterGraphDocumentNodesByIsolation, filterGraphDocumentNodesByRelations, filterGraphDocumentNodesByRiskState, filterGraphDocumentNodesBySearch, filterNonZeroRiskSummaryItems, getGraphDocumentIsolationStats, getGraphDocumentNodeTypeOptions, getGraphDocumentQuickRiskFilters, getGraphDocumentRiskStateOptions, getGraphDocumentSortOptions, getGraphNodeRelatedEdges, getGraphNodeRiskLabel, getGraphNodeRiskStateLabel, getGraphNodeRiskStateLabelColor, getGraphNodeTypeLabel, getGraphRelationLabel, getGraphRiskSummaryItemColor, getGraphRiskSummaryTotal, getNextGraphNodeRiskStateLabel, setGraphNodeRiskStateInContent, sortGraphDocumentNodes } from "@/lib/graph-readable"
import { useTranslation } from "react-i18next"
import { formatOperationError } from "@/lib/format-operation-error"

function graphDocumentNodeDomId(nodeId: string): string {
  return `graph-doc-node-${nodeId.replace(/[^a-zA-Z0-9_-]/g, "-")}`
}

function graphNodeLabel(nodes: GraphNode[], id: string): string {
  /* v8 ignore next */
  return nodes.find((node) => node.id === id)?.label ?? id
}

function graphDocumentButtonClass(active: boolean): string {
  return active
    ? "border-primary bg-primary text-primary-foreground elevation-1"
    : "border-border bg-background text-foreground hover:bg-muted"
}

export function DocumentGraphView({
  nodes,
  edges,
  editingNode,
  editingPath,
  editingContent,
  editStatus,
  savingNode,
  onEditNode,
  onChangeEditingContent,
  onSaveNodeEdit,
  onCancelNodeEdit,
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  editingNode: GraphNode | null
  editingPath: string
  editingContent: string
  editStatus: string | null
  savingNode: boolean
  onEditNode: (node: GraphNode) => void
  onChangeEditingContent: (content: string) => void
  onSaveNodeEdit: () => void
  onCancelNodeEdit: () => void
}) {
  const { t } = useTranslation()
  const groups = useMemo(() => groupGraphDocumentNodes(nodes), [nodes])
  /* v8 ignore next */
  const [activeGroupTitle, setActiveGroupTitle] = useState(groups[0]?.title ?? "")
  const [selectedNodeType, setSelectedNodeType] = useState("all")
  const [selectedRiskState, setSelectedRiskState] = useState("all")
  const [activeQuickRiskFilterKey, setActiveQuickRiskFilterKey] = useState("")
  const [documentSortMode, setDocumentSortMode] = useState<"default" | "links-desc" | "links-asc" | "title">("default")
  const [documentSearchQuery, setDocumentSearchQuery] = useState("")
  const [hideUnrelatedNodes, setHideUnrelatedNodes] = useState(false)
  const [showOnlyIsolatedNodes, setShowOnlyIsolatedNodes] = useState(false)
  const [riskStateOverrides, setRiskStateOverrides] = useState<Record<string, string>>({})
  const [riskStateHistory, setRiskStateHistory] = useState<Array<{ nodeId: string; from: string; to: string; timestamp: number }>>([])
  // R4 共识（glm+qwen）: 导出风险报告原先无任何可见反馈（浮空 Promise + 无状态展示）。
  const [riskReportStatus, setRiskReportStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set())
  const [documentNodePage, setDocumentNodePage] = useState(0)
  const DOCUMENT_NODES_PAGE_SIZE = PAGINATION_PAGE_SIZE
  const [pendingScrollNodeId, setPendingScrollNodeId] = useState<string | null>(null)
  const activeGroup = groups.find((group) => group.title === activeGroupTitle) ?? groups[0]
  const nodeTypeOptions = useMemo(() => getGraphDocumentNodeTypeOptions(activeGroup?.nodes ?? []), [activeGroup])
  const riskStateOptions = useMemo(() => getGraphDocumentRiskStateOptions(activeGroup?.nodes ?? [], riskStateOverrides), [activeGroup, riskStateOverrides])
  const sortOptions = useMemo(() => getGraphDocumentSortOptions(), [])
  const quickRiskFilters = useMemo(() => getGraphDocumentQuickRiskFilters(), [])
  const riskSummaryItems = useMemo(() => buildGraphRiskSummaryItemsForGroup(activeGroup?.nodes ?? [], riskStateOverrides), [activeGroup, riskStateOverrides])
  const filteredRiskSummaryItems = useMemo(() => filterNonZeroRiskSummaryItems(riskSummaryItems), [riskSummaryItems])
  const totalRiskCount = useMemo(() => getGraphRiskSummaryTotal(riskSummaryItems), [riskSummaryItems])
  const isolationStats = useMemo(() => getGraphDocumentIsolationStats(activeGroup?.nodes ?? [], edges), [activeGroup, edges])
  const visibleNodes = useMemo(() => {
    const byType = filterGraphDocumentNodes(activeGroup?.nodes ?? [], selectedNodeType)
    const byRiskState = filterGraphDocumentNodesByRiskState(byType, riskStateOverrides, selectedRiskState)
    const bySearch = filterGraphDocumentNodesBySearch(byRiskState, documentSearchQuery)
    const byRelations = filterGraphDocumentNodesByRelations(bySearch, edges, hideUnrelatedNodes)
    const byIsolation = filterGraphDocumentNodesByIsolation(byRelations, edges, showOnlyIsolatedNodes)
    return sortGraphDocumentNodes(byIsolation, documentSortMode)
  }, [activeGroup, documentSearchQuery, documentSortMode, edges, hideUnrelatedNodes, riskStateOverrides, selectedNodeType, selectedRiskState, showOnlyIsolatedNodes])
  const documentNodePageCount = Math.max(1, Math.ceil(visibleNodes.length / DOCUMENT_NODES_PAGE_SIZE))
  const visibleDocumentNodes = visibleNodes.slice(documentNodePage * DOCUMENT_NODES_PAGE_SIZE, (documentNodePage + 1) * DOCUMENT_NODES_PAGE_SIZE)
  const activeGroupIndex = groups.findIndex((group) => group.title === activeGroup?.title)

  useEffect(() => {
    if (groups.length === 0) return
    if (!groups.some((group) => group.title === activeGroupTitle)) {
      /* v8 ignore next */
      setActiveGroupTitle(groups[0]?.title ?? "")
    }
  }, [activeGroupTitle, groups])

  useEffect(() => {
    if (!nodeTypeOptions.some((option) => option.value === selectedNodeType)) {
      setSelectedNodeType("all")
    }
  }, [nodeTypeOptions, selectedNodeType])

  useEffect(() => {
    if (!riskStateOptions.some((option) => option.value === selectedRiskState)) {
      setSelectedRiskState("all")
    }
  }, [riskStateOptions, selectedRiskState])

  // 筛选/分组/搜索变化 → 回到第 1 页。riskStateOverrides 有意不入 deps：循环风险标签是当前页
  // 卡片上的高频交互，重置会打断阅读；其可能造成的列表缩容由下方钳位守卫兜底。
  useEffect(() => {
    setDocumentNodePage(0)
  }, [activeGroupTitle, selectedNodeType, selectedRiskState, documentSearchQuery, hideUnrelatedNodes, showOnlyIsolatedNodes])

  // 页码越界兜底（数据重载/风险标签循环导致列表缩容）
  useEffect(() => {
    if (documentNodePage > documentNodePageCount - 1) setDocumentNodePage(0)
  }, [documentNodePage, documentNodePageCount])

  // 编辑跳转（两效应流水线）：定位目标节点所在分组与页码，DOM 提交后再滚动，保证跨页/跨分组节点可达。
  // 保存节点会 bumpDataVersion 触发图重载，loading 闪现时本组件会 remount 并重置 activeGroupTitle/
  // expandedNodeIds/页码 —— effect 重跑时一并恢复分组与展开态。visibleNodes/groups/activeGroupTitle
  // 故意不入 deps：跳转目标在编辑开始时锁定。
  useEffect(() => {
    if (!editingNode) return
    setExpandedNodeIds((current) => new Set(current).add(editingNode.id))
    const ownerGroup = groups.find((group) => group.nodes.some((node) => node.id === editingNode.id))
    if (ownerGroup && ownerGroup.title !== activeGroupTitle) setActiveGroupTitle(ownerGroup.title)
    setPendingScrollNodeId(editingNode.id)
  }, [editingNode])

  useEffect(() => {
    if (!pendingScrollNodeId) return
    const idx = visibleNodes.findIndex((node) => node.id === pendingScrollNodeId)
    if (idx < 0) return // 分组切换尚未提交/节点被过滤：等待依赖变化重试（元素本就不存在时不滚动）
    const targetPage = Math.floor(idx / DOCUMENT_NODES_PAGE_SIZE)
    if (targetPage !== documentNodePage) {
      setDocumentNodePage(targetPage)
      return // 页码切换后 DOM 尚未提交，等待依赖变化重试
    }
    const el = document.getElementById(graphDocumentNodeDomId(pendingScrollNodeId))
    if (!el) return // 页尚未提交，等待依赖变化重试
    el.scrollIntoView({ block: "start", behavior: "smooth" })
    setPendingScrollNodeId(null)
  }, [pendingScrollNodeId, documentNodePage, visibleNodes])

  const toggleNode = useCallback((nodeId: string) => {
    setExpandedNodeIds((current) => {
      const next = new Set(current)
      if (next.has(nodeId)) {
        next.delete(nodeId)
      } else {
        next.add(nodeId)
      }
      return next
    })
  }, [])

  const expandAllVisibleNodes = useCallback(() => {
    setExpandedNodeIds(new Set(visibleNodes.map((node) => node.id)))
  }, [visibleNodes])

  const collapseAllVisibleNodes = useCallback(() => {
    setExpandedNodeIds((current) => {
      const next = new Set(current)
      for (const node of visibleNodes) next.delete(node.id)
      return next
    })
  }, [visibleNodes])

  const cycleRiskStateLabel = useCallback((node: GraphNode) => {
    const currentLabel = riskStateOverrides[node.id] ?? getGraphNodeRiskStateLabel(node.type)
    const nextLabel = getNextGraphNodeRiskStateLabel(node.type, currentLabel)
    /* v8 ignore next */
    if (!nextLabel) return
    // R4 共识（deepseek+glm）: 不能在 setState updater 内部产生副作用——
    // StrictMode/并发渲染下 updater 可能被调用多次，原先会重复推入 history。
    setRiskStateHistory((history) => [...history, { nodeId: node.id, from: currentLabel, to: nextLabel, timestamp: Date.now() }])
    setRiskStateOverrides((current) => ({ ...current, [node.id]: nextLabel }))
    if (editingNode?.id === node.id) {
      const currentLabel = riskStateOverrides[node.id] ?? getGraphNodeRiskStateLabel(node.type)
      const nextLabel = getNextGraphNodeRiskStateLabel(node.type, currentLabel)
      /* v8 ignore next */
      if (nextLabel) {
        onChangeEditingContent(setGraphNodeRiskStateInContent(editingContent, nextLabel))
      }
    }
  }, [editingContent, editingNode, onChangeEditingContent, riskStateOverrides])

  const applyQuickRiskFilter = useCallback((filterKey: string, nodeType: string, riskState: string) => {
    setActiveQuickRiskFilterKey((current) => {
      if (current === filterKey) {
        setSelectedNodeType("all")
        setSelectedRiskState("all")
        return ""
      }
      setSelectedNodeType(nodeType)
      setSelectedRiskState(riskState)
      return filterKey
    })
  }, [])

  const clearQuickRiskFilter = useCallback(() => {
    setActiveQuickRiskFilterKey("")
    setSelectedNodeType("all")
    setSelectedRiskState("all")
  }, [])

  const handleExportRiskReport = useCallback(async () => {
    const projectPath = useWikiStore.getState().project?.path
    if (!projectPath) return
    const report = buildGraphRiskReport(nodes, riskStateOverrides)
    const reportPath = normalizePath(`${projectPath}/wiki/risk-report.md`)
    // R4 共识（glm+qwen）: 原先 await 无 try/catch，写盘失败成为未处理 rejection，
    // 且成功/失败都没有任何用户反馈。
    try {
      await writeFileAtomic(reportPath, report)
      setRiskReportStatus({ kind: "ok", text: `风险报告已导出：${reportPath}` })
    } catch (err) {
      setRiskReportStatus({ kind: "error", text: formatOperationError(t, err) })
    }
  }, [nodes, riskStateOverrides, t])

  return (
    <div className="h-full overflow-auto bg-background p-6">
      <div className="w-full min-w-0 space-y-5">
        <div className="rounded-lg border bg-card p-5 elevation-1">
          <h1 className="text-xl font-semibold">{t("graph.docTitle")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("graph.docHint")}</p>
        </div>
        <div className="rounded-lg border bg-card p-4 elevation-1">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">
              当前分类风险统计
              {totalRiskCount > 0 && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">（共 {totalRiskCount} 项待处理）</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {activeQuickRiskFilterKey && (
                <button
                  type="button"
                  className="rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={clearQuickRiskFilter}
                >
                  清除筛选
                </button>
              )}
              <button
                type="button"
                className="rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={handleExportRiskReport}
              >
                导出报告
              </button>
            </div>
            {riskReportStatus ? (
              <p
                role={riskReportStatus.kind === "error" ? "alert" : "status"}
                className={`mt-2 text-xs ${riskReportStatus.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}
              >
                {riskReportStatus.text}
              </p>
            ) : null}
          </div>
          {filteredRiskSummaryItems.length === 0 ? (
            <div className="mt-3 text-sm text-muted-foreground">{t("graph.noRisks")}</div>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {filteredRiskSummaryItems.map((item) => {
                const color = getGraphRiskSummaryItemColor(item)
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`rounded-md border p-3 text-left transition-colors ${color.bg} ${color.border} ${graphDocumentButtonClass(activeQuickRiskFilterKey === item.key)}`}
                    onClick={() => applyQuickRiskFilter(item.key, item.nodeType, item.riskState)}
                  >
                    <div className={`text-xs ${color.text}`}>{item.label}</div>
                    <div className={`mt-1 text-lg font-semibold ${color.text}`}>{item.count}</div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <div className="rounded-lg border bg-card p-4 elevation-1">
          <div className="flex flex-wrap gap-2">
            {groups.map((group) => (
              <button
                key={group.title}
                type="button"
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${graphDocumentButtonClass(group.title === activeGroup?.title)}`}
                onClick={() => {
                  setActiveGroupTitle(group.title)
                  setSelectedNodeType("all")
                  setSelectedRiskState("all")
                  setActiveQuickRiskFilterKey("")
                  setShowOnlyIsolatedNodes(false)
                }}
              >
                {group.title} {group.nodes.length}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">节点类型</span>
            <select
              aria-label={t("graph.nodeTypeFilterLabel")}
              className="h-8 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={selectedNodeType}
              onChange={(event) => setSelectedNodeType(event.target.value)}
            >
              {nodeTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <span className="text-muted-foreground">状态</span>
            <select
              aria-label={t("graph.riskStateFilterLabel")}
              className="h-8 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={selectedRiskState}
              onChange={(event) => setSelectedRiskState(event.target.value)}
            >
              {riskStateOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <span className="text-muted-foreground">排序方式</span>
            <select
              aria-label={t("graph.sortByLabel")}
              className="h-8 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={documentSortMode}
              onChange={(event) => setDocumentSortMode(event.target.value as "default" | "links-desc" | "links-asc" | "title")}
            >
              {sortOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <input
              className="h-8 min-w-56 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={documentSearchQuery}
              onChange={(event) => setDocumentSearchQuery(event.target.value)}
              placeholder={t("graph.searchPlaceholder")}
            />
            <label className="flex h-8 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={hideUnrelatedNodes}
                onChange={(event) => {
                  setHideUnrelatedNodes(event.target.checked)
                  if (event.target.checked) setShowOnlyIsolatedNodes(false)
                }}
              />
              隐藏无关系节点
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>当前显示 {visibleNodes.length} / {activeGroup?.nodes.length ?? 0} 个节点</span>
            <span>·</span>
            <span>孤立节点 {isolationStats.isolated} 个</span>
            <button
              type="button"
              className="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-muted"
              onClick={expandAllVisibleNodes}
              disabled={visibleNodes.length === 0}
            >
              全部展开
            </button>
            <button
              type="button"
              className="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-muted"
              onClick={collapseAllVisibleNodes}
              disabled={visibleNodes.length === 0}
            >
              全部收起
            </button>
            <button
              type="button"
              data-testid="graph-orphan-filter-toggle"
              className={`rounded-md border px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${graphDocumentButtonClass(showOnlyIsolatedNodes)}`}
              disabled={isolationStats.isolated === 0}
              onClick={() => {
                setShowOnlyIsolatedNodes((current) => !current)
                setHideUnrelatedNodes(false)
              }}
            >
              只看孤立节点
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t("graph.riskQuickFilter")}</span>
            {quickRiskFilters.map((filter) => (
              <button
                key={filter.key}
                type="button"
                className={`rounded-md border px-2 py-1 text-xs transition-colors ${graphDocumentButtonClass(activeQuickRiskFilterKey === filter.key)}`}
                onClick={() => applyQuickRiskFilter(filter.key, filter.nodeType, filter.riskState)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
        {activeGroup && (
          <section className="rounded-lg border bg-card p-5 elevation-1">
            <h2 className="mb-4 text-lg font-semibold">{activeGroupIndex + 1}. {activeGroup.title}</h2>
            {visibleNodes.length === 0 ? (
              <div>
                <p className="text-sm text-muted-foreground">{showOnlyIsolatedNodes ? "当前分类暂无孤立节点。" : "当前筛选下暂无节点。"}</p>
                <p className="mt-1 text-xs text-muted-foreground">可调整上方的筛选条件。</p>
              </div>
            ) : (
              <div className="space-y-3">
                {visibleDocumentNodes.map((node, nodeIndex) => {
                  const nodeEdges = getGraphNodeRelatedEdges(edges, node.id)
                  const eventEdges = nodeEdges.filter((edge) => {
                    const otherId = edge.source === node.id ? edge.target : edge.source
                    const otherNode = nodes.find((item) => item.id === otherId)
                    return otherNode?.type === "event" || otherNode?.type === "chapter" || otherNode?.type === "outline"
                  })
                  const riskLabel = getGraphNodeRiskLabel(node.type)
                  const riskStateLabel = riskStateOverrides[node.id] ?? getGraphNodeRiskStateLabel(node.type)
                  const isEditing = editingNode?.id === node.id
                  const isExpanded = expandedNodeIds.has(node.id) || isEditing
                  const relationSummary = buildGraphNodeRelationSummary(node, nodes, edges)
                  const isDangerNode = riskStateLabel === "疑似冲突" || riskStateLabel === "疑似矛盾"
                  return (
                    /* v8 ignore next -- canon-rule/timeline-point 恒被 allowedNodeTypes 过滤，danger 不可达 */
                    <article key={node.id} id={graphDocumentNodeDomId(node.id)} className={`scroll-mt-4 rounded-md border bg-background p-4 ${isDangerNode ? "border-l-4 border-l-destructive bg-destructive/[0.03]" : ""}`}>
                      <button type="button" className="flex w-full items-start justify-between gap-3 text-left" onClick={() => toggleNode(node.id)}>
                        <div>
                          <h3 className="break-words text-base font-semibold">{activeGroupIndex + 1}.{documentNodePage * DOCUMENT_NODES_PAGE_SIZE + nodeIndex + 1} {node.label}</h3>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span>{getGraphNodeTypeLabel(node.type)} · {t("graph.contextNodeLinks", { count: node.linkCount })}</span>
                            {riskLabel && <span className="rounded border border-warning bg-warning/10 px-1.5 py-0.5 text-xs text-warning-foreground dark:border-warning dark:text-warning-foreground">{riskLabel}</span>}
                          </div>
                        </div>
                        <span className="shrink-0 rounded-md border px-2 py-1 text-xs text-muted-foreground">{isExpanded ? t("chat.collapse", { defaultValue: "收起" }) : t("chat.expand", { defaultValue: "展开" })}</span>
                      </button>
                      {riskStateLabel && (() => {
                        const labelColor = getGraphNodeRiskStateLabelColor(riskStateLabel)
                        return (
                          <button
                            type="button"
                            className={`mt-2 rounded border px-1.5 py-0.5 text-xs transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${labelColor.bg} ${labelColor.border} ${labelColor.text}`}
                            aria-label={t("graph.riskStateFilterLabel") + ": " + riskStateLabel}
                            onClick={() => cycleRiskStateLabel(node)}
                          >
                            {riskStateLabel}
                          </button>
                        )
                      })()}

                      {isExpanded && (
                        <>
                          <div className="mt-4 flex justify-end">
                            <Button variant="outline" size="sm" className="h-7 shrink-0 text-xs" onClick={() => onEditNode(node)}>
                              {t("graph.editProfileInline")}
                            </Button>
                          </div>

                          <div className="mt-4 space-y-3 text-sm">
                            <div>
                              <div className="mb-2 font-medium">{t("graph.relationSummary")}</div>
                              {relationSummary.length === 0 ? (
                                <p className="text-muted-foreground">{t("graph.noRelationSummary")}</p>
                              ) : (
                                <div className="space-y-2">
                                  {relationSummary.map((summary) => (
                                    <div key={summary.title} className="rounded-md border bg-muted/20 px-3 py-2">
                                      <div className="text-xs font-medium text-muted-foreground">{summary.title}</div>
                                      <div className="mt-1 text-sm">{summary.items?.map((item, i) => (
                                        <span key={`${summary.title}#${i}-${item}`} className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-muted text-muted-foreground mr-1 mb-1">{item}</span>
                                      ))}</div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>

                            <div>
                              <div className="mb-1 font-medium">{t("graph.relatedEvents")}</div>
                              {eventEdges.length === 0 ? (
                                <p className="text-muted-foreground">{t("graph.noRelatedEvents")}</p>
                              ) : (
                                <ul className="space-y-1 text-muted-foreground">
                                  {eventEdges.slice(0, 8).map((edge) => {
                                    const otherId = edge.source === node.id ? edge.target : edge.source
                                    return <li key={`${edge.source}-${edge.target}-${otherId}`}>{graphNodeLabel(nodes, otherId)}：{getGraphRelationLabel(edge.relation)}</li>
                                  })}
                                </ul>
                              )}
                            </div>

                            {(() => {
                              const nodeHistory = riskStateHistory.filter((h) => h.nodeId === node.id)
                              if (nodeHistory.length === 0) return null
                              return (
                                <div>
                                  <div className="mb-1 font-medium">{t("graph.statusHistory")}</div>
                                  <ul className="space-y-1 text-muted-foreground text-xs">
                                    {nodeHistory.slice(-10).reverse().map((entry) => {
                                      const time = new Date(entry.timestamp)
                                      const timeStr = `${time.getHours().toString().padStart(2, "0")}:${time.getMinutes().toString().padStart(2, "0")}:${time.getSeconds().toString().padStart(2, "0")}`
                                      return (
                                        <li key={`${entry.timestamp}-${entry.from}-${entry.to}`}>
                                          <span className="text-muted-foreground">{timeStr}</span>{" "}
                                          {entry.from} → {entry.to}
                                        </li>
                                      )
                                    })}
                                  </ul>
                                </div>
                              )
                            })()}

                            <details className="rounded-md border bg-muted/20 p-3">
                              <summary className="cursor-pointer text-sm font-medium">{t("graph.techInfo")}</summary>
                              <div className="mt-3 space-y-3">
                                <div>
                                  <div className="mb-1 font-medium">{t("graph.basicInfo")}</div>
                                  <ul className="space-y-1 text-muted-foreground">
                                    <li>节点类型：{getGraphNodeTypeLabel(node.type)}</li>
                                    <li>关联数量：{node.linkCount}</li>
                                    <li>来源路径：{node.path || "暂无"}</li>
                                  </ul>
                                </div>
                                <div>
                                  <div className="mb-1 font-medium">{t("graph.relationNetwork")}</div>
                                  {nodeEdges.length === 0 ? (
                                    <p className="text-muted-foreground">{t("graph.noRelations")}</p>
                                  ) : (
                                    <div className="overflow-x-auto">
                                      <table className="w-full border-collapse text-xs">
                                        <thead>
                                          <tr className="border-b text-left text-muted-foreground">
                                            <th className="py-1 pr-3">{t("graph.relatedObject")}</th>
                                            <th className="py-1 pr-3">关系</th>
                                            <th className="py-1 pr-3">{t("graph.direction")}</th>
                                            <th className="py-1">{t("graph.weight")}</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {nodeEdges.slice(0, 12).map((edge) => {
                                            const isSource = edge.source === node.id
                                            const otherId = isSource ? edge.target : edge.source
                                            return (
                                              <tr key={`${edge.source}-${edge.target}-${otherId}`} className="border-b last:border-0">
                                                <td className="py-1 pr-3">{graphNodeLabel(nodes, otherId)}</td>
                                                <td className="py-1 pr-3">{getGraphRelationLabel(edge.relation)}</td>
                                                <td className="py-1 pr-3">{isSource ? "指向对方" : "来自对方"}</td>
                                                <td className="py-1">{edge.weight}</td>
                                              </tr>
                                            )
                                          })}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </details>
                          </div>

                          {isEditing && (
                            <div className="mt-4 rounded-md border bg-muted/30 p-3">
                              <div className="mb-2 flex items-center justify-between gap-3">
                                <div>
                                  <div className="text-sm font-medium">{t("graph.editingProfileFor", { label: node.label })}</div>
                                  <div className="mt-1 text-xs text-muted-foreground">{t("graph.profilePath")}：{editingPath}</div>
                                </div>
                                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancelNodeEdit}>
                                  {t("graph.cancelProfileInline")}
                                </Button>
                              </div>
                              <textarea
                                className="h-72 w-full resize-y rounded-md border bg-background p-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
                                value={editingContent}
                                onChange={(event) => onChangeEditingContent(event.target.value)}
                              />
                              <div className="mt-2 flex items-center justify-between gap-3">
                                <div className="text-xs text-muted-foreground">{editStatus ?? t("graph.editNodeStatusDefault")}</div>
                                <Button size="sm" className="h-8 text-xs" onClick={onSaveNodeEdit} disabled={savingNode}>
                                  {savingNode ? t("graph.savingNode") : t("graph.saveProfileInline")}
                                </Button>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </article>
                  )
                })}
              </div>
            )}
            <Pagination
              page={documentNodePage + 1}
              pageCount={documentNodePageCount}
              total={visibleNodes.length}
              onPrev={() => setDocumentNodePage((p) => Math.max(0, p - 1))}
              onNext={() => setDocumentNodePage((p) => Math.min(documentNodePageCount - 1, p + 1))}
            />
          </section>
        )}
      </div>
    </div>
  )
}

// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { X, ArrowRight, ArrowLeft, ExternalLink, Network, FileText, Tag, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { GraphNode, GraphEdge } from "@/lib/wiki-graph"

export interface NodeInspectorDrawerProps {
  node: GraphNode | null
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** 节点类型显示名映射（与图例共用），缺省回落到原始 type 键。 */
  nodeTypeLabels?: Record<string, string>
  onSelectNode: (nodeId: string) => void
  onOpenWiki?: (path: string) => void
  onClose: () => void
}

interface RelationItem {
  id: string
  targetNodeId: string
  targetLabel: string
  targetType: string
  relation: string
}

export function NodeInspectorDrawer({
  node,
  nodes,
  edges,
  nodeTypeLabels,
  onSelectNode,
  onOpenWiki,
  onClose,
}: NodeInspectorDrawerProps) {
  const { t } = useTranslation()

  const nodeMap = useMemo(() => {
    const map = new Map<string, GraphNode>()
    for (const n of nodes) {
      map.set(n.id, n)
    }
    return map
  }, [nodes])

  const { incoming, outgoing } = useMemo(() => {
    if (!node) return { incoming: [], outgoing: [] }

    const inc: RelationItem[] = []
    const out: RelationItem[] = []

    // 同一对端可存在多条不同 relation 的边（buildWikiGraph 去重键含 relation），
    // 因此 id 必须带 relation，否则 React key 重复会只保留一行、漏掉关系。
    const fallbackRelation = t("graph.links", { defaultValue: "关联" })
    for (const edge of edges) {
      const relation = edge.relation || fallbackRelation
      if (edge.target === node.id) {
        const sourceNode = nodeMap.get(edge.source)
        inc.push({
          id: `in:${edge.source}->${edge.target}:${relation}`,
          targetNodeId: edge.source,
          targetLabel: sourceNode?.label || edge.source,
          targetType: sourceNode?.type || "unknown",
          relation,
        })
      } else if (edge.source === node.id) {
        const targetNode = nodeMap.get(edge.target)
        out.push({
          id: `out:${edge.source}->${edge.target}:${relation}`,
          targetNodeId: edge.target,
          targetLabel: targetNode?.label || edge.target,
          targetType: targetNode?.type || "unknown",
          relation,
        })
      }
    }

    return { incoming: inc, outgoing: out }
  }, [node, edges, nodeMap, t])

  if (!node) return null

  const totalRelations = incoming.length + outgoing.length

  return (
    <div
      role="region"
      aria-label={t("graph.inspectorTitle", { defaultValue: "节点关系与信息" })}
      data-testid="node-inspector-drawer"
      className="absolute top-3 right-14 bottom-3 z-20 flex w-80 max-w-[calc(100%-4rem)] flex-col rounded-xl border bg-background/95 shadow-2xl backdrop-blur-md animate-in slide-in-from-right-4 duration-200"
    >
      {/* 头部标题与关闭按钮 */}
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <Network className="h-4 w-4 shrink-0 text-primary" />
          <h3 className="truncate text-sm font-semibold text-foreground">
            {t("graph.inspectorTitle", { defaultValue: "节点关系与信息" })}
          </h3>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={onClose}
          aria-label={t("graph.inspectorClose", { defaultValue: "关闭详情面板" })}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1 px-4 py-3">
        {/* 节点名与类型徽章 */}
        <div className="space-y-3 pb-3 border-b">
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-1">
              {t("graph.inspectorNodeName", { defaultValue: "实体名称" })}
            </div>
            <h2 className="text-base font-bold text-foreground break-words" data-testid="inspector-node-label">
              {node.label}
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs font-normal text-secondary-foreground">
              <Tag className="h-3 w-3" />
              <span data-testid="inspector-node-type">
                {nodeTypeLabels?.[node.type] ?? (node.type || t("graph.nodeTypeDefault", { defaultValue: "未知类型" }))}
              </span>
            </span>

            {node.community !== undefined && (
              <span className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-normal text-muted-foreground">
                <Users className="h-3 w-3" />
                {t("graph.community", { defaultValue: "社区" })} #{node.community}
              </span>
            )}

            <span className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-normal text-muted-foreground">
              <Network className="h-3 w-3" />
              {t("graph.inspectorLinks", { defaultValue: "总连接度" })}: {node.linkCount ?? totalRelations}
            </span>
          </div>

          {node.path && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate" title={node.path}>{node.path}</span>
            </div>
          )}
        </div>

        {/* 关系列表区域 */}
        <div className="py-3 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground">
              {t("graph.inspectorRelations", { defaultValue: "直接关联" })} ({totalRelations})
            </span>
          </div>

          {totalRelations === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              {t("graph.inspectorNoRelations", { defaultValue: "暂无直接关联" })}
            </div>
          ) : (
            <>
              {/* 出边关系 (Outgoing) */}
              {outgoing.length > 0 && (
                <div className="space-y-1.5" data-relation-group="outgoing">
                  <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                    <ArrowRight className="h-3 w-3 text-primary" />
                    <span>{t("graph.inspectorOutgoing", { defaultValue: "指向关系 (Out)" })}</span>
                    <span className="text-[10px] text-muted-foreground/80">({outgoing.length})</span>
                  </div>
                  <div className="space-y-1">
                    {outgoing.map((rel) => (
                      <button
                        key={rel.id}
                        type="button"
                        onClick={() => onSelectNode(rel.targetNodeId)}
                        className="w-full flex items-center justify-between gap-2 rounded-lg border bg-card/60 p-2 text-left text-xs transition-colors hover:bg-accent/80 hover:text-foreground group"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-foreground truncate group-hover:text-primary">
                              {rel.targetLabel}
                            </span>
                            <span className="text-[10px] text-muted-foreground px-1.5 py-[1px] rounded bg-muted shrink-0">
                              {nodeTypeLabels?.[rel.targetType] ?? rel.targetType}
                            </span>
                          </div>
                          <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                            {rel.relation}
                          </div>
                        </div>
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 入边关系 (Incoming) */}
              {incoming.length > 0 && (
                <div className="space-y-1.5" data-relation-group="incoming">
                  <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                    <ArrowLeft className="h-3 w-3 text-muted-foreground" />
                    <span>{t("graph.inspectorIncoming", { defaultValue: "指入关系 (In)" })}</span>
                    <span className="text-[10px] text-muted-foreground/80">({incoming.length})</span>
                  </div>
                  <div className="space-y-1">
                    {incoming.map((rel) => (
                      <button
                        key={rel.id}
                        type="button"
                        onClick={() => onSelectNode(rel.targetNodeId)}
                        className="w-full flex items-center justify-between gap-2 rounded-lg border bg-card/60 p-2 text-left text-xs transition-colors hover:bg-accent/80 hover:text-foreground group"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-foreground truncate group-hover:text-primary">
                              {rel.targetLabel}
                            </span>
                            <span className="text-[10px] text-muted-foreground px-1.5 py-[1px] rounded bg-muted shrink-0">
                              {nodeTypeLabels?.[rel.targetType] ?? rel.targetType}
                            </span>
                          </div>
                          <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                            {rel.relation}
                          </div>
                        </div>
                        <ArrowLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform group-hover:-translate-x-0.5 group-hover:text-primary" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      {/* 底部操作栏 */}
      {onOpenWiki && node.path && (
        <div className="shrink-0 border-t p-3 bg-muted/20">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full gap-2 text-xs"
            onClick={() => onOpenWiki(node.path)}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t("graph.inspectorOpenWiki", { defaultValue: "打开完整 Wiki 档案" })}
          </Button>
        </div>
      )}
    </div>
  )
}

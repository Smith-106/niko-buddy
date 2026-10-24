import { useEffect, useMemo, useState } from "react"
import { useSigma } from "@react-sigma/core"
import { ZoomIn, ZoomOut, Maximize, ChevronRight, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NODE_TYPE_COLORS, hexToRgba, mixColor } from "@/lib/graph-style"
import { type MindMapNode } from "@/lib/graph-readable"
import { useTranslation } from "react-i18next"

/** 收集整棵导图里所有可折叠（有 children）的节点 id，供工具条一键展开/收起。 */
export function collectMindMapParentIds(forest: MindMapNode[]): string[] {
  const ids: string[] = []
  const walk = (nodes: MindMapNode[]) => {
    for (const node of nodes) {
      if (node.children.length > 0) {
        ids.push(node.id)
        walk(node.children)
      }
    }
  }
  walk(forest)
  return ids
}

export interface MindMapBranchProps {
  node: MindMapNode
  level?: number
  onNodeClick?: (node: MindMapNode) => void
  collapsedIds?: ReadonlySet<string>
  onToggleCollapse?: (nodeId: string) => void
}

export function MindMapBranch({ node, level = 0, onNodeClick, collapsedIds, onToggleCollapse }: MindMapBranchProps) {
  const { t } = useTranslation()
  const hasChildren = node.children.length > 0
  const collapsed = collapsedIds?.has(node.id) ?? false
  const accent = node.nodeType ? NODE_TYPE_COLORS[node.nodeType] : undefined

  return (
    <div className={level === 0 ? "space-y-1.5" : ""}>
      <div className="flex items-center gap-1.5">
        {hasChildren ? (
          <button
            type="button"
            data-testid={`mindmap-collapse-toggle-${node.id}`}
            aria-expanded={!collapsed}
            aria-label={collapsed ? t("graph.mindmapExpandBranch") : t("graph.mindmapCollapseBranch")}
            onClick={() => onToggleCollapse?.(node.id)}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-1.5 py-1 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
          >
            {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            <span className="min-w-4 rounded-full bg-muted px-1 text-center tabular-nums">{node.children.length}</span>
          </button>
        ) : (
          <span aria-hidden="true" className="w-[7px] shrink-0" />
        )}
        <div
          role={onNodeClick ? "button" : undefined}
          tabIndex={onNodeClick ? 0 : undefined}
          onClick={onNodeClick ? () => onNodeClick(node) : undefined}
          onKeyDown={onNodeClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onNodeClick(node) } } : undefined}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-sm shadow-sm transition-colors ${onNodeClick ? "cursor-pointer hover:bg-accent/60" : ""}`}
          style={accent ? { borderColor: hexToRgba(accent, 0.5), backgroundColor: mixColor(accent, "#ffffff", 0.92) } : undefined}
          title={node.label}
        >
          {accent && (
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: accent, boxShadow: `0 0 4px ${hexToRgba(accent, 0.5)}` }}
            />
          )}
          <span className="truncate text-foreground">{node.label}</span>
        </div>
      </div>
      {hasChildren && !collapsed && (
        <div className="relative mt-1.5 space-y-1.5 pl-6">
          <span
            data-testid="mindmap-connector-rail"
            aria-hidden="true"
            className="absolute bottom-2 left-[13px] top-1 w-0.5 rounded-full bg-gradient-to-b from-border via-primary/40 to-border"
          />
          {node.children.map((child) => (
            <div key={child.id} className="relative">
              <span
                aria-hidden="true"
                className="absolute -left-6 top-1/2 h-px w-[13px] -translate-y-1/2 bg-primary/30"
              />
              <MindMapBranch
                node={child}
                level={level + 1}
                onNodeClick={onNodeClick}
                collapsedIds={collapsedIds}
                onToggleCollapse={onToggleCollapse}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function MindMapGraphView({ mindMap, onNodeClick }: { mindMap: MindMapNode[]; onNodeClick?: (node: MindMapNode) => void }) {
  const { t } = useTranslation()
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const parentIds = useMemo(() => collectMindMapParentIds(mindMap), [mindMap])

  // 数据源切换（换项目/重建图谱）时清空折叠态，避免旧 id 误伤新树。
  useEffect(() => {
    setCollapsedIds(new Set())
  }, [mindMap])

  const toggleCollapse = (nodeId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }

  return (
    <div className="h-full overflow-auto bg-background p-6">
      <div
        data-testid="mindmap-toolbar"
        className="mb-3 flex flex-wrap items-center gap-2"
      >
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setCollapsedIds(new Set())}
          disabled={parentIds.length === 0}
        >
          {t("graph.mindmapExpandAll")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setCollapsedIds(new Set(parentIds))}
          disabled={parentIds.length === 0}
        >
          {t("graph.mindmapCollapseAll")}
        </Button>
      </div>
      <div className="min-w-[720px] space-y-3">
        {mindMap.map((node) => (
          <MindMapBranch
            key={node.id}
            node={node}
            onNodeClick={onNodeClick}
            collapsedIds={collapsedIds}
            onToggleCollapse={toggleCollapse}
          />
        ))}
      </div>
    </div>
  )
}

export function ZoomControls() {
  const sigma = useSigma()

  return (
    <div className="absolute top-3 right-3 flex flex-col gap-1">
      <Button
        variant="outline"
        size="icon"
        className="h-7 w-7 bg-background/80 backdrop-blur-sm"
        onClick={() => {
          const camera = sigma.getCamera()
          camera.animatedZoom({ duration: 200 })
        }}
      >
        <ZoomIn className="h-3.5 w-3.5 shrink-0" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-7 w-7 bg-background/80 backdrop-blur-sm"
        onClick={() => {
          const camera = sigma.getCamera()
          camera.animatedUnzoom({ duration: 200 })
        }}
      >
        <ZoomOut className="h-3.5 w-3.5 shrink-0" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className="h-7 w-7 bg-background/80 backdrop-blur-sm"
        onClick={() => {
          const camera = sigma.getCamera()
          camera.animatedReset({ duration: 300 })
        }}
      >
        <Maximize className="h-3.5 w-3.5 shrink-0" />
      </Button>
    </div>
  )
}

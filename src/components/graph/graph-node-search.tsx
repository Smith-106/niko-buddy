// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Search, X, Crosshair } from "lucide-react"
import type { GraphNode } from "@/lib/wiki-graph"

export interface GraphNodeSearchProps {
  nodes: GraphNode[]
  onSelectNode: (nodeId: string) => void
  maxResults?: number
}

/**
 * 图谱内节点搜索：按 label / type 模糊匹配，选中后交给调用方飞入定位。
 * 键盘可达：↑/↓ 移动高亮项，Enter 确认，Escape 清空。
 */
export function GraphNodeSearch({ nodes, onSelectNode, maxResults = 8 }: GraphNodeSearchProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const listboxId = useId()
  const optionId = (index: number) => `${listboxId}-opt-${index}`

  const results = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return []
    // 相关性排序后再截断：否则大图按原数组顺序截断，真正想找的节点可能永远进不了前 N 条。
    // 0 = 名称全等，1 = 名称前缀，2 = 名称子串，3 = 仅类型命中；同级按 linkCount 降序。
    const scored: Array<{ node: GraphNode; rank: number }> = []
    for (const node of nodes) {
      const label = (node.label ?? "").toLowerCase()
      const type = (node.type ?? "").toLowerCase()
      let rank: number
      if (label === keyword) rank = 0
      else if (label.startsWith(keyword)) rank = 1
      else if (label.includes(keyword)) rank = 2
      else if (type.includes(keyword)) rank = 3
      else continue
      scored.push({ node, rank })
    }
    scored.sort((a, b) => a.rank - b.rank || (b.node.linkCount ?? 0) - (a.node.linkCount ?? 0))
    return scored.slice(0, maxResults).map((entry) => entry.node)
  }, [query, nodes, maxResults])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  // 点击外部关闭下拉，避免遮挡画布。
  useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  const commit = (node: GraphNode) => {
    onSelectNode(node.id)
    setQuery("")
    setOpen(false)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setQuery("")
      setOpen(false)
      return
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setOpen(true)
      setActiveIndex((prev) => (results.length === 0 ? 0 : (prev + 1) % results.length))
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setOpen(true)
      setActiveIndex((prev) => (results.length === 0 ? 0 : (prev - 1 + results.length) % results.length))
      return
    }
    if (event.key === "Enter") {
      const target = results[activeIndex]
      if (target) {
        event.preventDefault()
        commit(target)
      }
    }
  }

  const showDropdown = open && query.trim().length > 0

  return (
    <div ref={containerRef} className="relative" data-testid="graph-node-search">
      <div className="flex items-center gap-1.5 rounded-full border bg-background/95 px-2.5 py-1 text-xs elevation-2 backdrop-blur-sm">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={t("graph.nodeSearchPlaceholder", { defaultValue: "在图谱中搜索节点..." })}
          aria-label={t("graph.nodeSearchPlaceholder", { defaultValue: "在图谱中搜索节点..." })}
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={showDropdown && results.length > 0 ? optionId(activeIndex) : undefined}
          className="w-40 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        {query && (
          <button
            type="button"
            aria-label={t("graph.searchClear", { defaultValue: "清空搜索" })}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => {
              setQuery("")
              setOpen(false)
            }}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {showDropdown && (
        <div
          role="listbox"
          id={listboxId}
          className="absolute top-full left-0 z-30 mt-1.5 max-h-64 w-64 overflow-y-auto rounded-lg border bg-popover/95 p-1 text-xs shadow-lg backdrop-blur-sm"
        >
          {results.length === 0 ? (
            <div className="px-2 py-2 text-center text-muted-foreground">
              {t("graph.searchNoResults", { defaultValue: "未匹配到相关节点" })}
            </div>
          ) : (
            results.map((node, index) => (
              <button
                key={node.id}
                id={optionId(index)}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => commit(node)}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                  index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
                }`}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{node.label}</span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {node.type}
                </span>
                <Crosshair className="h-3 w-3 shrink-0 text-muted-foreground/70" />
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

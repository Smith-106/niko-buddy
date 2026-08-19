// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from "react"
import { useTranslation } from "react-i18next"
import { X } from "lucide-react"
import { useWikiStore } from "@/stores/wiki-store"
import { parseReferences, resolveReferences, loadAllReferenceCandidates } from "@/lib/reference"
import type { ReferenceCandidate, ResolvedReference } from "@/lib/reference"
import { normalizePath } from "@/lib/path-utils"

/** 彩色标签配色：角色蓝 / 章节绿 / 设定紫 */
const KIND_STYLES: Record<string, string> = {
  character: "border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400",
  chapter: "border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400",
  setting: "border-purple-500/40 bg-purple-500/10 text-purple-600 dark:text-purple-400",
}

const KIND_LABELS: Record<string, string> = {
  character: "角色",
  chapter: "章节",
  setting: "设定",
}

export interface ReferenceMentionHandle {
  /** 返回 true 表示键盘事件已被引用交互消费（调用方应停止处理） */
  handleKeyDown(e: React.KeyboardEvent): boolean
}

/**
 * Wave 2 @引用系统 — 输入框内 @ 引用交互（候选下拉 + 彩色标签条）。
 *
 * 纯前端交互层：候选装载走 resolve（防抖 300ms），不触发 LLM；
 * 选中后 @token 保留在文本中（build-time 由 buildReferenceContext 重新解析注入）。
 */
export const ReferenceMention = forwardRef<ReferenceMentionHandle, {
  value: string
  onRemoveToken: (full: string) => void
}>(function ReferenceMention({ value, onRemoveToken }, ref) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const [candidates, setCandidates] = useState<ReferenceCandidate[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const projectPath = project?.path ? normalizePath(project.path) : ""

  // 当前 @ 触发点：最后一个 @ 且其后无终止符
  const trigger = useMemo(() => {
    const lastAt = value.lastIndexOf("@")
    if (lastAt < 0) return null
    const after = value.slice(lastAt + 1)
    if (/[\s，。！？、；：]/.test(after)) return null
    return { index: lastAt, query: after }
  }, [value])

  // 防抖装载候选（300ms）
  useEffect(() => {
    if (!trigger || !projectPath) {
      setOpen(false)
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void (async () => {
        const all = await loadAllReferenceCandidates(projectPath).catch(() => [])
        const scored = all
          .map((c) => ({ ...c, score: scoreForQuery(c, trigger.query) }))
          .filter((c) => c.score > 0)
          .sort((a, b) => b.score - a.score)
        setCandidates(scored.slice(0, 5))
        setActiveIndex(0)
        setOpen(scored.length > 0)
      })()
    }, 300)
    return () => {
      /* v8 ignore next -- early-return 分支不注册 cleanup，ref 恒非空 */
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [trigger, projectPath])

  // 已解析引用（chip 条数据源）
  const resolved = useMemo(() => {
    const tokens = parseReferences(value)
    if (tokens.length === 0) return []
    return tokens.map((token) => {
      const kind = token.kind ?? "character"
      return {
        token,
        kind,
        name: token.raw,
        id: `${kind}:${token.raw}`,
      } as ResolvedReference
    })
  }, [value])

  const selectCandidate = (candidate: ReferenceCandidate) => {
    // 把 @query 替换为 @候选名（保留在文本中，build-time 重新解析）
    /* v8 ignore next -- 下拉仅在 trigger 存在时打开，守卫不可达 */
    if (!trigger) return
    const before = value.slice(0, trigger.index)
    const after = value.slice(trigger.index + 1 + trigger.query.length)
    const next = `${before}@${candidate.name}${after}`
    onRemoveToken(next) // 复用同一 setter 通道（语义：更新文本）
    setOpen(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!open || candidates.length === 0) return false
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % candidates.length)
      return true
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((i) => (i - 1 + candidates.length) % candidates.length)
      return true
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      selectCandidate(candidates[activeIndex]!)
      return true
    } else if (e.key === "Escape") {
      setOpen(false)
      return true
    }
    return false
  }

  useImperativeHandle(ref, () => ({ handleKeyDown }), [open, candidates, activeIndex, trigger, value])

  if (resolved.length === 0 && !open) return null

  return (
    <div className="px-3 pb-2">
      {resolved.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {resolved.map((ref) => {
            /* v8 ignore next -- kind 恒为三值之一 */
            const chipStyle = KIND_STYLES[ref.kind] ?? KIND_STYLES.character
            /* v8 ignore next -- kind 恒为三值之一 */
            const chipLabel = KIND_LABELS[ref.kind] ?? "引用"
            return (
              <span
                key={ref.id}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${chipStyle}`}
              >
                <button
                  type="button"
                  className="cursor-pointer"
                  onClick={() => setExpanded((s) => ({ ...s, [ref.id]: !s[ref.id] }))}
                  title={t("chat.reference.expand", { defaultValue: "点击预览引用内容" })}
                >
                  {chipLabel} · {ref.name}
                </button>
                <button
                  type="button"
                  className="cursor-pointer opacity-60 hover:opacity-100"
                  onClick={() => onRemoveToken(ref.token.full)}
                  aria-label={t("chat.reference.remove", { defaultValue: "移除引用" })}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            )
          })}
        </div>
      )}
      {open && candidates.length > 0 && (
        <ul className="max-h-48 overflow-y-auto rounded-md border bg-background shadow-md">
          {candidates.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent ${i === activeIndex ? "bg-accent" : ""}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => selectCandidate(c)}
              >
                <span className={`rounded px-1 text-xs ${KIND_STYLES[c.kind]}`}>{KIND_LABELS[c.kind]}</span>
                <span>{c.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">{c.score}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
})

function scoreForQuery(candidate: ReferenceCandidate, query: string): number {
  const q = query.trim()
  if (!q) return 0
  if (candidate.name === q) return 100
  if (candidate.aliases?.includes(q)) return 90
  if (candidate.name.startsWith(q) && q.length >= 1) return 70
  return 0
}

/**
 * File Edit Preview - 显示 AI 建议的文件修改
 * 每条修改可单独：应用 / 忽略 / 编辑
 * 应用后可展开查看修改前后对比
 */

import { useState, useCallback, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Check, X, FileText, AlertCircle, Pencil, ChevronDown, ChevronRight } from "lucide-react"
import type { FileEditAction, FileEditResult } from "@/lib/novel"

interface FileEditPreviewProps {
  edits: FileEditAction[]
  onApply: (edits: FileEditAction[]) => Promise<FileEditResult[]>
  onDismiss: () => void
  applied?: boolean
  results?: FileEditResult[]
}

type EditItemStatus = "pending" | "applied" | "dismissed" | "editing"

interface EditItemState {
  status: EditItemStatus
  editedReplace?: string
  result?: FileEditResult
}

function EditDiffView({ search, replace }: { search: string; replace: string }) {
  return (
    <div className="space-y-1 text-xs font-mono">
      <div className="rounded bg-destructive px-2 py-1.5 dark:bg-destructive/30">
        {search.split("\n").map((line, i) => (
          <div key={i} className="text-destructive dark:text-destructive">
            <span className="mr-1 select-none text-destructive">-</span>{line}
          </div>
        ))}
      </div>
      <div className="rounded bg-success px-2 py-1.5 dark:bg-success/30">
        {replace.split("\n").map((line, i) => (
          <div key={i} className="text-success dark:text-success">
            <span className="mr-1 select-none text-success">+</span>{line}
          </div>
        ))}
      </div>
    </div>
  )
}

export function FileEditPreview({ edits, onApply, onDismiss, applied }: FileEditPreviewProps) {
  const { t } = useTranslation()
  const [itemStates, setItemStates] = useState<EditItemState[]>(
    () => edits.map(() => ({ status: applied ? "applied" : "pending" }))
  )
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set())
  const effectiveItemStates = edits.map((_, index) => itemStates[index] ?? { status: applied ? "applied" : "pending" })

  useEffect(() => {
    setItemStates((prev) => {
      if (prev.length === edits.length) return prev
      return edits.map((_, index) => prev[index] ?? { status: applied ? "applied" : "pending" })
    })
    setExpandedItems((prev) => {
      const next = new Set(Array.from(prev).filter((index) => index < edits.length))
      return next.size === prev.size ? prev : next
    })
  }, [edits, applied])

  const toggleExpand = (index: number) => {
    setExpandedItems((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const handleApplyOne = useCallback(async (index: number) => {
    const state = effectiveItemStates[index]
    const edit = { ...edits[index] }
    if (state.editedReplace !== undefined) {
      edit.replace = state.editedReplace
    }
    const editResults = await onApply([edit])
    setItemStates((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], status: "applied", result: editResults[0] }
      return next
    })
  }, [edits, effectiveItemStates, onApply])

  const handleDismissOne = useCallback((index: number) => {
    setItemStates((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], status: "dismissed" }
      return next
    })
  }, [])

  const handleEditOne = useCallback((index: number) => {
    setItemStates((prev) => {
      const next = [...prev]
      /* v8 ignore next */
      const current = next[index] ?? { status: applied ? "applied" : "pending" }
      next[index] = { ...current, status: "editing", editedReplace: current.editedReplace ?? edits[index].replace }
      return next
    })
  }, [applied, edits])

  const handleSaveEdit = useCallback((index: number, newReplace: string) => {
    setItemStates((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], status: "pending", editedReplace: newReplace }
      return next
    })
  }, [])

  const handleApplyAll = useCallback(async () => {
    const pendingEdits: { edit: FileEditAction; index: number }[] = []
    for (let i = 0; i < edits.length; i++) {
      const state = effectiveItemStates[i]
      if (state.status === "pending") {
        const edit = { ...edits[i] }
        if (state.editedReplace !== undefined) edit.replace = state.editedReplace
        pendingEdits.push({ edit, index: i })
      }
    }
    /* v8 ignore next */
    if (pendingEdits.length === 0) return
    const editResults = await onApply(pendingEdits.map(p => p.edit))
    setItemStates((prev) => {
      const next = [...prev]
      pendingEdits.forEach((p, ri) => {
        next[p.index] = { ...next[p.index], status: "applied", result: editResults[ri] }
      })
      return next
    })
  }, [edits, effectiveItemStates, onApply])

  const pendingCount = effectiveItemStates.filter(s => s.status === "pending").length
  const appliedCount = effectiveItemStates.filter(s => s.status === "applied").length

  // 全部已处理
  if (pendingCount === 0 && effectiveItemStates.every(s => s.status !== "editing")) {
    return (
      <div className="mt-2 rounded-md border border-success bg-success p-3 dark:border-success/60 dark:bg-success/30">
        <div className="flex items-center gap-2 text-sm font-medium text-success dark:text-success">
          <Check className="h-4 w-4 shrink-0" />
          已处理 {appliedCount} 条修改
        </div>
        <div className="mt-2 space-y-1">
          {edits.map((edit, i) => {
            const state = effectiveItemStates[i]
            const expanded = expandedItems.has(i)
            return (
              <div key={i} className="rounded border bg-background">
                <button
                  onClick={() => toggleExpand(i)}
                  className="flex w-full items-center gap-2 min-w-0 px-2 py-1.5 text-xs hover:bg-accent/50 text-left"
                >
                  {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                  <span className={`min-w-0 truncate ${state.status === "applied" ? "text-success dark:text-success" : "text-muted-foreground line-through"}`}>
                    {state.status === "applied" ? "✓" : "✗"} {edit.filePath}
                  </span>
                  {state.result && !state.result.success && (
                    <span className="shrink-0 text-destructive text-xs">({state.result.error})</span>
                  )}
                </button>
                {expanded && (
                  <div className="border-t px-2 py-2">
                    <EditDiffView search={edit.search} replace={state.editedReplace ?? edit.replace} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="mt-2 rounded-md border border-warning bg-warning p-3 dark:border-warning/60 dark:bg-warning/30">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 text-sm font-medium text-warning dark:text-warning">
          <FileText className="h-4 w-4 shrink-0" />
          <span className="truncate">AI 建议修改 {edits.length} 处</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {pendingCount > 1 && (
            <button
              onClick={() => void handleApplyAll()}
              className="inline-flex items-center gap-1 rounded-md bg-success px-2.5 py-1 text-xs font-medium text-white hover:bg-success shrink-0"
            >
              <Check className="h-3 w-3 shrink-0" />
              全部应用 ({pendingCount})
            </button>
          )}
          <button
            onClick={onDismiss}
            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent shrink-0"
          >
            <X className="h-3 w-3 shrink-0" />
            全部忽略
          </button>
        </div>
      </div>

      <div className="mt-2 space-y-2">
        {edits.map((edit, i) => {
          const state = effectiveItemStates[i]
          if (state.status === "dismissed") {
            return (
              <div key={i} className="rounded border bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground line-through">
                {edit.filePath} (已忽略)
              </div>
            )
          }
          if (state.status === "applied") {
            return (
              <div key={i} className="rounded border border-success bg-success/50 px-2 py-1.5 dark:border-success/40 dark:bg-success/20">
                <button onClick={() => toggleExpand(i)} className="flex w-full items-center gap-1 min-w-0 text-xs text-success dark:text-success text-left">
                  {expandedItems.has(i) ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                  <span className="min-w-0 truncate">✓ {edit.filePath}</span>
                </button>
                {expandedItems.has(i) && (
                  <div className="mt-1 border-t pt-1">
                    <EditDiffView search={edit.search} replace={state.editedReplace ?? edit.replace} />
                  </div>
                )}
              </div>
            )
          }
          if (state.status === "editing") {
            return (
              <div key={i} className="rounded border bg-background p-2">
                <div className="mb-1 text-xs font-medium text-muted-foreground truncate">{edit.filePath} — 编辑替换内容</div>
                <div className="mb-2 rounded bg-destructive px-2 py-1 text-xs dark:bg-destructive/30">
                  <div className="mb-1 text-[10px] font-medium text-destructive">{t("chat.originalText")}</div>
                  <pre className="whitespace-pre-wrap text-destructive dark:text-destructive">{edit.search}</pre>
                </div>
                <textarea
                  value={state.editedReplace ?? edit.replace}
                  onChange={(e) => {
                    const val = e.target.value
                    setItemStates((prev) => {
                      const next = [...prev]
                      next[i] = { ...next[i], editedReplace: val }
                      return next
                    })
                  }}
                  className="w-full min-h-[80px] rounded border bg-background px-2 py-1.5 text-xs font-mono outline-none focus:border-ring"
                />
                <div className="mt-1 flex gap-1">
                  <button
                    onClick={() => handleSaveEdit(i, state.editedReplace ?? edit.replace)}
                    className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground hover:bg-primary/90"
                  >
                    确认
                  </button>
                  <button
                    onClick={() => setItemStates((prev) => { const n = [...prev]; n[i] = { ...n[i], status: "pending" }; return n })}
                    className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
                  >
                    取消
                  </button>
                </div>
              </div>
            )
          }
          // pending
          const expanded = expandedItems.has(i)
          return (
            <div key={i} className="rounded border bg-background p-2">
              <div className="flex items-center justify-between gap-2">
                <button onClick={() => toggleExpand(i)} className="flex items-center gap-1 min-w-0 text-xs font-medium text-muted-foreground hover:text-foreground text-left">
                  {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                  <span className="min-w-0 truncate">{edit.filePath}</span>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => void handleApplyOne(i)}
                    className="rounded bg-success px-2 py-0.5 text-xs text-white hover:bg-success shrink-0"
                  >
                    应用
                  </button>
                  <button
                    onClick={() => handleEditOne(i)}
                    className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent shrink-0"
                  >
                    <Pencil className="h-3 w-3 shrink-0" />
                  </button>
                  <button
                    onClick={() => handleDismissOne(i)}
                    className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:text-destructive hover:bg-accent shrink-0"
                  >
                    <X className="h-3 w-3 shrink-0" />
                  </button>
                </div>
              </div>
              {expanded && (
                <div className="mt-2">
                  <EditDiffView search={edit.search} replace={state.editedReplace ?? edit.replace} />
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-2 flex items-center gap-1 text-xs text-warning dark:text-warning">
        <AlertCircle className="h-3 w-3 shrink-0" />
        点击「应用」后文件将被直接更新
      </div>
    </div>
  )
}

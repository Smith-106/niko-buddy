// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT

// 写作区工具条子组件（UX 审计批次二·6/8）：从 writing-workspace.tsx 拆出，主文件只做编排。

import { useEffect, useState, type ReactNode } from "react"
import { ChevronDown, Sparkles } from "lucide-react"
import { listChapterDrafts } from "@/lib/novel"

/**
 * 读取项目内待采纳（未写入正式章）的草稿数。读失败返回 null（fail-open，不显示徽标）。
 * reloadKey 变化时重读（采纳后 / dataVersion 变化）。
 */
export function usePendingDraftCount(
  projectPath: string,
  reloadKey: unknown,
  listDrafts: typeof listChapterDrafts = listChapterDrafts,
): number | null {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    if (!projectPath) {
      setCount(null)
      return
    }
    let cancelled = false
    void listDrafts(projectPath).then(
      (rows) => {
        if (!cancelled) setCount(rows.filter((draft) => draft.status !== "saved").length)
      },
      () => {
        if (!cancelled) setCount(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [listDrafts, projectPath, reloadKey])
  return count
}

/** 工具条主操作：生成本章草稿（只跳主控并预填目标，不直接调模型）。 */
export function GenerateDraftButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="workspace-generate-draft"
      title="到主控预填目标，确认后由 AI 生成草稿；草稿采纳前不会改动正文"
      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
      onClick={onClick}
    >
      <Sparkles className="h-3 w-3" aria-hidden="true" />
      <span>生成本章草稿</span>
    </button>
  )
}

/** 「本章草稿」按钮 + 待采纳数徽标。 */
export function DraftsToggleButton({
  pressed,
  pendingCount,
  onClick,
}: {
  pressed: boolean
  pendingCount: number | null
  onClick: () => void
}) {
  const hasPending = pendingCount !== null && pendingCount > 0
  return (
    <button
      type="button"
      data-testid="workspace-desk-drafts"
      aria-pressed={pressed}
      className={
        hasPending
          ? "inline-flex items-center gap-1 rounded border border-warning/50 bg-warning/10 px-2 py-1 text-xs text-warning-foreground hover:bg-warning/20"
          : "rounded border px-2 py-1 text-xs hover:bg-accent/50"
      }
      onClick={onClick}
    >
      <span>本章草稿</span>
      {hasPending ? (
        <span data-testid="workspace-pending-draft-badge" className="font-medium">
          {`· ${pendingCount} 份待采纳`}
        </span>
      ) : null}
    </button>
  )
}

/**
 * 低频工具收纳（导出 PDF / 批量替换 / 导出书稿 / 长程战役调度）。
 * 用原生 details 实现：子按钮常驻 DOM，键盘可达，窄屏不再挤满一行。
 */
export function WorkspaceMoreTools({ active, children }: { active: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="relative"
      data-testid="workspace-more-tools"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        className={
          "inline-flex cursor-pointer list-none items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-accent/50 [&::-webkit-details-marker]:hidden"
          + (active ? " border-primary/50 text-foreground" : "")
        }
      >
        更多工具
        <ChevronDown className="h-3 w-3" aria-hidden="true" />
      </summary>
      <div className="absolute bottom-full left-0 z-30 mb-1 flex w-44 flex-col gap-1 rounded-md border bg-popover p-1 text-popover-foreground elevation-3 [&>button]:w-full [&>button]:justify-start [&>button]:text-left">
        {children}
      </div>
    </details>
  )
}

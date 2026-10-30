// Copyright (c) 2024 Niko-hub contributors. MIT License.
import { useRef, useState, useCallback } from "react"

export interface PendingSoulDialogState {
  open: boolean
  summary: string
}

export interface PendingChapterOverwriteState {
  open: boolean
  chapterNumber: number
}

export interface ChatConfirmDialogsState {
  pendingSoulDialog: PendingSoulDialogState
  closeSoulDialog: (confirmed: boolean) => void
  requestSoulDialog: (summary: string) => Promise<boolean>
  pendingChapterOverwrite: PendingChapterOverwriteState
  closeChapterOverwriteDialog: (confirmed: boolean) => void
  requestChapterOverwriteConfirm: (chapterNumber: number) => Promise<boolean>
}

/**
 * 确认对话框 resolver 对（chat-panel 拆分 T3）。
 *
 * 包含两对基于 Promise+ref 的对话框控制器：
 * 1. Soul 注入前置确认（requestSoulDialog / closeSoulDialog）
 * 2. 章节正文覆盖确认（requestChapterOverwriteConfirm / closeChapterOverwriteDialog）
 *    含并发保存请求防御：旧确认按取消（false）处理，避免 resolver 槽被覆盖后旧流程挂起。
 *
 * 内部状态与回调依赖（`[]`）逐字保留。
 */
export function useChatConfirmDialogs(): ChatConfirmDialogsState {
  const soulDialogResolverRef = useRef<((confirmed: boolean) => void) | null>(null)
  const [pendingSoulDialog, setPendingSoulDialog] = useState<PendingSoulDialogState>({ open: false, summary: "" })

  // C4 覆盖守卫（CORR-012 落地，方案 a）：保存目标章节已有正文时，覆盖前必须显式确认。
  const chapterOverwriteResolverRef = useRef<((confirmed: boolean) => void) | null>(null)
  const [pendingChapterOverwrite, setPendingChapterOverwrite] = useState<PendingChapterOverwriteState>({ open: false, chapterNumber: 0 })

  const closeSoulDialog = useCallback((confirmed: boolean) => {
    const resolver = soulDialogResolverRef.current
    soulDialogResolverRef.current = null
    setPendingSoulDialog({ open: false, summary: "" })
    resolver?.(confirmed)
  }, [])

  const requestSoulDialog = useCallback((summary: string) => {
    setPendingSoulDialog({ open: true, summary })
    return new Promise<boolean>((resolve) => {
      soulDialogResolverRef.current = resolve
    })
  }, [])

  const closeChapterOverwriteDialog = useCallback((confirmed: boolean) => {
    const resolver = chapterOverwriteResolverRef.current
    chapterOverwriteResolverRef.current = null
    setPendingChapterOverwrite({ open: false, chapterNumber: 0 })
    resolver?.(confirmed)
  }, [])

  const requestChapterOverwriteConfirm = useCallback((chapterNumber: number) => {
    // 并发保存请求防御：旧确认按取消处理，避免 resolver 槽被覆盖后旧流程挂起。
    chapterOverwriteResolverRef.current?.(false)
    setPendingChapterOverwrite({ open: true, chapterNumber })
    return new Promise<boolean>((resolve) => {
      chapterOverwriteResolverRef.current = resolve
    })
  }, [])

  return {
    pendingSoulDialog,
    closeSoulDialog,
    requestSoulDialog,
    pendingChapterOverwrite,
    closeChapterOverwriteDialog,
    requestChapterOverwriteConfirm,
  }
}

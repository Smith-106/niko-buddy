// Copyright (c) 2024 Niko-hub contributors. MIT License.
import { useState, useCallback } from "react"
import {
  markStyleExemplarViaRust,
  loadStyleExemplarsViaRust,
  type StyleExemplarMarkType,
} from "@/commands/exemplar"
import { appendExemplarABSample, exemplarABStats, loadCognitionState } from "@/lib/novel/character-cognition"
import { normalizePath, getFileName } from "@/lib/path-utils"

/**
 * Manages the Style Exemplar marking UI state and operations.
 *
 * Style exemplars are user-selected text passages marked as positive
 * writing-style anchors (C-001 Draft-first exception — user markings,
 * not AI-generated). They are persisted via Rust commands to
 * .novel/style-exemplars.json and injected through the context pack.
 *
 * Also manages A/B scoring (1-5 stars) for exemplar-enabled vs disabled
 * writing quality comparison, persisted to cognition-state.json.
 *
 * Extracted from chat-panel.tsx to isolate exemplar concern from the
 * main chat component.
 */
export function useExemplarState(params: {
  project: { path: string } | null
  selectedFile: string | null
}) {
  const { project, selectedFile } = params

  const [exemplarDialog, setExemplarDialog] = useState<{
    open: boolean
    text: string
    chapterId: string
  }>({ open: false, text: "", chapterId: "" })
  const [exemplarMarkType, setExemplarMarkType] = useState<StyleExemplarMarkType>("style")
  const [exemplarNote, setExemplarNote] = useState("")
  const [exemplarCount, setExemplarCount] = useState<number>(0)
  const [exemplarFeedback, setExemplarFeedback] = useState<string>("")

  // Open exemplar dialog from current text selection (window.getSelection).
  const openExemplarDialogFromSelection = useCallback(async () => {
    if (!project) return
    const selection = window.getSelection?.()
    const text = selection?.toString().trim() ?? ""
    if (!text) {
      setExemplarFeedback("请先在消息中选中一段文本")
      return
    }
    const pp = normalizePath(project.path)
    const chapterId = selectedFile ? getFileName(selectedFile) : "chat-selection"
    setExemplarDialog({ open: true, text, chapterId })
    setExemplarMarkType("style")
    setExemplarNote("")
    setExemplarFeedback("")
    try {
      const list = await loadStyleExemplarsViaRust(pp)
      setExemplarCount(list.length)
    } catch {
      // non-fatal — counting failure should not block marking
    }
  }, [project, selectedFile])

  // Submit exemplar mark → Rust command writes .novel/style-exemplars.json
  const submitExemplarMark = useCallback(async () => {
    if (!project) return
    const pp = normalizePath(project.path)
    try {
      await markStyleExemplarViaRust(pp, {
        chapterId: exemplarDialog.chapterId,
        text: exemplarDialog.text,
        markType: exemplarMarkType,
        note: exemplarNote.trim() || undefined,
      })
      const list = await loadStyleExemplarsViaRust(pp)
      setExemplarCount(list.length)
      setExemplarFeedback("已标记为用户锚点（非自动生成）")
      setExemplarDialog({ open: false, text: "", chapterId: "" })
    } catch (e) {
      setExemplarFeedback(`标记失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [project, exemplarDialog, exemplarMarkType, exemplarNote])

  // Submit A/B style quality score (1-5 stars) to cognition-state.json
  const submitExemplarABScore = useCallback(async (score: number, variant: "enabled" | "disabled") => {
    if (!project) return
    const pp = normalizePath(project.path)
    await appendExemplarABSample(pp, {
      variant,
      score,
      chapterId: selectedFile ? getFileName(selectedFile) : "chat",
      timestamp: new Date().toISOString(),
    })
    const state = await loadCognitionState(pp)
    const stats = exemplarABStats(state)
    const enabledStr = stats.enabledAvg !== null ? stats.enabledAvg.toFixed(2) : "N/A"
    const disabledStr = stats.disabledAvg !== null ? stats.disabledAvg.toFixed(2) : "N/A"
    setExemplarFeedback(`已记录评分 ${score}★（${variant}）— enabled 均分 ${enabledStr} vs disabled ${disabledStr}`)
  }, [project, selectedFile])

  return {
    exemplarDialog,
    setExemplarDialog,
    exemplarMarkType,
    setExemplarMarkType,
    exemplarNote,
    setExemplarNote,
    exemplarCount,
    exemplarFeedback,
    openExemplarDialogFromSelection,
    submitExemplarMark,
    submitExemplarABScore,
  }
}

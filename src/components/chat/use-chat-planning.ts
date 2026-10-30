// Copyright (c) 2024 Niko-hub contributors. MIT License.
import { useRef, useState, useCallback } from "react"
import { normalizePath } from "@/lib/path-utils"
import { toErrorMessage } from "@/lib/utils"
import type { WikiProject } from "@/types/wiki"

export interface ChatPlanningState {
  planningOpen: boolean
  setPlanningOpen: React.Dispatch<React.SetStateAction<boolean>>
  planningPlan: import("@/lib/novel/planning").ChapterPlanView | null
  setPlanningPlan: React.Dispatch<React.SetStateAction<import("@/lib/novel/planning").ChapterPlanView | null>>
  planningLoading: boolean
  planningError: string | null
  /** 计划面板目标章（未发送过深度章节请求 → undefined = 全书视图）。 */
  planningChapterRef: React.RefObject<number | undefined>
  loadPlanning: (chapterNumber?: number) => Promise<void>
  openPlanning: () => void
}

/**
 * 计划模式状态与加载逻辑（chat-panel 拆分 T2）。
 *
 * 面板开合 / 计划快照 / one-shot 附加 + 目标章 ref 从 ChatPanel 内迁出；
 * 状态语义与回调依赖（`[project]` / `[loadPlanning]`）逐字保留。
 */
export function useChatPlanning({ project }: { project: WikiProject | null }): ChatPlanningState {
  const [planningOpen, setPlanningOpen] = useState(false)
  const [planningPlan, setPlanningPlan] = useState<import("@/lib/novel/planning").ChapterPlanView | null>(null)
  const [planningLoading, setPlanningLoading] = useState(false)
  const [planningError, setPlanningError] = useState<string | null>(null)
  const planningChapterRef = useRef<number | undefined>(undefined)
  const loadPlanning = useCallback(async (chapterNumber?: number) => {
    if (!project) return
    setPlanningLoading(true)
    setPlanningError(null)
    try {
      const { buildChapterPlan } = await import("@/lib/novel/planning")
      const plan = await buildChapterPlan(normalizePath(project.path), chapterNumber ?? 0)
      setPlanningPlan(plan)
    } catch (error) {
      setPlanningError(toErrorMessage(error))
    } finally {
      setPlanningLoading(false)
    }
  }, [project])
  const openPlanning = useCallback(() => {
    setPlanningOpen(true)
    void loadPlanning(planningChapterRef.current)
  }, [loadPlanning])
  return {
    planningOpen,
    setPlanningOpen,
    planningPlan,
    setPlanningPlan,
    planningLoading,
    planningError,
    planningChapterRef,
    loadPlanning,
    openPlanning,
  }
}

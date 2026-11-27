// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * 主控深章运行态纯内存 Store（P0-04 / R2-U02）。
 *
 * 硬约束：
 * - 严禁使用 `persist` / `localStorage` / `sessionStorage` 或任何写盘操作——
 *   `.novel/status.json` 仍是 QMAI 运行时唯一真源；
 * - 同项目切页（如从主控切去写作台/审查中心再切回）期间保活正在运行的深章任务、
 *   实时阶段活动与产出结果，不再因视图卸载丢失；
 * - 切换项目（`syncProject` 收到不同路径）立即 abort 旧句柄并清零全部运行态，
 *   杜绝跨项目结果串台。
 */

import { create } from "zustand"
import type { AgentActivityEvent } from "@/lib/agent/types"
import type { DeepChapterGenerationResult } from "@/lib/novel"
import { normalizePath } from "@/lib/path-utils"

function normalizeProjectKey(projectPath: string): string {
  return projectPath ? normalizePath(projectPath).replace(/\/+$/, "") : ""
}

export type MainControlLaunchDialog = "campaign" | "incubator"

export interface MainControlRuntimeState {
  projectPath: string
  deepRunning: boolean
  deepOutput: DeepChapterGenerationResult | null
  deepChapterNumber: number | undefined
  deepStartAt: number | null
  deepError: string | null
  deepCancelledAt: number | null
  deepActivities: AgentActivityEvent[]
  deepAbortController: AbortController | null
  /** 当前深章产出已幂等落盘至 `.qm-drafts/` 的草稿 ID（纯内存，杜绝重复保存）。 */
  deepSavedDraftId: string | null
  /** 当前深章产出自动存草稿失败时的错误信息（供用户手动重试）。 */
  deepAutoSaveError: string | null
  /** 由外部入口（如 Ctrl+K 命令面板）请求在主控挂载后立即打开的自治弹窗（纯内存）。 */
  pendingLaunchDialog: MainControlLaunchDialog | null

  /** 同步当前项目路径；路径变更时立即中止旧任务并清零运行态。 */
  syncProject: (projectPath: string) => void
  /** 启动一次新的深章任务，绑定本次运行的 AbortController。 */
  beginDeepRun: (input: {
    projectPath: string
    chapterNumber?: number
    controller: AbortController
    startedAt?: number
  }) => void
  /** 追加阶段活动（仅当 controller 仍为当前活跃句柄时生效）。 */
  appendDeepActivity: (controller: AbortController, activity: AgentActivityEvent) => void
  /** 记录深章任务成功产出（仅当 controller 仍为当前活跃句柄时生效）。 */
  finishDeepRunSuccess: (controller: AbortController, output: DeepChapterGenerationResult) => void
  /** 记录深章产出已落入 `.qm-drafts/`（按 output 引用核验，防过期异步回调串台）。 */
  markDeepDraftSaved: (output: DeepChapterGenerationResult, draftId: string) => void
  /** 记录深章自动存草稿失败（按 output 引用核验，仅当尚未保存成功时生效）。 */
  markDeepAutoSaveError: (output: DeepChapterGenerationResult, errorMessage: string) => void
  /** 记录深章任务取消（仅当 controller 仍为当前活跃句柄时生效）。 */
  finishDeepRunCancelled: (controller: AbortController, cancelledAt?: number) => void
  /** 记录深章任务异常（仅当 controller 仍为当前活跃句柄时生效）。 */
  finishDeepRunError: (controller: AbortController, errorMessage: string) => void
  /** 主动中止当前深章任务。 */
  abortDeepRun: (cancelledAt?: number) => void
  /** 清理已展示的深章产出与错误提示。 */
  clearDeepOutput: () => void
  /** 请求在主控视图打开指定自治弹窗（纯内存，不落盘）。 */
  requestLaunchDialog: (dialog: MainControlLaunchDialog) => void
  /** 消费并清零待打开的自治弹窗请求。 */
  consumePendingLaunchDialog: () => MainControlLaunchDialog | null
  /** 重置整个内存 store（供项目关闭或单测隔离使用）。 */
  reset: () => void
}

const INITIAL_DEEP_STATE = {
  deepRunning: false,
  deepOutput: null as DeepChapterGenerationResult | null,
  deepChapterNumber: undefined as number | undefined,
  deepStartAt: null as number | null,
  deepError: null as string | null,
  deepCancelledAt: null as number | null,
  deepActivities: [] as AgentActivityEvent[],
  deepAbortController: null as AbortController | null,
  deepSavedDraftId: null as string | null,
  deepAutoSaveError: null as string | null,
  pendingLaunchDialog: null as MainControlLaunchDialog | null,
}

export const useMainControlRuntimeStore = create<MainControlRuntimeState>((set, get) => ({
  projectPath: "",
  ...INITIAL_DEEP_STATE,

  syncProject: (nextProjectPath) => {
    const normalized = normalizeProjectKey(nextProjectPath)
    const current = get()
    if (normalized === current.projectPath) return
    const isColdStartBind = current.projectPath === "" && normalized !== ""
    current.deepAbortController?.abort()
    set({
      projectPath: normalized,
      ...INITIAL_DEEP_STATE,
      pendingLaunchDialog: isColdStartBind ? current.pendingLaunchDialog : null,
    })
  },

  beginDeepRun: ({ projectPath, chapterNumber, controller, startedAt }) => {
    const normalized = normalizeProjectKey(projectPath)
    const prev = get().deepAbortController
    if (prev && prev !== controller) {
      prev.abort()
    }
    set({
      projectPath: normalized,
      deepRunning: true,
      deepOutput: null,
      deepChapterNumber: chapterNumber,
      deepStartAt: startedAt ?? Date.now(),
      deepError: null,
      deepCancelledAt: null,
      deepActivities: [],
      deepAbortController: controller,
      deepSavedDraftId: null,
      deepAutoSaveError: null,
    })
  },

  appendDeepActivity: (controller, activity) => {
    set((state) => {
      if (state.deepAbortController !== controller) return state
      return {
        deepActivities: [...state.deepActivities, activity],
      }
    })
  },

  finishDeepRunSuccess: (controller, output) => {
    set((state) => {
      if (state.deepAbortController !== controller) return state
      return {
        deepRunning: false,
        deepOutput: output,
        deepAbortController: null,
        deepSavedDraftId: null,
        deepAutoSaveError: null,
      }
    })
  },

  markDeepDraftSaved: (output, draftId) => {
    set((state) => {
      if (state.deepOutput !== output) return state
      return {
        deepSavedDraftId: draftId,
        deepAutoSaveError: null,
      }
    })
  },

  markDeepAutoSaveError: (output, errorMessage) => {
    set((state) => {
      if (state.deepOutput !== output || state.deepSavedDraftId !== null) return state
      return {
        deepAutoSaveError: errorMessage,
      }
    })
  },

  finishDeepRunCancelled: (controller, cancelledAt) => {
    set((state) => {
      if (state.deepAbortController !== controller) return state
      return {
        deepRunning: false,
        deepCancelledAt: cancelledAt ?? Date.now(),
        deepAbortController: null,
      }
    })
  },

  finishDeepRunError: (controller, errorMessage) => {
    set((state) => {
      if (state.deepAbortController !== controller) return state
      return {
        deepRunning: false,
        deepError: errorMessage,
        deepAbortController: null,
      }
    })
  },

  abortDeepRun: (cancelledAt) => {
    const current = get()
    current.deepAbortController?.abort()
    set({
      deepRunning: false,
      deepCancelledAt: cancelledAt ?? Date.now(),
      deepAbortController: null,
    })
  },

  clearDeepOutput: () => {
    set({
      deepOutput: null,
      deepError: null,
      deepCancelledAt: null,
      deepSavedDraftId: null,
      deepAutoSaveError: null,
    })
  },

  requestLaunchDialog: (dialog) => {
    set({ pendingLaunchDialog: dialog })
  },

  consumePendingLaunchDialog: () => {
    const pending = get().pendingLaunchDialog
    if (pending === null) return null
    set({ pendingLaunchDialog: null })
    return pending
  },

  reset: () => {
    get().deepAbortController?.abort()
    set({
      projectPath: "",
      ...INITIAL_DEEP_STATE,
    })
  },
}))

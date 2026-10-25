import { useReviewStore } from "@/stores/review-store"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { saveReviewItems, saveChatHistory } from "./persist"
import { isTauri } from "@/lib/platform"

let reviewTimer: ReturnType<typeof setTimeout> | null = null
let chatTimer: ReturnType<typeof setTimeout> | null = null

/**
 * ISS-20260709-033: 项目路径解析注入点。默认回退直读 UI store
 * （向后兼容，行为等价）；测试/调用方可注入确定性解析器。
 */
export interface AutoSaveDeps {
  getProjectPath?: () => string | undefined
}

function defaultGetProjectPath(): string | undefined {
  return useWikiStore.getState().project?.path
}

export function setupAutoSave(deps?: AutoSaveDeps): void {
  const getProjectPath = deps?.getProjectPath ?? defaultGetProjectPath
  useReviewStore.subscribe((state) => {
    const projectPath = getProjectPath()
    if (reviewTimer) clearTimeout(reviewTimer)
    reviewTimer = setTimeout(() => {
      if (projectPath && isTauri()) {
        saveReviewItems(projectPath, state.items).catch((err) => console.error("自动保存失败:", err))
      }
    }, 1000)
  })

  useChatStore.subscribe((state) => {
    if (Object.keys(state.streamingContents).length > 0) return
    const projectPath = getProjectPath()
    if (chatTimer) clearTimeout(chatTimer)
    chatTimer = setTimeout(() => {
      if (projectPath && isTauri()) {
        saveChatHistory(projectPath, state.conversations, state.messages, useChatStore.getState().maxHistoryMessages).catch((err) => console.error("自动保存失败:", err))
      }
    }, 2000)
  })
}

import { useReviewStore } from "@/stores/review-store"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { saveReviewItems, saveChatHistory } from "./persist"
import { isTauri } from "@/lib/platform"

let reviewTimer: ReturnType<typeof setTimeout> | null = null
let chatTimer: ReturnType<typeof setTimeout> | null = null
let pagehideRegistered = false

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

/**
 * R2 崩溃不断稿：关闭/崩溃兜底立即落盘。
 * 读取最新 store 快照（review.items + chat 全量），门控与订阅一致：
 * 项目路径非空、Tauri 环境；chat 在 streaming 非空时跳过。
 */
export async function flushAutoSave(deps?: AutoSaveDeps): Promise<void> {
  const getProjectPath = deps?.getProjectPath ?? defaultGetProjectPath
  const projectPath = getProjectPath()
  if (!projectPath || !isTauri()) return
  try {
    await saveReviewItems(projectPath, useReviewStore.getState().items)
  } catch (err) {
    console.error("自动保存失败:", err)
  }
  const chatState = useChatStore.getState()
  if (Object.keys(chatState.streamingContents).length > 0) return
  try {
    await saveChatHistory(
      projectPath,
      chatState.conversations,
      chatState.messages,
      chatState.maxHistoryMessages,
    )
  } catch (err) {
    console.error("自动保存失败:", err)
  }
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

  if (
    typeof window !== "undefined" &&
    typeof window.addEventListener === "function" &&
    !pagehideRegistered
  ) {
    pagehideRegistered = true
    window.addEventListener("pagehide", () => {
      void flushAutoSave(deps)
    })
  }
}

import i18n from "@/i18n"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { isTauri } from "@/lib/platform"
import { useChatStore } from "@/stores/chat-store"
import { listDirectory, openProject, createDirectory } from "@/commands/fs"
import { normalizePath, joinPath } from "@/lib/path-utils"
import { setMetricsFilePath, flushMetrics } from "@/lib/llm-client"
import { getLastProject, saveLastProject, loadLlmConfig, loadAiChatModel, loadDefaultLlmModel, loadLanguage, loadEmbeddingConfig, loadProviderConfigs, loadActivePresetId, loadProxyConfig, loadScheduledImportConfig, loadSourceWatchConfig, loadNovelMode, loadNovelConfig, loadRevisionFeedbackWindowConfig, loadTheme, loadMaxHistoryMessages, saveLlmConfig, saveProviderConfigs, saveActivePresetId, migratePlaintextApiKeys } from "@/lib/project-store"
import { loadReviewItems, loadChatHistory } from "@/lib/persist"
import { loadTaskSummaries, attachTaskPersistence } from "@/lib/novel/book-analysis/task-persistence"
import { useBookAnalysisStore } from "@/stores/book-analysis-store"
import { checkForAppUpdate } from "@/lib/app-updater"
import { initAnalytics } from "@/lib/analytics"
import { restoreQueue as restoreIngestQueue } from "@/lib/ingest-queue"
import { hydrateChatHistoryWithInterruptedDeepChapter } from "@/components/chat/chat-resume"
import { resetProjectState } from "@/lib/reset-project-state"
import { LLM_PRESETS } from "@/components/settings/llm-presets"
import { resolveConfig } from "@/components/settings/preset-resolver"
import { loadEnvLlmDefault } from "@/lib/env-llm-defaults"
import { loadNovelSessionStatus } from "@/lib/novel/novel-session-status"
import { applyAntiAiTelemetryConsentOnProjectOpen } from "@/lib/novel/anti-ai-telemetry-wiring"
import { shutdownAntiAiTelemetrySink } from "@/lib/novel/anti-ai-telemetry-sink"
import { applyTheme } from "@/lib/theme-utils"
import type { WikiProject } from "@/types/wiki"

/**
 * 应用启动编排（组合根）。
 * 抽取自 App.tsx 的 init useEffect：加载全部持久化配置并把结果写入各 store，
 * 最后静默检查应用更新并初始化分析。App.tsx 仅负责调用与 loading 状态切换。
 */

/** Holds the unsubscribe handle for the current project's task persistence subscription. */
let detachTaskPersistence: (() => void) | null = null

/**
 * Per-day date stamp (YYYY-MM-DD, UTC) for the LLM metrics JSONL filename so
 * the sink rotates daily with zero extra logic (mirrors the metric `ts` stamp,
 * which is also UTC, so the validation query reads `llm-metrics-<today>.jsonl`).
 */
function llmMetricsDateStamp(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
}

export async function initializeApp(): Promise<void> {
  performance.mark("app-init-start") // bench: startup latency anchor
  try {
    // 先加载和应用主题
    const savedTheme = await loadTheme()
    const themeToUse = savedTheme ?? "system"
    useWikiStore.getState().setTheme(themeToUse)
    applyTheme(themeToUse)

    const envLlmDefault = loadEnvLlmDefault()
    const savedConfig = await loadLlmConfig()
    if (savedConfig) {
      useWikiStore.getState().setLlmConfig(savedConfig)
    } else if (envLlmDefault) {
      useWikiStore.getState().setLlmConfig(envLlmDefault.config)
      await saveLlmConfig(envLlmDefault.config)
    }
    const savedAiChatModel = await loadAiChatModel()
    if (savedAiChatModel) {
      useWikiStore.getState().setAiChatModel(savedAiChatModel)
    }
    const savedDefaultLlmModel = await loadDefaultLlmModel()
    if (savedDefaultLlmModel) {
      useWikiStore.getState().setDefaultLlmModel(savedDefaultLlmModel)
    }
    const savedProviderConfigs = await loadProviderConfigs()
    if (savedProviderConfigs) {
      useWikiStore.getState().setProviderConfigs(savedProviderConfigs)
    } else if (envLlmDefault) {
      useWikiStore.getState().setProviderConfigs(envLlmDefault.providerConfigs)
      await saveProviderConfigs(envLlmDefault.providerConfigs)
    }
    const savedActivePreset = await loadActivePresetId()
    if (savedActivePreset) {
      useWikiStore.getState().setActivePresetId(savedActivePreset)
      // Re-resolve the active preset's LlmConfig from (preset defaults
      // + saved overrides). Without this, preset default updates
      // (e.g. a corrected Anthropic model ID shipped in a release)
      // never reach users who are relying on defaults — their stored
      // `llmConfig` snapshot from a previous launch would keep the
      // old value. Overrides still win, so an explicit user choice
      // is preserved.
      const preset = LLM_PRESETS.find((p) => p.id === savedActivePreset)
      if (preset) {
        const currentFallback = useWikiStore.getState().llmConfig
        const override = (savedProviderConfigs ?? {})[savedActivePreset]
        const resolved = resolveConfig(preset, override, currentFallback)
        useWikiStore.getState().setLlmConfig(resolved)
        await saveLlmConfig(resolved)
      }
    } else if (envLlmDefault) {
      useWikiStore.getState().setActivePresetId(envLlmDefault.activePresetId)
      await saveActivePresetId(envLlmDefault.activePresetId)
    }
    const savedEmbeddingConfig = await loadEmbeddingConfig()
    if (savedEmbeddingConfig) {
      useWikiStore.getState().setEmbeddingConfig(savedEmbeddingConfig)
    }
    const savedProxy = await loadProxyConfig()
    if (savedProxy) {
      useWikiStore.getState().setProxyConfig(savedProxy)
    }
    const savedLang = await loadLanguage()
    if (savedLang) {
      await i18n.changeLanguage(savedLang)
    }
    const savedNovelMode = await loadNovelMode()
    if (savedNovelMode !== null) {
      useWikiStore.getState().setNovelMode(savedNovelMode)
    }
    const savedMaxHistoryMessages = await loadMaxHistoryMessages()
    if (savedMaxHistoryMessages !== null) {
      useChatStore.getState().setMaxHistoryMessages(savedMaxHistoryMessages)
    }
    const savedRevisionFeedbackWindowConfig = await loadRevisionFeedbackWindowConfig()
    useWikiStore.getState().setRevisionFeedbackWindowConfig(savedRevisionFeedbackWindowConfig)
    const lastProject = await getLastProject()
    if (lastProject) {
      try {
        const proj = await openProject(lastProject.path)
        await hydrateProjectOnOpen(proj)
      } catch (err) {
        console.error("打开上次项目失败:", err)
      }
    }
    // #34 退出 flush：webview 关闭/刷新时 flush 遥测缓冲 + 90 天清理（非致命）。
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => {
        void shutdownAntiAiTelemetrySink()
        void flushMetrics()
      })
    }
    // One-time plaintext→encrypted apiKey migration (re-saves any plaintext values encrypted).
    await migratePlaintextApiKeys()
  } catch (err) {
    console.error("应用初始化失败:", err)
  } finally {
    performance.mark("app-init-end") // bench: startup latency anchor
    void checkForAppUpdate({ mode: "silent" })
    void initAnalytics()
  }
}

/**
 * 项目打开后的项目级加载（组合根）。
 * 抽取自 App.tsx 的 handleProjectOpened：重置项目状态、写入项目相关 store、
 * 恢复队列/定时导入/文件同步、加载文件树/审查项/聊天历史（含中断深度章节恢复）。
 */
export async function hydrateProjectOnOpen(proj: WikiProject): Promise<void> {
  await resetProjectState()

  useWikiStore.getState().setProject(proj)
  // #34 反 AI 影子遥测：按 F-34 显式同意（默认关）在项目打开处接线；
  // 切换项目前会先 flush 上一项目残留缓冲（applyAntiAiTelemetryConsentOnProjectOpen 内部）。
  await applyAntiAiTelemetryConsentOnProjectOpen(proj.path)
  // R1 — wire the LLM metrics sink: ensure `<project>/.novel/metrics` exists and
  // point the in-memory metric buffer at a per-day JSONL file so every streamChat
  // `durationMs` record is persisted to disk. Previously `metricsFilePath` stayed
  // empty in production, so `flushMetrics` early-returned and nothing was written.
  const metricsDir = normalizePath(joinPath(proj.path, ".novel", "metrics"))
  try {
    await createDirectory(metricsDir)
  } catch (err) {
    console.error("创建 LLM 指标目录失败:", err)
  }
  setMetricsFilePath(
    normalizePath(joinPath(metricsDir, `llm-metrics-${llmMetricsDateStamp()}.jsonl`)),
  )
  useWikiStore.getState().clearTransientTaskState()
  // 默认开启小说模式
  useWikiStore.getState().setNovelMode(true)
  const projectNovelConfig = await loadNovelConfig(proj.id, proj.path)
  if (projectNovelConfig) {
    useWikiStore.getState().setNovelConfig(projectNovelConfig)
  }
  const projectRevisionFeedbackWindowConfig = await loadRevisionFeedbackWindowConfig(proj.id, proj.path)
  useWikiStore.getState().setRevisionFeedbackWindowConfig(projectRevisionFeedbackWindowConfig)
  useWikiStore.getState().setSelectedFile(null)
  useWikiStore.getState().setActiveView("wiki")
  useWikiStore.getState().bumpDataVersion()
  await saveLastProject(proj)

  if (isTauri()) {
    try {
      await restoreIngestQueue(proj.id, proj.path)
    } catch (err) {
      console.error("恢复摄取队列失败:", err)
    }
    import("@/lib/dedup-queue").then(({ restoreQueue }) => {
      restoreQueue(proj.id, proj.path).catch((err) =>
        console.error("恢复去重队列失败:", err)
      )
    })
  }

  try {
    const savedScheduledImport = await loadScheduledImportConfig(proj.path)
    if (savedScheduledImport) {
      let path = savedScheduledImport.path
      if (path && !path.startsWith("/") && !path.match(/^[a-zA-Z]:[/\\]/)) {
        path = `${proj.path}/${path}`
      }
      useWikiStore.getState().setScheduledImportConfig({
        ...savedScheduledImport,
        path,
      })
    } else {
      useWikiStore.getState().setScheduledImportConfig({
        enabled: false,
        path: `${proj.path}/raw/sources`,
        interval: 60,
        lastScan: null,
      })
    }
  } catch (err) {
    console.error("加载定时导入配置失败:", err)
  }

  if (isTauri()) {
    const scheduledImportConfig = useWikiStore.getState().scheduledImportConfig
    if (scheduledImportConfig.enabled && scheduledImportConfig.path && scheduledImportConfig.interval > 0) {
      import("@/lib/scheduled-import").then(({ startScheduledImport }) => {
        startScheduledImport(proj, scheduledImportConfig)
      }).catch((err) =>
        console.error("启动定时导入失败:", err)
      )
    }

    import("@/lib/project-file-sync").then(async ({ startProjectFileSync, stopProjectFileSync }) => {
      const config = await loadSourceWatchConfig(proj.id, proj.path)
      useWikiStore.getState().setSourceWatchConfig(config)
      if (config.enabled) {
        startProjectFileSync(proj, config).catch((err) =>
          console.error("启动项目文件同步失败:", err)
        )
      } else {
        stopProjectFileSync().catch(() => {})
      }
    }).catch((err) => console.error("配置项目文件同步失败:", err))
  }

  try {
    const tree = await listDirectory(proj.path)
    useWikiStore.getState().setFileTree(tree)
  } catch (err) {
    console.error("加载文件树失败:", err)
  }
  try {
    const savedReview = await loadReviewItems(proj.path)
    if (savedReview.length > 0) {
      useReviewStore.getState().setItems(savedReview)
    }
  } catch (err) {
    console.error("加载审查项失败:", err)
  }
  try {
    const savedChat = await loadChatHistory(proj.path)
    const interruptedStatus = await loadNovelSessionStatus(proj.path).catch(() => null)
    const hydratedChat = hydrateChatHistoryWithInterruptedDeepChapter(savedChat, interruptedStatus)
    if (hydratedChat.conversations.length > 0) {
      useChatStore.getState().setConversations(hydratedChat.conversations)
      useChatStore.getState().setMessages(hydratedChat.messages)
      const sorted = [...hydratedChat.conversations].sort((a, b) => b.updatedAt - a.updatedAt)
      const preferredConversationId = hydratedChat.focusConversationId ?? sorted[0]?.id
      if (preferredConversationId) {
        useChatStore.getState().setActiveConversation(preferredConversationId)
      }
      if (hydratedChat.focusConversationId) {
        useWikiStore.getState().setChatExpanded(true)
      }
    }
  } catch (err) {
    console.error("加载聊天历史失败:", err)
  }
  try {
    const persistedTasks = await loadTaskSummaries(proj.path)
    if (persistedTasks.length > 0) {
      // Restart recovery: running/paused tasks could not survive the process restart.
      const restored = persistedTasks.map((t) =>
        t.status === "running" || t.status === "paused"
          ? { ...t, status: "error" as const, error: "应用重启，任务已中断" }
          : t,
      )
      useBookAnalysisStore.getState().hydrateTasks(restored)
    }
    detachTaskPersistence?.()
    detachTaskPersistence = attachTaskPersistence(proj.path)
  } catch (err) {
    console.error("加载拆书任务失败:", err)
  }
}

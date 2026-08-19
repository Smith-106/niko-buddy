import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig, ScheduledImportConfig } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"

/**
 * Coverage for the application composition root (startup orchestration).
 * Every dependency is mocked; the store accessors return the shared hoisted
 * state objects so tests can both pre-seed state and assert mutations.
 */

const mocks = vi.hoisted(() => {
  const wikiState: Record<string, unknown> = {
    llmConfig: null,
    scheduledImportConfig: null,
    setTheme: vi.fn(),
    setLlmConfig: vi.fn(),
    setAiChatModel: vi.fn(),
    setDefaultLlmModel: vi.fn(),
    setProviderConfigs: vi.fn(),
    setActivePresetId: vi.fn(),
    setEmbeddingConfig: vi.fn(),
    setProxyConfig: vi.fn(),
    setNovelMode: vi.fn(),
    setRevisionFeedbackWindowConfig: vi.fn(),
    setProject: vi.fn(),
    clearTransientTaskState: vi.fn(),
    setNovelConfig: vi.fn(),
    setSelectedFile: vi.fn(),
    setActiveView: vi.fn(),
    bumpDataVersion: vi.fn(),
    setScheduledImportConfig: vi.fn(),
    setFileTree: vi.fn(),
    setChatExpanded: vi.fn(),
    setSourceWatchConfig: vi.fn(),
  }
  const chatState = {
    setMaxHistoryMessages: vi.fn(),
    setConversations: vi.fn(),
    setMessages: vi.fn(),
    setActiveConversation: vi.fn(),
  }
  const reviewState = {
    setItems: vi.fn(),
  }
  const bookAnalysisState = {
    hydrateTasks: vi.fn(),
  }
  return {
    wikiState,
    chatState,
    reviewState,
    bookAnalysisState,
    changeLanguage: vi.fn(),
    isTauri: vi.fn(),
    listDirectory: vi.fn(),
    openProject: vi.fn(),
    loadTheme: vi.fn(),
    loadLlmConfig: vi.fn(),
    loadAiChatModel: vi.fn(),
    loadDefaultLlmModel: vi.fn(),
    loadProviderConfigs: vi.fn(),
    loadActivePresetId: vi.fn(),
    loadEmbeddingConfig: vi.fn(),
    loadProxyConfig: vi.fn(),
    loadLanguage: vi.fn(),
    loadNovelMode: vi.fn(),
    loadMaxHistoryMessages: vi.fn(),
    loadRevisionFeedbackWindowConfig: vi.fn(),
    getLastProject: vi.fn(),
    saveLastProject: vi.fn(),
    loadNovelConfig: vi.fn(),
    loadScheduledImportConfig: vi.fn(),
    loadSourceWatchConfig: vi.fn(),
    saveLlmConfig: vi.fn(),
    saveProviderConfigs: vi.fn(),
    saveActivePresetId: vi.fn(),
    loadReviewItems: vi.fn(),
    loadChatHistory: vi.fn(),
    checkForAppUpdate: vi.fn(),
    initAnalytics: vi.fn(),
    restoreIngestQueue: vi.fn(),
    hydrateChat: vi.fn(),
    resetProjectState: vi.fn(),
    LLM_PRESETS: [{ id: "claude-code" }] as Array<{ id: string }>,
    resolveConfig: vi.fn(),
    loadEnvLlmDefault: vi.fn(),
    loadNovelSessionStatus: vi.fn(),
    applyTheme: vi.fn(),
    restoreDedupQueue: vi.fn(),
    startScheduledImport: vi.fn(),
    startProjectFileSync: vi.fn(),
    stopProjectFileSync: vi.fn(),
    loadTaskSummaries: vi.fn(),
    attachTaskPersistence: vi.fn(),
  }
})

vi.mock("@/i18n", () => ({ default: { changeLanguage: mocks.changeLanguage } }))
vi.mock("@/stores/wiki-store", () => ({ useWikiStore: { getState: () => mocks.wikiState } }))
vi.mock("@/stores/review-store", () => ({ useReviewStore: { getState: () => mocks.reviewState } }))
vi.mock("@/stores/chat-store", () => ({ useChatStore: { getState: () => mocks.chatState } }))
vi.mock("@/lib/platform", () => ({ isTauri: mocks.isTauri }))
vi.mock("@/commands/fs", () => ({
  listDirectory: mocks.listDirectory,
  openProject: mocks.openProject,
}))
vi.mock("@/lib/project-store", () => ({
  getLastProject: mocks.getLastProject,
  saveLastProject: mocks.saveLastProject,
  loadLlmConfig: mocks.loadLlmConfig,
  loadAiChatModel: mocks.loadAiChatModel,
  loadDefaultLlmModel: mocks.loadDefaultLlmModel,
  loadLanguage: mocks.loadLanguage,
  loadEmbeddingConfig: mocks.loadEmbeddingConfig,
  loadProviderConfigs: mocks.loadProviderConfigs,
  loadActivePresetId: mocks.loadActivePresetId,
  loadProxyConfig: mocks.loadProxyConfig,
  loadScheduledImportConfig: mocks.loadScheduledImportConfig,
  loadSourceWatchConfig: mocks.loadSourceWatchConfig,
  loadNovelMode: mocks.loadNovelMode,
  loadNovelConfig: mocks.loadNovelConfig,
  loadRevisionFeedbackWindowConfig: mocks.loadRevisionFeedbackWindowConfig,
  loadTheme: mocks.loadTheme,
  loadMaxHistoryMessages: mocks.loadMaxHistoryMessages,
  saveLlmConfig: mocks.saveLlmConfig,
  saveProviderConfigs: mocks.saveProviderConfigs,
  saveActivePresetId: mocks.saveActivePresetId,
}))
vi.mock("@/lib/persist", () => ({
  loadReviewItems: mocks.loadReviewItems,
  loadChatHistory: mocks.loadChatHistory,
}))
vi.mock("@/lib/app-updater", () => ({ checkForAppUpdate: mocks.checkForAppUpdate }))
vi.mock("@/lib/analytics", () => ({ initAnalytics: mocks.initAnalytics }))
vi.mock("@/lib/ingest-queue", () => ({ restoreQueue: mocks.restoreIngestQueue }))
vi.mock("@/components/chat/chat-resume", () => ({
  hydrateChatHistoryWithInterruptedDeepChapter: mocks.hydrateChat,
}))
vi.mock("@/lib/reset-project-state", () => ({ resetProjectState: mocks.resetProjectState }))
vi.mock("@/components/settings/llm-presets", () => ({ LLM_PRESETS: mocks.LLM_PRESETS }))
vi.mock("@/components/settings/preset-resolver", () => ({
  resolveConfig: mocks.resolveConfig,
  hasAnthropicApiKey: () => false,
}))
vi.mock("@/lib/env-llm-defaults", () => ({ loadEnvLlmDefault: mocks.loadEnvLlmDefault }))
vi.mock("@/lib/novel/novel-session-status", () => ({ loadNovelSessionStatus: mocks.loadNovelSessionStatus }))
vi.mock("@/lib/theme-utils", () => ({ applyTheme: mocks.applyTheme }))
vi.mock("@/lib/dedup-queue", () => ({ restoreQueue: mocks.restoreDedupQueue }))
vi.mock("@/lib/scheduled-import", () => ({ startScheduledImport: mocks.startScheduledImport }))
vi.mock("@/lib/project-file-sync", () => ({
  startProjectFileSync: mocks.startProjectFileSync,
  stopProjectFileSync: mocks.stopProjectFileSync,
}))
vi.mock("@/lib/novel/book-analysis/task-persistence", () => ({
  loadTaskSummaries: mocks.loadTaskSummaries,
  attachTaskPersistence: mocks.attachTaskPersistence,
}))
vi.mock("@/stores/book-analysis-store", () => ({
  useBookAnalysisStore: { getState: () => mocks.bookAnalysisState },
}))

import { hydrateProjectOnOpen, initializeApp } from "./composition-root"

function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "anthropic",
    apiKey: "sk-test",
    model: "claude-opus-4-1",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
    apiMode: "chat_completions",
    reasoning: { mode: "off" },
    ...overrides,
  }
}

const proj: WikiProject = {
  id: "proj-1",
  name: "Test Project",
  path: "C:/projects/test",
} as WikiProject

const flushDynamicImports = async () => {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.wikiState.llmConfig = null
  mocks.wikiState.scheduledImportConfig = null
  mocks.isTauri.mockReturnValue(false)
  mocks.loadTaskSummaries.mockResolvedValue([])
  mocks.attachTaskPersistence.mockReturnValue(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("initializeApp", () => {
  it("loads all persisted configuration into the stores", async () => {
    const savedConfig = llmConfig({ model: "claude-sonnet-4-5" })
    const savedProviders = { anthropic: { apiKey: "sk-1" }, "claude-code": { apiKey: "sk-2" } }
    const resolved = llmConfig({ model: "claude-opus-4-1" })
    const rfw = { windowSize: 3, enabled: true }
    mocks.loadTheme.mockResolvedValue("dark")
    mocks.loadLlmConfig.mockResolvedValue(savedConfig)
    mocks.wikiState.llmConfig = savedConfig
    mocks.loadAiChatModel.mockResolvedValue("claude-sonnet-4-5")
    mocks.loadDefaultLlmModel.mockResolvedValue("claude-opus-4-1")
    mocks.loadProviderConfigs.mockResolvedValue(savedProviders)
    mocks.loadActivePresetId.mockResolvedValue("claude-code")
    mocks.resolveConfig.mockReturnValue(resolved)
    mocks.loadEmbeddingConfig.mockResolvedValue({ enabled: true, endpoint: "http://x", apiKey: "", model: "m" })
    mocks.loadProxyConfig.mockResolvedValue({ enabled: true, url: "http://proxy" })
    mocks.loadLanguage.mockResolvedValue("zh-CN")
    mocks.loadNovelMode.mockResolvedValue(false)
    mocks.loadMaxHistoryMessages.mockResolvedValue(20)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(rfw)
    mocks.getLastProject.mockResolvedValue(null)
    mocks.saveLlmConfig.mockResolvedValue(undefined)
    mocks.saveProviderConfigs.mockResolvedValue(undefined)
    mocks.saveActivePresetId.mockResolvedValue(undefined)
    mocks.checkForAppUpdate.mockResolvedValue(undefined)
    mocks.initAnalytics.mockResolvedValue(undefined)

    await initializeApp()

    expect(mocks.wikiState.setTheme).toHaveBeenCalledWith("dark")
    expect(mocks.applyTheme).toHaveBeenCalledWith("dark")
    expect(mocks.wikiState.setLlmConfig).toHaveBeenCalledWith(savedConfig)
    expect(mocks.wikiState.setAiChatModel).toHaveBeenCalledWith("claude-sonnet-4-5")
    expect(mocks.wikiState.setDefaultLlmModel).toHaveBeenCalledWith("claude-opus-4-1")
    expect(mocks.wikiState.setProviderConfigs).toHaveBeenCalledWith(savedProviders)
    expect(mocks.wikiState.setActivePresetId).toHaveBeenCalledWith("claude-code")
    // The preset is re-resolved against saved overrides and persisted.
    expect(mocks.resolveConfig).toHaveBeenCalledWith(
      { id: "claude-code" },
      savedProviders["claude-code"],
      savedConfig,
    )
    expect(mocks.wikiState.setLlmConfig).toHaveBeenCalledWith(resolved)
    expect(mocks.saveLlmConfig).toHaveBeenCalledWith(resolved)
    expect(mocks.wikiState.setEmbeddingConfig).toHaveBeenCalledWith(expect.objectContaining({ model: "m" }))
    expect(mocks.wikiState.setProxyConfig).toHaveBeenCalledWith(expect.objectContaining({ url: "http://proxy" }))
    expect(mocks.changeLanguage).toHaveBeenCalledWith("zh-CN")
    expect(mocks.wikiState.setNovelMode).toHaveBeenCalledWith(false)
    expect(mocks.chatState.setMaxHistoryMessages).toHaveBeenCalledWith(20)
    expect(mocks.wikiState.setRevisionFeedbackWindowConfig).toHaveBeenCalledWith(rfw)
    expect(mocks.getLastProject).toHaveBeenCalledTimes(1)
    expect(mocks.checkForAppUpdate).toHaveBeenCalledWith({ mode: "silent" })
    expect(mocks.initAnalytics).toHaveBeenCalledTimes(1)
  })

  it("falls back to env LLM defaults when nothing is stored", async () => {
    const envConfig = llmConfig({ model: "env-model" })
    const envProviders = { anthropic: { apiKey: "env-key" } }
    mocks.loadTheme.mockResolvedValue(null)
    mocks.loadLlmConfig.mockResolvedValue(null)
    mocks.loadEnvLlmDefault.mockReturnValue({
      config: envConfig,
      providerConfigs: envProviders,
      activePresetId: "claude-code",
    })
    mocks.loadProviderConfigs.mockResolvedValue(null)
    mocks.loadActivePresetId.mockResolvedValue(null)
    mocks.getLastProject.mockResolvedValue(null)
    mocks.checkForAppUpdate.mockResolvedValue(undefined)
    mocks.initAnalytics.mockResolvedValue(undefined)

    await initializeApp()

    expect(mocks.wikiState.setTheme).toHaveBeenCalledWith("system")
    expect(mocks.applyTheme).toHaveBeenCalledWith("system")
    expect(mocks.wikiState.setLlmConfig).toHaveBeenCalledWith(envConfig)
    expect(mocks.saveLlmConfig).toHaveBeenCalledWith(envConfig)
    expect(mocks.wikiState.setProviderConfigs).toHaveBeenCalledWith(envProviders)
    expect(mocks.saveProviderConfigs).toHaveBeenCalledWith(envProviders)
    expect(mocks.wikiState.setActivePresetId).toHaveBeenCalledWith("claude-code")
    expect(mocks.saveActivePresetId).toHaveBeenCalledWith("claude-code")
    // No stored preset → no re-resolution.
    expect(mocks.resolveConfig).not.toHaveBeenCalled()
  })

  it("leaves optional configuration unset when nothing is stored", async () => {
    mocks.loadTheme.mockResolvedValue(null)
    mocks.loadLlmConfig.mockResolvedValue(null)
    mocks.loadEnvLlmDefault.mockReturnValue(null)
    mocks.loadProviderConfigs.mockResolvedValue(null)
    mocks.loadActivePresetId.mockResolvedValue(null)
    mocks.getLastProject.mockResolvedValue(null)
    mocks.checkForAppUpdate.mockResolvedValue(undefined)
    mocks.initAnalytics.mockResolvedValue(undefined)

    await initializeApp()

    expect(mocks.wikiState.setAiChatModel).not.toHaveBeenCalled()
    expect(mocks.wikiState.setDefaultLlmModel).not.toHaveBeenCalled()
    expect(mocks.wikiState.setEmbeddingConfig).not.toHaveBeenCalled()
    expect(mocks.wikiState.setProxyConfig).not.toHaveBeenCalled()
    expect(mocks.changeLanguage).not.toHaveBeenCalled()
  })

  it("re-resolves the preset with an undefined override when provider configs are absent", async () => {
    const resolved = llmConfig({ model: "claude-opus-4-1" })
    mocks.loadTheme.mockResolvedValue(null)
    mocks.loadLlmConfig.mockResolvedValue(null)
    mocks.loadEnvLlmDefault.mockReturnValue(null)
    mocks.loadProviderConfigs.mockResolvedValue(null)
    mocks.loadActivePresetId.mockResolvedValue("claude-code")
    mocks.resolveConfig.mockReturnValue(resolved)
    mocks.getLastProject.mockResolvedValue(null)
    mocks.checkForAppUpdate.mockResolvedValue(undefined)
    mocks.initAnalytics.mockResolvedValue(undefined)

    await initializeApp()

    expect(mocks.resolveConfig).toHaveBeenCalledWith({ id: "claude-code" }, undefined, null)
    expect(mocks.wikiState.setLlmConfig).toHaveBeenCalledWith(resolved)
    expect(mocks.saveLlmConfig).toHaveBeenCalledWith(resolved)
  })

  it("skips preset re-resolution when the saved preset id is unknown", async () => {
    mocks.loadTheme.mockResolvedValue("light")
    mocks.loadLlmConfig.mockResolvedValue(null)
    mocks.loadEnvLlmDefault.mockReturnValue(null)
    mocks.loadProviderConfigs.mockResolvedValue(null)
    mocks.loadActivePresetId.mockResolvedValue("no-such-preset")
    mocks.getLastProject.mockResolvedValue(null)
    mocks.checkForAppUpdate.mockResolvedValue(undefined)
    mocks.initAnalytics.mockResolvedValue(undefined)

    await initializeApp()

    expect(mocks.wikiState.setActivePresetId).toHaveBeenCalledWith("no-such-preset")
    expect(mocks.resolveConfig).not.toHaveBeenCalled()
  })

  it("leaves novel mode and history limits untouched when no values are stored", async () => {
    mocks.loadTheme.mockResolvedValue("system")
    mocks.loadLlmConfig.mockResolvedValue(null)
    mocks.loadEnvLlmDefault.mockReturnValue(null)
    mocks.loadProviderConfigs.mockResolvedValue(null)
    mocks.loadActivePresetId.mockResolvedValue(null)
    mocks.loadNovelMode.mockResolvedValue(null)
    mocks.loadMaxHistoryMessages.mockResolvedValue(null)
    mocks.getLastProject.mockResolvedValue(null)
    mocks.checkForAppUpdate.mockResolvedValue(undefined)
    mocks.initAnalytics.mockResolvedValue(undefined)

    await initializeApp()

    expect(mocks.wikiState.setNovelMode).not.toHaveBeenCalled()
    expect(mocks.chatState.setMaxHistoryMessages).not.toHaveBeenCalled()
  })

  it("opens and hydrates the last project", async () => {
    mocks.loadTheme.mockResolvedValue(null)
    mocks.loadLlmConfig.mockResolvedValue(null)
    mocks.loadEnvLlmDefault.mockReturnValue(null)
    mocks.loadProviderConfigs.mockResolvedValue(null)
    mocks.loadActivePresetId.mockResolvedValue(null)
    mocks.getLastProject.mockResolvedValue({ path: "C:/projects/test" })
    mocks.openProject.mockResolvedValue(proj)
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(null)
    mocks.loadScheduledImportConfig.mockResolvedValue(null)
    mocks.listDirectory.mockResolvedValue([])
    mocks.loadReviewItems.mockResolvedValue([])
    mocks.loadChatHistory.mockResolvedValue({ conversations: [], messages: [] })
    mocks.loadNovelSessionStatus.mockResolvedValue(null)
    mocks.hydrateChat.mockReturnValue({ conversations: [], messages: [], focusConversationId: null })
    mocks.checkForAppUpdate.mockResolvedValue(undefined)
    mocks.initAnalytics.mockResolvedValue(undefined)

    await initializeApp()

    expect(mocks.openProject).toHaveBeenCalledWith("C:/projects/test")
    expect(mocks.wikiState.setProject).toHaveBeenCalledWith(proj)
    expect(mocks.wikiState.bumpDataVersion).toHaveBeenCalledTimes(1)
  })

  it("catches last-project open failures without blocking startup checks", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.loadTheme.mockResolvedValue(null)
    mocks.loadLlmConfig.mockResolvedValue(null)
    mocks.loadEnvLlmDefault.mockReturnValue(null)
    mocks.loadProviderConfigs.mockResolvedValue(null)
    mocks.loadActivePresetId.mockResolvedValue(null)
    mocks.getLastProject.mockResolvedValue({ path: "/broken" })
    mocks.openProject.mockRejectedValue(new Error("permission denied"))
    mocks.checkForAppUpdate.mockResolvedValue(undefined)
    mocks.initAnalytics.mockResolvedValue(undefined)

    await expect(initializeApp()).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith("打开上次项目失败:", expect.any(Error))
    expect(mocks.checkForAppUpdate).toHaveBeenCalledWith({ mode: "silent" })
    expect(mocks.initAnalytics).toHaveBeenCalledTimes(1)
  })

  it("swallows initialization errors and still runs the silent checks", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.loadTheme.mockRejectedValue(new Error("store broken"))
    mocks.checkForAppUpdate.mockResolvedValue(undefined)
    mocks.initAnalytics.mockResolvedValue(undefined)

    await expect(initializeApp()).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith("应用初始化失败:", expect.any(Error))
    expect(mocks.checkForAppUpdate).toHaveBeenCalledWith({ mode: "silent" })
    expect(mocks.initAnalytics).toHaveBeenCalledTimes(1)
  })
})

describe("hydrateProjectOnOpen", () => {
  it("resets state, loads project config and restores all Tauri queues", async () => {
    const novelConfig = { sceneBreakdownEnabled: true }
    const rfw = { windowSize: 5, enabled: false }
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.isTauri.mockReturnValue(true)
    mocks.loadNovelConfig.mockResolvedValue(novelConfig)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(rfw)
    mocks.saveLastProject.mockResolvedValue(undefined)
    mocks.restoreIngestQueue.mockResolvedValue(undefined)
    mocks.restoreDedupQueue.mockResolvedValue(undefined)
    mocks.loadScheduledImportConfig.mockResolvedValue({ enabled: true, path: "raw/imports", interval: 30, lastScan: null })
    mocks.wikiState.scheduledImportConfig = { enabled: true, path: "C:/projects/test/raw/imports", interval: 30, lastScan: null }
    mocks.startScheduledImport.mockResolvedValue(undefined)
    mocks.loadSourceWatchConfig.mockResolvedValue({ enabled: true, extensions: [".md"] })
    mocks.startProjectFileSync.mockResolvedValue(undefined)
    mocks.listDirectory.mockResolvedValue(["a.md", "b.md"])
    mocks.loadReviewItems.mockResolvedValue([{ id: "r1" }])
    const conversations = [
      { id: "c1", updatedAt: 100 },
      { id: "c2", updatedAt: 200 },
    ]
    mocks.loadChatHistory.mockResolvedValue({ conversations, messages: [{ id: "m1" }] })
    mocks.loadNovelSessionStatus.mockResolvedValue(null)
    mocks.hydrateChat.mockReturnValue({
      conversations,
      messages: [{ id: "m1" }],
      focusConversationId: "c2",
    })

    await hydrateProjectOnOpen(proj)
    await flushDynamicImports()

    expect(mocks.resetProjectState).toHaveBeenCalledTimes(1)
    expect(mocks.wikiState.setProject).toHaveBeenCalledWith(proj)
    expect(mocks.wikiState.clearTransientTaskState).toHaveBeenCalledTimes(1)
    expect(mocks.wikiState.setNovelMode).toHaveBeenCalledWith(true)
    expect(mocks.wikiState.setNovelConfig).toHaveBeenCalledWith(novelConfig)
    expect(mocks.wikiState.setRevisionFeedbackWindowConfig).toHaveBeenCalledWith(rfw)
    expect(mocks.wikiState.setSelectedFile).toHaveBeenCalledWith(null)
    expect(mocks.wikiState.setActiveView).toHaveBeenCalledWith("wiki")
    expect(mocks.wikiState.bumpDataVersion).toHaveBeenCalledTimes(1)
    expect(mocks.saveLastProject).toHaveBeenCalledWith(proj)
    expect(mocks.restoreIngestQueue).toHaveBeenCalledWith(proj.id, proj.path)
    expect(mocks.restoreDedupQueue).toHaveBeenCalledWith(proj.id, proj.path)
    // Relative scheduled-import path is prefixed with the project path.
    expect(mocks.wikiState.setScheduledImportConfig).toHaveBeenCalledWith({
      enabled: true,
      path: "C:/projects/test/raw/imports",
      interval: 30,
      lastScan: null,
    })
    expect(mocks.startScheduledImport).toHaveBeenCalledWith(proj, mocks.wikiState.scheduledImportConfig)
    expect(mocks.wikiState.setSourceWatchConfig).toHaveBeenCalledWith({ enabled: true, extensions: [".md"] })
    expect(mocks.startProjectFileSync).toHaveBeenCalledWith(proj, { enabled: true, extensions: [".md"] })
    expect(mocks.wikiState.setFileTree).toHaveBeenCalledWith(["a.md", "b.md"])
    expect(mocks.reviewState.setItems).toHaveBeenCalledWith([{ id: "r1" }])
    expect(mocks.chatState.setConversations).toHaveBeenCalledWith(conversations)
    expect(mocks.chatState.setMessages).toHaveBeenCalledWith([{ id: "m1" }])
    expect(mocks.chatState.setActiveConversation).toHaveBeenCalledWith("c2")
    expect(mocks.wikiState.setChatExpanded).toHaveBeenCalledWith(true)
  })

  it("keeps absolute and Windows drive scheduled-import paths unchanged", async () => {
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(null)
    mocks.saveLastProject.mockResolvedValue(undefined)
    mocks.listDirectory.mockResolvedValue([])
    mocks.loadReviewItems.mockResolvedValue([])
    mocks.loadChatHistory.mockResolvedValue({ conversations: [], messages: [] })
    mocks.loadNovelSessionStatus.mockResolvedValue(null)
    mocks.hydrateChat.mockReturnValue({ conversations: [], messages: [], focusConversationId: null })

    mocks.loadScheduledImportConfig
      .mockResolvedValueOnce({ enabled: true, path: "/absolute/path", interval: 10, lastScan: null })
      .mockResolvedValueOnce({ enabled: true, path: "D:\\data\\in", interval: 10, lastScan: null })

    await hydrateProjectOnOpen(proj)
    expect(mocks.wikiState.setScheduledImportConfig).toHaveBeenNthCalledWith(1, {
      enabled: true,
      path: "/absolute/path",
      interval: 10,
      lastScan: null,
    })

    await hydrateProjectOnOpen(proj)
    expect(mocks.wikiState.setScheduledImportConfig).toHaveBeenNthCalledWith(2, {
      enabled: true,
      path: "D:\\data\\in",
      interval: 10,
      lastScan: null,
    })
  })

  it("installs a disabled default scheduled-import config when nothing is saved", async () => {
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(null)
    mocks.saveLastProject.mockResolvedValue(undefined)
    mocks.loadScheduledImportConfig.mockResolvedValue(null)
    mocks.listDirectory.mockResolvedValue([])
    mocks.loadReviewItems.mockResolvedValue([])
    mocks.loadChatHistory.mockResolvedValue({ conversations: [], messages: [] })
    mocks.loadNovelSessionStatus.mockResolvedValue(null)
    mocks.hydrateChat.mockReturnValue({ conversations: [], messages: [], focusConversationId: null })

    await hydrateProjectOnOpen(proj)

    expect(mocks.wikiState.setScheduledImportConfig).toHaveBeenCalledWith({
      enabled: false,
      path: "C:/projects/test/raw/sources",
      interval: 60,
      lastScan: null,
    })
  })

  it("skips Tauri-only queue and file-sync work outside the Tauri runtime", async () => {
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.isTauri.mockReturnValue(false)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(null)
    mocks.saveLastProject.mockResolvedValue(undefined)
    mocks.loadScheduledImportConfig.mockResolvedValue(null)
    mocks.listDirectory.mockResolvedValue([])
    mocks.loadReviewItems.mockResolvedValue([])
    mocks.loadChatHistory.mockResolvedValue({ conversations: [], messages: [] })
    mocks.loadNovelSessionStatus.mockResolvedValue(null)
    mocks.hydrateChat.mockReturnValue({ conversations: [], messages: [], focusConversationId: null })

    await hydrateProjectOnOpen(proj)
    await flushDynamicImports()

    expect(mocks.restoreIngestQueue).not.toHaveBeenCalled()
    expect(mocks.restoreDedupQueue).not.toHaveBeenCalled()
    expect(mocks.startScheduledImport).not.toHaveBeenCalled()
    expect(mocks.startProjectFileSync).not.toHaveBeenCalled()
    expect(mocks.stopProjectFileSync).not.toHaveBeenCalled()
  })

  it("logs queue restore failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.isTauri.mockReturnValue(true)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(null)
    mocks.saveLastProject.mockResolvedValue(undefined)
    mocks.restoreIngestQueue.mockRejectedValue(new Error("ingest queue corrupt"))
    mocks.restoreDedupQueue.mockRejectedValue(new Error("dedup queue corrupt"))
    mocks.loadScheduledImportConfig.mockResolvedValue(null)
    // Mirrors the disabled default that the mock store would receive from setScheduledImportConfig.
    mocks.wikiState.scheduledImportConfig = { enabled: false, path: "C:/projects/test/raw/sources", interval: 60, lastScan: null }
    mocks.listDirectory.mockResolvedValue([])
    mocks.loadReviewItems.mockResolvedValue([])
    mocks.loadChatHistory.mockResolvedValue({ conversations: [], messages: [] })
    mocks.loadNovelSessionStatus.mockResolvedValue(null)
    mocks.hydrateChat.mockReturnValue({ conversations: [], messages: [], focusConversationId: null })

    await hydrateProjectOnOpen(proj)
    await flushDynamicImports()

    expect(errorSpy).toHaveBeenCalledWith("恢复摄取队列失败:", expect.any(Error))
    expect(errorSpy).toHaveBeenCalledWith("恢复去重队列失败:", expect.any(Error))
  })

  it("logs scheduled-import start failures and stops the watcher when file sync is disabled", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.isTauri.mockReturnValue(true)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(null)
    mocks.saveLastProject.mockResolvedValue(undefined)
    mocks.restoreIngestQueue.mockResolvedValue(undefined)
    mocks.restoreDedupQueue.mockResolvedValue(undefined)
    const scheduledImportConfig: ScheduledImportConfig = {
      enabled: true,
      path: "C:/projects/test/raw/imports",
      interval: 60,
      lastScan: null,
    }
    mocks.loadScheduledImportConfig.mockResolvedValue(scheduledImportConfig)
    mocks.wikiState.scheduledImportConfig = scheduledImportConfig
    mocks.startScheduledImport.mockImplementation(() => {
      throw new Error("start failed")
    })
    mocks.loadSourceWatchConfig.mockResolvedValue({ enabled: false })
    mocks.stopProjectFileSync.mockRejectedValue(new Error("stop failed"))
    mocks.listDirectory.mockResolvedValue([])
    mocks.loadReviewItems.mockResolvedValue([])
    mocks.loadChatHistory.mockResolvedValue({ conversations: [], messages: [] })
    mocks.loadNovelSessionStatus.mockResolvedValue(null)
    mocks.hydrateChat.mockReturnValue({ conversations: [], messages: [], focusConversationId: null })

    await hydrateProjectOnOpen(proj)
    await flushDynamicImports()

    expect(errorSpy).toHaveBeenCalledWith("启动定时导入失败:", expect.any(Error))
    expect(mocks.stopProjectFileSync).toHaveBeenCalledTimes(1)
  })

  it("logs scheduled-import config load failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(null)
    mocks.saveLastProject.mockResolvedValue(undefined)
    mocks.loadScheduledImportConfig.mockRejectedValue(new Error("config store broken"))
    mocks.listDirectory.mockResolvedValue([])
    mocks.loadReviewItems.mockResolvedValue([])
    mocks.loadChatHistory.mockResolvedValue({ conversations: [], messages: [] })
    mocks.loadNovelSessionStatus.mockResolvedValue(null)
    mocks.hydrateChat.mockReturnValue({ conversations: [], messages: [], focusConversationId: null })

    await expect(hydrateProjectOnOpen(proj)).resolves.toBeUndefined()

    expect(errorSpy).toHaveBeenCalledWith("加载定时导入配置失败:", expect.any(Error))
    // The catch only logs — no default config is installed on load failure.
    expect(mocks.wikiState.setScheduledImportConfig).not.toHaveBeenCalled()
  })

  it("logs project file-sync configuration failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.isTauri.mockReturnValue(true)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(null)
    mocks.saveLastProject.mockResolvedValue(undefined)
    mocks.restoreIngestQueue.mockResolvedValue(undefined)
    mocks.restoreDedupQueue.mockResolvedValue(undefined)
    mocks.loadScheduledImportConfig.mockResolvedValue(null)
    mocks.wikiState.scheduledImportConfig = { enabled: false, path: "C:/projects/test/raw/sources", interval: 60, lastScan: null }
    mocks.loadSourceWatchConfig.mockRejectedValue(new Error("watch config broken"))
    mocks.listDirectory.mockResolvedValue([])
    mocks.loadReviewItems.mockResolvedValue([])
    mocks.loadChatHistory.mockResolvedValue({ conversations: [], messages: [] })
    mocks.loadNovelSessionStatus.mockResolvedValue(null)
    mocks.hydrateChat.mockReturnValue({ conversations: [], messages: [], focusConversationId: null })

    await hydrateProjectOnOpen(proj)
    await flushDynamicImports()

    expect(errorSpy).toHaveBeenCalledWith("配置项目文件同步失败:", expect.any(Error))
  })

  it("logs project file-sync start failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.isTauri.mockReturnValue(true)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(null)
    mocks.saveLastProject.mockResolvedValue(undefined)
    mocks.restoreIngestQueue.mockResolvedValue(undefined)
    mocks.restoreDedupQueue.mockResolvedValue(undefined)
    mocks.loadScheduledImportConfig.mockResolvedValue(null)
    mocks.wikiState.scheduledImportConfig = { enabled: false, path: "C:/projects/test/raw/sources", interval: 60, lastScan: null }
    mocks.loadSourceWatchConfig.mockResolvedValue({ enabled: true })
    mocks.startProjectFileSync.mockRejectedValue(new Error("sync start failed"))
    mocks.listDirectory.mockResolvedValue([])
    mocks.loadReviewItems.mockResolvedValue([])
    mocks.loadChatHistory.mockResolvedValue({ conversations: [], messages: [] })
    mocks.loadNovelSessionStatus.mockResolvedValue(null)
    mocks.hydrateChat.mockReturnValue({ conversations: [], messages: [], focusConversationId: null })

    await hydrateProjectOnOpen(proj)
    await flushDynamicImports()

    expect(errorSpy).toHaveBeenCalledWith("启动项目文件同步失败:", expect.any(Error))
  })

  it("logs file-tree, review and chat load failures without aborting", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(null)
    mocks.saveLastProject.mockResolvedValue(undefined)
    mocks.loadScheduledImportConfig.mockResolvedValue(null)
    mocks.listDirectory.mockRejectedValue(new Error("fs broken"))
    mocks.loadReviewItems.mockRejectedValue(new Error("review broken"))
    mocks.loadChatHistory.mockRejectedValue(new Error("chat broken"))
    mocks.loadNovelSessionStatus.mockResolvedValue(null)

    await expect(hydrateProjectOnOpen(proj)).resolves.toBeUndefined()

    expect(errorSpy).toHaveBeenCalledWith("加载文件树失败:", expect.any(Error))
    expect(errorSpy).toHaveBeenCalledWith("加载审查项失败:", expect.any(Error))
    expect(errorSpy).toHaveBeenCalledWith("加载聊天历史失败:", expect.any(Error))
  })

  it("activates the most recently updated conversation when there is no focus", async () => {
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(null)
    mocks.saveLastProject.mockResolvedValue(undefined)
    mocks.loadScheduledImportConfig.mockResolvedValue(null)
    mocks.listDirectory.mockResolvedValue([])
    mocks.loadReviewItems.mockResolvedValue([])
    const conversations = [
      { id: "old", updatedAt: 100 },
      { id: "new", updatedAt: 900 },
    ]
    mocks.loadChatHistory.mockResolvedValue({ conversations, messages: [] })
    mocks.loadNovelSessionStatus.mockResolvedValue(null)
    mocks.hydrateChat.mockReturnValue({ conversations, messages: [], focusConversationId: null })

    await hydrateProjectOnOpen(proj)

    expect(mocks.chatState.setActiveConversation).toHaveBeenCalledWith("new")
    expect(mocks.wikiState.setChatExpanded).not.toHaveBeenCalled()
  })

  it("skips activation when the preferred conversation id is empty", async () => {
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(null)
    mocks.saveLastProject.mockResolvedValue(undefined)
    mocks.loadScheduledImportConfig.mockResolvedValue(null)
    mocks.listDirectory.mockResolvedValue([])
    mocks.loadReviewItems.mockResolvedValue([])
    const conversations = [{ id: "", updatedAt: 5 }]
    mocks.loadChatHistory.mockResolvedValue({ conversations, messages: [] })
    mocks.loadNovelSessionStatus.mockResolvedValue(null)
    mocks.hydrateChat.mockReturnValue({ conversations, messages: [], focusConversationId: null })

    await hydrateProjectOnOpen(proj)

    expect(mocks.chatState.setConversations).toHaveBeenCalledWith(conversations)
    expect(mocks.chatState.setActiveConversation).not.toHaveBeenCalled()
  })

  it("tolerates a rejecting novel session status lookup", async () => {
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(null)
    mocks.saveLastProject.mockResolvedValue(undefined)
    mocks.loadScheduledImportConfig.mockResolvedValue(null)
    mocks.listDirectory.mockResolvedValue([])
    mocks.loadReviewItems.mockResolvedValue([])
    mocks.loadChatHistory.mockResolvedValue({ conversations: [], messages: [] })
    mocks.loadNovelSessionStatus.mockRejectedValue(new Error("status broken"))
    mocks.hydrateChat.mockReturnValue({ conversations: [], messages: [], focusConversationId: null })

    await expect(hydrateProjectOnOpen(proj)).resolves.toBeUndefined()
    expect(mocks.hydrateChat).toHaveBeenCalledWith({ conversations: [], messages: [] }, null)
  })

  it("does not restore chat when the hydrated conversation list is empty", async () => {
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(null)
    mocks.saveLastProject.mockResolvedValue(undefined)
    mocks.loadScheduledImportConfig.mockResolvedValue(null)
    mocks.listDirectory.mockResolvedValue([])
    mocks.loadReviewItems.mockResolvedValue([])
    mocks.loadChatHistory.mockResolvedValue({ conversations: [], messages: [] })
    mocks.loadNovelSessionStatus.mockResolvedValue(null)
    mocks.hydrateChat.mockReturnValue({ conversations: [], messages: [], focusConversationId: null })

    await hydrateProjectOnOpen(proj)

    expect(mocks.chatState.setConversations).not.toHaveBeenCalled()
    expect(mocks.chatState.setActiveConversation).not.toHaveBeenCalled()
  })

  it("does not restore review items when none are loaded", async () => {
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(null)
    mocks.saveLastProject.mockResolvedValue(undefined)
    mocks.loadScheduledImportConfig.mockResolvedValue(null)
    mocks.listDirectory.mockResolvedValue([])
    mocks.loadReviewItems.mockResolvedValue([])
    mocks.loadChatHistory.mockResolvedValue({ conversations: [], messages: [] })
    mocks.loadNovelSessionStatus.mockResolvedValue(null)
    mocks.hydrateChat.mockReturnValue({ conversations: [], messages: [], focusConversationId: null })

    await hydrateProjectOnOpen(proj)

    expect(mocks.reviewState.setItems).not.toHaveBeenCalled()
  })

  it("propagates a resetProjectState failure to the caller", async () => {
    mocks.resetProjectState.mockRejectedValue(new Error("reset exploded"))

    await expect(hydrateProjectOnOpen(proj)).rejects.toThrow("reset exploded")
  })

  it("restart recovery: running/paused tasks are marked error and rehydrated", async () => {
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(null)
    mocks.saveLastProject.mockResolvedValue(undefined)
    mocks.loadScheduledImportConfig.mockResolvedValue(null)
    mocks.listDirectory.mockResolvedValue([])
    mocks.loadReviewItems.mockResolvedValue([])
    mocks.loadChatHistory.mockResolvedValue({ conversations: [], messages: [] })
    mocks.loadNovelSessionStatus.mockResolvedValue(null)
    mocks.hydrateChat.mockReturnValue({ conversations: [], messages: [], focusConversationId: null })
    mocks.loadTaskSummaries.mockResolvedValue([
      { id: "t1", status: "running" },
      { id: "t2", status: "paused" },
      { id: "t3", status: "done" },
    ] as never)

    await hydrateProjectOnOpen(proj)

    expect(mocks.bookAnalysisState.hydrateTasks).toHaveBeenCalledWith([
      { id: "t1", status: "error", error: "应用重启，任务已中断" },
      { id: "t2", status: "error", error: "应用重启，任务已中断" },
      { id: "t3", status: "done" },
    ])
    expect(mocks.attachTaskPersistence).toHaveBeenCalledWith(proj.path)
  })

  it("logs task summary load failures without aborting", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.resetProjectState.mockResolvedValue(undefined)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRevisionFeedbackWindowConfig.mockResolvedValue(null)
    mocks.saveLastProject.mockResolvedValue(undefined)
    mocks.loadScheduledImportConfig.mockResolvedValue(null)
    mocks.listDirectory.mockResolvedValue([])
    mocks.loadReviewItems.mockResolvedValue([])
    mocks.loadChatHistory.mockResolvedValue({ conversations: [], messages: [] })
    mocks.loadNovelSessionStatus.mockResolvedValue(null)
    mocks.hydrateChat.mockReturnValue({ conversations: [], messages: [], focusConversationId: null })
    mocks.loadTaskSummaries.mockRejectedValue(new Error("tasks broken"))

    await expect(hydrateProjectOnOpen(proj)).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith("加载拆书任务失败:", expect.any(Error))
  })
})

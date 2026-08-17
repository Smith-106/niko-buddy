/**
 * wiki-store 单元测试
 * 覆盖：state 初始值、所有 setter action、localStorage persistence、config merge、task finishers
 */
import { describe, expect, it, beforeEach, vi } from "vitest"

// Mock localStorage at file load time so init functions work correctly
const _localStorageMock: Record<string, string> = {}
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: vi.fn((key) => (_localStorageMock[key] ?? null) as string),
    setItem: vi.fn((key, val) => {
      _localStorageMock[key] = val
    }),
    removeItem: vi.fn((key) => {
      delete _localStorageMock[key]
    }),
    clear: vi.fn(() => {
      Object.keys(_localStorageMock).forEach((k) => delete _localStorageMock[k])
    }),
    key: vi.fn((i) => Object.keys(_localStorageMock)[i]),
    get length() {
      return Object.keys(_localStorageMock).length
    },
  },
  writable: true,
  configurable: true,
})

import { useWikiStore } from "../wiki-store"
import type { SourceWatchConfig } from "../wiki-store"
import { DEFAULT_RERANK_CONFIG, DEFAULT_NOVEL_CONFIG } from "../wiki-store"
import { DEFAULT_SOURCE_WATCH_CONFIG } from "@/lib/source-watch-config"

// Re-export helper functions for readStored* tests
function readStoredGraphLabelDisplayMode() {
  const saved = (globalThis.localStorage as any).getItem("lk-graph-label-display-mode")
  return saved === "auto" || saved === "focused" || saved === "all" ? saved : "all"
}
function readStoredGraphEdgeStyle() {
  const saved = (globalThis.localStorage as any).getItem("lk-graph-edge-style")
  return saved === "curve" || saved === "arrow" || saved === "line" ? saved : "curve"
}
function readStoredGraphEdgeColorHex() {
  const saved = (globalThis.localStorage as any).getItem("lk-graph-edge-color")
  return saved && /^#[0-9a-fA-F]{6}$/.test(saved) ? saved : "#7f8ea3"
}
function readStoredGraphEdgeStrengthPercent() {
  const saved = Number((globalThis.localStorage as any).getItem("lk-graph-edge-strength") ?? "180")
  return Number.isFinite(saved) ? Math.max(100, Math.min(260, saved)) : 180
}
function readStoredGraphEdgeLabelsAlways() {
  return (globalThis.localStorage as any).getItem("lk-graph-edge-labels-always") === "true"
}
function readStoredUiFontSizeScale() {
  const saved = Number((globalThis.localStorage as any).getItem("qmai-ui-font-size-scale") ?? "1")
  return Number.isFinite(saved) ? Math.max(0.85, Math.min(1.3, Number(saved.toFixed(2)))) : 1
}

function resetStore(): void {
  useWikiStore.setState({
    project: null,
    fileTree: [],
    selectedFile: null,
    selectedTrashItem: null,
    fileContent: "",
    pendingEditorHighlight: null,
    pendingScrollImageSrc: null,
    selectedMemoryCenterEntry: null,
    chatExpanded: false,
    chatDockPosition: "bottom",
    searchPanelOpen: false,
    activeView: "wiki",
    activeSettingsCategory: null,
    selectedSoulId: null,
    selectedSoulTab: "project",
    selectedSoulSection: "builtIn",
    selectedReviewDimension: null,
    selectedReviewFilePath: "",
    selectedDismantlingProjectId: null,
    graphMode: "overview",
    graphDisplayMode: "graph",
    graphColorMode: "type",
    graphLabelDisplayMode: readStoredGraphLabelDisplayMode(),
    graphShowFilters: false,
    graphShowEdgeControls: false,
    graphEdgeStyle: readStoredGraphEdgeStyle(),
    graphEdgeColorHex: readStoredGraphEdgeColorHex(),
    graphEdgeStrengthPercent: readStoredGraphEdgeStrengthPercent(),
    graphEdgeLabelsAlwaysVisible: readStoredGraphEdgeLabelsAlways(),
    graphStats: { nodeCount: 0, edgeCount: 0, hiddenCount: 0, filteredNodeCount: 0, filteredEdgeCount: 0 },
    refreshGraph: null,
    llmConfig: {
      provider: "openai",
      apiKey: "",
      maxContextSize: 204800,
      model: "",
      ollamaUrl: "http://localhost:11434",
      customEndpoint: "",
      azureApiVersion: "2024-10-21",
      azureModelFamily: "auto",
      reasoning: { mode: "auto" },
      localCliIsolation: false,
    },
    aiChatModel: "",
    defaultLlmModel: "",
    providerConfigs: {},
    activePresetId: null,
    dataVersion: 0,
    searchApiConfig: {
      provider: "none",
      apiKey: "",
      serpApiEngine: "google",
      searXngUrl: "",
      searXngCategories: ["general"],
      providerConfigs: {},
    },
    embeddingConfig: {
      enabled: false,
      endpoint: "",
      apiKey: "",
      model: "",
    },
    rerankConfig: { ...DEFAULT_RERANK_CONFIG },
    multimodalConfig: {
      enabled: false,
      useMainLlm: true,
      provider: "custom",
      apiKey: "",
      model: "",
      ollamaUrl: "http://localhost:11434",
      customEndpoint: "",
      azureApiVersion: "2024-10-21",
      azureModelFamily: "auto",
      apiMode: "chat_completions",
      concurrency: 4,
    },
    outputLanguage: "Chinese",
    proxyConfig: {
      enabled: false,
      url: "",
      bypassLocal: true,
    },
    scheduledImportConfig: {
      enabled: false,
      path: "",
      interval: 60,
      lastScan: null,
    },
    sourceWatchConfig: DEFAULT_SOURCE_WATCH_CONFIG as unknown as SourceWatchConfig,
    novelMode: true,
    chatEditModeEnabled: false,
    novelConfig: { ...DEFAULT_NOVEL_CONFIG },
    communitySummaryError: null,
    searchHistory: [],
    searchTrigger: null,
    revisionFeedbackWindowConfig: {
      currentChapterIncludeShouldImprove: true,
      previousChapterCarryEnabled: true,
      lookbackChapterCount: 2,
      lookbackIncludeMustFixOnly: true,
    },
    finalChapterSave: null,
    lintRun: null,
    reviewRun: null,
    theme: "system",
    uiFontSizeScale: readStoredUiFontSizeScale(),
  })
}

beforeEach(() => {
  resetStore()
  Object.keys(_localStorageMock).forEach((k) => delete _localStorageMock[k])
})

describe("wiki-store 基本初始化", () => {
  it("核心 state 字段具有正确的默认值", () => {
    const s = useWikiStore.getState()
    expect(s.project).toBeNull()
    expect(s.fileTree).toEqual([])
    expect(s.selectedFile).toBeNull()
    expect(s.fileContent).toBe("")
    expect(s.activeView).toBe("wiki")
    expect(s.chatExpanded).toBe(false)
    expect(s.searchPanelOpen).toBe(false)
    expect(s.theme).toBe("system")
  })

  it("LLM config 默认值为 openai + auto reasoning", () => {
    const s = useWikiStore.getState()
    expect(s.llmConfig.provider).toBe("openai")
    expect(s.llmConfig.apiKey).toBe("")
    expect(s.llmConfig.maxContextSize).toBe(204800)
    expect(s.llmConfig.model).toBe("")
    expect(s.llmConfig.reasoning?.mode).toBe("auto")
    expect(s.llmConfig.localCliIsolation).toBe(false)
  })
})

// ─── Project/File UI ─────────────────────────────────────────────────────────

describe("setProject / setSelectedFile", () => {
  it("setProject 设置项目对象", () => {
    useWikiStore.getState().setProject({ id: "p1", name: "测试", path: "/test" })
    expect(useWikiStore.getState().project?.name).toBe("测试")
  })

  it("setSelectedFile 清除 selectedTrashItem", () => {
    const item = { id: "t1", name: "deleted.md", originalPath: "/old.md", trashPath: "/trash/t1", deletedAt: 1, expiresAt: 1000, kind: "chapter" as const }
    useWikiStore.getState().setSelectedTrashItem(item)
    expect(useWikiStore.getState().selectedTrashItem).not.toBeNull()
    useWikiStore.getState().setSelectedFile("/new.md")
    expect(useWikiStore.getState().selectedTrashItem).toBeNull()
  })
})

// ─── Settings State Setters ──────────────────────────────────────────────────

describe("Settings 配置器集合", () => {
  it("setAiChatModel / setDefaultLlmModel", () => {
    useWikiStore.getState().setAiChatModel("model-chat")
    expect(useWikiStore.getState().aiChatModel).toBe("model-chat")
    useWikiStore.getState().setDefaultLlmModel("model-default")
    expect(useWikiStore.getState().defaultLlmModel).toBe("model-default")
  })

  it("setSearchApiConfig", () => {
    useWikiStore.getState().setSearchApiConfig({
      provider: "tavily",
      apiKey: "key123",
      serpApiEngine: "google",
      searXngUrl: "",
      searXngCategories: ["general"],
      providerConfigs: {},
    })
    const c = useWikiStore.getState().searchApiConfig
    expect(c.provider).toBe("tavily")
    expect(c.apiKey).toBe("key123")
  })

  it("setEmbeddingConfig", () => {
    useWikiStore.getState().setEmbeddingConfig({
      enabled: true,
      endpoint: "http://localhost:1234/v1/embeddings",
      apiKey: "emb-key",
      model: "text-embedding",
    })
    const c = useWikiStore.getState().embeddingConfig
    expect(c.enabled).toBe(true)
    expect(c.endpoint).toContain("1234")
  })

  it("setOutputLanguage", () => {
    useWikiStore.getState().setOutputLanguage("Japanese")
    expect(useWikiStore.getState().outputLanguage).toBe("Japanese")
  })

  it("setProxyConfig", () => {
    useWikiStore.getState().setProxyConfig({ enabled: true, url: "http://proxy:8080", bypassLocal: false })
    const c = useWikiStore.getState().proxyConfig
    expect(c.enabled).toBe(true)
    expect(c.bypassLocal).toBe(false)
  })

  it("setScheduledImportConfig", () => {
    useWikiStore.getState().setScheduledImportConfig({
      enabled: true,
      path: "raw",
      interval: 10,
      lastScan: Date.now(),
    })
    const c = useWikiStore.getState().scheduledImportConfig
    expect(c.interval).toBe(10)
  })

  it("setSourceWatchConfig", () => {
    const cfg: SourceWatchConfig = {
      enabled: true,
      autoIngest: true,
      includeExtensions: ["md"],
      excludeExtensions: ["log"],
      excludeDirs: ["node_modules"],
      excludeGlobs: ["*.tmp"],
      maxFileSizeMb: 10,
    }
    useWikiStore.getState().setSourceWatchConfig(cfg)
    const c = useWikiStore.getState().sourceWatchConfig
    expect(c.includeExtensions).toContain("md")
  })

  it("setNovelMode / setChatEditModeEnabled", () => {
    useWikiStore.getState().setNovelMode(false)
    expect(useWikiStore.getState().novelMode).toBe(false)
    useWikiStore.getState().setChatEditModeEnabled(true)
    expect(useWikiStore.getState().chatEditModeEnabled).toBe(true)
  })

  it("setCommunitySummaryError", () => {
    useWikiStore.getState().setCommunitySummaryError("生成失败")
    expect(useWikiStore.getState().communitySummaryError).toBe("生成失败")
    useWikiStore.getState().setCommunitySummaryError(null)
    expect(useWikiStore.getState().communitySummaryError).toBeNull()
  })

  it("setSearchHistory / setSearchTrigger", () => {
    useWikiStore.getState().setSearchHistory(["query1", "query2"])
    expect(useWikiStore.getState().searchHistory).toEqual(["query1", "query2"])
    useWikiStore.getState().setSearchTrigger({ query: "hi", ts: Date.now() })
    expect(useWikiStore.getState().searchTrigger).not.toBeNull()
  })

  it("setTheme / bumpDataVersion", () => {
    useWikiStore.getState().setTheme("dark")
    expect(useWikiStore.getState().theme).toBe("dark")
    useWikiStore.getState().bumpDataVersion()
    expect(useWikiStore.getState().dataVersion).toBe(1)
  })
})

// ─── Config Merges ───────────────────────────────────────────────────────────

describe("setRerankConfig / setMultimodalConfig / setNovelConfig 合并行为", () => {
  it("setRerankConfig 只更新传入的字段（合并模式）", () => {
    const before = useWikiStore.getState().rerankConfig
    useWikiStore.getState().setRerankConfig({ enabled: true, maxCandidates: 5 })
    const after = useWikiStore.getState().rerankConfig
    // Enabled is updated, but unused fields keep their previous values
    expect(after.enabled).toBe(true)
    expect(after.maxCandidates).toBe(5)
    // Others are preserved
    expect(after.useMainLlm).toBe(before.useMainLlm)
    expect(after.provider).toBe(before.provider)
  })

  it("setMultimodalConfig 直接替换整个配置", () => {
    const cfg = {
      enabled: true,
      useMainLlm: false,
      provider: "ollama",
      apiKey: "",
      model: "llava",
      ollamaUrl: "http://x:11434",
      customEndpoint: "",
      azureApiVersion: "v1",
      azureModelFamily: "auto",
      apiMode: "chat_completions",
      concurrency: 2,
    } as const
    useWikiStore.getState().setMultimodalConfig(cfg)
    expect(useWikiStore.getState().multimodalConfig.concurrency).toBe(2)
  })

  it("setNovelConfig 合并模式", () => {
    useWikiStore.getState().setNovelConfig({ chapterTargetChars: 5000 })
    const after = useWikiStore.getState().novelConfig
    expect(after.chapterTargetChars).toBe(5000)
    // Other fields like contextTokenBudget remain unchanged
  })
})

// ─── Graph Settings Persistence ──────────────────────────────────────────────

describe("setChatDockPosition / setUiFontSizeScale 的 localStorage 持久化", () => {
  beforeEach(() => {
    Object.keys(_localStorageMock).forEach((k) => delete _localStorageMock[k])
  })

  it("setChatDockPosition 写入 localStorage", () => {
    useWikiStore.getState().setChatDockPosition("right")
    // Spies live on globalThis.localStorage; _localStorageMock is only the value map.
    expect(globalThis.localStorage.setItem).toHaveBeenCalledWith("qmai-chat-dock-position", "right")
    expect(_localStorageMock["qmai-chat-dock-position"]).toBe("right")
  })

  it("setUiFontSizeScale 写入并约束范围", () => {
    useWikiStore.getState().setUiFontSizeScale(2.0) // 超出上限
    expect(useWikiStore.getState().uiFontSizeScale).toBeCloseTo(1.3)
    expect(globalThis.localStorage.setItem).toHaveBeenCalledWith("qmai-ui-font-size-scale", String(1.3))
    expect(_localStorageMock["qmai-ui-font-size-scale"]).toBe(String(1.3))
  })
})

// ─── Task Run Finishers ──────────────────────────────────────────────────────

describe("finishLintRun / finishReviewRun / clearTransientTaskState", () => {
  it("finishLintRun 匹配 runId 时更新状态，不匹配时忽略", () => {
    const runId = "lint-x"
    const state = { runId, running: true, hasRun: true, error: "error message", projectPath: "/fake/project" }
    useWikiStore.getState().setLintRun({ ...state, results: [] })
    // RunId mismatch → should not update
    useWikiStore.getState().finishLintRun("wrong-id", { running: false })
    expect(useWikiStore.getState().lintRun?.running).toBe(true)
    // Correct match → update
    useWikiStore.getState().finishLintRun(runId, { running: false })
    expect(useWikiStore.getState().lintRun?.running).toBe(false)
  })

  it("finishReviewRun 相同逻辑", () => {
    const runId = "rev-y"
    useWikiStore.getState().setReviewRun({
      runId,
      running: true,
      results: [],
      projectPath: "/fake/project",
    })
    useWikiStore.getState().finishReviewRun("wrong", { running: false })
    expect(useWikiStore.getState().reviewRun?.running).toBe(true)
    useWikiStore.getState().finishReviewRun(runId, { running: false, thinking: "done" })
    expect(useWikiStore.getState().reviewRun?.thinking).toBe("done")
  })

  it("clearTransientTaskState 清空最终章节保存、lint、review 状态", () => {
    useWikiStore.getState().setFinalChapterSave({ filePath: "/a.md", saving: true, phase: "saving", projectPath: "/fake/project" })
    useWikiStore.getState().setLintRun({ runId: "1", running: false, hasRun: true, results: [], projectPath: "/fake/project" })
    useWikiStore.getState().setReviewRun({ runId: "2", running: false, results: [], projectPath: "/fake/project" })

    useWikiStore.getState().clearTransientTaskState()

    const s = useWikiStore.getState()
    expect(s.finalChapterSave).toBeNull()
    expect(s.lintRun).toBeNull()
    expect(s.reviewRun).toBeNull()
  })
})

// ─── Graph Settings 直接赋值器 ───────────────────────────────────────────────

describe("图表设置直接赋值器", () => {
  it("setGraphMode / setGraphDisplayMode / setGraphColorMode", () => {
    useWikiStore.getState().setGraphMode("entity")
    expect(useWikiStore.getState().graphMode).toBe("entity")
    useWikiStore.getState().setGraphDisplayMode("focused")
    expect(useWikiStore.getState().graphDisplayMode).toBe("focused")
    useWikiStore.getState().setGraphColorMode("highlight")
    expect(useWikiStore.getState().graphColorMode).toBe("highlight")
  })

  it("setGraphShowFilters / setGraphShowEdgeControls", () => {
    useWikiStore.getState().setGraphShowFilters(true)
    expect(useWikiStore.getState().graphShowFilters).toBe(true)
    useWikiStore.getState().setGraphShowEdgeControls(true)
    expect(useWikiStore.getState().graphShowEdgeControls).toBe(true)
  })

  it("setGraphEdgeStyle / setGraphEdgeColorHex / setGraphEdgeStrengthPercent", () => {
    useWikiStore.getState().setGraphEdgeStyle("line")
    expect(useWikiStore.getState().graphEdgeStyle).toBe("line")
    useWikiStore.getState().setGraphEdgeColorHex("#ff0000")
    expect(useWikiStore.getState().graphEdgeColorHex).toBe("#ff0000")
    useWikiStore.getState().setGraphEdgeStrengthPercent(200)
    expect(useWikiStore.getState().graphEdgeStrengthPercent).toBe(200)
  })

  it("setGraphEdgeLabelsAlwaysVisible", () => {
    useWikiStore.getState().setGraphEdgeLabelsAlwaysVisible(true)
    expect(useWikiStore.getState().graphEdgeLabelsAlwaysVisible).toBe(true)
  })

  it("setGraphStats", () => {
    useWikiStore.getState().setGraphStats({ nodeCount: 10, edgeCount: 5, hiddenCount: 1, filteredNodeCount: 9, filteredEdgeCount: 4 })
    expect(useWikiStore.getState().graphStats.nodeCount).toBe(10)
  })

  it("setRefreshGraph 可以设置为函数或 null", () => {
    const fn = () => {}
    useWikiStore.getState().setRefreshGraph(fn)
    expect(useWikiStore.getState().refreshGraph).toBe(fn)
    useWikiStore.getState().setRefreshGraph(null)
    expect(useWikiStore.getState().refreshGraph).toBeNull()
  })
})

// ─── View & Selection Settings ───────────────────────────────────────────────

describe("视图与选择设置", () => {
  it("setActiveSettingsCategory / setChatExpanded", () => {
    useWikiStore.getState().setActiveSettingsCategory("llm")
    expect(useWikiStore.getState().activeSettingsCategory).toBe("llm")
    useWikiStore.getState().setChatExpanded(true)
    expect(useWikiStore.getState().chatExpanded).toBe(true)
  })

  it("setActiveView", () => {
    for (const view of ["wiki", "sources", "search", "graph", "lint", "soul", "dismantling", "bookAnalysis", "settings", "trash", "reviewCenter"] as const) {
      useWikiStore.getState().setActiveView(view)
      expect(useWikiStore.getState().activeView).toBe(view)
    }
  })

  it("setSelectedSoulId / setSelectedSoulTab / setSelectedSoulSection", () => {
    useWikiStore.getState().setSelectedSoulId("s1")
    expect(useWikiStore.getState().selectedSoulId).toBe("s1")
    useWikiStore.getState().setSelectedSoulTab("character")
    expect(useWikiStore.getState().selectedSoulTab).toBe("character")
    useWikiStore.getState().setSelectedSoulSection("custom")
    expect(useWikiStore.getState().selectedSoulSection).toBe("custom")
  })

  it("setSelectedReviewDimension / setSelectedReviewFilePath / setSelectedDismantlingProjectId", () => {
    useWikiStore.getState().setSelectedReviewDimension("dimension1")
    expect(useWikiStore.getState().selectedReviewDimension).toBe("dimension1")
    useWikiStore.getState().setSelectedReviewFilePath("/file.md")
    expect(useWikiStore.getState().selectedReviewFilePath).toBe("/file.md")
    useWikiStore.getState().setSelectedDismantlingProjectId("proj1")
    expect(useWikiStore.getState().selectedDismantlingProjectId).toBe("proj1")
  })

  it("setSelectedMemoryCenterEntry / setPendingScrollImageSrc", () => {
    useWikiStore.getState().setSelectedMemoryCenterEntry("entry1")
    expect(useWikiStore.getState().selectedMemoryCenterEntry).toBe("entry1")
    useWikiStore.getState().setPendingScrollImageSrc("/img.png")
    expect(useWikiStore.getState().pendingScrollImageSrc).toBe("/img.png")
  })
})

// ─── Thrill soft-gate 认知标记 ────────────────────────────────────────────────

describe("setThrillSoftGateAcknowledged / clearThrillSoftGateAcknowledged", () => {
  beforeEach(() => {
    useWikiStore.setState({ thrilSoftGateAcknowledgedByChapter: {} })
  })

  it("ack=true 写入指定章节，ack=false 删除该章节", () => {
    const { setThrillSoftGateAcknowledged } = useWikiStore.getState()
    setThrillSoftGateAcknowledged(3, true)
    expect(useWikiStore.getState().thrilSoftGateAcknowledgedByChapter["3"]).toBe(true)
    setThrillSoftGateAcknowledged(3, false)
    expect(useWikiStore.getState().thrilSoftGateAcknowledgedByChapter).not.toHaveProperty("3")
  })

  it("chapter 为 null / 非有限数 / 小数时分别归一到 \"0\" 与截断", () => {
    const { setThrillSoftGateAcknowledged } = useWikiStore.getState()
    setThrillSoftGateAcknowledged(null, true)
    expect(useWikiStore.getState().thrilSoftGateAcknowledgedByChapter["0"]).toBe(true)
    setThrillSoftGateAcknowledged(NaN, true)
    expect(useWikiStore.getState().thrilSoftGateAcknowledgedByChapter["0"]).toBe(true)
    setThrillSoftGateAcknowledged(5.7, true)
    expect(useWikiStore.getState().thrilSoftGateAcknowledgedByChapter["5"]).toBe(true)
    expect(useWikiStore.getState().thrilSoftGateAcknowledgedByChapter).not.toHaveProperty("5.7")
  })

  it("clearThrillSoftGateAcknowledged() 不传参时整体清空", () => {
    const { setThrillSoftGateAcknowledged, clearThrillSoftGateAcknowledged } = useWikiStore.getState()
    setThrillSoftGateAcknowledged(1, true)
    setThrillSoftGateAcknowledged(2, true)
    clearThrillSoftGateAcknowledged()
    expect(useWikiStore.getState().thrilSoftGateAcknowledgedByChapter).toEqual({})
  })

  it("clearThrillSoftGateAcknowledged(章节) 只删除对应章节；null 删除 \"0\"", () => {
    const { setThrillSoftGateAcknowledged, clearThrillSoftGateAcknowledged } = useWikiStore.getState()
    setThrillSoftGateAcknowledged(1, true)
    setThrillSoftGateAcknowledged(2, true)
    setThrillSoftGateAcknowledged(null, true)
    clearThrillSoftGateAcknowledged(1)
    let m = useWikiStore.getState().thrilSoftGateAcknowledgedByChapter
    expect(m).not.toHaveProperty("1")
    expect(m["2"]).toBe(true)
    clearThrillSoftGateAcknowledged(null)
    m = useWikiStore.getState().thrilSoftGateAcknowledgedByChapter
    expect(m).not.toHaveProperty("0")
    expect(m["2"]).toBe(true)
  })
})

// ─── 缺失的配置 setter ────────────────────────────────────────────────────────

describe("其余配置 setter", () => {
  it("setGraphLabelDisplayMode", () => {
    useWikiStore.getState().setGraphLabelDisplayMode("focused")
    expect(useWikiStore.getState().graphLabelDisplayMode).toBe("focused")
  })

  it("setSearchPanelOpen", () => {
    useWikiStore.getState().setSearchPanelOpen(true)
    expect(useWikiStore.getState().searchPanelOpen).toBe(true)
    useWikiStore.getState().setSearchPanelOpen(false)
    expect(useWikiStore.getState().searchPanelOpen).toBe(false)
  })

  it("setLlmConfig 整体替换", () => {
    useWikiStore.getState().setLlmConfig({
      provider: "anthropic",
      apiKey: "ak",
      model: "claude",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 99999,
      reasoning: { mode: "high" },
    })
    const c = useWikiStore.getState().llmConfig
    expect(c.provider).toBe("anthropic")
    expect(c.maxContextSize).toBe(99999)
    expect(c.reasoning?.mode).toBe("high")
  })

  it("setProviderConfigs / setActivePresetId", () => {
    useWikiStore.getState().setProviderConfigs({
      openai: { label: "OpenAI", apiKey: "k", model: "gpt" },
    })
    expect(useWikiStore.getState().providerConfigs.openai?.label).toBe("OpenAI")
    useWikiStore.getState().setActivePresetId("preset-1")
    expect(useWikiStore.getState().activePresetId).toBe("preset-1")
  })

  it("setRevisionFeedbackWindowConfig 整体替换", () => {
    useWikiStore.getState().setRevisionFeedbackWindowConfig({
      currentChapterIncludeShouldImprove: false,
      previousChapterCarryEnabled: false,
      lookbackChapterCount: 4,
      lookbackIncludeMustFixOnly: false,
    })
    const c = useWikiStore.getState().revisionFeedbackWindowConfig
    expect(c.currentChapterIncludeShouldImprove).toBe(false)
    expect(c.lookbackChapterCount).toBe(4)
  })

  it("setPendingEditorHighlight / setFileContent / setFileTree", () => {
    useWikiStore.getState().setPendingEditorHighlight({ path: "/a.md", text: "x", nonce: 1 })
    expect(useWikiStore.getState().pendingEditorHighlight?.path).toBe("/a.md")
    useWikiStore.getState().setFileContent("内容")
    expect(useWikiStore.getState().fileContent).toBe("内容")
    useWikiStore.getState().setFileTree([{ id: "n1", name: "a.md", path: "/a.md", children: [] } as never])
    expect(useWikiStore.getState().fileTree).toHaveLength(1)
  })
})

// ─── localStorage 未定义（SSR/非浏览器）守卫 ───────────────────────────────────

describe("localStorage 不可用时的降级行为（typeof guard）", () => {
  it("localStorage undefined 时所有 readStored* 回退默认值，setter 仍生效", async () => {
    const savedLocalStorage = (globalThis as any).localStorage
    delete (globalThis as any).localStorage
    try {
      vi.resetModules()
      const mod = await import("../wiki-store")
      const store = mod.useWikiStore.getState()
      expect(store.chatDockPosition).toBe("bottom")
      expect(store.uiFontSizeScale).toBe(1)
      expect(store.graphLabelDisplayMode).toBe("all")
      expect(store.graphEdgeColorHex).toBe("#7f8ea3")
      expect(store.graphEdgeStrengthPercent).toBe(180)
      expect(store.graphEdgeStyle).toBe("curve")
      expect(store.graphEdgeLabelsAlwaysVisible).toBe(false)
      // setter 在无 localStorage 时跳过写入但仍更新 state
      mod.useWikiStore.getState().setChatDockPosition("right")
      expect(mod.useWikiStore.getState().chatDockPosition).toBe("right")
      mod.useWikiStore.getState().setUiFontSizeScale(2.0)
      expect(mod.useWikiStore.getState().uiFontSizeScale).toBeCloseTo(1.3)
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        value: savedLocalStorage,
        writable: true,
        configurable: true,
      })
    }
  })
})

// ─── localStorage 预置值读取（readStored* 各分支） ─────────────────────────────

describe("readStored* 预置值解析", () => {
  beforeEach(() => {
    Object.keys(_localStorageMock).forEach((k) => delete _localStorageMock[k])
  })

  it("合法预置值被读取", async () => {
    _localStorageMock["qmai-chat-dock-position"] = "right"
    _localStorageMock["qmai-ui-font-size-scale"] = "1.25"
    _localStorageMock["lk-graph-label-display-mode"] = "auto"
    _localStorageMock["lk-graph-edge-style"] = "arrow"
    _localStorageMock["lk-graph-edge-strength"] = "250"
    _localStorageMock["lk-graph-edge-labels-always"] = "true"
    _localStorageMock["lk-graph-edge-color"] = "#ff8800"
    vi.resetModules()
    const mod = await import("../wiki-store")
    const s = mod.useWikiStore.getState()
    expect(s.chatDockPosition).toBe("right")
    expect(s.uiFontSizeScale).toBeCloseTo(1.25)
    expect(s.graphLabelDisplayMode).toBe("auto")
    expect(s.graphEdgeStyle).toBe("arrow")
    expect(s.graphEdgeStrengthPercent).toBe(250)
    expect(s.graphEdgeLabelsAlwaysVisible).toBe(true)
    expect(s.graphEdgeColorHex).toBe("#ff8800")
  })

  it("非法/越界预置值回退默认或夹取边界", async () => {
    _localStorageMock["qmai-chat-dock-position"] = "left"
    _localStorageMock["qmai-ui-font-size-scale"] = "0.5"
    _localStorageMock["lk-graph-label-display-mode"] = "bogus"
    _localStorageMock["lk-graph-edge-style"] = "dotted"
    _localStorageMock["lk-graph-edge-strength"] = "300"
    _localStorageMock["lk-graph-edge-labels-always"] = "false"
    _localStorageMock["lk-graph-edge-color"] = "#12"
    vi.resetModules()
    const mod = await import("../wiki-store")
    const s = mod.useWikiStore.getState()
    expect(s.chatDockPosition).toBe("bottom")
    expect(s.uiFontSizeScale).toBeCloseTo(0.85) // 低于下限夹取
    expect(s.graphLabelDisplayMode).toBe("all")
    expect(s.graphEdgeStyle).toBe("curve")
    expect(s.graphEdgeStrengthPercent).toBe(260) // 高于上限夹取
    expect(s.graphEdgeLabelsAlwaysVisible).toBe(false)
    expect(s.graphEdgeColorHex).toBe("#7f8ea3")
  })

  it("非数字字体缩放 / 强度回退默认", async () => {
    _localStorageMock["qmai-ui-font-size-scale"] = "abc"
    _localStorageMock["lk-graph-edge-strength"] = "nan"
    vi.resetModules()
    const mod = await import("../wiki-store")
    const s = mod.useWikiStore.getState()
    expect(s.uiFontSizeScale).toBe(1)
    expect(s.graphEdgeStrengthPercent).toBe(180)
  })

  it("localStorage 存在但键缺失时 ?? 兜底默认值", async () => {
    // 不预置任何键：getItem 返回 null → ?? "1" / ?? "180" 生效
    vi.resetModules()
    const mod = await import("../wiki-store")
    const s = mod.useWikiStore.getState()
    expect(s.chatDockPosition).toBe("bottom")
    expect(s.uiFontSizeScale).toBe(1)
    expect(s.graphEdgeStrengthPercent).toBe(180)
    expect(s.graphLabelDisplayMode).toBe("all")
  })
})

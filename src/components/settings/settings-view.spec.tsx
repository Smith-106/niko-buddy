// @vitest-environment jsdom
/**
 * SettingsView 渲染级覆盖（W4F2 战役）。
 * 目标：src/components/settings/settings-view.tsx 四维全口径补满。
 * 策略：vi.mock store / 外部依赖 / 12 个 section 子组件，断言对照源码实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { act, fireEvent, render, screen, waitFor } from "@/test-helpers/component-test-utils"
import { SettingsView } from "./settings-view"
import type {
  EmbeddingConfig,
  LlmConfig,
  MultimodalConfig,
  NovelConfig,
  ProxyConfig,
  RerankConfig,
  ScheduledImportConfig,
  SourceWatchConfig,
} from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"
import type { RevisionFeedbackWindowConfig } from "@/lib/project-store"

/**
 * 本地镜像 WikiState 的字段子集：mock store 只暴露测试用到的字段。
 * setter 用 vi.fn 的返回类型以保留 mock 断言方法（toHaveBeenCalledWith 等）。
 * 用 type alias（非 interface）以保留到 Record<string, unknown> 的隐式索引签名兼容。
 */
type SettingsWikiState = {
  project: WikiProject | null
  activeSettingsCategory: string | null
  llmConfig: Partial<LlmConfig>
  embeddingConfig: EmbeddingConfig
  rerankConfig: RerankConfig
  multimodalConfig: MultimodalConfig
  outputLanguage: string
  proxyConfig: ProxyConfig
  scheduledImportConfig: ScheduledImportConfig
  sourceWatchConfig: SourceWatchConfig
  revisionFeedbackWindowConfig: RevisionFeedbackWindowConfig
  novelConfig: Partial<NovelConfig>
  uiFontSizeScale: number
  setActiveSettingsCategory: ReturnType<typeof vi.fn>
  setLlmConfig: ReturnType<typeof vi.fn>
  setEmbeddingConfig: ReturnType<typeof vi.fn>
  setRerankConfig: ReturnType<typeof vi.fn>
  setMultimodalConfig: ReturnType<typeof vi.fn>
  setOutputLanguage: ReturnType<typeof vi.fn>
  setProxyConfig: ReturnType<typeof vi.fn>
  setScheduledImportConfig: ReturnType<typeof vi.fn>
  setSourceWatchConfig: ReturnType<typeof vi.fn>
  setRevisionFeedbackWindowConfig: ReturnType<typeof vi.fn>
  setNovelConfig: ReturnType<typeof vi.fn>
  setUiFontSizeScale: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  const wikiState: SettingsWikiState = {
    project: null,
    activeSettingsCategory: null,
    llmConfig: {
      provider: "openai",
      apiKey: "key-1",
      model: "gpt-4o",
      ollamaUrl: "http://127.0.0.1:11434",
      customEndpoint: "",
      azureApiVersion: "2024-10-21",
      azureModelFamily: "auto",
      maxContextSize: 204800,
      apiMode: undefined,
      reasoning: undefined,
      localCliIsolation: false,
    },
    embeddingConfig: {
      enabled: true,
      endpoint: "http://localhost:6333",
      apiKey: "",
      model: "bge",
      outputDimensionality: 1024,
      maxChunkChars: 1000,
      overlapChunkChars: 200,
    },
    rerankConfig: {
      enabled: false,
      useMainLlm: true,
      provider: "custom",
      apiKey: "",
      model: "",
      ollamaUrl: "http://127.0.0.1:11434",
      customEndpoint: "",
      apiMode: "chat_completions",
      maxCandidates: 12,
    },
    multimodalConfig: {
      enabled: false,
      useMainLlm: true,
      provider: "openai",
      apiKey: "",
      model: "",
      ollamaUrl: "",
      customEndpoint: "",
      azureApiVersion: "2024-10-21",
      azureModelFamily: "auto",
      apiMode: undefined,
      concurrency: 4,
    },
    outputLanguage: "zh-CN",
    proxyConfig: { enabled: false, url: "", bypassLocal: true },
    scheduledImportConfig: { enabled: false, path: "", interval: 60, lastScan: 0 },
    sourceWatchConfig: { enabled: false, autoIngest: false, includeExtensions: [], excludeExtensions: [], excludeDirs: [], excludeGlobs: [], maxFileSizeMb: 10 },
    revisionFeedbackWindowConfig: { currentChapterIncludeShouldImprove: true, previousChapterCarryEnabled: false, lookbackChapterCount: 1, lookbackIncludeMustFixOnly: true },
    novelConfig: { contextTokenBudget: 50000, recentSummaryWindow: 8, searchTopK: 5, chapterTargetChars: 3000, autoIngestOnSave: false, autoExtractOnImport: true, reviewBeforeSave: true, deepPreviousChaptersAnalysis: false, deepChapterReview: true },
    uiFontSizeScale: 1,
    setActiveSettingsCategory: vi.fn(),
    setLlmConfig: vi.fn(),
    setEmbeddingConfig: vi.fn(),
    setRerankConfig: vi.fn(),
    setMultimodalConfig: vi.fn(),
    setOutputLanguage: vi.fn(),
    setProxyConfig: vi.fn(),
    setScheduledImportConfig: vi.fn(),
    setSourceWatchConfig: vi.fn(),
    setRevisionFeedbackWindowConfig: vi.fn(),
    setNovelConfig: vi.fn(),
    setUiFontSizeScale: vi.fn(),
  }

  const chatState: { maxHistoryMessages: number; setMaxHistoryMessages: ReturnType<typeof vi.fn> } = {
    maxHistoryMessages: 50,
    setMaxHistoryMessages: vi.fn(),
  }

  const t = vi.fn((key: string) => key)
  const changeLanguage = vi.fn<() => Promise<void>>(async () => {})
  const loadSourceWatchConfig = vi.fn<(projectId?: string, projectPath?: string) => Promise<SourceWatchConfig>>(async () => ({ enabled: false, autoIngest: false, includeExtensions: [], excludeExtensions: [], excludeDirs: [], excludeGlobs: [], maxFileSizeMb: 10 }))
  const loadNovelConfig = vi.fn<(projectId?: string, projectPath?: string) => Promise<NovelConfig | null>>(async () => null)
  const loadRerankConfig = vi.fn<(projectId?: string, projectPath?: string) => Promise<RerankConfig | null>>(async () => null)
  const saveLlmConfig = vi.fn<(config: unknown, projectId?: string, projectPath?: string) => Promise<void>>(async () => {})
  const saveEmbeddingConfig = vi.fn<(config: unknown, projectId?: string, projectPath?: string) => Promise<void>>(async () => {})
  const saveRerankConfig = vi.fn<(config: RerankConfig, projectId?: string, projectPath?: string) => Promise<void>>(async () => {})
  const saveMultimodalConfig = vi.fn<(config: unknown, projectId?: string, projectPath?: string) => Promise<void>>(async () => {})
  const saveProxyConfig = vi.fn<(config: unknown, projectId?: string, projectPath?: string) => Promise<void>>(async () => {})
  const saveScheduledImportConfig = vi.fn<(projectPath: string, config: ScheduledImportConfig) => Promise<void>>(async () => {})
  const saveSourceWatchConfig = vi.fn<(config: SourceWatchConfig, projectId?: string, projectPath?: string) => Promise<void>>(async () => {})
  const saveRevisionFeedbackWindowConfig = vi.fn<(config: RevisionFeedbackWindowConfig, projectId?: string, projectPath?: string) => Promise<void>>(async () => {})
  const saveNovelConfig = vi.fn<(config: NovelConfig, projectId?: string, projectPath?: string) => Promise<void>>(async () => {})
  const saveOutputLanguage = vi.fn<(lang: string, projectId?: string, projectPath?: string) => Promise<void>>(async () => {})
  const saveMaxHistoryMessages = vi.fn<(value: number, projectId?: string, projectPath?: string) => Promise<void>>(async () => {})
  const saveUiFontSizeScale = vi.fn<(value: number, projectId?: string, projectPath?: string) => Promise<void>>(async () => {})
  const saveLanguage = vi.fn<(lang: string) => Promise<void>>(async () => {})
  const isTauri = vi.fn<() => boolean>(() => false)
  const invoke = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {})
  const startProjectFileSync = vi.fn<(projectId?: string, projectPath?: string) => Promise<void>>(async () => {})
  const stopProjectFileSync = vi.fn<(projectId?: string) => Promise<void>>(async () => {})
  const startScheduledImport = vi.fn<() => void>(() => {})
  const stopScheduledImport = vi.fn<() => void>(() => {})
  const normalizeSourceWatchConfig = vi.fn<(config?: Partial<SourceWatchConfig> | null) => SourceWatchConfig>((config?: Partial<SourceWatchConfig> | null) =>
    config ? { enabled: false, autoIngest: false, includeExtensions: [], excludeExtensions: [], excludeDirs: [], excludeGlobs: [], maxFileSizeMb: 10, ...config } : { enabled: false, autoIngest: false, includeExtensions: [], excludeExtensions: [], excludeDirs: [], excludeGlobs: [], maxFileSizeMb: 10 },
  )
  return {
    wikiState,
    chatState,
    t,
    changeLanguage,
    loadSourceWatchConfig,
    loadNovelConfig,
    loadRerankConfig,
    saveLlmConfig,
    saveEmbeddingConfig,
    saveRerankConfig,
    saveMultimodalConfig,
    saveProxyConfig,
    saveScheduledImportConfig,
    saveSourceWatchConfig,
    saveRevisionFeedbackWindowConfig,
    saveNovelConfig,
    saveOutputLanguage,
    saveMaxHistoryMessages,
    saveUiFontSizeScale,
    saveLanguage,
    isTauri,
    invoke,
    startProjectFileSync,
    stopProjectFileSync,
    startScheduledImport,
    stopScheduledImport,
    normalizeSourceWatchConfig,
  }
})


vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/i18n", () => ({
  default: { language: "zh", changeLanguage: mocks.changeLanguage },
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(mocks.wikiState),
    { getState: () => mocks.wikiState },
  ),
}))

vi.mock("@/stores/chat-store", () => ({
  useChatStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(mocks.chatState),
    { getState: () => mocks.chatState },
  ),
}))

vi.mock("@/lib/platform", () => ({
  isTauri: mocks.isTauri,
}))

vi.mock("@/lib/project-store", () => ({
  loadSourceWatchConfig: mocks.loadSourceWatchConfig,
  saveLanguage: mocks.saveLanguage,
  loadNovelConfig: mocks.loadNovelConfig,
  loadRerankConfig: mocks.loadRerankConfig,
  saveLlmConfig: mocks.saveLlmConfig,
  saveEmbeddingConfig: mocks.saveEmbeddingConfig,
  saveRerankConfig: mocks.saveRerankConfig,
  saveMultimodalConfig: mocks.saveMultimodalConfig,
  saveProxyConfig: mocks.saveProxyConfig,
  saveScheduledImportConfig: mocks.saveScheduledImportConfig,
  saveSourceWatchConfig: mocks.saveSourceWatchConfig,
  saveRevisionFeedbackWindowConfig: mocks.saveRevisionFeedbackWindowConfig,
  saveNovelConfig: mocks.saveNovelConfig,
  saveOutputLanguage: mocks.saveOutputLanguage,
  saveMaxHistoryMessages: mocks.saveMaxHistoryMessages,
  saveUiFontSizeScale: mocks.saveUiFontSizeScale,
}))

vi.mock("@/lib/source-watch-config", () => ({
  normalizeSourceWatchConfig: mocks.normalizeSourceWatchConfig,
}))

vi.mock("@/lib/project-file-sync", () => ({
  startProjectFileSync: mocks.startProjectFileSync,
  stopProjectFileSync: mocks.stopProjectFileSync,
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}))

vi.mock("@/lib/scheduled-import", () => ({
  startScheduledImport: mocks.startScheduledImport,
  stopScheduledImport: mocks.stopScheduledImport,
}))

vi.mock("@/components/layout/panel-header-with-help", () => ({
  PanelHeaderWithHelp: (props: { title: string }) => <span data-testid="panel-header">{props.title}</span>,
}))

vi.mock("./sections/llm-provider-section", () => ({
  LlmProviderSection: () => <div data-testid="section-llm">llm-section</div>,
}))

vi.mock("./sections/rerank-section", () => ({
  RerankSection: (props: { draft: Record<string, unknown>; setDraft: (k: string, v: unknown) => void }) => (
    <div data-testid="section-rerank">
      <span data-testid="draft-max">{String((props.draft.rerankConfig as { maxCandidates: number }).maxCandidates)}</span>
      <span data-testid="draft-provider">{String(props.draft.provider)}</span>
      <span data-testid="draft-multimodal-provider">{String(props.draft.multimodalProvider)}</span>
      <button data-testid="set-max-1" onClick={() => props.setDraft("rerankConfig", { ...(props.draft.rerankConfig as object), maxCandidates: 1 })}>max1</button>
      <button data-testid="set-max-50" onClick={() => props.setDraft("rerankConfig", { ...(props.draft.rerankConfig as object), maxCandidates: 50 })}>max50</button>
      <button data-testid="set-max-0" onClick={() => props.setDraft("rerankConfig", { ...(props.draft.rerankConfig as object), maxCandidates: 0 })}>max0</button>
      <button data-testid="set-rerank-non-custom" onClick={() => props.setDraft("rerankConfig", { ...(props.draft.rerankConfig as object), provider: "openai", apiMode: undefined })}>non-custom</button>
      <button data-testid="set-provider-azure" onClick={() => props.setDraft("provider", "azure")}>azure</button>
      <button data-testid="set-provider-custom" onClick={() => props.setDraft("provider", "custom")}>custom</button>
      <button data-testid="set-llm-mode" onClick={() => props.setDraft("apiMode", "chat_completions")}>llm-mode</button>
      <button data-testid="set-azure-version" onClick={() => props.setDraft("azureApiVersion", " 2024-10-21 ")}>ver</button>
      <button data-testid="set-multimodal-azure" onClick={() => props.setDraft("multimodalProvider", "azure")}>mm-azure</button>
      <button data-testid="set-multimodal-custom" onClick={() => props.setDraft("multimodalProvider", "custom")}>mm-custom</button>
      <button data-testid="set-mm-mode" onClick={() => props.setDraft("multimodalApiMode", "chat_completions")}>mm-mode</button>
      <button data-testid="set-mm-key" onClick={() => props.setDraft("multimodalApiKey", "k")}>mm-key</button>
      <button data-testid="set-mm-azure-version" onClick={() => props.setDraft("multimodalAzureApiVersion", " 2025-01-01 ")}>mm-ver</button>
      <button data-testid="set-conc-0" onClick={() => props.setDraft("multimodalConcurrency", 0)}>c0</button>
      <button data-testid="set-conc-20" onClick={() => props.setDraft("multimodalConcurrency", 20)}>c20</button>
      <button data-testid="set-conc-4" onClick={() => props.setDraft("multimodalConcurrency", 4)}>c4</button>
    </div>
  ),
}))

vi.mock("./sections/embedding-section", () => ({
  EmbeddingSection: (props: { draft: Record<string, unknown>; setDraft: (k: string, v: unknown) => void }) => (
    <div data-testid="section-embedding">
      <span data-testid="draft-embed">{String(props.draft.embeddingEnabled)}</span>
      <button data-testid="embed-off" onClick={() => props.setDraft("embeddingEnabled", false)}>embed-off</button>
    </div>
  ),
}))

vi.mock("./sections/network-section", () => ({
  NetworkSection: (props: { draft: Record<string, unknown>; setDraft: (k: string, v: unknown) => void }) => (
    <div data-testid="section-network">
      <span data-testid="draft-proxy-url">{String(props.draft.proxyUrl)}</span>
      <span data-testid="draft-sched-enabled">{String(props.draft.scheduledImportEnabled)}</span>
      <span data-testid="draft-sched-path">{String(props.draft.scheduledImportPath)}</span>
      <span data-testid="draft-sched-interval">{String(props.draft.scheduledImportInterval)}</span>
      <button data-testid="set-proxy-url" onClick={() => props.setDraft("proxyUrl", "  http://127.0.0.1:8756  ")}>proxy</button>
      <button data-testid="sched-on" onClick={() => props.setDraft("scheduledImportEnabled", true)}>sched-on</button>
      <button data-testid="sched-off" onClick={() => props.setDraft("scheduledImportEnabled", false)}>sched-off</button>
      <button data-testid="sched-path" onClick={() => props.setDraft("scheduledImportPath", "raw/sources")}>sched-path</button>
      <button data-testid="sched-clear-path" onClick={() => props.setDraft("scheduledImportPath", "")}>sched-clear</button>
      <button data-testid="sched-abs-path" onClick={() => props.setDraft("scheduledImportPath", "/abs/path")}>sched-abs</button>
      <button data-testid="sched-interval-0" onClick={() => props.setDraft("scheduledImportInterval", 0)}>int0</button>
      <button data-testid="sched-interval-2000" onClick={() => props.setDraft("scheduledImportInterval", 2000)}>int2000</button>
    </div>
  ),
}))

vi.mock("./sections/interface-section", () => ({
  InterfaceSection: (props: { draft: Record<string, unknown>; setDraft: (k: string, v: unknown) => void }) => (
    <div data-testid="section-interface">
      <span data-testid="draft-ui-language">{String(props.draft.uiLanguage)}</span>
      <span data-testid="draft-scale">{String(props.draft.uiFontSizeScale)}</span>
      <button data-testid="set-ui-en" onClick={() => props.setDraft("uiLanguage", "en")}>en</button>
      <button data-testid="set-ui-zh" onClick={() => props.setDraft("uiLanguage", "zh")}>zh</button>
      <button data-testid="set-scale" onClick={() => props.setDraft("uiFontSizeScale", 1.25)}>scale</button>
    </div>
  ),
}))

vi.mock("./sections/novel-section", () => ({
  NovelSection: (props: { draft: Record<string, unknown>; setDraft: (k: string, v: unknown) => void }) => (
    <div data-testid="section-novel">
      <span data-testid="draft-source-watch">{String((props.draft.sourceWatchConfig as { enabled: boolean }).enabled)}</span>
      <span data-testid="draft-novel-budget">{String((props.draft.novelConfig as { contextTokenBudget: number }).contextTokenBudget)}</span>
      <button data-testid="source-watch-on" onClick={() => props.setDraft("sourceWatchConfig", { ...(props.draft.sourceWatchConfig as object), enabled: true })}>sw-on</button>
      <button data-testid="source-watch-off" onClick={() => props.setDraft("sourceWatchConfig", { ...(props.draft.sourceWatchConfig as object), enabled: false })}>sw-off</button>
      <button data-testid="novel-budget" onClick={() => props.setDraft("novelConfig", { ...(props.draft.novelConfig as object), contextTokenBudget: 999 })}>budget</button>
    </div>
  ),
}))

vi.mock("./sections/usage-guide-section", () => ({
  UsageGuideSection: () => <div data-testid="section-usage-guide">usage</div>,
}))

vi.mock("./sections/maintenance-section", () => ({
  MaintenanceSection: () => <div data-testid="section-maintenance">maintenance</div>,
}))

vi.mock("./sections/data-management-section", () => ({
  DataManagementSection: () => <div data-testid="section-data-management">data</div>,
}))

vi.mock("./sections/feedback-section", () => ({
  FeedbackSection: () => <div data-testid="section-feedback">feedback</div>,
}))

vi.mock("./sections/contact-support-section", () => ({
  ContactSupportSection: () => <div data-testid="section-contact-support">contact</div>,
}))

vi.mock("./sections/changelog-section", () => ({
  ChangelogSection: () => <div data-testid="section-changelog">changelog</div>,
}))

const PROJECT = { id: "p1", name: "P", path: "/p/x" }

const CATEGORIES: Array<{ id: string; label: string }> = [
  { id: "llm", label: "settings.categories.llm" },
  { id: "rerank", label: "settings.categories.rerank" },
  { id: "embedding", label: "settings.categories.embedding" },
  { id: "network", label: "settings.categories.network" },
  { id: "interface", label: "settings.categories.interface" },
  { id: "novel", label: "settings.categories.novel" },
  { id: "usage-guide", label: "settings.categories.usageGuide" },
  { id: "maintenance", label: "settings.categories.maintenance" },
  { id: "data-management", label: "settings.categories.dataManagement" },
  { id: "feedback", label: "settings.categories.feedback" },
  { id: "contact-support", label: "settings.categories.contactSupport" },
  { id: "changelog", label: "settings.categories.changelog" },
]

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function clickNav(category: string): void {
  const cat = CATEGORIES.find((c) => c.id === category)
  fireEvent.click(screen.getByText(cat?.label ?? category))
}

async function clickAndFlush(testId: string): Promise<void> {
  fireEvent.click(screen.getByTestId(testId))
  await flushAsync()
}

function clickSave(): void {
  // 保存后 2s 内按钮文案为 settings.saved
  const el = screen.queryByText("settings.save") ?? screen.queryByText("settings.saved")
  fireEvent.click(el as HTMLElement)
}

describe("SettingsView 渲染覆盖", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.wikiState.project = null
    mocks.wikiState.activeSettingsCategory = null
    mocks.wikiState.llmConfig = {
      provider: "openai",
      apiKey: "key-1",
      model: "gpt-4o",
      ollamaUrl: "http://127.0.0.1:11434",
      customEndpoint: "",
      azureApiVersion: "2024-10-21",
      azureModelFamily: "auto",
      maxContextSize: 204800,
      apiMode: undefined,
      reasoning: undefined,
      localCliIsolation: false,
    }
    mocks.wikiState.rerankConfig = {
      enabled: false,
      useMainLlm: true,
      provider: "custom",
      apiKey: "",
      model: "",
      ollamaUrl: "http://127.0.0.1:11434",
      customEndpoint: "",
      apiMode: "chat_completions",
      maxCandidates: 12,
    }
    mocks.wikiState.multimodalConfig = {
      enabled: false,
      useMainLlm: true,
      provider: "openai",
      apiKey: "",
      model: "",
      ollamaUrl: "",
      customEndpoint: "",
      azureApiVersion: "2024-10-21",
      azureModelFamily: "auto",
      apiMode: undefined,
      concurrency: 4,
    }
    mocks.wikiState.proxyConfig.url = ""
    mocks.wikiState.scheduledImportConfig.enabled = false
    mocks.wikiState.scheduledImportConfig.path = ""
    mocks.wikiState.scheduledImportConfig.interval = 60
    mocks.wikiState.sourceWatchConfig.enabled = false
    mocks.wikiState.novelConfig.contextTokenBudget = 50000
    mocks.isTauri.mockReturnValue(false)
    mocks.loadSourceWatchConfig.mockResolvedValue(mocks.wikiState.sourceWatchConfig)
    mocks.loadNovelConfig.mockResolvedValue(null)
    mocks.loadRerankConfig.mockResolvedValue(null)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("默认渲染：llm 分类激活、12 个导航按钮、aria-current、未保存提示", () => {
    render(<SettingsView />)
    expect(screen.getByTestId("section-llm")).toBeTruthy()
    for (const cat of CATEGORIES) {
      expect(screen.getByText(cat.label)).toBeTruthy()
    }
    const activeButton = screen.getByText("settings.categories.llm").closest("button")
    expect(activeButton).toHaveAttribute("aria-current", "page")
    const inactiveButton = screen.getByText("settings.categories.novel").closest("button")
    expect(inactiveButton).not.toHaveAttribute("aria-current")
    expect(screen.getByText("settings.changeHint")).toBeTruthy()
    expect(screen.getByText("settings.save")).toBeTruthy()
  })

  it("切换 12 个分类：body 与 aria-current 跟随 active", () => {
    render(<SettingsView />)
    for (const cat of CATEGORIES) {
      clickNav(cat.id)
      expect(screen.getByTestId(`section-${cat.id}`)).toBeTruthy()
      expect(screen.getByText(cat.label).closest("button")).toHaveAttribute("aria-current", "page")
    }
  })

  it("activeSettingsCategory 深链：合法分类切换并清空；非法分类忽略", () => {
    mocks.wikiState.activeSettingsCategory = "network"
    const first = render(<SettingsView />)
    expect(screen.getByTestId("section-network")).toBeTruthy()
    expect(mocks.wikiState.setActiveSettingsCategory).toHaveBeenCalledWith(null)
    first.unmount()

    // 非法分类：active 保持默认 llm，仍清空 store 标记
    mocks.wikiState.activeSettingsCategory = "bogus"
    const second = render(<SettingsView />)
    expect(screen.getByTestId("section-llm")).toBeTruthy()
    expect(mocks.wikiState.setActiveSettingsCategory).toHaveBeenCalledWith(null)
    second.unmount()
  })

  it("loadSourceWatchConfig 成功：写入 store 与 draft", async () => {
    mocks.loadSourceWatchConfig.mockResolvedValue({ ...mocks.wikiState.sourceWatchConfig, enabled: true, autoIngest: true })
    render(<SettingsView />)
    await flushAsync()
    expect(mocks.wikiState.setSourceWatchConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, autoIngest: true }))
    clickNav("novel")
    expect(screen.getByTestId("draft-source-watch")).toHaveTextContent("true")
  })

  it("loadSourceWatchConfig 失败：回退 normalizeSourceWatchConfig()", async () => {
    mocks.loadSourceWatchConfig.mockRejectedValue(new Error("io"))
    render(<SettingsView />)
    await flushAsync()
    expect(mocks.normalizeSourceWatchConfig).toHaveBeenCalledWith()
    expect(mocks.wikiState.setSourceWatchConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
  })

  it("loadNovelConfig：config 写入 store 与 draft；null 跳过；reject 吞掉", async () => {
    mocks.loadNovelConfig.mockResolvedValue({ ...mocks.wikiState.novelConfig, contextTokenBudget: 777 } as NovelConfig)
    render(<SettingsView />)
    await flushAsync()
    expect(mocks.wikiState.setNovelConfig).toHaveBeenCalledWith(expect.objectContaining({ contextTokenBudget: 777 }))
    clickNav("novel")
    expect(screen.getByTestId("draft-novel-budget")).toHaveTextContent("777")

    // reject 被吞
    mocks.wikiState.setNovelConfig.mockClear()
    mocks.loadNovelConfig.mockRejectedValue(new Error("io"))
    const second = render(<SettingsView />)
    await flushAsync()
    expect(mocks.wikiState.setNovelConfig).not.toHaveBeenCalled()
    second.rerender(<SettingsView />)
    await flushAsync()
    second.unmount()
  })

  it("loadRerankConfig：config 写入 store 与 draft；null 跳过；reject 吞掉", async () => {
    mocks.loadRerankConfig.mockResolvedValue({ ...mocks.wikiState.rerankConfig, maxCandidates: 30 })
    render(<SettingsView />)
    await flushAsync()
    expect(mocks.wikiState.setRerankConfig).toHaveBeenCalledWith(expect.objectContaining({ maxCandidates: 30 }))
    clickNav("rerank")
    expect(screen.getByTestId("draft-max")).toHaveTextContent("30")

    mocks.wikiState.setRerankConfig.mockClear()
    mocks.loadRerankConfig.mockRejectedValue(new Error("io"))
    const second = render(<SettingsView />)
    await flushAsync()
    expect(mocks.wikiState.setRerankConfig).not.toHaveBeenCalled()
    second.rerender(<SettingsView />)
    await flushAsync()
    second.unmount()
  })

  it("卸载后 load 配置 resolve/reject 均不再写 store（cancelled 分支）", async () => {
    let resolveSw: (c: SourceWatchConfig) => void = () => {}
    let resolveNv: (c: NovelConfig | null) => void = () => {}
    let resolveRr: (c: RerankConfig | null) => void = () => {}
    let rejectSw: (e: unknown) => void = () => {}
    mocks.loadSourceWatchConfig.mockReturnValue(new Promise((r) => { resolveSw = r }))
    mocks.loadNovelConfig.mockReturnValue(new Promise((r) => { resolveNv = r }))
    mocks.loadRerankConfig.mockReturnValue(new Promise((r) => { resolveRr = r }))
    const { unmount } = render(<SettingsView />)
    unmount()
    resolveSw({ ...mocks.wikiState.sourceWatchConfig, enabled: true })
    resolveNv({ ...mocks.wikiState.novelConfig, contextTokenBudget: 1 } as NovelConfig)
    resolveRr({ ...mocks.wikiState.rerankConfig, maxCandidates: 1 })
    await flushAsync()
    expect(mocks.wikiState.setSourceWatchConfig).not.toHaveBeenCalled()
    expect(mocks.wikiState.setNovelConfig).not.toHaveBeenCalled()
    expect(mocks.wikiState.setRerankConfig).not.toHaveBeenCalled()

    // 卸载后 reject：catch 里 cancelled 分支（line 216）
    mocks.loadSourceWatchConfig.mockReturnValue(new Promise((_r, rj) => { rejectSw = rj }))
    const second = render(<SettingsView />)
    second.unmount()
    rejectSw(new Error("late-io"))
    await flushAsync()
    expect(mocks.wikiState.setSourceWatchConfig).not.toHaveBeenCalled()
  })

  it("initialDraft 缺省值：azure 版本/家族与 maxContextSize 的 ?? 兜底", async () => {
    mocks.wikiState.project = PROJECT
    mocks.wikiState.llmConfig = {
      ...mocks.wikiState.llmConfig,
      azureApiVersion: undefined,
      azureModelFamily: undefined,
      maxContextSize: undefined,
    }
    mocks.wikiState.multimodalConfig = {
      ...mocks.wikiState.multimodalConfig,
      azureApiVersion: undefined,
      azureModelFamily: undefined,
    }
    render(<SettingsView />)
    await flushAsync()
    clickNav("rerank")
    await clickAndFlush("set-provider-azure")
    await clickAndFlush("set-multimodal-azure")
    clickSave()
    await waitFor(() => expect(mocks.saveLlmConfig).toHaveBeenCalled())
    const llm = mocks.saveLlmConfig.mock.calls[0]?.[0] as { azureApiVersion: string; azureModelFamily: string; maxContextSize: number }
    expect(llm.azureApiVersion).toBe("2024-10-21")
    expect(llm.azureModelFamily).toBe("auto")
    expect(llm.maxContextSize).toBe(204800)
    const mm = mocks.saveMultimodalConfig.mock.calls[0]?.[0] as { azureApiVersion: string; azureModelFamily: string }
    expect(mm.azureApiVersion).toBe("2024-10-21")
    expect(mm.azureModelFamily).toBe("auto")
  })

  it("initialDraft displayPath：scheduledImport.path 优先 / 项目拼接 / 相对路径 / 绝对路径 / 空", () => {
    // 1) scheduledImport.path 优先
    mocks.wikiState.scheduledImportConfig.path = "/custom/path"
    const first = render(<SettingsView />)
    clickNav("network")
    expect(screen.getByTestId("draft-sched-path")).toHaveTextContent("/custom/path")
    first.unmount()

    // 2) 无 path 有项目 → {project}/raw/sources
    mocks.wikiState.scheduledImportConfig.path = ""
    mocks.wikiState.project = PROJECT
    const second = render(<SettingsView />)
    clickNav("network")
    expect(screen.getByTestId("draft-sched-path")).toHaveTextContent("/p/x/raw/sources")
    second.unmount()

    // 3) 相对 path + 项目 → 拼接
    mocks.wikiState.scheduledImportConfig.path = "raw/sources"
    const third = render(<SettingsView />)
    clickNav("network")
    expect(screen.getByTestId("draft-sched-path")).toHaveTextContent("/p/x/raw/sources")
    third.unmount()

    // 4) 绝对 path + 项目 → 原样
    mocks.wikiState.scheduledImportConfig.path = "/abs/path"
    const fourth = render(<SettingsView />)
    clickNav("network")
    expect(screen.getByTestId("draft-sched-path")).toHaveTextContent("/abs/path")
    fourth.unmount()

    // 5) Windows 盘符 path → 原样
    mocks.wikiState.scheduledImportConfig.path = "C:\\novel\\raw"
    const fifth = render(<SettingsView />)
    clickNav("network")
    expect(screen.getByTestId("draft-sched-path")).toHaveTextContent("C:\\novel\\raw")
    fifth.unmount()

    // 6) 无 path 无项目 → 空
    mocks.wikiState.scheduledImportConfig.path = ""
    mocks.wikiState.project = null
    const sixth = render(<SettingsView />)
    clickNav("network")
    expect(screen.getByTestId("draft-sched-path")).toHaveTextContent("")
    sixth.unmount()
  })

  it("store 变化触发 draft 重同步：保留 uiLanguage、更新其他字段", async () => {
    const { rerender } = render(<SettingsView />)
    clickNav("interface")
    await clickAndFlush("set-ui-en")
    expect(screen.getByTestId("draft-ui-language")).toHaveTextContent("en")

    mocks.wikiState.llmConfig = { ...mocks.wikiState.llmConfig, provider: "ollama" }
    rerender(<SettingsView />)
    await flushAsync()
    clickNav("rerank")
    expect(screen.getByTestId("draft-provider")).toHaveTextContent("ollama")
    clickNav("interface")
    expect(screen.getByTestId("draft-ui-language")).toHaveTextContent("en")
  })

  it("handleSave 全链路：写 store + 磁盘 + 停止文件同步/定时导入 + 保存标记", async () => {
    mocks.wikiState.project = PROJECT
    render(<SettingsView />)
    await flushAsync()

    clickSave()
    await waitFor(() => expect(mocks.saveLlmConfig).toHaveBeenCalled())

    const newLlm = {
      provider: "openai",
      apiKey: "key-1",
      model: "gpt-4o",
      ollamaUrl: "http://127.0.0.1:11434",
      customEndpoint: "",
      azureApiVersion: undefined,
      azureModelFamily: undefined,
      maxContextSize: 204800,
      apiMode: undefined,
      reasoning: undefined,
      localCliIsolation: false,
    }
    const newEmbed = {
      enabled: true,
      endpoint: "http://localhost:6333",
      apiKey: "",
      model: "bge",
      outputDimensionality: 1024,
      maxChunkChars: 1000,
      overlapChunkChars: 200,
    }
    const newRerank = {
      enabled: false,
      useMainLlm: true,
      provider: "custom",
      apiKey: "",
      model: "",
      ollamaUrl: "http://127.0.0.1:11434",
      customEndpoint: "",
      apiMode: "chat_completions",
      maxCandidates: 12,
    }
    const newMultimodal = {
      enabled: false,
      useMainLlm: true,
      provider: "openai",
      apiKey: "",
      model: "",
      ollamaUrl: "",
      customEndpoint: "",
      azureApiVersion: undefined,
      azureModelFamily: undefined,
      apiMode: undefined,
      concurrency: 4,
    }
    const newProxy = { enabled: false, url: "", bypassLocal: true }
    const newSourceWatch = mocks.wikiState.sourceWatchConfig
    // initialDraft：scheduledImport.path 为空 + 项目存在 → displayPath = `${projectPath}/raw/sources`
    const newScheduledImport = { enabled: false, path: "/p/x/raw/sources", interval: 60, lastScan: 0 }

    expect(mocks.wikiState.setLlmConfig).toHaveBeenCalledWith(newLlm)
    expect(mocks.saveLlmConfig).toHaveBeenCalledWith(newLlm)
    expect(mocks.wikiState.setEmbeddingConfig).toHaveBeenCalledWith(newEmbed)
    expect(mocks.saveEmbeddingConfig).toHaveBeenCalledWith(newEmbed)
    expect(mocks.wikiState.setRerankConfig).toHaveBeenCalledWith(newRerank)
    expect(mocks.saveRerankConfig).toHaveBeenCalledWith(newRerank, "p1", "/p/x")
    expect(mocks.wikiState.setMultimodalConfig).toHaveBeenCalledWith(newMultimodal)
    expect(mocks.saveMultimodalConfig).toHaveBeenCalledWith(newMultimodal)
    expect(mocks.wikiState.setProxyConfig).toHaveBeenCalledWith(newProxy)
    expect(mocks.saveProxyConfig).toHaveBeenCalledWith(newProxy)
    expect(mocks.wikiState.setSourceWatchConfig).toHaveBeenCalledWith(newSourceWatch)
    expect(mocks.saveSourceWatchConfig).toHaveBeenCalledWith(newSourceWatch, "p1", "/p/x")
    expect(mocks.stopProjectFileSync).toHaveBeenCalledTimes(1)
    expect(mocks.startProjectFileSync).not.toHaveBeenCalled()
    expect(mocks.wikiState.setScheduledImportConfig).toHaveBeenCalledWith(newScheduledImport)
    expect(mocks.saveScheduledImportConfig).toHaveBeenCalledWith("/p/x", newScheduledImport)
    expect(mocks.stopScheduledImport).toHaveBeenCalledTimes(1)
    expect(mocks.startScheduledImport).not.toHaveBeenCalled()
    expect(mocks.wikiState.setRevisionFeedbackWindowConfig).toHaveBeenCalledWith(mocks.wikiState.revisionFeedbackWindowConfig)
    expect(mocks.saveRevisionFeedbackWindowConfig).toHaveBeenCalledWith(mocks.wikiState.revisionFeedbackWindowConfig, "p1", "/p/x")
    expect(mocks.wikiState.setNovelConfig).toHaveBeenCalledWith(mocks.wikiState.novelConfig)
    expect(mocks.saveNovelConfig).toHaveBeenCalledWith(mocks.wikiState.novelConfig, "p1", "/p/x")
    expect(mocks.wikiState.setOutputLanguage).toHaveBeenCalledWith("zh-CN")
    expect(mocks.saveOutputLanguage).toHaveBeenCalledWith("zh-CN", "p1")
    expect(mocks.chatState.setMaxHistoryMessages).toHaveBeenCalledWith(50)
    expect(mocks.saveMaxHistoryMessages).toHaveBeenCalledWith(50, "p1", "/p/x")
    expect(mocks.wikiState.setUiFontSizeScale).toHaveBeenCalledWith(1)
    expect(mocks.saveUiFontSizeScale).toHaveBeenCalledWith(1, "p1", "/p/x")
    // uiLanguage 未变 → 不切换语言
    expect(mocks.changeLanguage).not.toHaveBeenCalled()
    expect(mocks.saveLanguage).not.toHaveBeenCalled()

    // 保存标记 + 2s 后复位
    expect(screen.getByText("settings.savedTick")).toBeTruthy()
    expect(screen.getByText("settings.saved")).toBeTruthy()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2100))
    })
    expect(screen.getByText("settings.changeHint")).toBeTruthy()
    expect(screen.getByText("settings.save")).toBeTruthy()
  })

  it("handleSave azure/custom 分支：azure 版本号 trim + custom apiMode + 各 clamp", async () => {
    mocks.wikiState.project = PROJECT
    render(<SettingsView />)
    await flushAsync()
    clickNav("rerank")

    // rerank maxCandidates 1 → clamp 3
    await clickAndFlush("set-max-1")
    clickSave()
    await waitFor(() => expect(mocks.saveRerankConfig).toHaveBeenCalled())
    const newRerank = mocks.saveRerankConfig.mock.calls[0]?.[0] as { maxCandidates: number }
    expect(newRerank.maxCandidates).toBe(3)
    // 50 → clamp 30
    await clickAndFlush("set-max-50")
    clickSave()
    await waitFor(() => expect(mocks.saveRerankConfig).toHaveBeenCalledTimes(2))
    expect((mocks.saveRerankConfig.mock.calls[1]?.[0] as { maxCandidates: number }).maxCandidates).toBe(30)
    // 0 → || 12 → 12
    await clickAndFlush("set-max-0")
    clickSave()
    await waitFor(() => expect(mocks.saveRerankConfig).toHaveBeenCalledTimes(3))
    expect((mocks.saveRerankConfig.mock.calls[2]?.[0] as { maxCandidates: number }).maxCandidates).toBe(12)

    // provider azure：azureApiVersion.trim + azureModelFamily
    await clickAndFlush("set-provider-azure")
    await clickAndFlush("set-azure-version")
    await clickAndFlush("set-multimodal-azure")
    await clickAndFlush("set-mm-azure-version")
    clickSave()
    await waitFor(() => expect(mocks.saveLlmConfig).toHaveBeenCalledTimes(4))
    const azureLlm = mocks.saveLlmConfig.mock.calls[3]?.[0] as { provider: string; azureApiVersion: string; azureModelFamily: string; apiMode: unknown }
    expect(azureLlm.provider).toBe("azure")
    expect(azureLlm.azureApiVersion).toBe("2024-10-21")
    expect(azureLlm.azureModelFamily).toBe("auto")
    expect(azureLlm.apiMode).toBeUndefined()
    const azureMm = mocks.saveMultimodalConfig.mock.calls[3]?.[0] as { azureApiVersion: string; azureModelFamily: string; apiMode: unknown }
    expect(azureMm.azureApiVersion).toBe("2025-01-01")
    expect(azureMm.azureModelFamily).toBe("auto")
    expect(azureMm.apiMode).toBeUndefined()

    // provider custom：apiMode 保留（draft.apiMode）
    await clickAndFlush("set-provider-custom")
    await clickAndFlush("set-llm-mode")
    await clickAndFlush("set-multimodal-custom")
    await clickAndFlush("set-mm-mode")
    clickSave()
    await waitFor(() => expect(mocks.saveLlmConfig).toHaveBeenCalledTimes(5))
    const customLlm = mocks.saveLlmConfig.mock.calls[4]?.[0] as { apiMode: unknown }
    expect(customLlm.apiMode).toBe("chat_completions")
    const customMm = mocks.saveMultimodalConfig.mock.calls[4]?.[0] as { apiMode: unknown }
    expect(customMm.apiMode).toBe("chat_completions")

    // rerank 非 custom：apiMode 清空（6 次保存：max1/max50/max0/azure/custom/non-custom）
    await clickAndFlush("set-rerank-non-custom")
    clickSave()
    await waitFor(() => expect(mocks.saveRerankConfig).toHaveBeenCalledTimes(6))
    expect((mocks.saveRerankConfig.mock.calls[5]?.[0] as { apiMode: unknown }).apiMode).toBeUndefined()
  })

  it("handleSave multimodal concurrency：0→||4→4、20→16、4→4（clamp 为 Math 调用无分支）", async () => {
    mocks.wikiState.project = PROJECT
    render(<SettingsView />)
    await flushAsync()
    clickNav("rerank")
    await clickAndFlush("set-conc-0")
    clickSave()
    await waitFor(() => expect(mocks.saveMultimodalConfig).toHaveBeenCalledTimes(1))
    // 源码：Math.max(1, Math.min(16, draft.multimodalConcurrency || 4)) — 0 走 || 4
    expect((mocks.saveMultimodalConfig.mock.calls[0]?.[0] as { concurrency: number }).concurrency).toBe(4)
    await clickAndFlush("set-conc-20")
    clickSave()
    await waitFor(() => expect(mocks.saveMultimodalConfig).toHaveBeenCalledTimes(2))
    expect((mocks.saveMultimodalConfig.mock.calls[1]?.[0] as { concurrency: number }).concurrency).toBe(16)
    await clickAndFlush("set-conc-4")
    clickSave()
    await waitFor(() => expect(mocks.saveMultimodalConfig).toHaveBeenCalledTimes(3))
    expect((mocks.saveMultimodalConfig.mock.calls[2]?.[0] as { concurrency: number }).concurrency).toBe(4)
  })

  it("handleSave：proxy url trim + Tauri invoke 分支（成功与失败告警）", async () => {
    mocks.wikiState.project = PROJECT
    render(<SettingsView />)
    await flushAsync()
    clickNav("network")
    await clickAndFlush("set-proxy-url")
    clickSave()
    await waitFor(() => expect(mocks.saveProxyConfig).toHaveBeenCalled())
    const savedProxy = mocks.saveProxyConfig.mock.calls[0]?.[0] as { url: string }
    expect(savedProxy.url).toBe("http://127.0.0.1:8756")

    // 非 Tauri 不 invoke
    expect(mocks.invoke).not.toHaveBeenCalled()

    // Tauri 成功
    mocks.isTauri.mockReturnValue(true)
    clickSave()
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalled())
    expect(mocks.invoke).toHaveBeenCalledWith("set_proxy_env", { config: savedProxy })

    // Tauri 失败告警
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.invoke.mockRejectedValue(new Error("no rust"))
    clickSave()
    await waitFor(() => expect(warnSpy).toHaveBeenCalled())
    expect(warnSpy).toHaveBeenCalledWith(
      "[settings] live network update failed; restart will still apply:",
      expect.any(Error),
    )
  })

  it("handleSave：sourceWatch 启用时 startProjectFileSync；失败 console.error", async () => {
    mocks.wikiState.project = PROJECT
    render(<SettingsView />)
    await flushAsync()
    clickNav("novel")
    await clickAndFlush("source-watch-on")
    clickSave()
    await waitFor(() => expect(mocks.startProjectFileSync).toHaveBeenCalled())
    const newSourceWatch = mocks.saveSourceWatchConfig.mock.calls[0]?.[0] as SourceWatchConfig

    expect(mocks.startProjectFileSync).toHaveBeenCalledWith(PROJECT, newSourceWatch)
    expect(mocks.stopProjectFileSync).not.toHaveBeenCalled()

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.startProjectFileSync.mockRejectedValue(new Error("sync-fail"))
    clickSave()
    await waitFor(() => expect(errorSpy).toHaveBeenCalled())
    expect(errorSpy).toHaveBeenCalledWith("Failed to start project file sync:", expect.any(Error))
  })

  it("handleSave：定时导入启用+路径时 startScheduledImport；禁用或无路径时停止", async () => {
    mocks.wikiState.project = PROJECT
    render(<SettingsView />)
    await flushAsync()
    clickNav("network")
    await clickAndFlush("sched-on")
    await clickAndFlush("sched-path")
    await clickAndFlush("sched-interval-0")
    clickSave()
    await waitFor(() => expect(mocks.startScheduledImport).toHaveBeenCalled())
    // 源码：interval = Math.max(1, Math.min(1440, draft.scheduledImportInterval || 60)) — 0 走 || 60
    const saved = mocks.saveScheduledImportConfig.mock.calls[0]?.[1] as { interval: number; enabled: boolean; path: string }
    expect(saved.interval).toBe(60)
    expect(saved.enabled).toBe(true)
    expect(saved.path).toBe("raw/sources")
    expect(mocks.startScheduledImport).toHaveBeenCalledWith(PROJECT, saved)

    // interval 2000 → clamp 1440
    await clickAndFlush("sched-interval-2000")
    clickSave()
    await waitFor(() => expect(mocks.saveScheduledImportConfig).toHaveBeenCalledTimes(2))
    expect((mocks.saveScheduledImportConfig.mock.calls[1]?.[1] as { interval: number }).interval).toBe(1440)

    // 禁用 → stopScheduledImport（前两次保存均启用了定时导入）
    await clickAndFlush("sched-off")
    clickSave()
    await waitFor(() => expect(mocks.stopScheduledImport).toHaveBeenCalled())
    expect(mocks.startScheduledImport).toHaveBeenCalledTimes(2)

    // 启用但无路径 → stopScheduledImport
    mocks.stopScheduledImport.mockClear()
    await clickAndFlush("sched-on")
    await clickAndFlush("sched-clear-path")
    clickSave()
    await waitFor(() => expect(mocks.stopScheduledImport).toHaveBeenCalled())
    expect(mocks.startScheduledImport).toHaveBeenCalledTimes(2)
  })

  it("handleSave：uiLanguage 变更触发 changeLanguage + saveLanguage", async () => {
    mocks.wikiState.project = PROJECT
    render(<SettingsView />)
    await flushAsync()
    clickNav("interface")
    await clickAndFlush("set-ui-en")
    clickSave()
    await waitFor(() => expect(mocks.changeLanguage).toHaveBeenCalledWith("en"))
    expect(mocks.saveLanguage).toHaveBeenCalledWith("en")
  })

  it("handleSave 无项目：跳过文件同步与定时导入落盘，其余照常", async () => {
    render(<SettingsView />)
    await flushAsync()
    clickSave()
    await waitFor(() => expect(mocks.saveLlmConfig).toHaveBeenCalled())
    expect(mocks.saveScheduledImportConfig).not.toHaveBeenCalled()
    expect(mocks.startScheduledImport).not.toHaveBeenCalled()
    expect(mocks.stopScheduledImport).not.toHaveBeenCalled()
    expect(mocks.startProjectFileSync).not.toHaveBeenCalled()
    expect(mocks.stopProjectFileSync).not.toHaveBeenCalled()
    expect(mocks.saveSourceWatchConfig).toHaveBeenCalledWith(mocks.wikiState.sourceWatchConfig, undefined, undefined)
    expect(mocks.saveNovelConfig).toHaveBeenCalledWith(mocks.wikiState.novelConfig, undefined, undefined)
  })
})

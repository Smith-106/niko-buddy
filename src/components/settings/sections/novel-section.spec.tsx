// @vitest-environment jsdom
/**
 * W4D4 coverage campaign — NovelSection 全口径 100%。
 * 所有 store / 外部依赖均 vi.mock，参考 src/App.spec.tsx 的 vi.hoisted 可写 state 模式。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { NovelSection } from "./novel-section"
import type { SettingsDraft } from "../settings-types"

const mocks = vi.hoisted(() => {
  const wikiState: {
    setNovelConfig: ReturnType<typeof vi.fn>
    llmConfig: Record<string, unknown>
    aiChatModel: string
    project: { id: string; path: string } | null
  } = {
    setNovelConfig: vi.fn(),
    llmConfig: { provider: "openai", apiKey: "k", model: "gpt" },
    aiChatModel: "chat-model",
    project: { id: "p1", path: "/p1" },
  }
  return {
    wikiState,
    t: vi.fn(
      (key: string, opts?: { defaultValue?: string; message?: string; model?: string }) => {
        if (opts?.defaultValue !== undefined) return opts.defaultValue
        if (opts?.message !== undefined) return `${key}:${opts.message}`
        if (opts?.model !== undefined) return `${key}:${opts.model}`
        return key
      },
    ),
    testNovelModel: vi.fn(async () => ({ model: "m", content: "c", usedFallbackModel: false })),
    saveNovelConfig: vi.fn(async () => {}),
    loadAntiAiTelemetryConsent: vi.fn(async () => false),
    saveAntiAiTelemetryConsent: vi.fn(async () => {}),
    applyAntiAiTelemetryConsentOnProjectOpen: vi.fn(async () => {}),
    selectModelChanged: vi.fn(),
    runKbShadowArmsIfConsented: vi.fn(async () => ({ written: 68, failed: 0, skipped: true })),
    goldenKbShadowCases: vi.fn(() => [
      { caseId: "GOLDEN-01", query: "q1", obligationCoverage: null, scaleViolation: false, minHits: 1 },
    ]),
    goldenCoverageOf: vi.fn(() => 1),
    toastError: vi.fn(),
  }
})

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: mocks.toastError, info: vi.fn() },
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
      useWikiStore: Object.assign(
        (selector: (s: typeof mocks.wikiState) => unknown) => selector(mocks.wikiState),
        { getState: () => mocks.wikiState },
      ),
    
  }
})

vi.mock("@/lib/project-store", () => ({
  saveNovelConfig: mocks.saveNovelConfig,
}))

vi.mock("@/lib/novel/anti-ai-telemetry-wiring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/anti-ai-telemetry-wiring")>()
  return {
    ...actual,
      loadAntiAiTelemetryConsent: mocks.loadAntiAiTelemetryConsent,
      saveAntiAiTelemetryConsent: mocks.saveAntiAiTelemetryConsent,
      applyAntiAiTelemetryConsentOnProjectOpen: mocks.applyAntiAiTelemetryConsentOnProjectOpen,
    
  }
})

vi.mock("@/lib/novel/novel-model-test", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/novel-model-test")>()
  return {
    ...actual,
      testNovelModel: mocks.testNovelModel,
    
  }
})

vi.mock("@/lib/novel/kb-shadow-wiring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/kb-shadow-wiring")>()
  return {
    ...actual,
      runKbShadowArmsIfConsented: mocks.runKbShadowArmsIfConsented,
      goldenKbShadowCases: mocks.goldenKbShadowCases,
      goldenCoverageOf: mocks.goldenCoverageOf,
    
  }
})

vi.mock("@/components/chat/chat-model-selector", () => ({
  ChatModelSelector: (props: { value: string; onChange: (m: string) => void; disabled?: boolean }) => {
    mocks.selectModelChanged(props.disabled === true ? "disabled" : props.value)
    return (
      <select
        data-testid={`model-select-${props.value || "empty"}`}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      >
        <option value="">（跟随）</option>
        <option value="model-a">model-a</option>
      </select>
    )
  },
}))

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: (props: { render?: React.ReactElement; children?: React.ReactNode }) => (
    <span>{props.render ?? props.children}</span>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  ),
}))

// ── draft builder ────────────────────────────────────────────────────────────

let currentDraft: SettingsDraft

const setDraft = vi.fn((key: keyof SettingsDraft, value: unknown) => {
  ;(currentDraft as unknown as Record<string, unknown>)[key] = value
})

function buildDraft(): SettingsDraft {
  return {
    provider: "openai",
    apiKey: "k",
    model: "m",
    ollamaUrl: "",
    customEndpoint: "",
    azureApiVersion: "",
    azureModelFamily: "openai",
    maxContextSize: 128000,
    apiMode: undefined,
    reasoning: undefined,
    localCliIsolation: false,
    embeddingEnabled: true,
    embeddingEndpoint: "",
    embeddingApiKey: "",
    embeddingModel: "",
    embeddingOutputDimensionality: undefined,
    embeddingMaxChunkChars: undefined,
    embeddingOverlapChunkChars: undefined,
    multimodalEnabled: false,
    multimodalUseMainLlm: true,
    multimodalProvider: "openai",
    multimodalApiKey: "",
    multimodalModel: "",
    multimodalOllamaUrl: "",
    multimodalCustomEndpoint: "",
    multimodalAzureApiVersion: "",
    multimodalAzureModelFamily: "openai",
    multimodalApiMode: undefined,
    multimodalConcurrency: 1,
    outputLanguage: "Chinese",
    maxHistoryMessages: 4,
    proxyEnabled: false,
    proxyUrl: "",
    proxyBypassLocal: true,
    scheduledImportEnabled: false,
    scheduledImportPath: "",
    scheduledImportInterval: 30,
    uiLanguage: "zh-CN",
    uiFontSizeScale: 1,
    sourceWatchConfig: { enabled: false, watchPath: "", watchInterval: 5 },
    revisionFeedbackWindowConfig: {
      currentChapterIncludeShouldImprove: true,
      previousChapterCarryEnabled: true,
      lookbackChapterCount: 3,
      lookbackIncludeMustFixOnly: true,
    },
    novelConfig: {
      contextTokenBudget: 4000,
      recentSummaryWindow: 8,
      searchTopK: 5,
      chapterTargetChars: 3000,
      autoIngestOnSave: true,
      autoExtractOnImport: true,
      reviewBeforeSave: false,
      deepPreviousChaptersAnalysis: false,
      deepChapterReview: true,
      literaryPolishAfterGate: false,
      residualCampaignEnabled: false,
      residualCampaignIncludeFreezeChapters: false,
      stageJournalEnabled: true,
      autoPlanningEnabled: true,
      reviewReasoningEffort: "high",
      // TASK-009：`writingModel` 已从 NovelConfig 删除，此夹具不再保留该键
      // （旧键残留会在 typecheck 时因为 NovelConfig 无此字段而红）。
      reviewModel: "",
      summaryModel: "",
      extractModel: "",
      communitySummaryEnabled: true,
      communitySummaryInterval: 7,
      communitySummaryAsync: true,
      autoGenerateChapterTitle: true,
      exemplarEnabled: true,
      relatedChaptersEnabled: true,
      sceneBreakdownEnabled: false,
      conditionalRoutingEnabled: true,
      inspectorEnabled: true,
      temporalFactsEnabled: true,
      entityBoostEnabled: true,
      entityBoostWeight: 0.4,
      stateDeltaLightCheckEnabled: true,
      stateDeltaBlocksTrackA: false,
      outlineThrillSoftGateEnabled: true,
    },
    rerankConfig: {
      enabled: false,
      provider: "openai",
      apiKey: "",
      baseUrl: "",
      model: "",
      topK: 8,
      threshold: 0.3,
    },
  } as unknown as SettingsDraft
}

function renderSection(): { rerender: () => void } {
  const view = render(<NovelSection draft={currentDraft} setDraft={setDraft} />)
  return {
    rerender: () => view.rerender(<NovelSection draft={currentDraft} setDraft={setDraft} />),
  }
}

/** 找到标签所在行（flex items-center justify-between），返回行内 NovelToggle 按钮。 */
function toggleButtonFor(labelText: string): HTMLButtonElement {
  const el = screen.getByText(labelText)
  let node: HTMLElement | null = el
  while (node && !String(node.className).includes("justify-between")) {
    node = node.parentElement
  }
  // NovelToggle 按钮特征 class：h-6 w-11（避免命中行内 tooltip 帮助按钮）
  const btn = node?.querySelector('button[class*="h-6 w-11"]') as HTMLButtonElement | null
  if (!btn) throw new Error(`toggle not found for ${labelText}`)
  return btn
}

/** 找到模型项 wrapper（space-y-2 容器）。 */
function modelRow(labelText: string): HTMLElement {
  const el = screen.getByText(labelText)
  let node: HTMLElement | null = el
  while (node && !String(node.className).includes("space-y-2")) {
    node = node.parentElement
  }
  if (!node) throw new Error(`model row not found for ${labelText}`)
  return node
}

/** CommitNumberInput：输入后失焦才提交 */
function commitValue(input: HTMLElement, value: string): void {
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

/** 按 label 关联取数字输入（NovelNumberField 的 Label htmlFor ↔ input id）。 */
function numberInputFor(labelText: string): HTMLInputElement {
  return screen.getByLabelText(labelText) as HTMLInputElement
}

/** 最近一次落盘的完整 novelConfig（saveNovelConfig 第一参）。 */
function lastSavedNovelConfig(): Record<string, unknown> {
  const calls = mocks.saveNovelConfig.mock.calls as unknown as Array<[Record<string, unknown>]>
  return calls[calls.length - 1][0]
}

async function clickToggle(labelText: string): Promise<void> {
  const before = mocks.saveNovelConfig.mock.calls.length
  const btn = toggleButtonFor(labelText)
  fireEvent.click(btn)
  await waitFor(() => {
    expect(mocks.saveNovelConfig.mock.calls.length).toBeGreaterThan(before)
  })
}
afterEach(() => {
  cleanup()
})

beforeEach(() => {
  setupDomGlobals()
  vi.clearAllMocks()
  currentDraft = buildDraft()
  mocks.wikiState.setNovelConfig.mockClear()
  mocks.wikiState.aiChatModel = "chat-model"
  mocks.wikiState.project = { id: "p1", path: "/p1" }
  mocks.testNovelModel.mockResolvedValue({ model: "m", content: "c", usedFallbackModel: false })
  mocks.saveNovelConfig.mockClear()
  mocks.loadAntiAiTelemetryConsent.mockReset()
  mocks.loadAntiAiTelemetryConsent.mockResolvedValue(false)
  mocks.saveAntiAiTelemetryConsent.mockReset()
  mocks.saveAntiAiTelemetryConsent.mockResolvedValue(undefined)
  mocks.applyAntiAiTelemetryConsentOnProjectOpen.mockReset()
  mocks.applyAntiAiTelemetryConsentOnProjectOpen.mockResolvedValue(undefined)
})

describe("NovelSection", () => {
  it("渲染标题、说明、各区块标签与 tooltip 提示", () => {
    renderSection()
    expect(screen.getByText("小说设置")).toBeInTheDocument()
    expect(screen.getByText(/项目级写作模式和小说工作流/)).toBeInTheDocument()
    expect(screen.getByText("novel.settings.title")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.recentSummaryWindow")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.searchTopK")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.contextTokenBudget")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.chatHistoryLength")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.chapterTargetChars")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.reviewModel")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.summaryModel")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.extractModel")).toBeInTheDocument()
    // tooltip 内容（hint 文案）随行渲染
    expect(screen.getByText("novel.settings.recentSummaryWindowHint")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.searchTopKHint")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.feedbackWindowLookbackChapterCountHelp")).toBeInTheDocument()
    // 反馈窗口区块
    expect(screen.getByText("修改反馈窗口")).toBeInTheDocument()
    expect(screen.getByText("回溯章节数量")).toBeInTheDocument()
    expect(screen.getByText("包含当前章节改进建议")).toBeInTheDocument()
    expect(screen.getByText("读取上一章延续事项")).toBeInTheDocument()
    expect(screen.getByText("回溯章节仅保留必须修复项")).toBeInTheDocument()
    // KB 路由区（三 flag + 实体加权）+ 内容装配区 + 治理只读区
    expect(screen.getByText("novel.settings.retrievalRoutingSection")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.dualKbRoutingEnabled")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.usefulnessRerankEnabled")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.hardInjectEnabled")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.entityBoostWeight")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.contentAssemblySection")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.exemplarEnabled")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.relatedChaptersEnabled")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.referenceEnabled")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.sceneBreakdownEnabled")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.conditionalRoutingEnabled")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.inspectorEnabled")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.stateDeltaBlocksTrackA")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.governanceSection")).toBeInTheDocument()
    // DEC-02: trustFilterEnabled 徽章改开关（不再只读）；decay/supersession 两个死字段已删
    expect(screen.getByText("novel.settings.trustFilterEnabled")).toBeInTheDocument()
    expect(screen.queryByText("novel.settings.decayEnabledReadonly")).not.toBeInTheDocument()
    expect(screen.queryByText("novel.settings.supersessionFilterEnabledReadonly")).not.toBeInTheDocument()
    expect(screen.queryByText("novel.settings.governanceBadgeNotWired")).not.toBeInTheDocument()
    // R5 影子采集区
    expect(screen.getByText("novel.settings.kbShadowCollectionSection")).toBeInTheDocument()
    expect(screen.getByText("novel.settings.kbShadowRunButton")).toBeInTheDocument()
  })

  it("recentSummaryWindow 输入：失焦提交，上下限钳制", async () => {
    const { rerender } = renderSection()
    let input = screen.getByDisplayValue("8")
    commitValue(input, "50")
    await waitFor(() => expect(currentDraft.novelConfig.recentSummaryWindow).toBe(30))
    expect(mocks.wikiState.setNovelConfig).toHaveBeenCalledWith({ recentSummaryWindow: 30 })
    expect(mocks.saveNovelConfig).toHaveBeenCalledWith(currentDraft.novelConfig, "p1", "/p1")

    rerender()
    input = screen.getByDisplayValue("30")
    commitValue(input, "0")
    await waitFor(() => expect(currentDraft.novelConfig.recentSummaryWindow).toBe(1))
  })

  it("searchTopK 输入：上限钳制；清空后失焦还原原值且不写盘", async () => {
    const { rerender } = renderSection()
    let input = screen.getByDisplayValue("5")
    commitValue(input, "100")
    await waitFor(() => expect(currentDraft.novelConfig.searchTopK).toBe(20))

    rerender()
    const saves = mocks.saveNovelConfig.mock.calls.length
    input = screen.getByDisplayValue("20")
    commitValue(input, "")
    expect(currentDraft.novelConfig.searchTopK).toBe(20)
    expect(screen.getByDisplayValue("20")).toBeInTheDocument()
    expect(mocks.saveNovelConfig.mock.calls.length).toBe(saves)
  })

  it("A10 数字框：逐键输入不写盘，失焦才提交一次", async () => {
    renderSection()
    const input = screen.getByDisplayValue("8")
    fireEvent.change(input, { target: { value: "1" } })
    fireEvent.change(input, { target: { value: "12" } })
    expect(mocks.saveNovelConfig).not.toHaveBeenCalled()
    expect(mocks.wikiState.setNovelConfig).not.toHaveBeenCalled()
    fireEvent.blur(input)
    await waitFor(() => expect(mocks.saveNovelConfig).toHaveBeenCalledTimes(1))
    expect(mocks.wikiState.setNovelConfig).toHaveBeenCalledWith({ recentSummaryWindow: 12 })
  })

  it("contextTokenBudget 输入：上下限钳制，清空还原", async () => {
    const { rerender } = renderSection()
    let input = screen.getByDisplayValue("4000")
    commitValue(input, "-5")
    await waitFor(() => expect(currentDraft.novelConfig.contextTokenBudget).toBe(0))

    rerender()
    input = screen.getByDisplayValue("0")
    commitValue(input, "999999")
    await waitFor(() => expect(currentDraft.novelConfig.contextTokenBudget).toBe(200000))

    rerender()
    input = screen.getByDisplayValue("200000")
    commitValue(input, "")
    expect(currentDraft.novelConfig.contextTokenBudget).toBe(200000)
  })

  it("chapterTargetChars 输入：上下限钳制，清空还原", async () => {
    const { rerender } = renderSection()
    let input = screen.getByDisplayValue("3000")
    commitValue(input, "100")
    await waitFor(() => expect(currentDraft.novelConfig.chapterTargetChars).toBe(500))

    rerender()
    input = screen.getByDisplayValue("500")
    commitValue(input, "25000")
    await waitFor(() => expect(currentDraft.novelConfig.chapterTargetChars).toBe(20000))

    rerender()
    input = screen.getByDisplayValue("20000")
    commitValue(input, "")
    expect(currentDraft.novelConfig.chapterTargetChars).toBe(20000)
  })

  it("maxHistoryMessages 按钮：切换 draft 值", () => {
    renderSection()
    fireEvent.click(screen.getByText("6"))
    expect(currentDraft.maxHistoryMessages).toBe(6)
    fireEvent.click(screen.getByText("10"))
    expect(currentDraft.maxHistoryMessages).toBe(10)
  })

  it("reviewReasoningEffort 按钮：切换等级（含 ?? 回退）", async () => {
    renderSection()
    fireEvent.click(screen.getByText("settings.sections.llm.reasoning.low"))
    await waitFor(() => expect(currentDraft.novelConfig.reviewReasoningEffort).toBe("low"))
    fireEvent.click(screen.getByText("settings.sections.llm.reasoning.medium"))
    await waitFor(() => expect(currentDraft.novelConfig.reviewReasoningEffort).toBe("medium"))
  })

  it("reviewReasoningEffort 为 undefined 时 ?? 回退 high 仍高亮", () => {
    ;(currentDraft.novelConfig as { reviewReasoningEffort?: string }).reviewReasoningEffort = undefined
    renderSection()
    const highBtn = screen.getByText("settings.sections.llm.reasoning.high")
    expect(String(highBtn.className)).toContain("border-primary")
  })

  it("NovelToggle 全部开关：切换并持久化到 store 与磁盘", async () => {
    const { rerender } = renderSection()
    const cases: Array<[string, () => boolean]> = [
      ["novel.settings.autoIngestOnSave", () => currentDraft.novelConfig.autoIngestOnSave],
      ["novel.settings.reviewBeforeSave", () => currentDraft.novelConfig.reviewBeforeSave],
      ["novel.settings.deepPreviousChaptersAnalysis", () => currentDraft.novelConfig.deepPreviousChaptersAnalysis],
      ["novel.settings.deepChapterReview", () => currentDraft.novelConfig.deepChapterReview],
      ["novel.settings.literaryPolishAfterGate", () => !!currentDraft.novelConfig.literaryPolishAfterGate],
      // 组件 12：autoGenerateChapterTitle 曾是死字段（UI 无处可改），现已由 ensureChapterTitle 消费，此断言防止控件回退。
      ["novel.settings.autoGenerateChapterTitle", () => !!currentDraft.novelConfig.autoGenerateChapterTitle],
      ["novel.settings.residualCampaignEnabled", () => !!currentDraft.novelConfig.residualCampaignEnabled],
      // R9（Round-9 用户可感知开关）：stageJournalEnabled 默认开，用 !== false 读值（与 novel-section.tsx 一致）。
      ["novel.settings.stageJournalEnabled", () => currentDraft.novelConfig.stageJournalEnabled !== false],
      ["novel.settings.temporalFactsEnabled", () => currentDraft.novelConfig.temporalFactsEnabled],
      ["novel.settings.entityBoostEnabled", () => currentDraft.novelConfig.entityBoostEnabled !== false],
      ["novel.settings.stateDeltaLightCheckEnabled", () => currentDraft.novelConfig.stateDeltaLightCheckEnabled !== false],
      ["novel.settings.outlineThrillSoftGateEnabled", () => currentDraft.novelConfig.outlineThrillSoftGateEnabled !== false],
    ]
    for (const [label, read] of cases) {
      const before = read()
      await clickToggle(label)
      expect(read()).toBe(!before)
      rerender()
    }
    // 验证确实写入 store（每个 toggle 至少一次 patch）
    expect(mocks.wikiState.setNovelConfig).toHaveBeenCalled()
    expect(mocks.saveNovelConfig).toHaveBeenCalled()
  })

  // DEC-02: trustFilterEnabled 从只读徽章改为真实开关；写入经 persistNovelConfigPatch（逐键 patch 落盘）。
  it("DEC-02 trustFilterEnabled 开关：默认关，点击写入 trustFilterEnabled=true 并落盘", async () => {
    const { rerender } = renderSection()
    const btn = toggleButtonFor("novel.settings.trustFilterEnabled")
    expect(btn.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(btn)
    await waitFor(() => expect(currentDraft.novelConfig.trustFilterEnabled).toBe(true))
    expect(mocks.wikiState.setNovelConfig).toHaveBeenCalledWith({ trustFilterEnabled: true })
    expect(mocks.saveNovelConfig).toHaveBeenCalledWith(currentDraft.novelConfig, "p1", "/p1")

    rerender()
    const onBtn = toggleButtonFor("novel.settings.trustFilterEnabled")
    expect(onBtn.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(onBtn)
    await waitFor(() => expect(currentDraft.novelConfig.trustFilterEnabled).toBe(false))
    expect(mocks.wikiState.setNovelConfig).toHaveBeenLastCalledWith({ trustFilterEnabled: false })
  })

  // TASK-004（G2 / F22）：三个「有活消费点却完全无控件」的字段补上控件；默认值全部不变。
  it("TASK-004 autoPlanningEnabled：默认开（fail-open），点击写入 false 并落盘", async () => {
    const { rerender } = renderSection()
    expect(screen.getByText("novel.settings.autoPlanningEnabled")).toBeInTheDocument()
    const btn = toggleButtonFor("novel.settings.autoPlanningEnabled")
    expect(btn.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(btn)
    await waitFor(() => expect(currentDraft.novelConfig.autoPlanningEnabled).toBe(false))
    expect(mocks.wikiState.setNovelConfig).toHaveBeenCalledWith({ autoPlanningEnabled: false })
    rerender()
    expect(toggleButtonFor("novel.settings.autoPlanningEnabled").getAttribute("aria-checked")).toBe("false")
  })

  it("TASK-004 autoPlanningEnabled 缺省（undefined）按消费点的 ?? true 语义渲染为开", () => {
    ;(currentDraft.novelConfig as { autoPlanningEnabled?: boolean }).autoPlanningEnabled = undefined
    renderSection()
    expect(toggleButtonFor("novel.settings.autoPlanningEnabled").getAttribute("aria-checked")).toBe("true")
  })

  it("TASK-004 residualCampaignIncludeFreezeChapters：默认关，封印章警告常驻可见", async () => {
    const { rerender } = renderSection()
    // 封印提示必须始终可见（不折进 tooltip）——这是产品封印而非普通开关
    expect(screen.getByText("novel.settings.residualCampaignIncludeFreezeChaptersHint")).toBeInTheDocument()
    const btn = toggleButtonFor("novel.settings.residualCampaignIncludeFreezeChapters")
    expect(btn.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(btn)
    await waitFor(() => expect(currentDraft.novelConfig.residualCampaignIncludeFreezeChapters).toBe(true))
    expect(mocks.wikiState.setNovelConfig).toHaveBeenCalledWith({ residualCampaignIncludeFreezeChapters: true })

    rerender()
    fireEvent.click(toggleButtonFor("novel.settings.residualCampaignIncludeFreezeChapters"))
    await waitFor(() => expect(currentDraft.novelConfig.residualCampaignIncludeFreezeChapters).toBe(false))
    expect(mocks.wikiState.setNovelConfig).toHaveBeenLastCalledWith({ residualCampaignIncludeFreezeChapters: false })
  })

  it("TASK-004 journalTtlMs：默认留空不写键，填值写入，再清空回到「不写入」且绝不为 0", async () => {
    const { rerender } = renderSection()
    // 默认 undefined → 输入框为空（不显示 0）
    expect(numberInputFor("novel.settings.journalTtlMs").value).toBe("")

    commitValue(numberInputFor("novel.settings.journalTtlMs"), "7200000")
    await waitFor(() => expect(currentDraft.novelConfig.journalTtlMs).toBe(7_200_000))
    expect(mocks.wikiState.setNovelConfig).toHaveBeenCalledWith({ journalTtlMs: 7_200_000 })
    const savedAfterSet = lastSavedNovelConfig()
    expect(savedAfterSet.journalTtlMs).toBe(7_200_000)

    rerender()
    commitValue(numberInputFor("novel.settings.journalTtlMs"), "")
    await waitFor(() => expect(currentDraft.novelConfig.journalTtlMs).toBeUndefined())
    expect(mocks.wikiState.setNovelConfig).toHaveBeenLastCalledWith({ journalTtlMs: undefined })
    const savedAfterClear = lastSavedNovelConfig()
    expect(savedAfterClear.journalTtlMs).toBeUndefined()
    // 关键回归：留空绝不写成 0（0 会让 journal 立即过期）
    expect(savedAfterClear.journalTtlMs).not.toBe(0)
    // 留空 = 不写入该键：JSON 落盘时 undefined 键消失，回读仍是缺席
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(savedAfterClear)), "journalTtlMs")).toBe(false)
  })

  it("反馈窗口 toggle 开关（直接 setDraft，不持久化）", async () => {
    const { rerender } = renderSection()
    const cases: Array<[string, () => boolean]> = [
      ["包含当前章节改进建议", () => currentDraft.revisionFeedbackWindowConfig.currentChapterIncludeShouldImprove],
      ["读取上一章延续事项", () => currentDraft.revisionFeedbackWindowConfig.previousChapterCarryEnabled],
      ["回溯章节仅保留必须修复项", () => currentDraft.revisionFeedbackWindowConfig.lookbackIncludeMustFixOnly],
    ]
    for (const [label, read] of cases) {
      const before = read()
      fireEvent.click(toggleButtonFor(label))
      await waitFor(() => expect(read()).toBe(!before))
      expect(mocks.saveNovelConfig).not.toHaveBeenCalled()
      rerender()
    }
  })

  it("回溯章节数量输入：下限 0，清空还原", async () => {
    const { rerender } = renderSection()
    let input = screen.getByDisplayValue("3")
    fireEvent.change(input, { target: { value: "-3" } })
    expect(currentDraft.revisionFeedbackWindowConfig.lookbackChapterCount).toBe(3)
    fireEvent.blur(input)
    expect(currentDraft.revisionFeedbackWindowConfig.lookbackChapterCount).toBe(0)

    rerender()
    input = screen.getByDisplayValue("0")
    commitValue(input, "")
    expect(currentDraft.revisionFeedbackWindowConfig.lookbackChapterCount).toBe(0)
  })

  it("communitySummary 条件块：可见时输入 interval 与 async 开关", async () => {
    const { rerender } = renderSection()
    // 默认 communitySummaryEnabled=true → 条件块可见
    let input = screen.getByDisplayValue("7")
    commitValue(input, "0")
    await waitFor(() => expect(currentDraft.novelConfig.communitySummaryInterval).toBe(1))

    rerender()
    input = screen.getByDisplayValue("1")
    commitValue(input, "100")
    await waitFor(() => expect(currentDraft.novelConfig.communitySummaryInterval).toBe(50))

    await clickToggle("novel.settings.communitySummaryAsync")
    expect(currentDraft.novelConfig.communitySummaryAsync).toBe(false)
  })

  it("communitySummaryEnabled 关闭 → 条件块隐藏（&& 假分支）", async () => {
    const { rerender } = renderSection()
    expect(screen.getByDisplayValue("7")).toBeInTheDocument()
    await clickToggle("novel.settings.communitySummaryEnabled")
    expect(currentDraft.novelConfig.communitySummaryEnabled).toBe(false)
    rerender()
    expect(screen.queryByDisplayValue("7")).not.toBeInTheDocument()
    expect(screen.queryByText("novel.settings.communitySummaryAsync")).not.toBeInTheDocument()
  })

  it("model item：取消跟随 → aiChatModel 回填 → 选择模型", async () => {
    const { rerender } = renderSection()
    const row = modelRow("novel.settings.reviewModel")
    const checkbox = within(row).getByRole("checkbox")
    expect(checkbox).toBeChecked()
    const select = within(row).getByTestId("model-select-empty")
    expect(select).toBeDisabled()

    // 取消跟随 → else 分支：aiChatModel || " "
    fireEvent.click(checkbox)
    await waitFor(() => expect(currentDraft.novelConfig.reviewModel).toBe("chat-model"))
    expect(mocks.wikiState.setNovelConfig).toHaveBeenCalledWith({ reviewModel: "chat-model" })

    rerender()
    const enabledSelect = within(row).getByTestId("model-select-chat-model")
    expect(enabledSelect).toBeEnabled()
    fireEvent.change(enabledSelect, { target: { value: "model-a" } })
    await waitFor(() => expect(currentDraft.novelConfig.reviewModel).toBe("model-a"))
  })

  it("model item：aiChatModel 为空时回退单空格", async () => {
    mocks.wikiState.aiChatModel = ""
    renderSection()
    const row = modelRow("novel.settings.summaryModel")
    const checkbox = within(row).getByRole("checkbox")
    fireEvent.click(checkbox)
    await waitFor(() => expect(currentDraft.novelConfig.summaryModel).toBe(" "))
  })

  it("model item：重新勾选跟随 → 清空模型值（checked 真分支）", async () => {
    currentDraft.novelConfig.reviewModel = "chat-model"
    renderSection()
    const row = modelRow("novel.settings.reviewModel")
    const checkbox = within(row).getByRole("checkbox")
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)
    await waitFor(() => expect(currentDraft.novelConfig.reviewModel).toBe(""))
  })

  it("模型测试：加载中 → 成功（usedFallbackModel=false）", async () => {
    renderSection()
    const row = modelRow("novel.settings.reviewModel")
    const testBtn = within(row).getByRole("button", { name: "novel.settings.testModel" })
    fireEvent.click(testBtn)
    await waitFor(() => {
      expect(screen.getByText("novel.settings.testSuccess novel.settings.testUsingCurrentModel:m")).toBeInTheDocument()
    })
    expect(mocks.testNovelModel).toHaveBeenCalledWith(
      mocks.wikiState.llmConfig,
      currentDraft.novelConfig,
      "review",
    )
  })

  it("模型测试：usedFallbackModel=true 时展示默认主模型后缀", async () => {
    mocks.testNovelModel.mockResolvedValue({ model: "fallback-m", content: "c", usedFallbackModel: true })
    renderSection()
    const row = modelRow("novel.settings.summaryModel")
    fireEvent.click(within(row).getByRole("button", { name: "novel.settings.testModel" }))
    await waitFor(() => {
      expect(screen.getByText("novel.settings.testSuccess novel.settings.testUsingDefaultMainModel:fallback-m")).toBeInTheDocument()
    })
  })

  it("模型测试：加载态禁用按钮并显示测试中文案", async () => {
    mocks.testNovelModel.mockReturnValueOnce(new Promise(() => {}))
    renderSection()
    const row = modelRow("novel.settings.reviewModel")
    const testBtn = within(row).getByRole("button", { name: "novel.settings.testModel" })
    fireEvent.click(testBtn)
    const loadingBtn = await waitFor(() =>
      within(row).getByRole("button", { name: "novel.settings.testingModel" }),
    )
    expect(loadingBtn).toBeDisabled()
  })

  it("模型测试：Error 异常 → testFailed 展示 error.message", async () => {
    mocks.testNovelModel.mockRejectedValueOnce(new Error("boom"))
    renderSection()
    const row = modelRow("novel.settings.reviewModel")
    fireEvent.click(within(row).getByRole("button", { name: "novel.settings.testModel" }))
    await waitFor(() => {
      expect(screen.getByText("novel.settings.testFailed:boom")).toBeInTheDocument()
    })
  })

  it("模型测试：非 Error 异常 → String(error)", async () => {
    mocks.testNovelModel.mockRejectedValueOnce("string-error")
    renderSection()
    const row = modelRow("novel.settings.extractModel")
    fireEvent.click(within(row).getByRole("button", { name: "novel.settings.testModel" }))
    await waitFor(() => {
      expect(screen.getByText("novel.settings.testFailed:string-error")).toBeInTheDocument()
    })
  })

  it("extract 项展示专属提示文案（ternary 真分支）", () => {
    renderSection()
    // hint 同时出现在 tooltip 内容与 extract 项提示段落中
    expect(screen.getAllByText("novel.settings.extractModelHint").length).toBeGreaterThanOrEqual(2)
  })

  it("project 为 null 时 saveNovelConfig 的 projectId/path 为 undefined", async () => {
    mocks.wikiState.project = null
    renderSection()
    const row = modelRow("novel.settings.reviewModel")
    const checkbox = within(row).getByRole("checkbox")
    fireEvent.click(checkbox)
    await waitFor(() => {
      expect(mocks.saveNovelConfig).toHaveBeenCalledWith(currentDraft.novelConfig, undefined, undefined)
    })
  })

  it("A11 落盘失败：draft 与 store 回滚到原值，并 toast 错误", async () => {
    mocks.saveNovelConfig.mockRejectedValueOnce(new Error("disk-full"))
    renderSection()
    const before = currentDraft.novelConfig
    expect(before.autoIngestOnSave).toBe(true)
    fireEvent.click(toggleButtonFor("novel.settings.autoIngestOnSave"))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("disk-full"))
    expect(currentDraft.novelConfig).toEqual(before)
    expect(currentDraft.novelConfig.autoIngestOnSave).toBe(true)
    expect(mocks.wikiState.setNovelConfig).toHaveBeenNthCalledWith(1, { autoIngestOnSave: false })
    expect(mocks.wikiState.setNovelConfig).toHaveBeenLastCalledWith({ autoIngestOnSave: true })
  })

  it("A11 落盘失败只回滚本次改动的键：期间改的其它项保留", async () => {
    let rejectFirst: (e: Error) => void = () => {}
    mocks.saveNovelConfig.mockImplementationOnce(() => new Promise((_, rej) => { rejectFirst = rej }))
    const view = renderSection()
    const otherBefore = currentDraft.novelConfig.communitySummaryEnabled
    fireEvent.click(toggleButtonFor("novel.settings.autoIngestOnSave"))
    view.rerender()
    await clickToggle("novel.settings.communitySummaryEnabled")
    view.rerender()
    expect(currentDraft.novelConfig.communitySummaryEnabled).toBe(!otherBefore)
    rejectFirst(new Error("disk-full"))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("disk-full"))
    expect(currentDraft.novelConfig.autoIngestOnSave).toBe(true)
    expect(currentDraft.novelConfig.communitySummaryEnabled).toBe(!otherBefore)
  })

  it("A11 落盘成功：不回滚、不 toast", async () => {
    renderSection()
    await clickToggle("novel.settings.autoIngestOnSave")
    expect(currentDraft.novelConfig.autoIngestOnSave).toBe(false)
    expect(mocks.wikiState.setNovelConfig).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it("A12 实验性开关收进默认折叠的 <details>，summary 可见", () => {
    renderSection()
    const details = screen.getByTestId("novel-experimental-details") as HTMLDetailsElement
    expect(details.tagName).toBe("DETAILS")
    expect(details.open).toBe(false)
    expect(within(details).getByText("实验性选项").closest("summary")).not.toBeNull()
    expect(within(details).getByText("novel.settings.dualKbRoutingEnabled")).toBeInTheDocument()
    expect(within(details).getByText("novel.settings.contentAssemblySection")).toBeInTheDocument()
    // 常用开关不在折叠区
    expect(within(details).queryByText("novel.settings.autoIngestOnSave")).not.toBeInTheDocument()
  })

  it("A12 组标题为 h3（非孤立 label）", () => {
    renderSection()
    expect(screen.getByText("novel.settings.title").tagName).toBe("H3")
    expect(screen.getByText("修改反馈窗口").tagName).toBe("H3")
  })

  it("A7 可见标签关联控件：开关 / 数字框可按标签名查询", () => {
    renderSection()
    expect(screen.getByRole("switch", { name: "novel.settings.autoIngestOnSave" })).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "包含当前章节改进建议" })).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "novel.settings.inspectorEnabled" })).toBeInTheDocument()
    expect(screen.getByLabelText("novel.settings.recentSummaryWindow")).toHaveValue(8)
    expect(screen.getByLabelText("回溯章节数量")).toHaveValue(3)
    // 所有可见 <label> 都关联到控件（无孤立 label）
    const orphans = Array.from(document.querySelectorAll("label")).filter(
      (l) => !(l as HTMLLabelElement).control,
    )
    expect(orphans.map((l) => l.textContent)).toEqual([])
  })

  describe("F-34 反 AI 遥测同意开关", () => {
    it("渲染分组块：组标题/Label/tooltip 可见，load=false → 开关为关（bg-input）", async () => {
      renderSection()
      expect(screen.getByText("反 AI 遥测诊断")).toBeInTheDocument()
      expect(screen.getByText("应用级设置：仅控制本机匿名诊断遥测，与项目级小说设置相互独立。")).toBeInTheDocument()
      expect(screen.getByText("novel.settings.antiAiTelemetryConsent")).toBeInTheDocument()
      expect(screen.getByText("novel.settings.antiAiTelemetryConsentHint")).toBeInTheDocument()
      await waitFor(() => {
        expect(mocks.loadAntiAiTelemetryConsent).toHaveBeenCalledTimes(1)
      })
      expect(String(toggleButtonFor("novel.settings.antiAiTelemetryConsent").className)).toContain("bg-input")
    })

    it("load=true → 开关为开（bg-primary）", async () => {
      mocks.loadAntiAiTelemetryConsent.mockResolvedValue(true)
      renderSection()
      const btn = toggleButtonFor("novel.settings.antiAiTelemetryConsent")
      await waitFor(() => expect(String(btn.className)).toContain("bg-primary"))
    })

    it("点击开启：save(true) 先于 apply(/p1)，UI 变为开", async () => {
      renderSection()
      await waitFor(() => expect(mocks.loadAntiAiTelemetryConsent).toHaveBeenCalledTimes(1))
      fireEvent.click(toggleButtonFor("novel.settings.antiAiTelemetryConsent"))
      await waitFor(() => expect(mocks.saveAntiAiTelemetryConsent).toHaveBeenCalledWith(true))
      await waitFor(() => expect(mocks.applyAntiAiTelemetryConsentOnProjectOpen).toHaveBeenCalledWith("/p1"))
      expect(mocks.saveAntiAiTelemetryConsent.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.applyAntiAiTelemetryConsentOnProjectOpen.mock.invocationCallOrder[0],
      )
      expect(String(toggleButtonFor("novel.settings.antiAiTelemetryConsent").className)).toContain("bg-primary")
      expect(screen.queryByText(/antiAiTelemetryConsentError/)).not.toBeInTheDocument()
    })

    it("点击关闭：save(false) + apply(/p1)，UI 变为关", async () => {
      mocks.loadAntiAiTelemetryConsent.mockResolvedValue(true)
      renderSection()
      const btn = toggleButtonFor("novel.settings.antiAiTelemetryConsent")
      await waitFor(() => expect(String(btn.className)).toContain("bg-primary"))
      fireEvent.click(btn)
      await waitFor(() => expect(mocks.saveAntiAiTelemetryConsent).toHaveBeenCalledWith(false))
      await waitFor(() => expect(mocks.applyAntiAiTelemetryConsentOnProjectOpen).toHaveBeenCalledWith("/p1"))
      expect(String(toggleButtonFor("novel.settings.antiAiTelemetryConsent").className)).toContain("bg-input")
    })

    it("project 为 null：仍 save，但不 apply（下次打开项目生效）", async () => {
      mocks.wikiState.project = null
      renderSection()
      await waitFor(() => expect(mocks.loadAntiAiTelemetryConsent).toHaveBeenCalledTimes(1))
      fireEvent.click(toggleButtonFor("novel.settings.antiAiTelemetryConsent"))
      await waitFor(() => expect(mocks.saveAntiAiTelemetryConsent).toHaveBeenCalledWith(true))
      expect(mocks.applyAntiAiTelemetryConsentOnProjectOpen).not.toHaveBeenCalled()
    })

    it("save 失败 → UI 回滚到原值 + 错误文案含 message", async () => {
      mocks.saveAntiAiTelemetryConsent.mockRejectedValueOnce(new Error("boom"))
      renderSection()
      await waitFor(() => expect(mocks.loadAntiAiTelemetryConsent).toHaveBeenCalledTimes(1))
      fireEvent.click(toggleButtonFor("novel.settings.antiAiTelemetryConsent"))
      await waitFor(() => {
        expect(screen.getByText("novel.settings.antiAiTelemetryConsentError:boom")).toBeInTheDocument()
      })
      expect(String(toggleButtonFor("novel.settings.antiAiTelemetryConsent").className)).toContain("bg-input")
    })

    it("apply 失败 → UI 保持新值 + 错误文案（半态：store 已写，下次项目打开自愈）", async () => {
      mocks.applyAntiAiTelemetryConsentOnProjectOpen.mockRejectedValueOnce(new Error("apply-boom"))
      renderSection()
      await waitFor(() => expect(mocks.loadAntiAiTelemetryConsent).toHaveBeenCalledTimes(1))
      fireEvent.click(toggleButtonFor("novel.settings.antiAiTelemetryConsent"))
      await waitFor(() => {
        expect(screen.getByText("novel.settings.antiAiTelemetryConsentError:apply-boom")).toBeInTheDocument()
      })
      expect(String(toggleButtonFor("novel.settings.antiAiTelemetryConsent").className)).toContain("bg-primary")
    })
  })

  describe("R5 KB 影子采集触发", () => {
    it("未同意（skipped=true）→ 显示未采集文案；点击调 runKbShadowArmsIfConsented（golden cases + coverageOf）", async () => {
      mocks.runKbShadowArmsIfConsented.mockResolvedValueOnce({ written: 0, failed: 0, skipped: true })
      renderSection()
      fireEvent.click(screen.getByText("novel.settings.kbShadowRunButton"))
      await waitFor(() =>
        expect(mocks.runKbShadowArmsIfConsented).toHaveBeenCalledWith(
          "/p1",
          "golden34",
          mocks.goldenKbShadowCases(),
          undefined,
          undefined,
          mocks.goldenCoverageOf,
        ),
      )
      await waitFor(() => expect(screen.getByText("novel.settings.kbShadowSkipped")).toBeInTheDocument())
    })

    it("同意开 → 显示写入行数（kbShadowDone）", async () => {
      mocks.runKbShadowArmsIfConsented.mockResolvedValueOnce({ written: 68, failed: 0, skipped: false })
      renderSection()
      fireEvent.click(screen.getByText("novel.settings.kbShadowRunButton"))
      await waitFor(() => expect(screen.getByText("novel.settings.kbShadowDone")).toBeInTheDocument())
    })

    it("采集中 → 按钮禁用 + running 文案", async () => {
      let resolveRun: (v: { written: number; failed: number; skipped: boolean }) => void = () => {}
      mocks.runKbShadowArmsIfConsented.mockImplementationOnce(
        () => new Promise((res) => { resolveRun = res as typeof resolveRun }),
      )
      renderSection()
      const button = screen.getByText("novel.settings.kbShadowRunButton")
      fireEvent.click(button)
      await waitFor(() => expect(screen.getByText("novel.settings.kbShadowRunning")).toBeInTheDocument())
      expect((button as HTMLButtonElement).disabled).toBe(true)
      resolveRun({ written: 68, failed: 0, skipped: false })
      await waitFor(() => expect(screen.getByText("novel.settings.kbShadowDone")).toBeInTheDocument())
    })
  })
})

describe("NovelSection 未覆盖分支（覆盖战役补齐）", () => {
  beforeEach(() => {
    // 顶层 beforeEach 已重建 currentDraft；这里补上共识/任务定制/拼写三块字段。
    Object.assign(currentDraft.novelConfig as unknown as Record<string, unknown>, {
      consensusEnabled: false,
      consensusWritingModels: [],
      consensusDebateRounds: 2,
      consensusReviewModels: {},
      taskSkillNames: {},
      taskPrompts: {},
      dialoguePunctuationStyle: "",
      paragraphIndent: "",
      quoteConvention: "",
    })
  })

  it("同意加载失败（reject）：开关保持关，不崩", async () => {
    mocks.loadAntiAiTelemetryConsent.mockRejectedValueOnce(new Error("load-down"))
    renderSection()
    await waitFor(() => {
      expect(mocks.loadAntiAiTelemetryConsent).toHaveBeenCalledTimes(1)
    })
    // catch 分支把 consent 置 false → 开关关态。
    expect(String(toggleButtonFor("novel.settings.antiAiTelemetryConsent").className)).toContain("bg-input")
  })

  it("同意加载完成前卸载：cancelled 守卫阻止 setState，不报错", async () => {
    let resolveLoad!: (v: boolean) => void
    mocks.loadAntiAiTelemetryConsent.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveLoad = resolve
      }),
    )
    const view = render(<NovelSection draft={currentDraft} setDraft={setDraft} />)
    view.unmount()
    resolveLoad(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText("novel.settings.antiAiTelemetryConsent")).toBeNull()
  })

  it("同意加载拒绝前卸载：catch 内 cancelled 守卫同样阻止 setState", async () => {
    let rejectLoad!: (e: unknown) => void
    mocks.loadAntiAiTelemetryConsent.mockReturnValueOnce(
      new Promise<boolean>((_resolve, reject) => {
        rejectLoad = reject
      }),
    )
    const view = render(<NovelSection draft={currentDraft} setDraft={setDraft} />)
    view.unmount()
    rejectLoad(new Error("late-down"))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText("novel.settings.antiAiTelemetryConsent")).toBeNull()
  })

  it("无项目时点 KB 采集：直接报错 kbShadowNoProject，不调后端", async () => {
    mocks.wikiState.project = null
    renderSection()
    fireEvent.click(screen.getByText("novel.settings.kbShadowRunButton"))
    await waitFor(() => {
      // 错误经 kbShadowError 键包装展示（message 透传），断言组合后文本。
      expect(screen.getByText("novel.settings.kbShadowError:novel.settings.kbShadowNoProject")).toBeInTheDocument()
    })
    expect(mocks.runKbShadowArmsIfConsented).not.toHaveBeenCalled()
  })

  it("KB 采集抛错：错误文案展示 toErrorMessage", async () => {
    mocks.runKbShadowArmsIfConsented.mockRejectedValueOnce(new Error("shadow-down"))
    renderSection()
    fireEvent.click(screen.getByText("novel.settings.kbShadowRunButton"))
    await waitFor(() => {
      expect(screen.getByText("novel.settings.kbShadowError:shadow-down")).toBeInTheDocument()
    })
  })

  it("持久化前 store 抛非 NovelConfigPersistError：按空回滚 + toast，不落盘", async () => {
    mocks.wikiState.setNovelConfig.mockImplementationOnce(() => {
      throw new Error("store-down")
    })
    renderSection()
    const before = mocks.saveNovelConfig.mock.calls.length
    fireEvent.click(toggleButtonFor("novel.settings.autoIngestOnSave"))
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith("store-down")
    })
    expect(mocks.saveNovelConfig.mock.calls.length).toBe(before)
  })

  it("共识总开关：勾选后落盘 consensusEnabled=true，并展开写作模型输入", async () => {
    renderSection()
    fireEvent.click(screen.getByLabelText("novel.settings.consensusEnabled"))
    await waitFor(() => {
      expect(mocks.saveNovelConfig).toHaveBeenCalled()
    })
    expect(lastSavedNovelConfig().consensusEnabled as boolean).toBe(true)
  })

  it("共识写作模型输入：逗号分隔写入数组", async () => {
    ;(currentDraft.novelConfig as unknown as Record<string, unknown>).consensusEnabled = true
    renderSection()
    fireEvent.change(screen.getByLabelText("novel.settings.consensusWritingModels"), {
      target: { value: "a/m1, b/m2" },
    })
    await waitFor(() => {
      expect(mocks.saveNovelConfig).toHaveBeenCalled()
    })
    expect(lastSavedNovelConfig().consensusWritingModels).toEqual(["a/m1", "b/m2"])
  })

  it("共识辩论轮数：CommitNumberInput 提交落盘", async () => {
    ;(currentDraft.novelConfig as unknown as Record<string, unknown>).consensusEnabled = true
    renderSection()
    commitValue(screen.getByLabelText("novel.settings.consensusDebateRounds"), "3")
    await waitFor(() => {
      expect(mocks.saveNovelConfig).toHaveBeenCalled()
    })
    expect(lastSavedNovelConfig().consensusDebateRounds).toBe(3)
  })

  it("共识评审模型：按维度键写入 consensusReviewModels", async () => {
    ;(currentDraft.novelConfig as unknown as Record<string, unknown>).consensusEnabled = true
    renderSection()
    // 维度行渲染（consensusDimensionKeys 展开）。
    expect(screen.getByLabelText("reviewCenter.dimension.thrill")).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("reviewCenter.dimension.thrill"), {
      target: { value: "x/r1" },
    })
    await waitFor(() => {
      expect(mocks.saveNovelConfig).toHaveBeenCalled()
    })
    expect((lastSavedNovelConfig().consensusReviewModels as Record<string, string[]>).thrill).toEqual(["x/r1"])
  })

  it("任务定制：技能名与附加提示词分别落盘", async () => {
    renderSection()
    fireEvent.change(screen.getByLabelText("novel.settings.taskCustom_writing"), {
      target: { value: "skill-a, skill-b" },
    })
    await waitFor(() => {
      expect(mocks.saveNovelConfig).toHaveBeenCalled()
    })
    expect((lastSavedNovelConfig().taskSkillNames as Record<string, string[]>).writing).toEqual([
      "skill-a",
      "skill-b",
    ])
    fireEvent.change(screen.getAllByLabelText(/附加提示词/)[0], {
      target: { value: "extra-hint" },
    })
    await waitFor(() => {
      expect((lastSavedNovelConfig().taskPrompts as Record<string, { extra: string }>).writing).toEqual({
        extra: "extra-hint",
      })
    })
  })

  it("拼写约定三输入：改值即落盘对应键", async () => {
    renderSection()
    fireEvent.change(screen.getByLabelText("对话标点风格"), { target: { value: "用「」" } })
    await waitFor(() => {
      expect(mocks.saveNovelConfig).toHaveBeenCalled()
    })
    expect(lastSavedNovelConfig().dialoguePunctuationStyle).toBe("用「」")
    fireEvent.change(screen.getByLabelText("段落缩进"), { target: { value: "两字符" } })
    await waitFor(() => {
      expect(lastSavedNovelConfig().paragraphIndent).toBe("两字符")
    })
    fireEvent.change(screen.getByLabelText("引号规范"), { target: { value: "双引号" } })
    await waitFor(() => {
      expect(lastSavedNovelConfig().quoteConvention).toBe("双引号")
    })
  })
})

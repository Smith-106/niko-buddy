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
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: typeof mocks.wikiState) => unknown) => selector(mocks.wikiState),
    { getState: () => mocks.wikiState },
  ),
}))

vi.mock("@/lib/project-store", () => ({
  saveNovelConfig: mocks.saveNovelConfig,
}))

vi.mock("@/lib/novel/anti-ai-telemetry-wiring", () => ({
  loadAntiAiTelemetryConsent: mocks.loadAntiAiTelemetryConsent,
  saveAntiAiTelemetryConsent: mocks.saveAntiAiTelemetryConsent,
  applyAntiAiTelemetryConsentOnProjectOpen: mocks.applyAntiAiTelemetryConsentOnProjectOpen,
}))

vi.mock("@/lib/novel/novel-model-test", () => ({
  testNovelModel: mocks.testNovelModel,
}))

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
      reviewReasoningEffort: "high",
      writingModel: "",
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
  })

  it("recentSummaryWindow 输入：上限钳制与 || 1 回退", async () => {
    const { rerender } = renderSection()
    let input = screen.getByDisplayValue("8")
    fireEvent.change(input, { target: { value: "50" } })
    await waitFor(() => expect(currentDraft.novelConfig.recentSummaryWindow).toBe(30))
    expect(mocks.wikiState.setNovelConfig).toHaveBeenCalledWith({ recentSummaryWindow: 30 })
    expect(mocks.saveNovelConfig).toHaveBeenCalledWith(currentDraft.novelConfig, "p1", "/p1")

    rerender()
    input = screen.getByDisplayValue("30")
    fireEvent.change(input, { target: { value: "0" } })
    await waitFor(() => expect(currentDraft.novelConfig.recentSummaryWindow).toBe(1))
  })

  it("searchTopK 输入：上限钳制与 || 1 回退", async () => {
    const { rerender } = renderSection()
    let input = screen.getByDisplayValue("5")
    fireEvent.change(input, { target: { value: "100" } })
    await waitFor(() => expect(currentDraft.novelConfig.searchTopK).toBe(20))

    rerender()
    input = screen.getByDisplayValue("20")
    fireEvent.change(input, { target: { value: "" } })
    await waitFor(() => expect(currentDraft.novelConfig.searchTopK).toBe(1))
  })

  it("contextTokenBudget 输入：上下限钳制与 || 0 回退", async () => {
    const { rerender } = renderSection()
    let input = screen.getByDisplayValue("4000")
    fireEvent.change(input, { target: { value: "-5" } })
    await waitFor(() => expect(currentDraft.novelConfig.contextTokenBudget).toBe(0))

    rerender()
    input = screen.getByDisplayValue("0")
    fireEvent.change(input, { target: { value: "999999" } })
    await waitFor(() => expect(currentDraft.novelConfig.contextTokenBudget).toBe(200000))

    rerender()
    input = screen.getByDisplayValue("200000")
    fireEvent.change(input, { target: { value: "" } })
    await waitFor(() => expect(currentDraft.novelConfig.contextTokenBudget).toBe(0))
  })

  it("chapterTargetChars 输入：上下限钳制与 || 3000 回退", async () => {
    const { rerender } = renderSection()
    let input = screen.getByDisplayValue("3000")
    fireEvent.change(input, { target: { value: "100" } })
    await waitFor(() => expect(currentDraft.novelConfig.chapterTargetChars).toBe(500))

    rerender()
    input = screen.getByDisplayValue("500")
    fireEvent.change(input, { target: { value: "25000" } })
    await waitFor(() => expect(currentDraft.novelConfig.chapterTargetChars).toBe(20000))

    rerender()
    input = screen.getByDisplayValue("20000")
    fireEvent.change(input, { target: { value: "" } })
    await waitFor(() => expect(currentDraft.novelConfig.chapterTargetChars).toBe(3000))
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
      ["novel.settings.residualCampaignEnabled", () => !!currentDraft.novelConfig.residualCampaignEnabled],
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

  it("回溯章节数量输入：max(0, || 0)", async () => {
    const { rerender } = renderSection()
    let input = screen.getByDisplayValue("3")
    fireEvent.change(input, { target: { value: "-3" } })
    expect(currentDraft.revisionFeedbackWindowConfig.lookbackChapterCount).toBe(0)

    rerender()
    input = screen.getByDisplayValue("0")
    fireEvent.change(input, { target: { value: "" } })
    expect(currentDraft.revisionFeedbackWindowConfig.lookbackChapterCount).toBe(0)
  })

  it("communitySummary 条件块：可见时输入 interval 与 async 开关", async () => {
    const { rerender } = renderSection()
    // 默认 communitySummaryEnabled=true → 条件块可见
    let input = screen.getByDisplayValue("7")
    fireEvent.change(input, { target: { value: "0" } })
    await waitFor(() => expect(currentDraft.novelConfig.communitySummaryInterval).toBe(1))

    rerender()
    input = screen.getByDisplayValue("1")
    fireEvent.change(input, { target: { value: "100" } })
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
})

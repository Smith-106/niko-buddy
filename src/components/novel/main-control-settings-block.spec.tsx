/**
 * main-control-settings-block.spec — 主控运行设置块（jsdom）。
 * 覆盖：目标字数 patch 键集单一 / aiWorkflowMode 全局键落盘 / 落盘失败 toast / D3+D2 文案与无 writingModel 控件。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

const mocks = vi.hoisted(() => ({
  persistNovelConfigPatch: vi.fn(async (_input: { patch: Record<string, unknown> }) => ({ next: {} })),
  saveAiWorkflowMode: vi.fn(async () => undefined),
  setNovelConfig: vi.fn(),
  setAiWorkflowMode: vi.fn(),
  toastError: vi.fn(),
  t: vi.fn((key: string) => key),
}))

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/lib/toast", () => ({
  toast: { error: mocks.toastError, success: vi.fn(), info: vi.fn() },
}))

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return { ...actual, persistNovelConfigPatch: mocks.persistNovelConfigPatch }
})

vi.mock("@/lib/project-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-store")>()
  return { ...actual, saveAiWorkflowMode: mocks.saveAiWorkflowMode }
})

// ChatModelSelector 读 providerConfigs（缺了会抛），这里给最小可用形态。
const wikiState = vi.hoisted(() => ({
  novelConfig: {
    chapterTargetChars: 3000,
    preWriteGateMode: "warn" as "warn" | "block" | undefined,
    reviewModel: "",
    sceneBreakdownEnabled: false,
    literaryPolishAfterGate: false,
  },
  aiWorkflowMode: "standard" as "fast" | "standard" | "strict",
  aiChatModel: "m1",
  project: { id: "p1", path: "/proj" } as { id: string; path: string } | null,
  // 审查模型下拉的 provider 配置（默认为空 ⇒ ChatModelSelector 渲染 null；
  // 「选定具体模型」用例临时注入一份可用配置）。
  providerConfigs: {} as Record<string, unknown>,
  setNovelConfig: mocks.setNovelConfig,
  setAiWorkflowMode: mocks.setAiWorkflowMode,
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  const state = {
    get novelConfig() {
      return wikiState.novelConfig
    },
    get aiWorkflowMode() {
      return wikiState.aiWorkflowMode
    },
    get aiChatModel() {
      return wikiState.aiChatModel
    },
    get project() {
      return wikiState.project
    },
    get providerConfigs() {
      return wikiState.providerConfigs
    },
    get setNovelConfig() {
      return wikiState.setNovelConfig
    },
    get setAiWorkflowMode() {
      return wikiState.setAiWorkflowMode
    },
  }
  const useWikiStore = <T,>(selector: (s: typeof state) => T) => selector(state)
  return {
    ...actual,
    useWikiStore: Object.assign(useWikiStore, { getState: () => state }),
  }
})

const { MainControlSettingsBlock } = await import("./main-control-settings-block")

beforeEach(() => {
  mocks.persistNovelConfigPatch.mockClear()
  mocks.persistNovelConfigPatch.mockResolvedValue({ next: {} })
  mocks.saveAiWorkflowMode.mockClear()
  mocks.saveAiWorkflowMode.mockResolvedValue(undefined)
  mocks.setNovelConfig.mockClear()
  mocks.setAiWorkflowMode.mockClear()
  mocks.toastError.mockClear()
})

afterEach(() => {
  cleanup()
})

describe("MainControlSettingsBlock", () => {
  it("改目标字数并失焦：persistNovelConfigPatch 只带 chapterTargetChars 一个键", async () => {
    render(<MainControlSettingsBlock />)
    const input = screen.getByTestId("main-control-settings-chapter-target")
    fireEvent.change(input, { target: { value: "4500" } })
    fireEvent.blur(input)
    await waitFor(() => expect(mocks.persistNovelConfigPatch).toHaveBeenCalledTimes(1))
    const arg = mocks.persistNovelConfigPatch.mock.calls[0][0]
    expect(Object.keys(arg.patch)).toEqual(["chapterTargetChars"])
    expect(arg.patch.chapterTargetChars).toBe(4500)
  })

  it("点 strict：saveAiWorkflowMode 与 setAiWorkflowMode 均以 strict 调用", async () => {
    render(<MainControlSettingsBlock />)
    fireEvent.click(screen.getByTestId("main-control-ai-workflow-mode-strict"))
    await waitFor(() => expect(mocks.saveAiWorkflowMode).toHaveBeenCalledWith("strict"))
    expect(mocks.setAiWorkflowMode).toHaveBeenCalledWith("strict")
  })

  it("落盘失败：toast.error 以 settingsSaveFailed 文案调用", async () => {
    mocks.persistNovelConfigPatch.mockRejectedValueOnce(new Error("disk full"))
    render(<MainControlSettingsBlock />)
    fireEvent.click(screen.getByTestId("main-control-settings-scene-breakdown"))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled())
    expect(mocks.t).toHaveBeenCalledWith("mainControl.settingsSaveFailed", { message: "disk full" })
  })

  it("渲染 D3 生效位置说明与 D2 写作模型已移除说明，且无可编辑 writingModel 控件", () => {
    render(<MainControlSettingsBlock />)
    const text = screen.getByTestId("main-control-settings").textContent ?? ""
    expect(text).toContain("mainControl.settingsPreWriteGateModeHint")
    expect(text).toContain("mainControl.settingsWritingModelRemoved")
    expect(screen.queryByTestId("main-control-writing-model")).toBeNull()
  })
})

/**
 * 前端验收（--frontend-verify）：G1「五项写作设置 + aiWorkflowMode」逐项渲染 + 逐项写入。
 *
 * 五项写作设置 = chapterTargetChars / preWriteGateMode / sceneBreakdownEnabled /
 * literaryPolishAfterGate / reviewModel；aiWorkflowMode 是全局单键（D1=A）。
 * 每项写入都必须经 persistNovelConfigPatch 且 patch 只带本次改动的一个键（逐键回滚前提）。
 */
describe("G1 设置块逐项渲染与写入（前端验收）", () => {
  it("五项写作设置 + aiWorkflowMode 全部渲染，当前值以 aria-pressed 反映", () => {
    render(<MainControlSettingsBlock />)
    const text = screen.getByTestId("main-control-settings").textContent ?? ""
    // 五项写作设置
    expect(text).toContain("mainControl.settingsChapterTargetChars")
    expect(text).toContain("mainControl.settingsPreWriteGateMode")
    expect(text).toContain("mainControl.settingsSceneBreakdown")
    expect(text).toContain("mainControl.settingsLiteraryPolish")
    expect(text).toContain("mainControl.settingsReviewModel")
    // 全局工作流强度
    expect(text).toContain("mainControl.settingsAiWorkflowMode")
    // 目标字数输入框真渲染出 store 当前值
    const input = screen.getByTestId("main-control-settings-chapter-target") as HTMLInputElement
    expect(input.value).toBe("3000")
    // 写前门控：warn 生效 → warn 按下、block 未按下
    expect(screen.getByTestId("main-control-settings-gate-warn").getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByTestId("main-control-settings-gate-block").getAttribute("aria-pressed")).toBe("false")
    // 三档工作流强度齐备，standard 生效
    expect(screen.getByTestId("main-control-ai-workflow-mode-fast")).toBeTruthy()
    expect(screen.getByTestId("main-control-ai-workflow-mode-standard").getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByTestId("main-control-ai-workflow-mode-strict").getAttribute("aria-pressed")).toBe("false")
    // 审查模型：reviewModel 为空串 ⇒ 「跟随会话模型」勾选态
    expect((screen.getByTestId("main-control-settings-review-follow") as HTMLInputElement).checked).toBe(true)
  })

  it("写前门控切 block：patch 只带 preWriteGateMode", async () => {
    render(<MainControlSettingsBlock />)
    fireEvent.click(screen.getByTestId("main-control-settings-gate-block"))
    await waitFor(() => expect(mocks.persistNovelConfigPatch).toHaveBeenCalledTimes(1))
    const arg = mocks.persistNovelConfigPatch.mock.calls[0][0]
    expect(Object.keys(arg.patch)).toEqual(["preWriteGateMode"])
    expect(arg.patch.preWriteGateMode).toBe("block")
  })

  it("场景切分勾选：patch 只带 sceneBreakdownEnabled=true", async () => {
    render(<MainControlSettingsBlock />)
    fireEvent.click(screen.getByTestId("main-control-settings-scene-breakdown"))
    await waitFor(() => expect(mocks.persistNovelConfigPatch).toHaveBeenCalledTimes(1))
    const arg = mocks.persistNovelConfigPatch.mock.calls[0][0]
    expect(Object.keys(arg.patch)).toEqual(["sceneBreakdownEnabled"])
    expect(arg.patch.sceneBreakdownEnabled).toBe(true)
  })

  it("门后文学打磨勾选：patch 只带 literaryPolishAfterGate=true", async () => {
    render(<MainControlSettingsBlock />)
    fireEvent.click(screen.getByTestId("main-control-settings-literary-polish"))
    await waitFor(() => expect(mocks.persistNovelConfigPatch).toHaveBeenCalledTimes(1))
    const arg = mocks.persistNovelConfigPatch.mock.calls[0][0]
    expect(Object.keys(arg.patch)).toEqual(["literaryPolishAfterGate"])
    expect(arg.patch.literaryPolishAfterGate).toBe(true)
  })

  it("取消「跟随会话模型」：patch 只带 reviewModel=当前会话模型", async () => {
    render(<MainControlSettingsBlock />)
    fireEvent.click(screen.getByTestId("main-control-settings-review-follow"))
    await waitFor(() => expect(mocks.persistNovelConfigPatch).toHaveBeenCalledTimes(1))
    const arg = mocks.persistNovelConfigPatch.mock.calls[0][0]
    expect(Object.keys(arg.patch)).toEqual(["reviewModel"])
    expect(arg.patch.reviewModel).toBe("m1")
  })

  it("审查模型下拉选定具体模型：patch 只带 reviewModel=provider/model", async () => {
    const prevProviders = wikiState.providerConfigs
    const prevConfig = wikiState.novelConfig
    wikiState.providerConfigs = {
      openai: {
        enabled: true,
        label: "OpenAI",
        savedModels: [{ id: "sm1", name: "GPT Test", model: "gpt-test" }],
      },
    }
    wikiState.novelConfig = { ...prevConfig, reviewModel: "openai/gpt-test" }
    try {
      render(<MainControlSettingsBlock />)
      // 非空 reviewModel ⇒ 「跟随会话模型」未勾选，下拉可用
      expect((screen.getByTestId("main-control-settings-review-follow") as HTMLInputElement).checked).toBe(false)
      const trigger = screen.getByRole("button", { name: /GPT Test/ })
      fireEvent.click(trigger)
      const option = await screen.findByRole("button", { name: /gpt-test/ })
      fireEvent.click(option)
      await waitFor(() => expect(mocks.persistNovelConfigPatch).toHaveBeenCalledTimes(1))
      const arg = mocks.persistNovelConfigPatch.mock.calls[0][0]
      expect(Object.keys(arg.patch)).toEqual(["reviewModel"])
      expect(arg.patch.reviewModel).toBe("openai/gpt-test")
    } finally {
      wikiState.providerConfigs = prevProviders
      wikiState.novelConfig = prevConfig
    }
  })
})

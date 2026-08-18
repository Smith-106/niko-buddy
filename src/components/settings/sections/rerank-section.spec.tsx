// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/sections/rerank-section.tsx

import { useCallback, useState, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, waitFor } from "@testing-library/react"
import {
  render,
  screen,
  fireEvent,
  act,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { RerankSection } from "./rerank-section"
import type { SettingsDraft, DraftSetter } from "../settings-types"
import type { LlmModelListResult } from "@/lib/settings-model-list"
import type { LlmConfig, RerankConfig } from "@/stores/wiki-store"

// ── hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const state: {
    llmConfig: Record<string, unknown>
  } = {
    llmConfig: { provider: "openai", apiKey: "k", model: "gpt-4o" },
  }
  return {
    state,
    t: vi.fn((key: string, opts?: Record<string, unknown>) =>
      // 与真实 i18n 一致：testFailed/modelListFailed 的 { message } 插值直接透出
      opts && typeof opts.message === "string" ? opts.message : key,
    ),
    fetchRerankModelList: vi.fn<(llmConfig: LlmConfig, rerankConfig: RerankConfig) => Promise<LlmModelListResult>>(async () => ({ models: [] })),
    testSettingsRerankModel: vi.fn(async () => ({ model: "m", content: "c", usedMainLlm: false })),
    recordModelSelectProps: vi.fn(),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}))

vi.mock("@/lib/settings-model-list", () => ({
  fetchRerankModelList: mocks.fetchRerankModelList,
}))

vi.mock("@/lib/settings-model-test", () => ({
  testSettingsRerankModel: mocks.testSettingsRerankModel,
}))

vi.mock("@/components/settings/model-select-input", () => ({
  ModelSelectInput: (props: {
    value: string
    options: string[]
    onChange: (v: string) => void
  }) => {
    mocks.recordModelSelectProps({ value: props.value, options: props.options })
    return (
      <input
        data-testid="model-select-input"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    )
  },
}))

vi.mock("@/components/settings/resource-link", () => ({
  ResourceLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}))

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDraft(overrides: Partial<SettingsDraft["rerankConfig"]> = {}) {
  const rerankConfig = {
    enabled: false,
    useMainLlm: true,
    provider: "custom" as const,
    apiKey: "",
    model: "",
    ollamaUrl: "",
    customEndpoint: "",
    apiMode: "chat_completions" as const,
    maxCandidates: 12,
    ...overrides,
  }
  const draft = { rerankConfig } as unknown as SettingsDraft
  const setDraft: DraftSetter = (key, value) => {
    draft[key] = value
  }
  return { draft, setDraft }
}

/**
 * 受控包装：与真实设置页一致 —— setDraft 同时更新外部 draft（供断言读取）
 * 并触发重渲染。否则输入驱动的分支（ollama 地址框、endpoint 提示、badge
 * 切换、provider 条件区）永远不会出现（前序实现只改 draft 不重渲染）。
 */
function RerankSectionHarness({ draft, setDraft }: { draft: SettingsDraft; setDraft: DraftSetter }) {
  const [, forceRender] = useState(0)
  const handleSetDraft: DraftSetter = useCallback(
    (key, value) => {
      setDraft(key, value)
      forceRender((n) => n + 1)
    },
    [setDraft],
  )
  return <RerankSection draft={draft} setDraft={handleSetDraft} />
}

function renderSection(overrides: Partial<SettingsDraft["rerankConfig"]> = {}) {
  const { draft, setDraft } = makeDraft(overrides)
  render(<RerankSectionHarness draft={draft} setDraft={setDraft} />)
  return draft
}

function expand() {
  fireEvent.click(screen.getByTitle("settings.sections.llm.expand"))
}

const TEST_BTN = "settings.sections.shared.testModel"
const TESTING_LABEL = "settings.sections.shared.testing"

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  setupDomGlobals()
  mocks.state.llmConfig = { provider: "openai", apiKey: "k", model: "gpt-4o" }
  mocks.fetchRerankModelList.mockClear()
  mocks.fetchRerankModelList.mockResolvedValue({ models: [] })
  mocks.testSettingsRerankModel.mockClear()
  mocks.testSettingsRerankModel.mockResolvedValue({ model: "m", content: "c", usedMainLlm: false })
  mocks.recordModelSelectProps.mockClear()
})

describe("RerankSection", () => {
  it("默认折叠：chevron-right + 无正文；点击展开/收起", () => {
    renderSection()
    expect(screen.getByTitle("settings.sections.llm.expand")).toBeInTheDocument()
    expect(screen.queryByText("settings.sections.rerank.description")).not.toBeInTheDocument()
    expand()
    expect(screen.getByTitle("settings.sections.llm.collapse")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.rerank.description")).toBeInTheDocument()
    fireEvent.click(screen.getByTitle("settings.sections.llm.collapse"))
    expect(screen.queryByText("settings.sections.rerank.description")).not.toBeInTheDocument()
  })

  it("启用 toggle：关闭→开启时展开并显示 activeBadge；再关显示 configuredBadge", () => {
    const draft = renderSection({ useMainLlm: true })
    // 关闭态：useMainLlm=true 视为已有配置 → configuredBadge（源码 hasConfig 分支）
    expect(screen.getByText("settings.sections.llm.configuredBadge")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("settings.sections.llm.activate"))
    expect(draft.rerankConfig.enabled).toBe(true)
    // 开启 → activeBadge，configuredBadge 消失（enabled 分支优先）
    expect(screen.getByText("settings.sections.llm.activeBadge")).toBeInTheDocument()
    expect(screen.queryByText("settings.sections.llm.configuredBadge")).not.toBeInTheDocument()
    // 再关 → configuredBadge（hasConfig=useMainLlm=true 且 enabled=false）
    // 展开后有两个 deactivate toggle（启用 + useMainLlm），[0] 为头部启用 toggle
    fireEvent.click(screen.getAllByLabelText("settings.sections.llm.deactivate")[0])
    expect(draft.rerankConfig.enabled).toBe(false)
    expect(screen.getByText("settings.sections.llm.configuredBadge")).toBeInTheDocument()
  })

  it("点击面板标题区域 → handleOpenPanel 展开/收起（与 chevron 等价）", () => {
    renderSection()
    expect(screen.queryByText("settings.sections.rerank.description")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("settings.sections.rerank.enableLabel"))
    expect(screen.getByText("settings.sections.rerank.description")).toBeInTheDocument()
    fireEvent.click(screen.getByText("settings.sections.rerank.enableLabel"))
    expect(screen.queryByText("settings.sections.rerank.description")).not.toBeInTheDocument()
  })

  it("apiKey 输入写回 draft（needsApiKey 区块 onChange）", () => {
    const draft = renderSection({ useMainLlm: false, provider: "openai" })
    expand()
    const apiKeyInput = screen.getByPlaceholderText("settings.sections.rerank.apiKeyPlaceholder") as HTMLInputElement
    fireEvent.change(apiKeyInput, { target: { value: "sk-rerank" } })
    expect(draft.rerankConfig.apiKey).toBe("sk-rerank")
  })

  it("useMainLlm toggle 与 maxCandidates 边界", () => {
    const draft = renderSection()
    expand()
    // 展开后：启用 toggle 未开（activate），useMainLlm toggle 开（deactivate）
    // 先开启用（getAllByLabelText("activate") 仅头部一个）
    fireEvent.click(screen.getAllByLabelText("settings.sections.llm.activate")[0])
    expect(draft.rerankConfig.enabled).toBe(true)
    // useMainLlm toggle：deactivate 列表 [0]=启用 [1]=useMainLlm
    fireEvent.click(screen.getAllByLabelText("settings.sections.llm.deactivate")[1])
    expect(draft.rerankConfig.useMainLlm).toBe(false)

    const candidates = screen.getByRole("spinbutton") as HTMLInputElement
    fireEvent.change(candidates, { target: { value: "50" } })
    expect(draft.rerankConfig.maxCandidates).toBe(30)
    fireEvent.change(candidates, { target: { value: "2" } })
    expect(draft.rerankConfig.maxCandidates).toBe(3)
    fireEvent.change(candidates, { target: { value: "10" } })
    expect(draft.rerankConfig.maxCandidates).toBe(10)
    fireEvent.change(candidates, { target: { value: "" } })
    expect(draft.rerankConfig.maxCandidates).toBe(3) // Number("")||3
    fireEvent.change(candidates, { target: { value: "abc" } })
    expect(draft.rerankConfig.maxCandidates).toBe(3) // Number("abc")||3
  })

  it("useMainLlm=false：provider 列表 + apiKey/ollamaUrl 分支", () => {
    const draft = renderSection({ useMainLlm: false, provider: "openai" })
    expand()
    const providerSelect = screen.getByRole("combobox") as HTMLSelectElement
    expect(providerSelect.querySelectorAll("option").length).toBe(8)
    // openai → 需要 apiKey
    expect(screen.getByText("settings.sections.rerank.apiKey")).toBeInTheDocument()

    fireEvent.change(providerSelect, { target: { value: "ollama" } })
    expect(draft.rerankConfig.provider).toBe("ollama")
    const urlInput = screen.getByPlaceholderText("http://127.0.0.1:11434") as HTMLInputElement
    fireEvent.change(urlInput, { target: { value: "http://localhost:11434" } })
    expect(draft.rerankConfig.ollamaUrl).toBe("http://localhost:11434")
    expect(screen.queryByText("settings.sections.rerank.apiKey")).not.toBeInTheDocument()

    fireEvent.change(providerSelect, { target: { value: "claude-code" } })
    expect(screen.queryByText("settings.sections.rerank.apiKey")).not.toBeInTheDocument()
    fireEvent.change(providerSelect, { target: { value: "codex-cli" } })
    expect(screen.queryByText("settings.sections.rerank.apiKey")).not.toBeInTheDocument()
    fireEvent.change(providerSelect, { target: { value: "anthropic" } })
    expect(screen.getByText("settings.sections.rerank.apiKey")).toBeInTheDocument()
  })

  it("custom provider：apiMode 切换 + endpoint 字段", () => {
    const draft = renderSection({ useMainLlm: false, provider: "custom" })
    expand()
    // 默认 chat_completions active
    expect(screen.getByText("settings.sections.rerank.wireOpenAi")).toBeInTheDocument()
    fireEvent.click(screen.getByText("settings.sections.rerank.wireAnthropic"))
    expect(draft.rerankConfig.apiMode).toBe("anthropic_messages")
    fireEvent.click(screen.getByText("settings.sections.rerank.wireOpenAi"))
    expect(draft.rerankConfig.apiMode).toBe("chat_completions")
  })

  it("custom provider：apiMode 为 undefined 时回退 chat_completions（?? 分支）", () => {
    const draft = renderSection({ useMainLlm: false, provider: "custom", apiMode: undefined })
    expand()
    // 线协议按钮：undefined ?? chat_completions → wireOpenAi 高亮
    const openAiBtn = screen.getByText("settings.sections.rerank.wireOpenAi").closest("button") as HTMLButtonElement
    expect(openAiBtn.className).toContain("border-primary")
    // endpoint 字段 mode 回退 chat_completions（无警告）
    expect(screen.getByPlaceholderText("https://your-api.example.com/v1")).toBeInTheDocument()
    // 切换后显式写入
    fireEvent.click(screen.getByText("settings.sections.rerank.wireAnthropic"))
    expect(draft.rerankConfig.apiMode).toBe("anthropic_messages")
  })

  it("endpoint 字段：rerank 后缀自动规整 + blur 提交", () => {
    const draft = renderSection({ useMainLlm: false, provider: "custom" })
    expand()
    const endpoint = screen.getByPlaceholderText("https://your-api.example.com/v1") as HTMLInputElement
    fireEvent.change(endpoint, { target: { value: "https://x.example.com/rerank/" } })
    expect(screen.getByText("settings.sections.llm.endpointPreviewWillUse")).toBeInTheDocument()
    expect(screen.getByText("https://x.example.com/rerank")).toBeInTheDocument()
    fireEvent.blur(endpoint)
    expect(draft.rerankConfig.customEndpoint).toBe("https://x.example.com/rerank")
  })

  it("endpoint 字段：非 http → warning 提示（CheckCircle2 分支）", () => {
    const draft = renderSection({ useMainLlm: false, provider: "custom" })
    expand()
    const endpoint = screen.getByPlaceholderText("https://your-api.example.com/v1") as HTMLInputElement
    fireEvent.change(endpoint, { target: { value: "localhost:8000" } })
    expect(screen.getByText("接口地址需要以 http:// 或 https:// 开头。")).toBeInTheDocument()
    fireEvent.blur(endpoint)
    expect(draft.rerankConfig.customEndpoint).toBe("localhost:8000")
  })

  it("endpoint 字段：正常 http /v1 → 无提示", () => {
    const draft = renderSection({ useMainLlm: false, provider: "custom" })
    expand()
    const endpoint = screen.getByPlaceholderText("https://your-api.example.com/v1") as HTMLInputElement
    fireEvent.change(endpoint, { target: { value: "https://x.example.com/v1" } })
    expect(screen.queryByText("settings.sections.llm.endpointPreviewWillUse")).not.toBeInTheDocument()
    fireEvent.blur(endpoint)
    expect(draft.rerankConfig.customEndpoint).toBe("https://x.example.com/v1")
  })

  it("endpoint 字段：chat/completions 尾部规整（AlertCircle 分支）", () => {
    const draft = renderSection({ useMainLlm: false, provider: "custom" })
    expand()
    const endpoint = screen.getByPlaceholderText("https://your-api.example.com/v1") as HTMLInputElement
    fireEvent.change(endpoint, { target: { value: "https://x.example.com/v1/chat/completions" } })
    expect(screen.getByText("settings.sections.llm.endpointPreviewWillUse")).toBeInTheDocument()
    fireEvent.blur(endpoint)
    expect(draft.rerankConfig.customEndpoint).toBe("https://x.example.com/v1")
  })

  it("测试模型成功（useMainLlm，usedMainLlm=true）", async () => {
    mocks.testSettingsRerankModel.mockResolvedValue({ model: "gpt-4o", content: "ok", usedMainLlm: true })
    mocks.fetchRerankModelList.mockResolvedValue({ models: ["rerank-a", "rerank-b"] })
    const draft = renderSection({ useMainLlm: true })
    expand()
    fireEvent.click(screen.getByText(TEST_BTN))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.rerank.testSuccessUsingMainModel")).toBeInTheDocument()
    })
    expect(screen.getByText("settings.sections.shared.modelListSuccess")).toBeInTheDocument()
    expect(mocks.testSettingsRerankModel).toHaveBeenCalledWith(mocks.state.llmConfig, draft.rerankConfig)
    expect(mocks.fetchRerankModelList).toHaveBeenCalledWith(mocks.state.llmConfig, draft.rerankConfig)
  })

  it("测试模型成功（独立 provider，usedMainLlm=false）+ 模型下拉选项", async () => {
    mocks.fetchRerankModelList.mockResolvedValue({ models: ["rerank-a", "rerank-b"] })
    const draft = renderSection({ useMainLlm: false, provider: "custom", model: "rerank-a" })
    expand()
    fireEvent.click(screen.getByText(TEST_BTN))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.shared.testSuccessWithModel")).toBeInTheDocument()
    })
    expect(draft.rerankConfig.model).toBe("rerank-a")
    expect(mocks.recordModelSelectProps).toHaveBeenCalledWith(
      expect.objectContaining({ options: ["rerank-a", "rerank-b"] }),
    )
    // 手动改模型
    const modelInput = screen.getByTestId("model-select-input") as HTMLInputElement
    fireEvent.change(modelInput, { target: { value: "rerank-c" } })
    expect(draft.rerankConfig.model).toBe("rerank-c")
  })

  it("测试模型失败：Error 与 非 Error → 错误消息", async () => {
    mocks.testSettingsRerankModel.mockRejectedValueOnce(new Error("bad-key"))
    const draft = renderSection({ useMainLlm: true })
    expand()
    fireEvent.click(screen.getByText(TEST_BTN))
    await waitFor(() => {
      expect(screen.getByText("bad-key")).toBeInTheDocument()
    })
    expect(draft.rerankConfig).toBeTruthy()
  })

  it("测试模型失败：非 Error 抛出 → String(err)", async () => {
    mocks.testSettingsRerankModel.mockRejectedValueOnce("raw-err")
    renderSection({ useMainLlm: true })
    expand()
    fireEvent.click(screen.getByText(TEST_BTN))
    await waitFor(() => {
      expect(screen.getByText("raw-err")).toBeInTheDocument()
    })
  })

  it("模型列表拉取失败 → modelListFailed 消息", async () => {
    mocks.fetchRerankModelList.mockRejectedValueOnce(new Error("list-down"))
    renderSection({ useMainLlm: true })
    expand()
    fireEvent.click(screen.getByText(TEST_BTN))
    await waitFor(() => {
      expect(screen.getByText("list-down")).toBeInTheDocument()
    })
    // eslint-disable-next-line no-console
    console.log("ZZZ p-class:", screen.getByText("list-down").closest("p")?.className)
    // eslint-disable-next-line no-console
    console.log("ZZZ all-p:", JSON.stringify(Array.from(document.querySelectorAll("p")).map((x) => ({ t: x.textContent, c: x.className }))))
    // eslint-disable-next-line no-console
    console.log("ZZZ fetch calls:", mocks.fetchRerankModelList.mock.calls.length)
  })

  it("模型列表拉取失败（useMainLlm=false 面板）→ modelListFailed 消息红字", async () => {
    mocks.fetchRerankModelList.mockRejectedValueOnce("plain-string-fail")
    const draft = renderSection({ useMainLlm: false, provider: "openai" })
    expand()
    fireEvent.click(screen.getByText(TEST_BTN))
    await waitFor(() => {
      expect(screen.getByText("plain-string-fail")).toBeInTheDocument()
    })
    expect(screen.getByText("plain-string-fail").closest("p")?.className).toContain("text-destructive")
    expect(draft.rerankConfig).toBeTruthy()
  })

  it("无模型时不测试（hasModel=false → testState 保持 null），但仍拉取列表", async () => {
    mocks.state.llmConfig = { provider: "openai", apiKey: "k", model: "" }
    const draft = renderSection({ useMainLlm: true })
    expand()
    fireEvent.click(screen.getByText(TEST_BTN))
    await waitFor(() => {
      expect(mocks.fetchRerankModelList).toHaveBeenCalled()
    })
    expect(screen.queryByText("settings.sections.shared.testing")).not.toBeInTheDocument()
    expect(mocks.testSettingsRerankModel).not.toHaveBeenCalled()
    expect(draft.rerankConfig).toBeTruthy()
  })

  it("isBusy：测试挂起时按钮禁用 + testing 文案；列表挂起时同样禁用", async () => {
    let resolveTest: ((v: { model: string; content: string; usedMainLlm: boolean }) => void) | undefined
    mocks.testSettingsRerankModel.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTest = resolve
        }),
    )
    let resolveList: ((v: { models: string[] }) => void) | undefined
    mocks.fetchRerankModelList.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve
        }),
    )
    renderSection({ useMainLlm: true })
    expand()
    const testBtn = screen.getByText(TEST_BTN).closest("button") as HTMLButtonElement
    fireEvent.click(testBtn)
    // 测试进行中：按钮 disabled + testing 文案
    // （按钮文案与 testState 消息同文案 → 两处；用 role 定位按钮避免 multiple elements）
    expect(screen.getByRole("button", { name: TESTING_LABEL })).toBeDisabled()
    expect(screen.getAllByText(TESTING_LABEL)).toHaveLength(2)
    await act(async () => {
      resolveTest?.({ model: "m", content: "c", usedMainLlm: false })
    })
    await waitFor(() => {
      expect(screen.getByText("settings.sections.shared.testSuccessWithModel")).toBeInTheDocument()
    })
    // 列表进行中：仍 busy（消息区为 loadingModels，testing 文案仅剩按钮一处）
    expect(screen.getByRole("button", { name: TESTING_LABEL })).toBeDisabled()
    expect(screen.getAllByText(TESTING_LABEL)).toHaveLength(1)
    await act(async () => {
      resolveList?.({ models: [] })
    })
    await waitFor(() => {
      expect(screen.getByText("settings.sections.shared.modelListSuccess")).toBeInTheDocument()
    })
  })
})

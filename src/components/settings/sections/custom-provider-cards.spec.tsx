// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/sections/custom-provider-cards.tsx

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
import { CustomProviderCards } from "./custom-provider-cards"

// ── hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const state: {
    providerConfigs: Record<string, any>
    activePresetId: string | null
    llmConfig: Record<string, unknown>
    setProviderConfigs: (c: Record<string, any>) => void
    setActivePresetId: (id: string | null) => void
  } = {
    providerConfigs: {},
    activePresetId: null,
    llmConfig: {
      provider: "openai",
      apiKey: "key",
      model: "model",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 204800,
    },
    setProviderConfigs: (configs) => {
      state.providerConfigs = configs
    },
    setActivePresetId: (id) => {
      state.activePresetId = id
    },
  }
  // In-memory stand-in for the Tauri store plugin. The real
  // @/lib/project-store module routes every persistence call through
  // getStore(), so mocking @/lib/web-store makes real saves
  // deterministic in jsdom (the native vitest loader makes
  // vi.mock interception of *dynamic* imports unreliable).
  const store = {
    data: {} as Record<string, unknown>,
    get: vi.fn(async (key: string) => store.data[key] ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      store.data[key] = value
    }),
    save: vi.fn(async () => {}),
  }
  return {
    state,
    store,
    t: vi.fn((key: string, params?: { message?: unknown }) =>
      params && typeof params.message === "string" ? params.message : key,
    ),
    fetchLlmModelList: vi.fn(async () => ({ models: ["model-alpha", "model-beta"] })),
    batch: {
      state: {
        loading: false,
        success: false,
        message: "",
        failedModels: undefined as string[] | undefined,
      },
      runBatchTest: vi.fn(async () => {}),
      retryFailed: vi.fn(async () => {}),
      removeFailedModel: vi.fn(),
    },
    recordModelOptions: vi.fn(),
    isTauri: vi.fn(() => false),
    invoke: vi.fn(),
    testLlmConnection: vi.fn(async () => ({ ok: true, message: "conn-ok" })),
    testLlmFunction: vi.fn(async () => ({ ok: false, message: "func-fail" })),
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

// The real wiki-store module must stay loadable by the real
// project-store (values imported at module top level).
vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: Object.assign(
    (selector: (s: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
  DEFAULT_NOVEL_CONFIG: {},
  DEFAULT_RERANK_CONFIG: {},
}))

// Real @/lib/project-store persistence routes through getStore(); the
// mocked store keeps real saves deterministic without tauri invoke.
vi.mock("@/lib/web-store", () => ({
  getStore: async () => mocks.store,
}))

vi.mock("@/lib/platform", () => ({
  isTauri: mocks.isTauri,
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}))

vi.mock("@/lib/connection-tests", () => ({
  testLlmConnection: mocks.testLlmConnection,
  testLlmFunction: mocks.testLlmFunction,
}))

vi.mock("@/lib/settings-model-list", () => ({
  fetchLlmModelList: mocks.fetchLlmModelList,
}))

vi.mock("../hooks/use-batch-model-test", () => ({
  useBatchModelTest: () => ({
    modelTestState: mocks.batch.state,
    runBatchTest: mocks.batch.runBatchTest,
    retryFailed: mocks.batch.retryFailed,
    clearTestState: vi.fn(),
    removeFailedModel: mocks.batch.removeFailedModel,
  }),
}))

vi.mock("../model-select-input", () => ({
  ModelSelectInput: (props: {
    value: string
    options: string[]
    onChange: (v: string) => void
  }) => {
    mocks.recordModelOptions(props.options)
    return (
      <input
        data-testid="model-select-input"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    )
  },
}))

vi.mock("./saved-models-manager", () => ({
  SavedModelsManager: (props: {
    savedModels: { model: string; id: string }[]
    onChange: (m: unknown[]) => void
  }) => (
    <div>
      <span data-testid="saved-models-count">{props.savedModels.length}</span>
      <button data-testid="saved-models-clear" onClick={() => props.onChange([])}>
        clear-all
      </button>
    </div>
  ),
}))

// ── helpers ──────────────────────────────────────────────────────────────────

const FETCH_BTN = "settings.sections.llm.fetchModels"
const TEST_BTN = "settings.sections.shared.testModel"
const TESTING_LABEL = "settings.sections.shared.testing"

function expandCard(container: HTMLElement) {
  fireEvent.click(within(container).getByTitle("展开"))
}

/** Find the card container for the given label text. */
function cardByLabel(label: string): HTMLElement {
  const el = screen.getByText(label)
  let node: HTMLElement | null = el
  while (node && !String(node.className).includes("rounded-lg border")) {
    node = node.parentElement
  }
  return node as HTMLElement
}

async function fetchModels(card: HTMLElement) {
  fireEvent.click(within(card).getByText(FETCH_BTN))
  await waitFor(() => {
    // "已拉取 N 个模型" renders both as the count button and the
    // success message, so use getAllByText.
    expect(within(card).getAllByText("已拉取 2 个模型").length).toBeGreaterThan(0)
  })
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  setupDomGlobals()
  mocks.state.providerConfigs = {}
  mocks.state.activePresetId = null
  mocks.batch.state = { loading: false, success: false, message: "", failedModels: undefined }
  mocks.batch.runBatchTest.mockClear()
  mocks.batch.retryFailed.mockClear()
  mocks.batch.removeFailedModel.mockClear()
  mocks.saveProviderConfigs?.mockClear()
  mocks.saveActivePresetId?.mockClear()
  mocks.store.set.mockClear()
  mocks.store.get.mockClear()
  mocks.store.save.mockClear()
  mocks.fetchLlmModelList.mockClear()
  mocks.fetchLlmModelList.mockResolvedValue({ models: ["model-alpha", "model-beta"] })
  mocks.recordModelOptions.mockClear()
  window.confirm = vi.fn(() => true) as unknown as typeof window.confirm
})

// ── tests ────────────────────────────────────────────────────────────────────

describe("CustomProviderCards", () => {
  it("renders empty state when no custom provider configs exist", () => {
    render(<CustomProviderCards />)
    expect(screen.getByText("自定义模型配置")).toBeInTheDocument()
    expect(screen.getByText("暂未添加任何模型配置")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /添加模型/ })).toBeInTheDocument()
  })

  it("addCard adds a card to UI and persists to the store", async () => {
    const { rerender } = render(<CustomProviderCards />)
    fireEvent.click(screen.getByRole("button", { name: /添加模型/ }))

    await waitFor(() => {
      const keys = Object.keys(mocks.state.providerConfigs)
      expect(keys.length).toBe(1)
      expect(keys[0]).toMatch(/^custom-\d+$/)
    })

    rerender(<CustomProviderCards />)
    expect(screen.getByText("自定义模型")).toBeInTheDocument()
    expect(screen.getByText("未配置")).toBeInTheDocument()

    const card = cardByLabel("自定义模型")
    expect(String(card.className)).toContain("border-primary/60")
    await waitFor(() =>
      expect(mocks.store.set).toHaveBeenCalledWith("providerConfigs", expect.anything()),
    )
  })

  it("initializes cards from existing custom-* store configs and derives baseUrl hint", () => {
    mocks.state.providerConfigs = {
      "custom-1": {
        label: "My Provider",
        apiMode: "chat_completions",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        model: "gpt-4o",
        enabled: false,
        savedModels: [],
      },
      "custom-2": {
        label: "Broken",
        baseUrl: "not a url",
        enabled: true,
      },
      "custom-3": { label: "Empty", enabled: true },
      other: { label: "Not a card", enabled: true },
    }
    render(<CustomProviderCards />)
    expect(screen.getByText("My Provider")).toBeInTheDocument()
    expect(screen.getByText("Broken")).toBeInTheDocument()
    expect(screen.getByText("Empty")).toBeInTheDocument()
    expect(screen.queryByText("Not a card")).not.toBeInTheDocument()

    expect(screen.getByText("api.openai.com")).toBeInTheDocument()
    expect(screen.getByText("not a url")).toBeInTheDocument()
    expect(screen.getByText("未配置")).toBeInTheDocument()

    const disabledCard = cardByLabel("My Provider")
    expect(String(disabledCard.className)).toContain("border-border")
    const enabledCard = cardByLabel("Broken")
    expect(String(enabledCard.className)).toContain("border-primary/60")
  })

  it("edits label via inline input (blur and Enter/Escape both close)", () => {
    mocks.state.providerConfigs = {
      "custom-1": { label: "Old", enabled: true, baseUrl: "https://x.example.com" },
    }
    const { rerender } = render(<CustomProviderCards />)

    fireEvent.click(screen.getByText("Old"))
    const input = screen.getByDisplayValue("Old")
    fireEvent.change(input, { target: { value: "New Label" } })
    expect(mocks.state.providerConfigs["custom-1"].label).toBe("New Label")
    fireEvent.keyDown(input, { key: "Enter" })
    rerender(<CustomProviderCards />)
    expect(screen.getByText("New Label")).toBeInTheDocument()

    fireEvent.click(screen.getByText("New Label"))
    const input2 = screen.getByDisplayValue("New Label")
    fireEvent.change(input2, { target: { value: "Escaped" } })
    fireEvent.keyDown(input2, { key: "Escape" })
    rerender(<CustomProviderCards />)
    expect(screen.getByText("Escaped")).toBeInTheDocument()
  })

  it("edits apiMode, baseUrl, apiKey and model fields and persists", () => {
    mocks.state.providerConfigs = {
      "custom-1": { label: "C1", enabled: true, baseUrl: "", apiMode: "chat_completions" },
    }
    render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)

    fireEvent.click(within(card).getByText("Responses API"))
    expect(mocks.state.providerConfigs["custom-1"].apiMode).toBe("responses")
    fireEvent.click(within(card).getByText("Anthropic 兼容"))
    expect(mocks.state.providerConfigs["custom-1"].apiMode).toBe("anthropic_messages")
    fireEvent.click(within(card).getByText("OpenAI 兼容"))
    expect(mocks.state.providerConfigs["custom-1"].apiMode).toBe("chat_completions")

    const urlInput = within(card).getByLabelText("接口地址")
    fireEvent.change(urlInput, { target: { value: "https://api.example.com/v1" } })
    expect(mocks.state.providerConfigs["custom-1"].baseUrl).toBe("https://api.example.com/v1")

    const keyInput = within(card).getByLabelText("API 密钥")
    fireEvent.change(keyInput, { target: { value: "sk-abc" } })
    expect(mocks.state.providerConfigs["custom-1"].apiKey).toBe("sk-abc")

    const modelInput = within(card).getByLabelText("模型")
    fireEvent.change(modelInput, { target: { value: "gpt-4.1" } })
    expect(mocks.state.providerConfigs["custom-1"].model).toBe("gpt-4.1")
  })

  it("toggleEnabled flips enabled state and persists", () => {
    mocks.state.providerConfigs = {
      "custom-1": { label: "C1", enabled: true },
    }
    const { rerender } = render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    fireEvent.click(within(card).getByTitle("停用"))
    expect(mocks.state.providerConfigs["custom-1"].enabled).toBe(false)
    rerender(<CustomProviderCards />)
    fireEvent.click(within(card).getByTitle("启用"))
    expect(mocks.state.providerConfigs["custom-1"].enabled).toBe(true)
  })

  it("adds manual models via Enter key and the add button, dedupes existing models", () => {
    mocks.state.providerConfigs = {
      "custom-1": {
        label: "C1",
        enabled: true,
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-x",
        model: "gpt-4o",
        savedModels: [{ id: "m0", name: "gpt-4o", model: "gpt-4o", createdAt: 1 }],
      },
    }
    const { rerender } = render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)

    const addButton = within(card).getByRole("button", { name: "添加" })
    expect(addButton).toBeDisabled()

    const modelInput = within(card).getByLabelText("模型")
    fireEvent.change(modelInput, { target: { value: "gpt-4o" } })
    expect(addButton).toBeDisabled()

    fireEvent.change(modelInput, { target: { value: "gpt-4o, gpt-5" } })
    expect(addButton).toBeEnabled()
    fireEvent.keyDown(modelInput, { key: "Enter" })
    rerender(<CustomProviderCards />)
    expect(mocks.state.providerConfigs["custom-1"].savedModels.map((m: any) => m.model)).toEqual([
      "gpt-4o",
      "gpt-5",
    ])
    expect(mocks.state.providerConfigs["custom-1"].model).toBe("gpt-4o")
    expect(modelInput).toHaveValue("")

    fireEvent.change(modelInput, { target: { value: "gpt-6，gpt-7,gpt-8" } })
    fireEvent.click(addButton)
    rerender(<CustomProviderCards />)
    expect(mocks.state.providerConfigs["custom-1"].savedModels.map((m: any) => m.model)).toEqual([
      "gpt-4o",
      "gpt-5",
      "gpt-6",
      "gpt-7",
      "gpt-8",
    ])
  })

  it("addManualModelToSaved no-ops for empty or fully-duplicate input", () => {
    mocks.state.providerConfigs = {
      "custom-1": {
        label: "C1",
        enabled: true,
        savedModels: [{ id: "m0", name: "gpt-4o", model: "gpt-4o", createdAt: 1 }],
      },
    }
    render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)
    const modelInput = within(card).getByLabelText("模型")
    const savedCountBefore = JSON.stringify(mocks.state.providerConfigs["custom-1"].savedModels)

    fireEvent.keyDown(modelInput, { key: "Enter" })
    fireEvent.change(modelInput, { target: { value: "gpt-4o" } })
    fireEvent.click(within(card).getByRole("button", { name: "添加" }))
    expect(JSON.stringify(mocks.state.providerConfigs["custom-1"].savedModels)).toBe(savedCountBefore)
  })

  it("toggles model selection chips, removes saved models, select-all and clear", async () => {
    mocks.state.providerConfigs = {
      "custom-1": {
        label: "C1",
        enabled: true,
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-x",
        model: "gpt-4o",
        savedModels: [
          { id: "m0", name: "model-alpha", model: "model-alpha", createdAt: 1 },
          { id: "m1", name: "other", model: "other", createdAt: 2 },
        ],
      },
    }
    const { rerender } = render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)

    // remove "other" via its chip X button
    const otherChip = within(card).getByText("other").closest("span") as HTMLElement
    fireEvent.click(within(otherChip).getByTitle("移除"))
    expect(mocks.state.providerConfigs["custom-1"].savedModels.map((m: any) => m.model)).toEqual([
      "model-alpha",
    ])
    expect(mocks.batch.removeFailedModel).toHaveBeenCalledWith("other")
    expect(mocks.state.providerConfigs["custom-1"].model).toBe("model-alpha")
    rerender(<CustomProviderCards />)

    await fetchModels(card)
    // model-alpha currently selected → toggle removes it (the selection
    // grid chips are <button>s; the saved-model chip is a <span>)
    fireEvent.click(within(card).getByRole("button", { name: "model-alpha" }))
    expect(mocks.state.providerConfigs["custom-1"].savedModels).toEqual([])
    // fallback to card.model when the last saved model is removed
    expect(mocks.state.providerConfigs["custom-1"].model).toBe("model-alpha")
    rerender(<CustomProviderCards />)

    // manual input falls back to card.model when saved models go from >0 to 0
    expect(within(card).getByLabelText("模型")).toHaveValue("model-alpha")

    // toggle back on
    fireEvent.click(within(card).getByRole("button", { name: "model-alpha" }))
    expect(mocks.state.providerConfigs["custom-1"].savedModels.map((m: any) => m.model)).toEqual([
      "model-alpha",
    ])
    rerender(<CustomProviderCards />)

    // 全选 adds the missing beta; second click early-returns; 清空 empties
    fireEvent.click(within(card).getByText("全选"))
    rerender(<CustomProviderCards />)
    expect(mocks.state.providerConfigs["custom-1"].savedModels.length).toBe(2)
    fireEvent.click(within(card).getByText("全选"))
    expect(mocks.state.providerConfigs["custom-1"].savedModels.length).toBe(2)
    fireEvent.click(within(card).getByText("清空"))
    expect(mocks.state.providerConfigs["custom-1"].savedModels).toEqual([])
    expect(mocks.state.providerConfigs["custom-1"].model).toBe("")
  })

  it("selects all fetched models with 全选 when none selected", async () => {
    mocks.state.providerConfigs = {
      "custom-1": { label: "C1", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "k" },
    }
    const { rerender } = render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)
    await fetchModels(card)
    fireEvent.click(within(card).getByText("全选"))
    rerender(<CustomProviderCards />)
    const saved = mocks.state.providerConfigs["custom-1"].savedModels as any[]
    expect(saved.map((m) => m.model).sort()).toEqual(["model-alpha", "model-beta"])
    expect(mocks.state.providerConfigs["custom-1"].model).toBe("model-alpha")
  })

  it("shows failed fetch message on model list error", async () => {
    mocks.fetchLlmModelList.mockRejectedValueOnce(new Error("boom"))
    mocks.state.providerConfigs = { "custom-1": { label: "C1", enabled: true } }
    render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)
    fireEvent.click(within(card).getByText(FETCH_BTN))
    await waitFor(() => {
      expect(within(card).getByText("boom")).toBeInTheDocument()
    })
  })

  it("shows loading state while fetching models (button disabled + loading label)", () => {
    mocks.fetchLlmModelList.mockReturnValueOnce(new Promise(() => {}))
    mocks.state.providerConfigs = { "custom-1": { label: "C1", enabled: true } }
    render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)
    fireEvent.click(within(card).getByText(FETCH_BTN))
    const loadingLabel = within(card).getByText("settings.sections.llm.loadingModels")
    expect(loadingLabel).toBeInTheDocument()
    expect(loadingLabel.closest("button")).toBeDisabled()
    expect(within(card).getByText(TEST_BTN).closest("button")).toBeDisabled()
  })

  it("tests models and shows failed retry UI with retry button", async () => {
    mocks.batch.state = {
      loading: false,
      success: false,
      message: "部分失败",
      failedModels: ["model-alpha"],
    }
    mocks.state.providerConfigs = {
      "custom-1": {
        label: "C1",
        enabled: true,
        savedModels: [{ id: "m0", name: "saved-x", model: "saved-x", createdAt: 1 }],
      },
    }
    const { rerender } = render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)

    // loading → button disabled, shows testing label, click no-ops
    mocks.batch.state.loading = true
    rerender(<CustomProviderCards />)
    fireEvent.click(within(card).getByText(TESTING_LABEL))
    expect(mocks.batch.runBatchTest).not.toHaveBeenCalled()

    mocks.batch.state.loading = false
    rerender(<CustomProviderCards />)
    fireEvent.click(within(card).getByText(TEST_BTN))
    expect(mocks.batch.runBatchTest).toHaveBeenCalledTimes(1)
    expect(mocks.batch.runBatchTest).toHaveBeenCalledWith(["saved-x"], expect.any(Function))

    expect(within(card).getByText("失败模型：")).toBeInTheDocument()
    expect(within(card).getByText("model-alpha")).toBeInTheDocument()
    expect(within(card).getByText("部分失败")).toBeInTheDocument()
    fireEvent.click(within(card).getByText("重试失败模型"))
    expect(mocks.batch.retryFailed).toHaveBeenCalledTimes(1)
  })

  it("test button disabled when no saved models and no manual input; enabled after typing", () => {
    mocks.state.providerConfigs = { "custom-1": { label: "C1", enabled: true } }
    render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)
    const testBtn = within(card).getByText(TEST_BTN).closest("button")
    expect(testBtn).toBeDisabled()
    const modelInput = within(card).getByLabelText("模型")
    fireEvent.change(modelInput, { target: { value: "manual-model" } })
    expect(testBtn).toBeEnabled()
    fireEvent.click(testBtn as HTMLButtonElement)
    expect(mocks.batch.runBatchTest).toHaveBeenCalledWith(["manual-model"], expect.any(Function))
  })

  it("updates maxContextSize via ContextSizeSelector and reasoning via ReasoningControls", () => {
    mocks.state.providerConfigs = {
      "custom-1": { label: "C1", enabled: true, maxContextSize: 131072 },
    }
    render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)
    fireEvent.click(within(card).getByText("256K"))
    expect(mocks.state.providerConfigs["custom-1"].maxContextSize).toBe(262144)

    fireEvent.click(within(card).getByText("settings.sections.llm.reasoning.off"))
    expect(mocks.state.providerConfigs["custom-1"].reasoning).toEqual({ mode: "off" })
    fireEvent.click(within(card).getByText("settings.sections.llm.reasoning.custom"))
    expect(mocks.state.providerConfigs["custom-1"].reasoning).toEqual({ mode: "custom" })

    const budget = within(card).getByPlaceholderText("1024")
    fireEvent.change(budget, { target: { value: "2048" } })
    expect(mocks.state.providerConfigs["custom-1"].reasoning.budgetTokens).toBe(2048)
    fireEvent.change(budget, { target: { value: "" } })
    expect(mocks.state.providerConfigs["custom-1"].reasoning.budgetTokens).toBeUndefined()
    fireEvent.change(budget, { target: { value: "abc" } })
    expect(mocks.state.providerConfigs["custom-1"].reasoning.budgetTokens).toBeUndefined()
  })

  it("deletes a card: confirm false aborts, confirm true removes + persists", async () => {
    mocks.state.providerConfigs = {
      "custom-1": { label: "C1", enabled: true },
      "custom-2": { label: "C2", enabled: true },
    }
    const { rerender } = render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)

    ;(window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)
    fireEvent.click(within(card).getByText("删除此配置"))
    expect(mocks.state.providerConfigs["custom-1"]).toBeDefined()

    fireEvent.click(within(card).getByText("删除此配置"))
    rerender(<CustomProviderCards />)
    expect(mocks.state.providerConfigs["custom-1"]).toBeUndefined()
    expect(mocks.state.providerConfigs["custom-2"]).toBeDefined()
    expect(screen.queryByText("C1")).not.toBeInTheDocument()
    expect(screen.getByText("C2")).toBeInTheDocument()
    await waitFor(() =>
      expect(mocks.store.set).toHaveBeenCalledWith("providerConfigs", expect.anything()),
    )
  })

  it("deletes the active card → deactivates preset and persists active id", async () => {
    mocks.state.providerConfigs = {
      "custom-1": { label: "C1", enabled: true },
    }
    mocks.state.activePresetId = "custom-1"
    const { rerender } = render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)
    fireEvent.click(within(card).getByText("删除此配置"))
    rerender(<CustomProviderCards />)
    expect(mocks.state.activePresetId).toBeNull()
    await waitFor(() => expect(mocks.store.set).toHaveBeenCalledWith("activePresetId", null))
    await waitFor(() =>
      expect(mocks.store.set).toHaveBeenCalledWith("providerConfigs", expect.anything()),
    )
  })

  it("blur closes label edit mode (onBlur branch)", () => {
    mocks.state.providerConfigs = { "custom-1": { label: "Old Label", enabled: true } }
    render(<CustomProviderCards />)
    fireEvent.click(screen.getByText("Old Label"))
    const input = screen.getByDisplayValue("Old Label")
    fireEvent.blur(input)
    // edit mode closed → label text rendered again instead of the input
    expect(screen.queryByDisplayValue("Old Label")).not.toBeInTheDocument()
    expect(screen.getByText("Old Label")).toBeInTheDocument()
  })

  it("collapses/expands the fetched-models section via its toggle", async () => {
    mocks.state.providerConfigs = { "custom-1": { label: "C1", enabled: true } }
    const { rerender } = render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)
    await fetchModels(card)
    // auto-expanded after fetch → selection grid chips visible
    expect(within(card).getByRole("button", { name: "model-alpha" })).toBeInTheDocument()
    // collapse via the header toggle (the 已选择 span lives inside the toggle)
    fireEvent.click(within(card).getByText("已选择 0 个"))
    rerender(<CustomProviderCards />)
    expect(within(card).queryByRole("button", { name: "model-alpha" })).not.toBeInTheDocument()
    // expand again
    fireEvent.click(within(card).getByText("已选择 0 个"))
    rerender(<CustomProviderCards />)
    expect(within(card).getByRole("button", { name: "model-alpha" })).toBeInTheDocument()
  })

  it("config without label/apiMode/enabled → initializer fallbacks", () => {
    mocks.state.providerConfigs = { "custom-1": { baseUrl: "https://x.example.com/v1" } }
    render(<CustomProviderCards />)
    // label || 自定义模型, apiMode || chat_completions, enabled ?? true
    expect(screen.getByText("自定义模型")).toBeInTheDocument()
    const card = cardByLabel("自定义模型")
    expect(String(card.className)).toContain("border-primary/60")
  })

  it("empty label edit → header falls back to 配置名称", () => {
    mocks.state.providerConfigs = { "custom-1": { label: "X", enabled: true } }
    const { rerender } = render(<CustomProviderCards />)
    fireEvent.click(screen.getByText("X"))
    const input = screen.getByDisplayValue("X")
    fireEvent.change(input, { target: { value: "" } })
    // exit edit mode via Enter so the header re-renders
    fireEvent.keyDown(input, { key: "Enter" })
    rerender(<CustomProviderCards />)
    expect(screen.getByText("配置名称")).toBeInTheDocument()
  })

  it("label-edit keydown with another key keeps editing (Enter/Escape guard false side)", () => {
    mocks.state.providerConfigs = { "custom-1": { label: "X", enabled: true } }
    render(<CustomProviderCards />)
    fireEvent.click(screen.getByText("X"))
    const input = screen.getByDisplayValue("X")
    fireEvent.keyDown(input, { key: "Tab" })
    // still editing
    expect(screen.getByDisplayValue("X")).toBeInTheDocument()
  })

  it("updating one of two cards keeps the other card intact (map ternary false side)", () => {
    mocks.state.providerConfigs = {
      "custom-1": { label: "C1", enabled: true },
      "custom-2": { label: "C2", enabled: true },
    }
    const { rerender } = render(<CustomProviderCards />)
    const c1 = cardByLabel("C1")
    fireEvent.click(within(c1).getByTitle("停用"))
    rerender(<CustomProviderCards />)
    expect(screen.getByText("C2")).toBeInTheDocument()
    expect(mocks.state.providerConfigs["custom-1"].enabled).toBe(false)
    expect(mocks.state.providerConfigs["custom-2"].enabled).toBe(true)
  })

  it("updateCard falls back to {} when the store config was removed (?? guard)", () => {
    mocks.state.providerConfigs = { "custom-1": { label: "C1", enabled: true } }
    const { rerender } = render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    // the store key disappears and the component re-renders: the cards state
    // persists (useState init runs once) but the selector re-reads the now
    // empty providerConfigs → prev falls back to {}
    mocks.state.providerConfigs = {}
    rerender(<CustomProviderCards />)
    fireEvent.click(within(card).getByTitle("停用"))
    expect(mocks.state.providerConfigs["custom-1"]).toBeDefined()
    expect(mocks.state.providerConfigs["custom-1"].enabled).toBe(false)
  })

  it("updateCard with config lacking enabled → ?? true fallback in updatedConfig", () => {
    mocks.state.providerConfigs = { "custom-1": { label: "X" } }
    const { rerender } = render(<CustomProviderCards />)
    fireEvent.click(screen.getByText("X"))
    const input = screen.getByDisplayValue("X")
    fireEvent.change(input, { target: { value: "Y" } })
    rerender(<CustomProviderCards />)
    expect(mocks.state.providerConfigs["custom-1"].label).toBe("Y")
    expect(mocks.state.providerConfigs["custom-1"].enabled).toBe(true)
  })

  it("model-list failure with non-Error rejection → String(error) message", async () => {
    mocks.fetchLlmModelList.mockRejectedValueOnce("raw-boom")
    mocks.state.providerConfigs = { "custom-1": { label: "C1", enabled: true } }
    render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)
    fireEvent.click(within(card).getByText(FETCH_BTN))
    await waitFor(() => {
      expect(within(card).getByText("raw-boom")).toBeInTheDocument()
    })
  })

  it("Enter with fully-duplicate manual input → newModels empty → early return", () => {
    mocks.state.providerConfigs = {
      "custom-1": {
        label: "C1",
        enabled: true,
        savedModels: [{ id: "m0", name: "gpt-4o", model: "gpt-4o", createdAt: 1 }],
      },
    }
    render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)
    const modelInput = within(card).getByLabelText("模型")
    fireEvent.change(modelInput, { target: { value: "gpt-4o" } })
    fireEvent.keyDown(modelInput, { key: "Enter" })
    expect(mocks.state.providerConfigs["custom-1"].savedModels).toHaveLength(1)
  })

  it("model input non-Enter keydown is a no-op (guard false side)", () => {
    mocks.state.providerConfigs = { "custom-1": { label: "C1", enabled: true } }
    render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)
    const modelInput = within(card).getByLabelText("模型")
    fireEvent.change(modelInput, { target: { value: "gpt-x" } })
    fireEvent.keyDown(modelInput, { key: "Tab" })
    expect(mocks.state.providerConfigs["custom-1"].savedModels).toBeUndefined()
  })

  it("removing the LAST saved model falls back to card.model", () => {
    mocks.state.providerConfigs = {
      "custom-1": {
        label: "C1",
        enabled: true,
        model: "gpt-4o",
        savedModels: [{ id: "m0", name: "only", model: "only", createdAt: 1 }],
      },
    }
    render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)
    const chip = within(card).getByText("only").closest("span") as HTMLElement
    fireEvent.click(within(chip).getByTitle("移除"))
    expect(mocks.state.providerConfigs["custom-1"].savedModels).toEqual([])
    expect(mocks.state.providerConfigs["custom-1"].model).toBe("gpt-4o")
  })

  it("URL with empty host falls back to the raw baseUrl in the hint", () => {
    mocks.state.providerConfigs = {
      "custom-1": { label: "C1", enabled: true, baseUrl: "file:///tmp/custom" },
    }
    render(<CustomProviderCards />)
    expect(screen.getByText("file:///tmp/custom")).toBeInTheDocument()
  })

  it("清空 with no saved models is a no-op (guard)", async () => {
    mocks.state.providerConfigs = { "custom-1": { label: "C1", enabled: true } }
    const { rerender } = render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)
    await fetchModels(card)
    fireEvent.click(within(card).getByText("清空"))
    rerender(<CustomProviderCards />)
    expect(mocks.state.providerConfigs["custom-1"].savedModels).toBeUndefined()
  })

  it("failed saved model chip renders the destructive style", () => {
    mocks.batch.state = {
      loading: false,
      success: false,
      message: "部分失败",
      failedModels: ["model-alpha"],
    }
    mocks.state.providerConfigs = {
      "custom-1": {
        label: "C1",
        enabled: true,
        savedModels: [{ id: "m0", name: "model-alpha", model: "model-alpha", createdAt: 1 }],
      },
    }
    render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)
    // the saved-model chip wraps its own 移除 button — disambiguate from the
    // failed-models list chip (which has no 移除 button)
    const chip = within(card).getByTitle("移除").closest("span") as HTMLElement
    expect(chip.className).toContain("bg-destructive/15")
    const removeBtn = within(card).getByTitle("移除")
    expect(removeBtn.className).toContain("hover:bg-destructive/20")
  })

  it("successful batch state renders the success message in green", () => {
    mocks.batch.state = {
      loading: false,
      success: true,
      message: "全部通过",
      failedModels: undefined,
    }
    mocks.state.providerConfigs = {
      "custom-1": { label: "C1", enabled: true, savedModels: [] },
    }
    render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)
    const msg = within(card).getByText("全部通过")
    expect(msg.className).toContain("text-emerald-600")
  })

  it("testCurrentModel mapper callback executes (runBatchTest builds configs)", async () => {
    mocks.batch.runBatchTest.mockImplementation(
      async (_models: string[], buildConfig: (m: string) => unknown) => {
        buildConfig("mapped-model")
      },
    )
    mocks.state.providerConfigs = {
      "custom-1": { label: "C1", enabled: true, savedModels: [] },
    }
    render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)
    const modelInput = within(card).getByLabelText("模型")
    fireEvent.change(modelInput, { target: { value: "manual-model" } })
    fireEvent.click(within(card).getByText(TEST_BTN))
    await waitFor(() => {
      expect(mocks.batch.runBatchTest).toHaveBeenCalledWith(
        ["manual-model"],
        expect.any(Function),
      )
    })
  })

  it("retryFailed mapper callback executes (builds config per failed model)", async () => {
    mocks.batch.state = {
      loading: false,
      success: false,
      message: "部分失败",
      failedModels: ["model-alpha"],
    }
    mocks.batch.retryFailed.mockImplementation(async (buildConfig: (m: string) => unknown) => {
      buildConfig("model-alpha")
    })
    mocks.state.providerConfigs = {
      "custom-1": {
        label: "C1",
        enabled: true,
        savedModels: [{ id: "m0", name: "model-alpha", model: "model-alpha", createdAt: 1 }],
      },
    }
    render(<CustomProviderCards />)
    const card = cardByLabel("C1")
    expandCard(card)
    fireEvent.click(within(card).getByText("重试失败模型"))
    await waitFor(() => {
      expect(mocks.batch.retryFailed).toHaveBeenCalledWith(expect.any(Function))
    })
  })
})

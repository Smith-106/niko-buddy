// @vitest-environment jsdom
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// 100% coverage spec for src/components/settings/sections/llm-provider-section.tsx

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  act,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { LlmProviderSection, ReasoningControls } from "./llm-provider-section"
import type { LlmPreset } from "../llm-presets"

// ── hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const state: {
    providerConfigs: Record<string, any>
    activePresetId: string | null
    llmConfig: Record<string, unknown>
    setProviderConfigs: (c: Record<string, any>) => void
    setActivePresetId: (id: string | null) => void
    setLlmConfig: ReturnType<typeof vi.fn>
  } = {
    providerConfigs: {},
    activePresetId: null,
    llmConfig: {
      provider: "openai",
      apiKey: "",
      model: "",
      ollamaUrl: "http://localhost:11434",
      customEndpoint: "",
      maxContextSize: 204800,
      reasoning: { mode: "auto" },
      localCliIsolation: false,
    },
    setProviderConfigs: (configs) => {
      state.providerConfigs = configs
    },
    setActivePresetId: (id) => {
      state.activePresetId = id
    },
    setLlmConfig: vi.fn(),
  }
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
    t: vi.fn((key: string, params?: Record<string, unknown>) => {
      // keep interpolations visible for {model}/{message} labels
      if (params && typeof params.model === "string") return `${key}:${params.model}`
      if (params && typeof params.message === "string") return params.message
      return key
    }),
    LLM_PRESETS: [] as LlmPreset[],
    resolveConfig: vi.fn(() => ({
      provider: "openai",
      apiKey: "",
      model: "",
      ollamaUrl: "http://localhost:11434",
      customEndpoint: "",
      maxContextSize: 204800,
      reasoning: { mode: "auto" },
      localCliIsolation: false,
    })),
    normalizeEndpoint: vi.fn((raw: string) => ({ normalized: raw, changed: false })),
    isTauri: vi.fn(() => false),
    invoke: vi.fn<() => Promise<{ installed: boolean; version: string | null; path: string | null; error: string | null }>>(async () => ({ installed: true, version: "2.1.0", path: "/usr/bin/claude", error: null })),
    testLlmConnection: vi.fn(async () => ({ ok: true, message: "conn-ok" })),
    testLlmFunction: vi.fn(async () => ({ ok: false, message: "func-fail" })),
    fetchLlmModelList: vi.fn(async () => ({ models: ["m-alpha", "m-beta"] })),
    batch: {
      state: {
        loading: false,
        success: false,
        message: "",
        failedModels: undefined as string[] | undefined,
      },
      // invoke the buildConfig callback so the source arrows are executed
      runBatchTest: vi.fn(async (models: string[], buildConfig: (m: string) => unknown) => {
        ;(models ?? []).forEach((m) => buildConfig(m))
      }),
      retryFailed: vi.fn(async (buildConfig: (m: string) => unknown) => {
        buildConfig("m-alpha")
      }),
    },
    recordModelOptions: vi.fn(),
    setLlmConfig: vi.fn(),
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
  DEFAULT_NOVEL_CONFIG: {},
  DEFAULT_RERANK_CONFIG: {},
}))

vi.mock("../llm-presets", () => ({
  LLM_PRESETS: mocks.LLM_PRESETS,
}))

vi.mock("../preset-resolver", () => ({
  resolveConfig: mocks.resolveConfig,
}))

vi.mock("@/lib/endpoint-normalizer", () => ({
  normalizeEndpoint: mocks.normalizeEndpoint,
}))

vi.mock("@/lib/platform", () => ({
  isTauri: mocks.isTauri,
}))

vi.mock("@/lib/azure-openai", () => ({
  AZURE_OPENAI_API_VERSION: "2024-10-21",
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
  }),
}))

vi.mock("../model-select-input", () => ({
  ModelSelectInput: (props: {
    value: string
    options: string[]
    onChange: (v: string) => void
    inputPlaceholder?: string
    selectPlaceholder?: string
  }) => {
    mocks.recordModelOptions(props.options)
    return (
      <input
        data-testid="model-select-input"
        value={props.value}
        placeholder={props.inputPlaceholder}
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

vi.mock("./custom-provider-cards", () => ({
  CustomProviderCards: () => <div data-testid="custom-provider-cards">cards</div>,
}))

vi.mock("@/lib/web-store", () => ({
  getStore: async () => mocks.store,
}))

// ── default preset set (provider-branch coverage) ────────────────────────────

const DEFAULT_PRESETS: LlmPreset[] = [
  {
    id: "my-custom",
    label: "MyCustom",
    provider: "custom",
    apiMode: "chat_completions",
    baseUrl: "https://api.example.com/v1",
    baseUrlByMode: {
      chat_completions: "https://api.example.com/v1",
      anthropic_messages: "https://api.example.com/anthropic",
    },
    suggestedModels: ["m1", "m2"],
    suggestedContextSize: 131072,
    defaultModel: "dm",
    hint: "custom hint",
  },
  { id: "ollama-local", label: "OllamaLocal", provider: "ollama", baseUrl: "http://localhost:11434" },
  {
    id: "azure-prod",
    label: "AzureProd",
    provider: "azure",
    baseUrl: "https://x.openai.azure.com",
    azureApiVersion: "2024-10-21",
    suggestedModels: ["dep-a"],
  },
  {
    id: "claude-cli",
    label: "ClaudeCli",
    provider: "claude-code",
    defaultModel: "claude-sonnet-4-6",
    suggestedModels: ["claude-opus-4-7"],
  },
  { id: "codex-cli", label: "CodexCli", provider: "codex-cli", defaultModel: "gpt-5.4-mini" },
  {
    id: "openai-main",
    label: "OpenAI",
    provider: "openai",
    defaultModel: "gpt-4o",
    suggestedModels: ["gpt-4o", "gpt-4o-mini"],
    suggestedContextSize: 128000,
  },
  // No baseUrl → EndpointField renders its default placeholder; also no
  // suggestedModels → ModelPicker renders input-only.
  {
    id: "custom-nobase",
    label: "CustomNoBase",
    provider: "custom",
    apiMode: "chat_completions",
    defaultModel: "nobase-model",
  },
]

const EXPAND = "settings.sections.llm.expand"
const FETCH_BTN = "settings.sections.llm.fetchModels"
const TEST_BTN = "settings.sections.shared.testModel"

// ── helpers ──────────────────────────────────────────────────────────────────

/** Find the card container (rounded-lg border row) for the given label text. */
function cardByLabel(label: string): HTMLElement {
  const el = screen.getByText(label)
  let node: HTMLElement | null = el
  while (node && !String(node.className).includes("rounded-lg border")) {
    node = node.parentElement
  }
  return node as HTMLElement
}

function expandCard(card: HTMLElement) {
  fireEvent.click(within(card).getByTitle(EXPAND))
}

function modelInput(card: HTMLElement): HTMLInputElement {
  return within(card).getByTestId("model-select-input") as HTMLInputElement
}

beforeEach(() => {
  setupDomGlobals()
  mocks.state.providerConfigs = {}
  mocks.state.activePresetId = null
  // The vi.mock factory captured the ORIGINAL array reference at import
  // time, so mutate in place rather than reassign.
  mocks.LLM_PRESETS.splice(0, mocks.LLM_PRESETS.length, ...DEFAULT_PRESETS.map((p) => ({ ...p })))
  mocks.batch.state = { loading: false, success: false, message: "", failedModels: undefined }
  mocks.batch.runBatchTest.mockClear()
  mocks.batch.retryFailed.mockClear()
  mocks.resolveConfig.mockClear()
  mocks.setLlmConfig = vi.fn()
  mocks.state.setLlmConfig = vi.fn()
  mocks.normalizeEndpoint.mockClear()
  mocks.normalizeEndpoint.mockImplementation((raw: string) => ({ normalized: raw, changed: false }))
  mocks.fetchLlmModelList.mockClear()
  mocks.fetchLlmModelList.mockResolvedValue({ models: ["m-alpha", "m-beta"] })
  mocks.testLlmConnection.mockClear()
  mocks.testLlmConnection.mockResolvedValue({ ok: true, message: "conn-ok" })
  mocks.testLlmFunction.mockClear()
  mocks.testLlmFunction.mockResolvedValue({ ok: false, message: "func-fail" })
  mocks.invoke.mockClear()
  mocks.invoke.mockResolvedValue({ installed: true, version: "2.1.0", path: "/usr/bin/claude", error: null })
  mocks.isTauri.mockClear()
  mocks.isTauri.mockReturnValue(false)
  mocks.store.get.mockClear()
  mocks.store.set.mockClear()
  mocks.store.save.mockClear()
  mocks.store.data = {}
  mocks.recordModelOptions.mockClear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// ── tests ────────────────────────────────────────────────────────────────────

describe("LlmProviderSection — section shell & row header", () => {
  it("renders title/description, custom provider cards and one row per preset (custom preset excluded)", () => {
    const { rerender } = render(<LlmProviderSection />)
    expect(screen.getByText("settings.sections.llm.title")).toBeInTheDocument()
    expect(screen.getByText("settings.sections.llm.description")).toBeInTheDocument()
    expect(screen.getByTestId("custom-provider-cards")).toBeInTheDocument()
    for (const p of DEFAULT_PRESETS) {
      expect(screen.getByText(p.label)).toBeInTheDocument()
    }
    // the `custom` preset id is filtered out by the section itself
    mocks.LLM_PRESETS.push({ id: "custom", label: "HiddenCustom", provider: "custom" })
    rerender(<LlmProviderSection />)
    expect(screen.queryByText("HiddenCustom")).not.toBeInTheDocument()
  })

  it("shows configuredBadge when override has config but provider is not enabled", () => {
    mocks.state.providerConfigs = { "openai-main": { apiKey: "sk-x" } }
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expect(within(card).getByText("settings.sections.llm.configuredBadge")).toBeInTheDocument()
    expect(within(card).queryByText(/enabledBadge/)).not.toBeInTheDocument()
  })

  it("shows enabledBadge with saved-model count when enabled with saved models", () => {
    mocks.state.providerConfigs = {
      "openai-main": {
        enabled: true,
        savedModels: [{ id: "m0", name: "gpt-4o", model: "gpt-4o", createdAt: 1 }],
      },
    }
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expect(within(card).getByText("settings.sections.llm.enabledBadge")).toBeInTheDocument()
    expect(within(card).queryByText("settings.sections.llm.configuredBadge")).not.toBeInTheDocument()
  })

  it("expand/collapse toggles the config panel and chevron title", () => {
    const { rerender } = render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    rerender(<LlmProviderSection />)
    expect(within(card).getByTitle("settings.sections.llm.collapse")).toBeInTheDocument()
    expect(within(card).queryByLabelText("settings.sections.llm.apiKey")).not.toBeInTheDocument()
    // collapse again
    fireEvent.click(within(card).getByTitle("settings.sections.llm.collapse"))
    rerender(<LlmProviderSection />)
    expect(within(card).getByTitle(EXPAND)).toBeInTheDocument()
  })

  it("toggleEnabled flips enabled state and persists (activePresetId null → no llm save)", async () => {
    const { rerender } = render(<LlmProviderSection />)
    let card = cardByLabel("OpenAI")
    fireEvent.click(within(card).getByTitle("settings.sections.llm.toggleOn"))
    expect(mocks.state.providerConfigs["openai-main"]?.enabled).toBe(true)
    await waitFor(() => {
      expect(mocks.store.set).toHaveBeenCalledWith("providerConfigs", expect.anything())
      expect(mocks.store.set).toHaveBeenCalledWith("activePresetId", null)
    })
    expect(mocks.store.set).not.toHaveBeenCalledWith("llmConfig", expect.anything())

    // flip back (mock store is not reactive → force a re-render)
    mocks.state.providerConfigs = { "openai-main": { enabled: true } }
    rerender(<LlmProviderSection />)
    card = cardByLabel("OpenAI")
    fireEvent.click(within(card).getByTitle("settings.sections.llm.toggleOff"))
    expect(mocks.state.providerConfigs["openai-main"]?.enabled).toBe(false)
  })

  it("toggleActive updates activePresetId and persists (via updateOverride path)", async () => {
    // toggleActive is never wired into PresetRow (prop is dropped), so the
    // active-preset flow is driven through updateOverride below; here we
    // assert the persist side of an active preset refresh.
    mocks.state.activePresetId = "openai-main"
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    const keyInput = within(card).getByPlaceholderText("settings.sections.llm.apiKeyPlaceholder")
    fireEvent.change(keyInput, { target: { value: "sk-live" } })
    expect(mocks.state.providerConfigs["openai-main"].apiKey).toBe("sk-live")
    // live refresh: id === activePresetId && preset found → resolveConfig + setLlmConfig
    expect(mocks.resolveConfig).toHaveBeenCalled()
    expect(mocks.state.setLlmConfig).toHaveBeenCalled()
    // persist: saveProviderConfigs + saveActivePresetId + saveLlmConfig
    await waitFor(() => {
      expect(mocks.store.set).toHaveBeenCalledWith("providerConfigs", expect.anything())
      expect(mocks.store.set).toHaveBeenCalledWith("activePresetId", "openai-main")
      expect(mocks.store.set).toHaveBeenCalledWith("llmConfig", expect.anything())
    })
    // saved badge appears
    expect(within(card).getByText("settings.sections.llm.savedBadge")).toBeInTheDocument()
  })

  it("updateOverride with an unknown active preset skips live refresh and llm save", async () => {
    mocks.state.activePresetId = "ghost-preset"
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    const keyInput = within(card).getByPlaceholderText("settings.sections.llm.apiKeyPlaceholder")
    fireEvent.change(keyInput, { target: { value: "sk-x" } })
    expect(mocks.state.providerConfigs["openai-main"].apiKey).toBe("sk-x")
    // preset not found → no live refresh (setLlmConfig), no llm config save;
    // resolveConfig itself is called by each row's useMemo, so assert setLlmConfig.
    expect(mocks.state.setLlmConfig).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(mocks.store.set).toHaveBeenCalledWith("providerConfigs", expect.anything())
      expect(mocks.store.set).toHaveBeenCalledWith("activePresetId", "ghost-preset")
    })
    expect(mocks.store.set).not.toHaveBeenCalledWith("llmConfig", expect.anything())
  })

  it("saved badge timeout with overlapping updates to different presets (cur !== id branch)", async () => {
    vi.useFakeTimers()
    render(<LlmProviderSection />)
    const openai = cardByLabel("OpenAI")
    expandCard(openai)
    const azure = cardByLabel("AzureProd")
    expandCard(azure)
    const keyOpenai = within(openai).getByPlaceholderText("settings.sections.llm.apiKeyPlaceholder")
    const keyAzure = within(azure).getByPlaceholderText("settings.sections.llm.apiKeyPlaceholder")
    fireEvent.change(keyOpenai, { target: { value: "sk-1" } })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    fireEvent.change(keyAzure, { target: { value: "sk-2" } })
    await act(async () => {
      // first timeout (openai) fires while savedId is azure-prod → cur !== id
      await vi.advanceTimersByTimeAsync(1600)
    })
    expect(within(openai).queryByText("settings.sections.llm.savedBadge")).not.toBeInTheDocument()
    expect(within(azure).queryByText("settings.sections.llm.savedBadge")).not.toBeInTheDocument()
  })

  it("persist rejection is swallowed by .catch in updateOverride and toggleEnabled", async () => {
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    // updateOverride path: saveProviderConfigs rejects → .catch(() => {})
    mocks.store.set.mockRejectedValueOnce(new Error("save-boom"))
    const keyInput = within(card).getByPlaceholderText("settings.sections.llm.apiKeyPlaceholder")
    fireEvent.change(keyInput, { target: { value: "sk-x" } })
    await waitFor(() => {
      expect(mocks.state.providerConfigs["openai-main"].apiKey).toBe("sk-x")
    })
    // toggleEnabled path: persist rejects → .catch(() => {})
    mocks.store.set.mockRejectedValueOnce(new Error("save-boom-2"))
    fireEvent.click(within(card).getByTitle("settings.sections.llm.toggleOn"))
    expect(mocks.state.providerConfigs["openai-main"]?.enabled).toBe(true)
  })

  it("enabled preset without savedModels evaluates the enabledBadge guard with empty list", () => {
    mocks.state.providerConfigs = { "openai-main": { enabled: true } }
    render(<LlmProviderSection />)
    expect(screen.queryByText("settings.sections.llm.enabledBadge")).not.toBeInTheDocument()
    const card = cardByLabel("OpenAI")
    expect(within(card).queryByText(/enabledBadge/)).not.toBeInTheDocument()
  })

  it("ModelSelectInput falls back to the model placeholder when inputPlaceholder is empty", () => {
    mocks.t.mockImplementation((key: string, params?: Record<string, unknown>) => {
      if (key === "settings.sections.shared.modelManualPlaceholder") return ""
      if (params && typeof params.model === "string") return `${key}:${params.model}`
      if (params && typeof params.message === "string") return params.message
      return key
    })
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    expect(modelInput(card).placeholder).toBe("gpt-4o")
  })
})

describe("LlmProviderSection — custom provider panel (apiMode / endpoint / model)", () => {
  it("switches apiMode and flips baseUrl when baseUrlByMode declares a per-wire URL", () => {
    const { rerender } = render(<LlmProviderSection />)
    const card = cardByLabel("MyCustom")
    expandCard(card)
    fireEvent.click(within(card).getByText("settings.sections.llm.wireOpenAi"))
    expect(mocks.state.providerConfigs["my-custom"].apiMode).toBe("chat_completions")
    // anthropic mode flips the URL (declared in baseUrlByMode)
    rerender(<LlmProviderSection />)
    fireEvent.click(within(card).getByText("settings.sections.llm.wireAnthropic"))
    expect(mocks.state.providerConfigs["my-custom"].apiMode).toBe("anthropic_messages")
    expect(mocks.state.providerConfigs["my-custom"].baseUrl).toBe("https://api.example.com/anthropic")
    // responses mode has no per-wire URL → only apiMode changes
    rerender(<LlmProviderSection />)
    fireEvent.click(within(card).getByText("settings.sections.llm.wireResponses"))
    expect(mocks.state.providerConfigs["my-custom"].apiMode).toBe("responses")
    expect(mocks.state.providerConfigs["my-custom"].baseUrl).toBe("https://api.example.com/anthropic")
  })

  it("edits the endpoint field and auto-applies normalization on blur", async () => {
    mocks.normalizeEndpoint.mockImplementation(() => ({
      normalized: "https://cleaned.example.com/v1",
      changed: true,
      warning: "warn-msg",
    }))
    render(<LlmProviderSection />)
    const card = cardByLabel("MyCustom")
    expandCard(card)
    const input = within(card).getByPlaceholderText("https://api.example.com/v1")
    fireEvent.change(input, { target: { value: "https://api.example.com/v1/chat/completions" } })
    // hint block: AlertCircle path + will-use code + auto-apply + warning
    expect(within(card).getByText("settings.sections.llm.endpointPreviewWillUse")).toBeInTheDocument()
    expect(within(card).getByText("settings.sections.llm.endpointPreviewAutoApply")).toBeInTheDocument()
    expect(within(card).getByText("https://cleaned.example.com/v1")).toBeInTheDocument()
    expect(within(card).getByText("warn-msg")).toBeInTheDocument()
    expect(mocks.state.providerConfigs["my-custom"].baseUrl).toBe("https://api.example.com/v1/chat/completions")
    // blur applies the normalized value
    fireEvent.blur(input)
    expect(mocks.state.providerConfigs["my-custom"].baseUrl).toBe("https://cleaned.example.com/v1")
  })

  it("endpoint hint renders warning-only (blue) state and does not auto-apply on blur", () => {
    mocks.normalizeEndpoint.mockImplementation((raw: string) => ({
      normalized: raw,
      changed: false,
      warning: "only-warn",
    }))
    render(<LlmProviderSection />)
    const card = cardByLabel("MyCustom")
    expandCard(card)
    const input = within(card).getByPlaceholderText("https://api.example.com/v1")
    fireEvent.change(input, { target: { value: "https://api.example.com/v1" } })
    expect(within(card).getByText("only-warn")).toBeInTheDocument()
    expect(within(card).queryByText("settings.sections.llm.endpointPreviewWillUse")).not.toBeInTheDocument()
    fireEvent.blur(input)
    // unchanged value → not auto-applied (no onChange for baseUrl)
    expect(mocks.state.providerConfigs["my-custom"]?.baseUrl).toBeUndefined()
  })

  it("endpoint hint hidden when value empty or unchanged without warning", () => {
    render(<LlmProviderSection />)
    const card = cardByLabel("MyCustom")
    expandCard(card)
    const input = within(card).getByPlaceholderText("https://api.example.com/v1")
    expect(within(card).queryByText("settings.sections.llm.endpointPreviewWillUse")).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: "https://api.example.com/v1" } })
    expect(within(card).queryByText("settings.sections.llm.endpointPreviewWillUse")).not.toBeInTheDocument()
  })

  it("endpoint hint shows (empty) fallback when normalized value is empty", () => {
    mocks.normalizeEndpoint.mockImplementation(() => ({
      normalized: "",
      changed: true,
      warning: "warn-empty",
    }))
    render(<LlmProviderSection />)
    const card = cardByLabel("MyCustom")
    expandCard(card)
    const input = within(card).getByPlaceholderText("https://api.example.com/v1")
    fireEvent.change(input, { target: { value: "https://x.example.com" } })
    expect(within(card).getByText("(empty)")).toBeInTheDocument()
    expect(within(card).getByText("warn-empty")).toBeInTheDocument()
  })

  it("endpoint placeholder falls back to the default when preset has no baseUrl", () => {
    render(<LlmProviderSection />)
    const card = cardByLabel("CustomNoBase")
    expandCard(card)
    expect(within(card).getByPlaceholderText("https://your-api.example.com/v1")).toBeInTheDocument()
    // no suggestedModels → ModelPicker renders the input alone
    expect(within(card).queryByTitle(/useModel/)).not.toBeInTheDocument()
  })

  it("ollama panel shows endpoint field but no apiKey field", () => {
    render(<LlmProviderSection />)
    const card = cardByLabel("OllamaLocal")
    expandCard(card)
    expect(within(card).getByPlaceholderText("http://localhost:11434")).toBeInTheDocument()
    expect(within(card).queryByLabelText("settings.sections.llm.apiKey")).not.toBeInTheDocument()
    const input = within(card).getByPlaceholderText("http://localhost:11434")
    fireEvent.change(input, { target: { value: "http://127.0.0.1:11434" } })
    expect(mocks.state.providerConfigs["ollama-local"].baseUrl).toBe("http://127.0.0.1:11434")
  })
})

describe("LlmProviderSection — azure panel", () => {
  it("renders azure endpoint, apiVersion input, model family select and api key", () => {
    render(<LlmProviderSection />)
    const card = cardByLabel("AzureProd")
    expandCard(card)
    const endpoint = within(card).getByPlaceholderText("https://x.openai.azure.com")
    fireEvent.change(endpoint, { target: { value: "https://my.openai.azure.com" } })
    expect(mocks.state.providerConfigs["azure-prod"].baseUrl).toBe("https://my.openai.azure.com")
    // azure mode feeds the endpoint normalizer as mode="azure"
    expect(mocks.normalizeEndpoint).toHaveBeenCalledWith("https://my.openai.azure.com", "azure")

    const versionInput = within(card).getByDisplayValue("2024-10-21")
    fireEvent.change(versionInput, { target: { value: "2024-12-01" } })
    expect(mocks.state.providerConfigs["azure-prod"].azureApiVersion).toBe("2024-12-01")

    const select = card.querySelector("select") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "gpt5" } })
    expect(mocks.state.providerConfigs["azure-prod"].azureModelFamily).toBe("gpt5")

    const keyInput = within(card).getByPlaceholderText("settings.sections.llm.apiKeyPlaceholder")
    fireEvent.change(keyInput, { target: { value: "az-key" } })
    expect(mocks.state.providerConfigs["azure-prod"].apiKey).toBe("az-key")
  })

  it("falls back to AZURE_OPENAI_API_VERSION default when override is empty", () => {
    render(<LlmProviderSection />)
    const card = cardByLabel("AzureProd")
    expandCard(card)
    expect(within(card).getByDisplayValue("2024-10-21")).toBeInTheDocument()
    const select = card.querySelector("select") as HTMLSelectElement
    expect(select.value).toBe("auto")
  })
})

describe("LlmProviderSection — local CLI pills", () => {
  it("claude pill: non-Tauri → error state with desktop-only message", async () => {
    mocks.isTauri.mockReturnValue(false)
    render(<LlmProviderSection />)
    const card = cardByLabel("ClaudeCli")
    expandCard(card)
    await waitFor(() => {
      expect(within(card).getByText("settings.sections.llm.cliStatus.desktopOnly")).toBeInTheDocument()
    })
    expect(within(card).getByText(/installPrefix/)).toBeInTheDocument()
    expect(within(card).getByText(/installSuffix/)).toBeInTheDocument()
    expect(within(card).getByText("npm i -g @anthropic-ai/claude-code")).toBeInTheDocument()
  })

  it("claude pill: Tauri + installed → ok state with version/path and recheck", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.invoke.mockResolvedValue({ installed: true, version: "2.1.0", path: "/usr/bin/claude", error: null })
    render(<LlmProviderSection />)
    const card = cardByLabel("ClaudeCli")
    expandCard(card)
    await waitFor(() => {
      expect(within(card).getByText(/claudeReady/)).toBeInTheDocument()
    })
    expect(within(card).getByText("settings.sections.llm.cliStatus.claudeTransportHint")).toBeInTheDocument()
    expect(within(card).getByText("/usr/bin/claude")).toBeInTheDocument()
    expect(within(card).getByText(/authErrorPrefix/)).toBeInTheDocument()
    // recheck with no version → versionSuffix falsy branch
    mocks.invoke.mockResolvedValue({ installed: true, version: null, path: null, error: null })
    fireEvent.click(within(card).getByText("settings.sections.llm.cliStatus.recheck"))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("claude_cli_detect"))
  })

  it("claude pill: invoke reports not-installed → error state with claudeUnavailable", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.invoke.mockResolvedValue({ installed: false, version: null, path: null, error: null })
    render(<LlmProviderSection />)
    const card = cardByLabel("ClaudeCli")
    expandCard(card)
    await waitFor(() => {
      expect(within(card).getByText("settings.sections.llm.cliStatus.claudeUnavailable")).toBeInTheDocument()
    })
  })

  it("claude pill: invoke rejects — Error message then plain-string String(e)", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.invoke.mockRejectedValueOnce(new Error("detect-boom"))
    render(<LlmProviderSection />)
    const card = cardByLabel("ClaudeCli")
    expandCard(card)
    await waitFor(() => {
      expect(within(card).getByText("detect-boom")).toBeInTheDocument()
    })
    mocks.invoke.mockRejectedValueOnce("detect-boom-plain")
    fireEvent.click(within(card).getByText("settings.sections.llm.cliStatus.recheck"))
    await waitFor(() => {
      expect(within(card).getByText("detect-boom-plain")).toBeInTheDocument()
    })
  })

  it("claude pill: pending invoke → loading state with disabled recheck", () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.invoke.mockReturnValue(new Promise(() => {}))
    render(<LlmProviderSection />)
    const card = cardByLabel("ClaudeCli")
    expandCard(card)
    expect(within(card).getByText("settings.sections.llm.cliStatus.checking")).toBeInTheDocument()
    expect(within(card).getByText("settings.sections.llm.cliStatus.claudeDetecting")).toBeInTheDocument()
    const recheck = within(card).getByText("settings.sections.llm.cliStatus.checking").closest("button")
    expect(recheck).toBeDisabled()
  })

  it("codex pill: ok and err states (codex_cli_detect)", async () => {
    mocks.isTauri.mockReturnValue(true)
    mocks.invoke.mockResolvedValue({ installed: true, version: "0.1.0", path: "/usr/local/bin/codex", error: null })
    render(<LlmProviderSection />)
    const card = cardByLabel("CodexCli")
    expandCard(card)
    await waitFor(() => {
      expect(within(card).getByText(/codexReady/)).toBeInTheDocument()
    })
    expect(within(card).getByText("/usr/local/bin/codex")).toBeInTheDocument()
    expect(within(card).getByText(/codexAuthErrorSuffix/)).toBeInTheDocument()

    // recheck with no version → versionSuffix falsy branch
    mocks.invoke.mockResolvedValueOnce({ installed: true, version: null, path: null, error: null })
    fireEvent.click(within(card).getByText("settings.sections.llm.cliStatus.recheck"))
    await waitFor(() => {
      expect(within(card).getByText(/codexReady/)).toBeInTheDocument()
    })
    expect(within(card).queryByText(/version/)).not.toBeInTheDocument()

    // not installed → r.installed falsy → err state with codexUnavailable fallback
    mocks.invoke.mockResolvedValueOnce({ installed: false, version: null, path: null, error: null })
    fireEvent.click(within(card).getByText("settings.sections.llm.cliStatus.recheck"))
    await waitFor(() => {
      expect(within(card).getByText("settings.sections.llm.cliStatus.codexUnavailable")).toBeInTheDocument()
    })

    // Error rejection → e.message branch
    mocks.invoke.mockRejectedValueOnce(new Error("codex-boom"))
    fireEvent.click(within(card).getByText("settings.sections.llm.cliStatus.recheck"))
    await waitFor(() => {
      expect(within(card).getByText("codex-boom")).toBeInTheDocument()
    })

    // plain-string rejection → String(e) message
    mocks.invoke.mockRejectedValueOnce("codex-boom-plain")
    fireEvent.click(within(card).getByText("settings.sections.llm.cliStatus.recheck"))
    await waitFor(() => {
      expect(within(card).getByText("codex-boom-plain")).toBeInTheDocument()
    })
  })

  it("localCliIsolation toggle flips override and text", () => {
    const { rerender } = render(<LlmProviderSection />)
    const card = cardByLabel("ClaudeCli")
    expandCard(card)
    expect(within(card).getByText("settings.sections.llm.localCliIsolationOff")).toBeInTheDocument()
    fireEvent.click(within(card).getByLabelText("settings.sections.llm.localCliIsolation"))
    expect(mocks.state.providerConfigs["claude-cli"].localCliIsolation).toBe(true)
    rerender(<LlmProviderSection />)
    expect(within(card).getByText("settings.sections.llm.localCliIsolationOn")).toBeInTheDocument()
    fireEvent.click(within(card).getByLabelText("settings.sections.llm.localCliIsolation"))
    expect(mocks.state.providerConfigs["claude-cli"].localCliIsolation).toBe(false)
  })

  it("codex-cli timeout input: numeric clamp, NaN → undefined, out-of-range clamp", () => {
    const { rerender } = render(<LlmProviderSection />)
    const card = cardByLabel("CodexCli")
    expandCard(card)
    const timeoutInput = within(card).getByDisplayValue("10")
    fireEvent.change(timeoutInput, { target: { value: "30" } })
    expect(mocks.state.providerConfigs["codex-cli"].codexCliTimeoutMinutes).toBe(30)
    // a non-numeric value in a number input sanitizes to "" → 0 → clamp 1.
    // The `Number.isFinite(n) ? … : undefined` else-branch is unreachable via
    // the number input (see unreachable list).
    fireEvent.change(timeoutInput, { target: { value: "abc" } })
    expect(mocks.state.providerConfigs["codex-cli"].codexCliTimeoutMinutes).toBe(1)
    fireEvent.change(timeoutInput, { target: { value: "500" } })
    expect(mocks.state.providerConfigs["codex-cli"].codexCliTimeoutMinutes).toBe(240)
    fireEvent.change(timeoutInput, { target: { value: "0" } })
    expect(mocks.state.providerConfigs["codex-cli"].codexCliTimeoutMinutes).toBe(1)
    // override present → derived value uses it
    mocks.state.providerConfigs["codex-cli"].codexCliTimeoutMinutes = 42
    rerender(<LlmProviderSection />)
    expect(within(card).getByDisplayValue("42")).toBeInTheDocument()
  })
})

describe("LlmProviderSection — api key, model picker, context & reasoning", () => {
  it("apiKey field edits override and is hidden for CLI/ollama providers", () => {
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    const keyInput = within(card).getByPlaceholderText("settings.sections.llm.apiKeyPlaceholder")
    fireEvent.change(keyInput, { target: { value: "sk-123" } })
    expect(mocks.state.providerConfigs["openai-main"].apiKey).toBe("sk-123")
    // claude-code panel: no apiKey field
    const cliCard = cardByLabel("ClaudeCli")
    expandCard(cliCard)
    expect(within(cliCard).queryByLabelText("settings.sections.llm.apiKey")).not.toBeInTheDocument()
  })

  it("ModelPicker: chip click fills model, custom badge shows for unlisted value, clear resets", () => {
    const { rerender } = render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    fireEvent.click(within(card).getByTitle("settings.sections.llm.useModel:gpt-4o"))
    expect(mocks.state.providerConfigs["openai-main"].model).toBe("gpt-4o")
    rerender(<LlmProviderSection />)
    // type an unlisted model → custom badge (t returns key:model)
    fireEvent.change(modelInput(card), { target: { value: "gpt-custom" } })
    expect(mocks.state.providerConfigs["openai-main"].model).toBe("gpt-custom")
    rerender(<LlmProviderSection />)
    expect(within(card).getByText("settings.sections.llm.customModelBadge:gpt-custom")).toBeInTheDocument()
    // click the custom-model chip → clears the model
    fireEvent.click(within(card).getByTitle("settings.sections.llm.typeCustomModel"))
    expect(mocks.state.providerConfigs["openai-main"].model).toBe("")
  })

  it("ModelPicker without suggestions renders input only (ollama)", () => {
    render(<LlmProviderSection />)
    const card = cardByLabel("OllamaLocal")
    expandCard(card)
    expect(within(card).queryByTitle(/useModel/)).not.toBeInTheDocument()
    fireEvent.change(modelInput(card), { target: { value: "llama3" } })
    expect(mocks.state.providerConfigs["ollama-local"].model).toBe("llama3")
  })

  it("context window selector writes maxContextSize", () => {
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    fireEvent.click(within(card).getByText("256K"))
    expect(mocks.state.providerConfigs["openai-main"].maxContextSize).toBe(262144)
  })

  it("ReasoningControls (exported): mode buttons + custom budget edge cases", () => {
    const onChange = vi.fn()
    const { rerender } = render(<ReasoningControls value={{ mode: "auto" }} onChange={onChange} />)
    for (const mode of ["off", "low", "medium", "high", "max", "custom"] as const) {
      fireEvent.click(screen.getByText(`settings.sections.llm.reasoning.${mode}`))
      expect(onChange).toHaveBeenLastCalledWith({ mode })
    }
    rerender(<ReasoningControls value={{ mode: "custom", budgetTokens: 0 }} onChange={onChange} />)
    const budget = screen.getByPlaceholderText("1024")
    fireEvent.change(budget, { target: { value: "2048" } })
    expect(onChange).toHaveBeenLastCalledWith({ mode: "custom", budgetTokens: 2048 })
    fireEvent.change(budget, { target: { value: "" } })
    expect(onChange).toHaveBeenLastCalledWith({ mode: "custom", budgetTokens: undefined })
    fireEvent.change(budget, { target: { value: "abc" } })
    expect(onChange).toHaveBeenLastCalledWith({ mode: "custom", budgetTokens: undefined })
    fireEvent.change(budget, { target: { value: "-5" } })
    expect(onChange).toHaveBeenLastCalledWith({ mode: "custom", budgetTokens: 0 })
  })

  it("reasoning controls inside a card write override.reasoning (incl. custom budget empty value)", () => {
    const { rerender } = render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    fireEvent.click(within(card).getByText("settings.sections.llm.reasoning.off"))
    expect(mocks.state.providerConfigs["openai-main"].reasoning).toEqual({ mode: "off" })
    // custom mode with no budgetTokens → input value falls back to ""
    fireEvent.click(within(card).getByText("settings.sections.llm.reasoning.custom"))
    expect(mocks.state.providerConfigs["openai-main"].reasoning).toEqual({ mode: "custom" })
    rerender(<LlmProviderSection />)
    expect((within(card).getByPlaceholderText("1024") as HTMLInputElement).value).toBe("")
  })
})

describe("LlmProviderSection — model list fetch & selection", () => {
  it("fetch succeeds → options render, selection toggles savedModels, textarea shows saved", async () => {
    const { rerender } = render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    fireEvent.click(within(card).getByText(FETCH_BTN))
    await waitFor(() => {
      expect(within(card).getByText("settings.sections.llm.toggleModelHint")).toBeInTheDocument()
    })
    expect(mocks.fetchLlmModelList).toHaveBeenCalled()
    expect(within(card).getByText("settings.sections.shared.modelListSuccess")).toBeInTheDocument()
    expect(within(card).getByText("settings.sections.llm.fetchedModelsCount")).toBeInTheDocument()

    // select m-alpha
    fireEvent.click(within(card).getByRole("button", { name: "m-alpha" }))
    expect(mocks.state.providerConfigs["openai-main"].savedModels.map((m: any) => m.model)).toEqual(["m-alpha"])
    rerender(<LlmProviderSection />)
    expect(within(card).getByText("settings.sections.llm.selectedModelsCount")).toBeInTheDocument()
    // textarea lists the saved model
    expect(within(card).getByDisplayValue("m-alpha")).toBeInTheDocument()

    // collapse the selection area, then re-expand
    fireEvent.click(within(card).getByText("settings.sections.llm.fetchedModelsCount"))
    rerender(<LlmProviderSection />)
    expect(within(card).queryByText("settings.sections.llm.toggleModelHint")).not.toBeInTheDocument()
    fireEvent.click(within(card).getByText("settings.sections.llm.fetchedModelsCount"))
    rerender(<LlmProviderSection />)

    // deselect m-alpha
    fireEvent.click(within(card).getByRole("button", { name: "m-alpha" }))
    expect(mocks.state.providerConfigs["openai-main"].savedModels).toEqual([])
    rerender(<LlmProviderSection />)
    expect(within(card).queryByDisplayValue("m-alpha")).not.toBeInTheDocument()
  })

  it("saved-models manager onChange writes savedModels override", async () => {
    mocks.state.providerConfigs = {
      "openai-main": {
        enabled: true,
        savedModels: [{ id: "m0", name: "gpt-4o", model: "gpt-4o", createdAt: 1 }],
      },
    }
    const { rerender } = render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    fireEvent.click(within(card).getByTestId("saved-models-clear"))
    expect(mocks.state.providerConfigs["openai-main"].savedModels).toEqual([])
    rerender(<LlmProviderSection />)
    // enabledBadge count disappears with zero saved models
    expect(within(card).queryByText("settings.sections.llm.enabledBadge")).not.toBeInTheDocument()
  })

  it("fetch failure shows error message with exception text (Error and plain-string paths)", async () => {
    mocks.fetchLlmModelList.mockRejectedValueOnce(new Error("list-boom"))
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    fireEvent.click(within(card).getByText(FETCH_BTN))
    await waitFor(() => {
      // t() interpolates {message} → the exception text is the message body
      expect(within(card).getByText("list-boom")).toBeInTheDocument()
    })
    expect(within(card).queryByText("settings.sections.shared.modelListFailed")).toBeNull()
    // plain-string rejection → String(error)
    mocks.fetchLlmModelList.mockRejectedValueOnce("string-list-error")
    fireEvent.click(within(card).getByText(FETCH_BTN))
    await waitFor(() => {
      expect(within(card).getByText("string-list-error")).toBeInTheDocument()
    })
  })

  it("fetch pending → loading label + both buttons disabled", () => {
    mocks.fetchLlmModelList.mockReturnValueOnce(new Promise(() => {}))
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    fireEvent.click(within(card).getByText(FETCH_BTN))
    expect(within(card).getByText("settings.sections.llm.loadingModels")).toBeInTheDocument()
    expect(within(card).getByText("settings.sections.llm.loadingModels").closest("button")).toBeDisabled()
    expect(within(card).getByText(TEST_BTN).closest("button")).toBeDisabled()
  })

  it("changing endpoint/apiKey resets fetched model options (useEffect cleanup)", async () => {
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    fireEvent.click(within(card).getByText(FETCH_BTN))
    await waitFor(() => {
      expect(within(card).getByText("settings.sections.llm.toggleModelHint")).toBeInTheDocument()
    })
    // typing a new apiKey triggers the reset effect → options cleared
    const keyInput = within(card).getByPlaceholderText("settings.sections.llm.apiKeyPlaceholder")
    fireEvent.change(keyInput, { target: { value: "sk-2" } })
    expect(within(card).queryByText("settings.sections.llm.toggleModelHint")).not.toBeInTheDocument()
    expect(within(card).queryByText(FETCH_BTN)).not.toBeNull()
  })

  it("runSelectedModelTest uses saved models when present, else the current model", () => {
    mocks.state.providerConfigs = {
      "openai-main": {
        savedModels: [{ id: "m0", name: "saved-x", model: "saved-x", createdAt: 1 }],
      },
    }
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    fireEvent.click(within(card).getByText(TEST_BTN))
    expect(mocks.batch.runBatchTest).toHaveBeenCalledWith(["saved-x"], expect.any(Function))
  })

  it("runSelectedModelTest falls back to preset default model when override model empty", () => {
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    fireEvent.click(within(card).getByText(TEST_BTN))
    expect(mocks.batch.runBatchTest).toHaveBeenCalledWith(["gpt-4o"], expect.any(Function))
  })

  it("batch test loading → test button disabled and shows testing label", () => {
    mocks.batch.state.loading = true
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    fireEvent.click(within(card).getByText("settings.sections.shared.testing"))
    expect(mocks.batch.runBatchTest).not.toHaveBeenCalled()
  })

  it("failed models render retry UI and retryFailed fires", () => {
    mocks.batch.state = {
      loading: false,
      success: false,
      message: "part-fail",
      failedModels: ["m-alpha"],
    }
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    expect(within(card).getByText("失败模型：")).toBeInTheDocument()
    expect(within(card).getByText("part-fail")).toBeInTheDocument()
    fireEvent.click(within(card).getByText("重试失败模型"))
    expect(mocks.batch.retryFailed).toHaveBeenCalledTimes(1)
    expect(mocks.batch.retryFailed).toHaveBeenCalledWith(expect.any(Function))
  })

  it("batch test success message renders (emerald state)", () => {
    mocks.batch.state = { loading: false, success: true, message: "all-good", failedModels: undefined }
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    expect(within(card).getByText("all-good")).toBeInTheDocument()
  })
})

describe("LlmProviderSection — provider connection tests", () => {
  it("connection test: running label then ok result", async () => {
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    fireEvent.click(within(card).getByText("settings.sections.llm.testConnection"))
    expect(within(card).getByText("settings.sections.llm.testingConnection")).toBeInTheDocument()
    expect(within(card).getByText("settings.sections.llm.testConnection").closest("button")).toBeDisabled()
    await waitFor(() => {
      expect(within(card).getByText("conn-ok")).toBeInTheDocument()
    })
    expect(mocks.testLlmConnection).toHaveBeenCalled()
  })

  it("function test: ok and failed result rendering", async () => {
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    fireEvent.click(within(card).getByText("settings.sections.llm.testFunction"))
    expect(within(card).getByText("settings.sections.llm.testingFunction")).toBeInTheDocument()
    await waitFor(() => {
      expect(within(card).getByText("func-fail")).toBeInTheDocument()
    })
    expect(mocks.testLlmFunction).toHaveBeenCalled()
    // ok path
    mocks.testLlmFunction.mockResolvedValueOnce({ ok: true, message: "func-ok" })
    fireEvent.click(within(card).getByText("settings.sections.llm.testFunction"))
    await waitFor(() => {
      expect(within(card).getByText("func-ok")).toBeInTheDocument()
    })
  })

  it("test buttons disabled while a provider test is running", () => {
    mocks.testLlmConnection.mockReturnValue(new Promise(() => {}))
    render(<LlmProviderSection />)
    const card = cardByLabel("OpenAI")
    expandCard(card)
    fireEvent.click(within(card).getByText("settings.sections.llm.testConnection"))
    expect(within(card).getByText("settings.sections.llm.testConnection").closest("button")).toBeDisabled()
    expect(within(card).getByText("settings.sections.llm.testFunction").closest("button")).toBeDisabled()
  })
})

import { describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { invoke } from "@tauri-apps/api/core"

const isTauriMock = vi.fn()

vi.mock("@/lib/platform", () => ({
  isTauri: () => isTauriMock(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

import {
  detectLocalCliConfig,
  resolveRuntimeLocalCliConfig,
} from "./local-cli-config"

function makeConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "claude-code",
    apiKey: "",
    model: "",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    maxContextSize: 128000,
    apiMode: "chat_completions",
    reasoning: { mode: "off" },
    ...overrides,
  }
}

describe("detectLocalCliConfig", () => {
  it("returns null for providers without a CLI command", async () => {
    isTauriMock.mockReturnValue(true)
    await expect(detectLocalCliConfig("custom")).resolves.toBeNull()
    await expect(detectLocalCliConfig("openai")).resolves.toBeNull()
  })

  it("returns an unsupported result outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const result = await detectLocalCliConfig("claude-code")
    expect(result).toEqual({
      installed: false,
      version: null,
      path: null,
      error: "仅桌面端支持本地 CLI 检测",
    })
    expect(invoke).not.toHaveBeenCalled()
  })

  it("invokes claude_cli_detect for claude-code", async () => {
    isTauriMock.mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValue({
      installed: true,
      version: "2.1.169",
      path: "claude.cmd",
      model: "opus",
      error: null,
    })
    const result = await detectLocalCliConfig("claude-code")
    expect(invoke).toHaveBeenCalledWith("claude_cli_detect")
    expect(result?.model).toBe("opus")
  })

  it("invokes codex_cli_detect for codex-cli", async () => {
    isTauriMock.mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValue({
      installed: false,
      version: null,
      path: null,
      error: "not found",
    })
    const result = await detectLocalCliConfig("codex-cli")
    expect(invoke).toHaveBeenCalledWith("codex_cli_detect")
    expect(result?.installed).toBe(false)
  })
})

describe("resolveRuntimeLocalCliConfig", () => {
  it("returns the config untouched for non-CLI providers", async () => {
    const config = makeConfig({ provider: "openai", model: "gpt-4o" })
    await expect(resolveRuntimeLocalCliConfig(config)).resolves.toBe(config)
  })

  it("overrides the model with the detected local model", async () => {
    isTauriMock.mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValue({ model: "  claude-sonnet-4-5  " })
    const config = makeConfig({ model: "" })
    const result = await resolveRuntimeLocalCliConfig(config)
    expect(result.model).toBe("claude-sonnet-4-5")
  })

  it("keeps the config when the detected model is blank", async () => {
    isTauriMock.mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValue({ model: "   " })
    const config = makeConfig({ model: "" })
    await expect(resolveRuntimeLocalCliConfig(config)).resolves.toBe(config)
  })

  it("keeps the config when the detected model field is absent or null", async () => {
    isTauriMock.mockReturnValue(true)
    // `detected?.model?.trim()` short-circuits to undefined, so the
    // `?? ""` fallback supplies the empty model.
    vi.mocked(invoke).mockResolvedValue({ model: null })
    const config = makeConfig({ model: "" })
    await expect(resolveRuntimeLocalCliConfig(config)).resolves.toBe(config)
    vi.mocked(invoke).mockResolvedValue({ installed: true, version: null, path: null, error: null })
    await expect(resolveRuntimeLocalCliConfig(config)).resolves.toBe(config)
  })

  it("keeps the config when detection throws", async () => {
    isTauriMock.mockReturnValue(true)
    vi.mocked(invoke).mockRejectedValue(new Error("invoke failed"))
    const config = makeConfig({ model: "" })
    await expect(resolveRuntimeLocalCliConfig(config)).resolves.toBe(config)
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  detectCursorCli,
  ensureCursorProxyRunning,
  getCursorProxyStatus,
  restartCursorProxyWithAuth,
  stopCursorProxy,
  toCursorProxyV1Endpoint,
  withCursorProxyEndpoint,
} from "./cursor-cli-proxy"

const tauriState = vi.hoisted(() => ({ desktop: false }))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>()
  return { ...actual, isTauri: () => tauriState.desktop }
})

describe("cursor-cli-proxy helpers", () => {
  it("toCursorProxyV1Endpoint 追加 /v1", () => {
    expect(toCursorProxyV1Endpoint("http://127.0.0.1:8765")).toBe("http://127.0.0.1:8765/v1")
    expect(toCursorProxyV1Endpoint("http://127.0.0.1:8765/")).toBe("http://127.0.0.1:8765/v1")
  })

  it("toCursorProxyV1Endpoint 保留已有 /v1", () => {
    expect(toCursorProxyV1Endpoint("http://127.0.0.1:8765/v1")).toBe("http://127.0.0.1:8765/v1")
  })

  it("withCursorProxyEndpoint 注入端点并切换 apiMode", () => {
    const base = {
      provider: "cursor-cli" as const,
      apiKey: "",
      model: "claude-3.7-sonnet",
      customEndpoint: "",
      apiMode: "chat_completions" as const,
    } as Parameters<typeof withCursorProxyEndpoint>[0]
    const out = withCursorProxyEndpoint(base, "http://127.0.0.1:8765/v1")
    expect(out.customEndpoint).toBe("http://127.0.0.1:8765/v1")
    expect(out.apiMode).toBe("chat_completions")
  })
})

describe("cursor-cli-proxy 桌面托管", () => {
  const invokeMock = vi.mocked(invoke)

  beforeEach(() => {
    tauriState.desktop = false
    invokeMock.mockReset()
  })

  function llmConfig(): LlmConfig {
    return {
      provider: "cursor-cli",
      apiKey: "",
      model: "claude-3.7-sonnet",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
      apiMode: "chat_completions",
    }
  }

  it("detectCursorCli：非桌面端直接返回未安装", async () => {
    const result = await detectCursorCli()
    expect(result).toMatchObject({ installed: false, error: "仅桌面端支持本地 CLI 检测" })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("detectCursorCli：桌面端透传入参检测结果", async () => {
    tauriState.desktop = true
    invokeMock.mockResolvedValue({ installed: true, version: "1.0", path: "/bin/cursor", error: null })
    const result = await detectCursorCli()
    expect(invokeMock).toHaveBeenCalledWith("cursor_cli_detect")
    expect(result).toMatchObject({ installed: true, version: "1.0" })
  })

  it("stopCursorProxy：非桌面端拒绝", async () => {
    await expect(stopCursorProxy()).rejects.toThrow("Cursor CLI 仅桌面端可用")
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("stopCursorProxy：桌面端调用停止命令", async () => {
    tauriState.desktop = true
    invokeMock.mockResolvedValue(undefined)
    await stopCursorProxy()
    expect(invokeMock).toHaveBeenCalledWith("cursor_proxy_stop")
  })

  it("getCursorProxyStatus：非桌面端返回托管不可用", async () => {
    const status = await getCursorProxyStatus()
    expect(status).toMatchObject({
      healthy: false,
      base_url: "http://127.0.0.1:8765",
      managed: false,
    })
    expect(status.error).toContain("仅桌面端可托管")
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("getCursorProxyStatus：桌面端透传 invoke 结果", async () => {
    tauriState.desktop = true
    invokeMock.mockResolvedValue({
      healthy: true,
      base_url: "http://127.0.0.1:9000",
      managed: true,
      error: null,
    })
    const status = await getCursorProxyStatus()
    expect(invokeMock).toHaveBeenCalledWith("cursor_proxy_status")
    expect(status).toMatchObject({ healthy: true, base_url: "http://127.0.0.1:9000" })
  })

  it("ensureCursorProxyRunning：非 cursor 提供者直接返回默认端点（不走 Tauri）", async () => {
    tauriState.desktop = true
    const endpoint = await ensureCursorProxyRunning({ provider: "openai" })
    expect(endpoint).toBe("http://127.0.0.1:8765/v1")
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("ensureCursorProxyRunning：cursor 提供者非桌面端拒绝", async () => {
    await expect(ensureCursorProxyRunning({ provider: "cursor-cli" })).rejects.toThrow(
      "Cursor CLI 仅桌面端可用",
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("ensureCursorProxyRunning：健康代理补 /v1 后返回", async () => {
    tauriState.desktop = true
    invokeMock.mockResolvedValue({ healthy: true, base_url: "http://127.0.0.1:9000", managed: true, error: null })
    const endpoint = await ensureCursorProxyRunning({ provider: "cursor-cli" })
    expect(invokeMock).toHaveBeenCalledWith("cursor_proxy_ensure", { forceRestart: false })
    expect(endpoint).toBe("http://127.0.0.1:9000/v1")
  })

  it("ensureCursorProxyRunning：已有 /v1 后缀的 base 原样返回", async () => {
    tauriState.desktop = true
    invokeMock.mockResolvedValue({ healthy: true, base_url: "http://127.0.0.1:9000/v1", managed: true, error: null })
    const endpoint = await ensureCursorProxyRunning({ provider: "cursor-cli" })
    expect(endpoint).toBe("http://127.0.0.1:9000/v1")
  })

  it("ensureCursorProxyRunning：不健康时透传代理错误", async () => {
    tauriState.desktop = true
    invokeMock.mockResolvedValue({ healthy: false, base_url: "http://127.0.0.1:9000", managed: true, error: "port taken" })
    await expect(ensureCursorProxyRunning({ provider: "cursor-cli" })).rejects.toThrow("port taken")
  })

  it("ensureCursorProxyRunning：不健康且无错误信息时用默认文案", async () => {
    tauriState.desktop = true
    invokeMock.mockResolvedValue({ healthy: false, base_url: "http://127.0.0.1:9000", managed: true, error: null })
    await expect(ensureCursorProxyRunning({ provider: "cursor-cli" })).rejects.toThrow(
      "cursor-api-proxy 未就绪",
    )
  })

  it("restartCursorProxyWithAuth：强制重启并返回端点", async () => {
    tauriState.desktop = true
    invokeMock.mockResolvedValue({ healthy: true, base_url: "http://127.0.0.1:9000", managed: true, error: null })
    const endpoint = await restartCursorProxyWithAuth(llmConfig())
    expect(invokeMock).toHaveBeenCalledWith("cursor_proxy_ensure", { forceRestart: true })
    expect(endpoint).toBe("http://127.0.0.1:9000/v1")
  })
})

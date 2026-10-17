/**
 * claude-cli-transport.stream-registry.spec.ts — C2 去猴补验收。
 *
 * transport 第一方暴露启动/结束中流 id 广播（onStatus "claude-cli:stream-start:<id>"
 * / "claude-cli:stream-end:<id>"）与注册表 activeRustStreamIds()/forceKillAll()，
 * 替代 chat-panel 对 __TAURI_INTERNALS__.invoke 的拦截跟踪。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}))

import {
  activeRustStreamIds,
  forceKillAll,
  streamClaudeCodeCli,
} from "./claude-cli-transport"

function claudeCliConfig(): LlmConfig {
  return {
    provider: "claude-code",
    apiKey: "",
    model: "claude-opus-4-1",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    maxContextSize: 128000,
    apiMode: "chat_completions",
    reasoning: { mode: "off" },
  }
}

const noopUnlisten = () => {}

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(invoke).mockReset()
  vi.mocked(listen).mockReset()
})

describe("transport stream registry（C2 去猴补）", () => {
  it("流启动时广播 stream-start 并在注册表可见；结束时广播 stream-end 并摘除", async () => {
    const listeners = new Map<string, (event: { payload: unknown }) => void>()
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      listeners.set(String(eventName), handler as (event: { payload: unknown }) => void)
      return noopUnlisten
    })
    vi.mocked(invoke).mockImplementation(async () => undefined)

    const statuses: string[] = []
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onStatus: (s: string) => {
        statuses.push(s)
      },
    }
    const p = streamClaudeCodeCli(claudeCliConfig(), [{ role: "user", content: "hi" }], callbacks)
    await Promise.resolve()
    await Promise.resolve()

    const startMsg = statuses.find((s) => s.startsWith("claude-cli:stream-start:"))
    expect(startMsg).toBeDefined()
    const startedId = startMsg!.slice("claude-cli:stream-start:".length)
    expect(startedId.length).toBeGreaterThan(0)
    // 注册表快照可见启动中流
    expect(activeRustStreamIds()).toContain(startedId)

    // 喂数据 + 正常结束
    const dataEvent = [...listeners.keys()].find((n) => n.startsWith("claude-cli:") && !n.endsWith(":done"))
    const doneEvent = [...listeners.keys()].find((n) => n.endsWith(":done"))
    expect(dataEvent).toBeDefined()
    expect(doneEvent).toBeDefined()
    listeners.get(dataEvent!)?.({
      payload: '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}',
    })
    listeners.get(doneEvent!)?.({ payload: { code: 0, stderr: "" } })
    await p

    const endMsg = statuses.find((s) => s === `claude-cli:stream-end:${startedId}`)
    expect(endMsg).toBeDefined()
    // 注册表已摘除
    expect(activeRustStreamIds()).not.toContain(startedId)
    expect(callbacks.onToken).toHaveBeenCalledWith("ok")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
  })

  it("forceKillAll 对注册表内流逐个 kill（无流时为空操作）", async () => {
    const killed: string[] = []
    vi.mocked(invoke).mockImplementation(async (command, payload) => {
      if (command === "claude_cli_kill") {
        killed.push(String((payload as { streamId?: string })?.streamId ?? ""))
      }
      return undefined
    })
    await forceKillAll() // 注册表此时应为空（上一用例已摘除）
    expect(killed).toEqual([])
    expect(activeRustStreamIds()).toEqual([])
  })
})

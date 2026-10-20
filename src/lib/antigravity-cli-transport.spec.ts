/** C4 冒烟覆盖：src/lib/antigravity-cli-transport.ts（自动生成，核心行为由专项 spec 加深） */
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

import { parseAntigravityCliLine, extractAntigravityCliError, buildPrompt, streamAntigravityCli } from "./antigravity-cli-transport"
describe("antigravity-cli-transport.ts smoke", () => {
  it("exports parseAntigravityCliLine", () => {
    expect(parseAntigravityCliLine).toBeDefined()
  })
  it("exports extractAntigravityCliError", () => {
    expect(extractAntigravityCliError).toBeDefined()
  })
  it("exports buildPrompt", () => {
    expect(buildPrompt).toBeDefined()
  })
  it("exports streamAntigravityCli", () => {
    expect(streamAntigravityCli).toBeDefined()
  })
})

describe("parseAntigravityCliLine — 事件形态（四-14 zod 窄化行为锁）", () => {
  it("codex 风 item.completed/agent_message", () => {
    expect(parseAntigravityCliLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "你好" } }))).toBe("你好")
  })
  it("直出 text/content/delta", () => {
    expect(parseAntigravityCliLine(JSON.stringify({ type: "message", content: "正文" }))).toBe("正文")
    expect(parseAntigravityCliLine(JSON.stringify({ delta: "增量" }))).toBe("增量")
  })
  it("parts 数组拼接", () => {
    expect(parseAntigravityCliLine(JSON.stringify({ parts: [{ text: "a" }, { text: "b" }] }))).toBe("ab")
  })
  it("Gemini candidates", () => {
    expect(parseAntigravityCliLine(JSON.stringify({ candidates: [{ content: { parts: [{ text: "c" }] } }] }))).toBe("c")
  })
  it("垃圾行/非对象 → null（上游加层不崩）", () => {
    expect(parseAntigravityCliLine("")).toBeNull()
    expect(parseAntigravityCliLine("not json")).toBeNull()
    expect(parseAntigravityCliLine("[1,2]")).toBeNull()
    expect(parseAntigravityCliLine(JSON.stringify({ type: "unknown.event", foo: 1 }))).toBeNull()
  })
})

describe("extractAntigravityCliError — 回退语义锁", () => {
  it("turn.failed 优先返回，error 累积 lastError", () => {
    const out = [
      JSON.stringify({ type: "error", message: "first" }),
      JSON.stringify({ type: "turn.failed", error: { message: "fatal" } }),
    ].join("\n")
    expect(extractAntigravityCliError(out)).toBe("fatal")
  })
  it("无结构化错误 → 回退原文", () => {
    expect(extractAntigravityCliError("plain boom")).toBe("plain boom")
  })
})

describe("streamAntigravityCli — 聚合 payload 按行拆分（P1-10）", () => {
  afterEach(() => {
    vi.mocked(invoke).mockReset()
    vi.mocked(listen).mockReset()
  })

  it("单 payload 多行逐行出 token", async () => {
    const listeners = new Map<string, (event: { payload: string | { code: number | null; stderr: string; stdout?: string } }) => void>()
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      listeners.set(String(eventName), handler as (event: { payload: string | { code: number | null; stderr: string; stdout?: string } }) => void)
      return () => {}
    })
    vi.mocked(invoke).mockResolvedValue(undefined)

    const config: LlmConfig = {
      provider: "antigravity-cli",
      apiKey: "",
      model: "gemini-3-flash",
      ollamaUrl: "http://localhost:11434",
      customEndpoint: "",
      maxContextSize: 128000,
      apiMode: "chat_completions",
      reasoning: { mode: "off" },
    }
    const callbacks = { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    const streamPromise = streamAntigravityCli(config, [{ role: "user", content: "hi" }], callbacks)

    await Promise.resolve()
    await Promise.resolve()
    const eventNames = [...listeners.keys()]
    const dataEventName = eventNames.find((n) => n.startsWith("antigravity-cli:") && !n.endsWith(":done"))
    const doneEventName = eventNames.find((n) => n.endsWith(":done"))
    if (!dataEventName || !doneEventName) throw new Error("expected antigravity-cli listeners")

    // 后端 24ms/8KB 聚合后单 payload 可含多行（含尾换行），必须逐行出 token。
    listeners.get(dataEventName)!({
      payload:
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "batch-one" } }) + "\n" +
        JSON.stringify({ type: "message", content: "batch-two" }) + "\n",
    })
    listeners.get(doneEventName)!({ payload: { code: 0, stderr: "" } })

    await expect(streamPromise).resolves.toBeUndefined()
    expect(callbacks.onToken).toHaveBeenNthCalledWith(1, "batch-one")
    expect(callbacks.onToken).toHaveBeenNthCalledWith(2, "batch-two")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
})

/** C4 冒烟覆盖：src/lib/antigravity-cli-transport.ts（自动生成，核心行为由专项 spec 加深） */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

// ===== 增补：helpers / extract 形态 / stream 错误与边界 =====
// 覆盖：contentToText 非字符串分支、escapePromptContent、buildPrompt、
// parse 原语与空形态、extract 空白/数组行、DEV warn、captureUnparsed、
// replayFromStdout、abort（前/中/首 listen 后）、非零退出、spawn 抛错。
import type { ChatMessage, RequestOverrides } from "./llm-providers"

describe("buildPrompt — 角色块拼接与转义", () => {
  it("角色大写分块，多轮以空行分隔", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]
    expect(buildPrompt(msgs)).toBe("<USER>\nhi\n</USER>\n\n<ASSISTANT>\nhello\n</ASSISTANT>")
  })

  it("图文块混合：文本直出，图片折叠为占位", () => {
    const msgs: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "看这张图" },
          { type: "image", mediaType: "image/png", dataBase64: "zzz" },
        ],
      },
    ]
    const prompt = buildPrompt(msgs)
    expect(prompt).toContain("看这张图")
    expect(prompt).toContain("[Image omitted: image/png]")
  })

  it("正文里的尖括号标签被转义，避免与角色块混淆", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "用 <USER> 标签包裹" }]
    expect(buildPrompt(msgs)).toBe("<USER>\n用 &lt;USER&gt; 标签包裹\n</USER>")
  })
})

describe("parseAntigravityCliLine — 形态补齐", () => {
  it("JSON 原语（字符串/数字/null/布尔）→ null", () => {
    expect(parseAntigravityCliLine('"just a string"')).toBeNull()
    expect(parseAntigravityCliLine("123")).toBeNull()
    expect(parseAntigravityCliLine("null")).toBeNull()
    expect(parseAntigravityCliLine("true")).toBeNull()
  })

  it("空 text 与非 agent 的 item.completed 落到 null", () => {
    expect(parseAntigravityCliLine(JSON.stringify({ type: "message", text: "" }))).toBeNull()
    expect(
      parseAntigravityCliLine(JSON.stringify({ type: "item.completed", item: { type: "other", text: "x" } })),
    ).toBeNull()
  })

  it("content 对象里的 parts 也拼，非文本成员被过滤", () => {
    expect(
      parseAntigravityCliLine(
        JSON.stringify({ content: { parts: [{ text: "p1" }, { nope: 1 }, { text: "p2" }] } }),
      ),
    ).toBe("p1p2")
  })

  it("空 parts / 非文本 parts / 空 candidates / 无内容 candidates → null", () => {
    expect(parseAntigravityCliLine(JSON.stringify({ parts: [] }))).toBeNull()
    expect(parseAntigravityCliLine(JSON.stringify({ parts: [{ nope: 1 }] }))).toBeNull()
    expect(parseAntigravityCliLine(JSON.stringify({ candidates: [] }))).toBeNull()
    expect(parseAntigravityCliLine(JSON.stringify({ candidates: [{}] }))).toBeNull()
    expect(
      parseAntigravityCliLine(JSON.stringify({ candidates: [{ content: { parts: [] } }] })),
    ).toBeNull()
  })

  it("assistant role + content 直出", () => {
    expect(parseAntigravityCliLine(JSON.stringify({ role: "assistant", content: "hi" }))).toBe("hi")
  })
})

describe("extractAntigravityCliError — 形态补齐", () => {
  it("嵌套 error.message 优先于顶层 message", () => {
    const line = JSON.stringify({ type: "error", error: { message: "deep" }, message: "shallow" })
    expect(extractAntigravityCliError(line)).toBe("deep")
  })

  it("无嵌套时顶层 message 生效（turn.failed 直接返回）", () => {
    expect(extractAntigravityCliError(JSON.stringify({ type: "turn.failed", message: "fatal-m" }))).toBe(
      "fatal-m",
    )
  })

  it("纯文本 message 行不算错误，回退原文", () => {
    const raw = JSON.stringify({ message: "oops" })
    expect(extractAntigravityCliError(raw)).toBe(raw)
  })

  it("数组行与空行被跳过", () => {
    expect(extractAntigravityCliError("[1,2]\n\nplain boom")).toBe("[1,2]\n\nplain boom")
  })

  it("空输入回空串", () => {
    expect(extractAntigravityCliError("")).toBe("")
    expect(extractAntigravityCliError("   ")).toBe("")
  })
})

describe("streamAntigravityCli — 错误与边界", () => {
  const baseConfig: LlmConfig = {
    provider: "antigravity-cli",
    apiKey: "",
    model: "gemini-3-flash",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    maxContextSize: 128000,
    apiMode: "chat_completions",
    reasoning: { mode: "off" },
  }

  type AnyPayload = { payload: unknown }
  let listeners: Map<string, (event: AnyPayload) => void>

  const agentLine = (text: string) =>
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })

  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    vi.mocked(listen).mockReset()
    listeners = new Map()
    vi.mocked(listen).mockImplementation(async (eventName, handler) => {
      listeners.set(String(eventName), handler as (event: AnyPayload) => void)
      return () => {}
    })
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  async function settledStream(signal?: AbortSignal, overrides?: RequestOverrides) {
    const callbacks = { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    const promise = streamAntigravityCli(
      baseConfig,
      [{ role: "user", content: "hi" }],
      callbacks,
      signal,
      overrides,
    )
    await Promise.resolve()
    await Promise.resolve()
    return { callbacks, promise }
  }

  function dataEvent() {
    const name = [...listeners.keys()].find((n) => n.startsWith("antigravity-cli:") && !n.endsWith(":done"))
    if (!name) throw new Error("no data listener registered")
    return listeners.get(name)!
  }

  function doneEvent() {
    const name = [...listeners.keys()].find((n) => n.endsWith(":done"))
    if (!name) throw new Error("no done listener registered")
    return listeners.get(name)!
  }

  it("非零退出 + stderr：onError 带 code 与 stderr", async () => {
    const { callbacks, promise } = await settledStream()
    dataEvent()({ payload: agentLine("half") })
    doneEvent()({ payload: { code: 1, stderr: "boom-stderr" } })
    await expect(promise).resolves.toBeUndefined()
    expect(callbacks.onToken).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    const err = callbacks.onError.mock.calls[0][0] as Error
    expect(err.message).toContain("code 1")
    expect(err.message).toContain("boom-stderr")
    expect(callbacks.onDone).not.toHaveBeenCalled()
  })

  it("非零退出无 stderr：从 stdout 提取结构化错误", async () => {
    const { callbacks, promise } = await settledStream()
    doneEvent()({
      payload: { code: 2, stderr: "", stdout: JSON.stringify({ type: "turn.failed", error: { message: "fatal-x" } }) },
    })
    await expect(promise).resolves.toBeUndefined()
    const err = callbacks.onError.mock.calls[0][0] as Error
    expect(err.message).toContain("fatal-x")
  })

  it("非零退出且无任何细节：回退 unknown error", async () => {
    const { callbacks, promise } = await settledStream()
    doneEvent()({ payload: { code: 3, stderr: "", stdout: undefined } })
    await expect(promise).resolves.toBeUndefined()
    const err = callbacks.onError.mock.calls[0][0] as Error
    expect(err.message).toContain("unknown error")
  })

  it("无 token 时从 stdout 回放补发", async () => {
    const { callbacks, promise } = await settledStream()
    doneEvent()({ payload: { code: 0, stderr: "", stdout: `${agentLine("replayed")}\nplain-garbage\n` } })
    await expect(promise).resolves.toBeUndefined()
    expect(callbacks.onToken).toHaveBeenCalledTimes(1)
    expect(callbacks.onToken).toHaveBeenCalledWith("replayed")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("已有 token 时不再从 stdout 回放（不重复）", async () => {
    const { callbacks, promise } = await settledStream()
    dataEvent()({ payload: agentLine("live") })
    doneEvent()({ payload: { code: 0, stderr: "", stdout: agentLine("SHOULD-NOT-APPEAR") } })
    await expect(promise).resolves.toBeUndefined()
    expect(callbacks.onToken).toHaveBeenCalledTimes(1)
    expect(callbacks.onToken).toHaveBeenCalledWith("live")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
  })

  it("垃圾行只进未解析缓存，不触发 token", async () => {
    const { callbacks, promise } = await settledStream()
    dataEvent()({ payload: '{"unrecognized":true,"n":1}\n\n' })
    doneEvent()({ payload: { code: 0, stderr: "" } })
    await expect(promise).resolves.toBeUndefined()
    expect(callbacks.onToken).not.toHaveBeenCalled()
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("超大垃圾缓存被截断而不崩", async () => {
    const { callbacks, promise } = await settledStream()
    const big = "z".repeat(3000)
    dataEvent()({ payload: `${big}\n${big}\n${big}\n` })
    doneEvent()({ payload: { code: 0, stderr: "" } })
    await expect(promise).resolves.toBeUndefined()
    expect(callbacks.onToken).not.toHaveBeenCalled()
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
  })

  it("spawn 抛错：onError，移除 abort 监听", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("spawn fail"))
    const controller = new AbortController()
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
    try {
      const { callbacks, promise } = await settledStream(controller.signal)
      await expect(promise).resolves.toBeUndefined()
      expect(callbacks.onError).toHaveBeenCalledTimes(1)
      expect((callbacks.onError.mock.calls[0][0] as Error).message).toContain("spawn fail")
      expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function))
      expect(callbacks.onDone).not.toHaveBeenCalled()
    } finally {
      removeSpy.mockRestore()
    }
  })

  it("调用前已 abort：直接 onDone，不注册不 spawn", async () => {
    const controller = new AbortController()
    controller.abort()
    const callbacks = { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    await streamAntigravityCli(baseConfig, [{ role: "user", content: "hi" }], callbacks, controller.signal)
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onToken).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
    expect(vi.mocked(listen)).not.toHaveBeenCalled()
  })

  it("中途 abort：kill 进程 + onDone，且后续 done 不再触发完成", async () => {
    const controller = new AbortController()
    const { callbacks, promise } = await settledStream(controller.signal)
    dataEvent()({ payload: agentLine("before-abort") })
    controller.abort()
    await expect(promise).resolves.toBeUndefined()
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("antigravity_cli_kill", expect.objectContaining({}))
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onToken).toHaveBeenCalledWith("before-abort")
    doneEvent()({ payload: { code: 0, stderr: "" } })
    await Promise.resolve()
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("首个 listen 期间 abort：清理后直接返回，不注册 done", async () => {
    const controller = new AbortController()
    vi.mocked(listen).mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          setTimeout(() => {
            listeners.set("antigravity-cli:late", () => {})
            resolve(() => {})
          }, 20)
        }),
    )
    const { callbacks, promise } = await settledStream(controller.signal)
    await new Promise((r) => setTimeout(r, 5))
    controller.abort()
    await expect(promise).resolves.toBeUndefined()
    await new Promise((r) => setTimeout(r, 40))
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
    expect([...listeners.keys()].some((n) => n.endsWith(":done"))).toBe(false)
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("antigravity_cli_kill", expect.objectContaining({}))
  })

  it("DEV 下不支持的 overrides 逐条 warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const { callbacks, promise } = await settledStream(undefined, { temperature: 0.5 })
      doneEvent()({ payload: { code: 0, stderr: "" } })
      await expect(promise).resolves.toBeUndefined()
      expect(callbacks.onDone).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("temperature"))
    } finally {
      warn.mockRestore()
    }
  })
})

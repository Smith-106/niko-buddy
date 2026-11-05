// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "./platform"
import type { ChatMessage } from "./llm-providers"
import {
  formatReasoningReplayRiskForError,
  isReasoningContentRequiredError,
  logReasoningReplay,
  summarizeReasoningReplayRisk,
} from "./reasoning-replay-debug"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

vi.mock("./platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./platform")>()
  return { ...actual, isTauri: vi.fn(() => false) }
})

function assistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { role: "assistant", content: "", ...overrides }
}

describe("isReasoningContentRequiredError", () => {
  it("同时命中 reasoning_content 与 must be passed back 时为真", () => {
    expect(
      isReasoningContentRequiredError(
        "reasoning_content must be passed back for tool call replay",
      ),
    ).toBe(true)
  })

  it("大小写不敏感", () => {
    expect(isReasoningContentRequiredError("REASONING_CONTENT MUST BE PASSED BACK")).toBe(true)
  })

  it("只命中一半时为假", () => {
    expect(isReasoningContentRequiredError("reasoning_content is missing")).toBe(false)
    expect(isReasoningContentRequiredError("must be passed back")).toBe(false)
    expect(isReasoningContentRequiredError("")).toBe(false)
    expect(isReasoningContentRequiredError("model overloaded, retry later")).toBe(false)
  })
})

describe("logReasoningReplay", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    sessionStorage.clear()
  })

  afterEach(() => {
    warnSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it("console.warn 输出 TAG+阶段+详情并持久化最近日志", () => {
    logReasoningReplay("agent.round.start", { round: 1 })
    expect(warnSpy).toHaveBeenCalledWith(
      "[reasoning-replay]",
      "agent.round.start",
      { round: 1 },
    )
    const stored = JSON.parse(sessionStorage.getItem("niko-buddy.reasoningReplayLogs") ?? "[]") as Array<{
      at: string
      stage: string
      details: Record<string, unknown>
    }>
    expect(stored).toHaveLength(1)
    expect(stored[0].stage).toBe("agent.round.start")
    expect(stored[0].details).toEqual({ round: 1 })
    expect(typeof stored[0].at).toBe("string")
  })

  it("超过 40 条只保留最近 40 条", () => {
    for (let i = 0; i < 45; i += 1) {
      logReasoningReplay(`stage-${i}`, { i })
    }
    const stored = JSON.parse(sessionStorage.getItem("niko-buddy.reasoningReplayLogs") ?? "[]") as unknown[]
    expect(stored).toHaveLength(40)
  })

  it("存储配额异常时吞掉错误不中断主流程", () => {
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new Error("quota exceeded")
      })
    expect(() => logReasoningReplay("stage", {})).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
    setItemSpy.mockRestore()
  })

  it("无 sessionStorage 环境直接跳过持久化", () => {
    vi.stubGlobal("sessionStorage", undefined)
    expect(() => logReasoningReplay("stage", {})).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
  })

  it("桌面端桥接 Rust 终端日志", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)
    vi.mocked(isTauri).mockReturnValue(true)
    try {
      logReasoningReplay("agent.round.end", { ok: true })
      await vi.waitFor(() => {
        expect(invoke).toHaveBeenCalledWith("log_diagnostic", {
          message: expect.stringContaining("[reasoning-replay] agent.round.end"),
        })
      })
    } finally {
      vi.mocked(isTauri).mockReturnValue(false)
    }
  })

  it("桥接 invoke 失败时吞掉不抛", async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(invoke).mockRejectedValueOnce(new Error("bridge down"))
    try {
      expect(() => logReasoningReplay("stage", {})).not.toThrow()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(invoke).toHaveBeenCalled()
    } finally {
      vi.mocked(isTauri).mockReturnValue(false)
    }
  })
})

describe("summarizeReasoningReplayRisk", () => {
  it("统计带工具助手缺 reasoning 的数量并忽略非助手消息", () => {
    const summary = summarizeReasoningReplayRisk([
      assistantMessage({
        content: "正文",
        tool_calls: [{ function: { name: "read_chapter", arguments: "{}" } }],
        reasoning_content: "思考过程",
      }),
      assistantMessage({
        content: "正文2",
        tool_calls: [{ function: { name: "read_chapter", arguments: "{}" } }],
      }),
      assistantMessage({
        content: "正文3",
        tool_calls: [{ function: { name: "write_memory", arguments: "{}" } }],
        reasoning_content: "",
      }),
      // 无工具调用的助手不计入
      assistantMessage({ content: "纯文本", reasoning_content: "x" }),
      // 非助手即使带工具也不计入
      { role: "user", content: "hi" },
      // 数组 content 走 JSON 长度分支
      assistantMessage({
        content: [{ type: "text", text: "块内容" }],
        tool_calls: [{ function: { name: "a", arguments: "{}" } }],
        reasoning_content: "r",
      }),
    ])
    expect(summary.assistantWithTools).toBe(4)
    expect(summary.missingReasoningOnToolAssistants).toBe(1)
    expect(summary.emptyReasoningOnToolAssistants).toBe(1)
    expect(summary.probes).toHaveLength(4)
    expect(summary.probes[0]).toMatchObject({
      index: 0,
      role: "assistant",
      toolCallCount: 1,
      toolNames: ["read_chapter"],
      hasReasoningField: true,
      reasoningLen: 4,
    })
    expect(summary.probes[3]).toMatchObject({ toolNames: ["a"], reasoningLen: 1 })
  })

  it("tool_calls 缺省按 0 计且无工具名", () => {
    const summary = summarizeReasoningReplayRisk([assistantMessage({ content: "x" })])
    expect(summary.assistantWithTools).toBe(0)
    expect(summary.probes).toHaveLength(0)
  })
})

describe("formatReasoningReplayRiskForError", () => {
  it("含探针时输出计数与工具明细", () => {
    const summary = summarizeReasoningReplayRisk([
      assistantMessage({
        content: "x",
        tool_calls: [{ function: { name: "read_chapter", arguments: "{}" } }],
      }),
      assistantMessage({
        content: "y",
        tool_calls: [
          { function: { name: "a", arguments: "{}" } },
          { function: { name: "b", arguments: "{}" } },
        ],
        reasoning_content: "zz",
      }),
    ])
    const text = formatReasoningReplayRiskForError(summary)
    expect(text).toContain("toolAssistants=2")
    expect(text).toContain("missing=1")
    expect(text).toContain("empty=0")
    expect(text).toContain("#0 tools=[read_chapter] reasoning=MISSING")
    expect(text).toContain("#1 tools=[a,b] reasoning=2chars")
  })

  it("无探针时不带明细分隔符", () => {
    const text = formatReasoningReplayRiskForError(
      summarizeReasoningReplayRisk([{ role: "user", content: "hi" }]),
    )
    expect(text).toContain("toolAssistants=0")
    expect(text).not.toContain(" | ")
  })

  it("无工具名探针用 - 占位", () => {
    const text = formatReasoningReplayRiskForError(
      summarizeReasoningReplayRisk([
        assistantMessage({
          content: "x",
          tool_calls: [{ function: { name: "", arguments: "{}" } }],
          reasoning_content: "",
        }),
      ]),
    )
    expect(text).toContain("tools=[-]")
    expect(text).toContain("empty=1")
  })
})

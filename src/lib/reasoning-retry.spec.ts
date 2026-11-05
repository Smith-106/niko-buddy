import { describe, expect, it } from "vitest"
import {
  hasUnreplayableToolAssistantReasoning,
  stripEmptyReasoningContent,
  isReasoningOnlyResponseError,
  isReasoningDisabled,
  withReasoningDisabled,
} from "./reasoning-retry"
import type { ChatMessage } from "./llm-providers"

function assistantMsg(extra: Record<string, unknown> = {}): ChatMessage {
  return { role: "assistant", content: "", ...extra } as ChatMessage
}

describe("hasUnreplayableToolAssistantReasoning", () => {
  it("无 tool_calls 的消息不触发（纯文本 assistant 可续轮）", () => {
    expect(hasUnreplayableToolAssistantReasoning([assistantMsg()])).toBe(false)
  })

  it("带 tool_calls 且 reasoning_content 非空 → 可回放", () => {
    const messages = [
      assistantMsg({ tool_calls: [{ id: "c1" }], reasoning_content: "因为章节需要伏笔" }),
    ]
    expect(hasUnreplayableToolAssistantReasoning(messages)).toBe(false)
  })

  it("带 tool_calls 但 reasoning_content 缺失 → 不可回放", () => {
    const messages = [assistantMsg({ tool_calls: [{ id: "c1" }] })]
    expect(hasUnreplayableToolAssistantReasoning(messages)).toBe(true)
  })

  it("带 tool_calls 但 reasoning_content 为空串/空白 → 不可回放", () => {
    expect(
      hasUnreplayableToolAssistantReasoning([
        assistantMsg({ tool_calls: [{ id: "c1" }], reasoning_content: "   " }),
      ]),
    ).toBe(true)
  })

  it("多轮混合：任一不可回放即整体 true", () => {
    const messages = [
      assistantMsg({ tool_calls: [{ id: "c1" }], reasoning_content: "ok" }),
      { role: "user", content: "继续" } as ChatMessage,
      assistantMsg({ tool_calls: [{ id: "c2" }], reasoning_content: "" }),
    ]
    expect(hasUnreplayableToolAssistantReasoning(messages)).toBe(true)
  })
})

describe("stripEmptyReasoningContent", () => {
  it("空串 reasoning_content 被剥离（DeepSeek 不接受空字段续轮）", () => {
    const out = stripEmptyReasoningContent([
      assistantMsg({ tool_calls: [{ id: "c1" }], reasoning_content: "" }),
    ])
    expect(out).toHaveLength(1)
    expect("reasoning_content" in (out[0] as unknown as Record<string, unknown>)).toBe(false)
    expect((out[0] as { tool_calls?: unknown[] }).tool_calls).toHaveLength(1)
  })

  it("空白串同样被剥离，非空则原样保留", () => {
    const out = stripEmptyReasoningContent([
      assistantMsg({ reasoning_content: "  " }),
      assistantMsg({ reasoning_content: "有效思考" }),
    ])
    expect("reasoning_content" in (out[0] as unknown as Record<string, unknown>)).toBe(false)
    expect((out[1] as { reasoning_content?: string }).reasoning_content).toBe("有效思考")
  })

  it("缺字段的消息不受影响（同一引用语义保留其余字段）", () => {
    const msg = assistantMsg({ tool_calls: [{ id: "c1" }] })
    const out = stripEmptyReasoningContent([msg])
    expect(out).toHaveLength(1)
    expect("reasoning_content" in (out[0] as unknown as Record<string, unknown>)).toBe(false)
  })
})

describe("isReasoningOnlyResponseError", () => {
  it("命中「模型只输出思考内容没有输出正文」句式 → true", () => {
    expect(
      isReasoningOnlyResponseError(
        new Error("模型只输出了 1200 字符的思考内容，但没有输出正文。请缩短输入后重试。"),
      ),
    ).toBe(true)
  })

  it("普通 400/网络错误 → false", () => {
    expect(isReasoningOnlyResponseError(new Error("HTTP 400: Bad Request"))).toBe(false)
    expect(isReasoningOnlyResponseError(new Error("Connection lost"))).toBe(false)
  })
})

describe("isReasoningDisabled / withReasoningDisabled", () => {
  it("reasoning.mode === off → 禁用；缺省/auto → 未禁用", () => {
    expect(isReasoningDisabled({ reasoning: { mode: "off" } })).toBe(true)
    expect(isReasoningDisabled({})).toBe(false)
    expect(isReasoningDisabled({ reasoning: { mode: "auto" } })).toBe(false)
  })

  it("overrides 优先于 config（显式 off 覆盖 auto）", () => {
    expect(
      isReasoningDisabled({ reasoning: { mode: "auto" } }, { reasoning: { mode: "off" } }),
    ).toBe(true)
    expect(
      isReasoningDisabled({ reasoning: { mode: "off" } }, { reasoning: { mode: "auto" } }),
    ).toBe(false)
  })

  it("withReasoningDisabled 保留其余 overrides 并强制 reasoning off", () => {
    expect(withReasoningDisabled({ max_tokens: 100 })).toEqual({
      max_tokens: 100,
      reasoning: { mode: "off" },
    })
    expect(withReasoningDisabled()).toEqual({ reasoning: { mode: "off" } })
  })
})

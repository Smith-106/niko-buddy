import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"

const streamChatMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/llm-client", () => ({ streamChat: streamChatMock }))

import {
  buildCaptionPromptWithContext,
  CAPTION_PROMPT,
  captionImage,
} from "./vision-caption"

const llmConfig: LlmConfig = {
  provider: "openai",
  apiKey: "sk-test",
  model: "gpt-4o",
  maxContextSize: 128000,
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  reasoning: { mode: "off" },
}

const B64 = "aGVsbG8="

function firstMessageText() {
  const msgs = streamChatMock.mock.calls[0][1] as { content: Array<{ type: string; text?: string }> }[]
  return msgs[0].content[0].text ?? ""
}

beforeEach(() => {
  vi.clearAllMocks()
  streamChatMock.mockReset()
  streamChatMock.mockImplementation(async () => {})
})

describe("buildCaptionPromptWithContext", () => {
  it("embeds trimmed non-empty flanking text", () => {
    const p = buildCaptionPromptWithContext("  before text  ", "after text")
    expect(p).toContain("--- Text before image ---")
    expect(p).toContain("before text")
    expect(p).toContain("after text")
    expect(p).not.toContain("(none)")
  })

  it("collapses whitespace-only sides to (none)", () => {
    const p = buildCaptionPromptWithContext("   ", "")
    expect(p).toContain("(none)")
    expect(p).not.toContain("before text")
  })
})

describe("captionImage", () => {
  it("uses the fixed factual prompt and default tuning when no context or options are given", async () => {
    streamChatMock.mockImplementation(async (_cfg, msgs, callbacks) => {
      expect(msgs).toHaveLength(1)
      const content = msgs[0].content as Array<{ type: string; text?: string; mediaType?: string; dataBase64?: string }>
      expect(content[0]).toMatchObject({ type: "text", text: CAPTION_PROMPT })
      expect(content[1]).toMatchObject({ type: "image", mediaType: "image/png", dataBase64: B64 })
      callbacks.onToken("  hello ")
      callbacks.onToken("world  ")
      callbacks.onDone()
    })

    const out = await captionImage(B64, "image/png", llmConfig)
    expect(out).toBe("hello world")
    expect(streamChatMock).toHaveBeenCalledWith(
      llmConfig,
      expect.any(Array),
      expect.objectContaining({
        onToken: expect.any(Function),
        onDone: expect.any(Function),
        onError: expect.any(Function),
      }),
      undefined,
      { temperature: 0, max_tokens: 4096 },
    )
  })

  it("builds a context-aware prompt and forwards the signal plus tuning options", async () => {
    const controller = new AbortController()
    streamChatMock.mockImplementation(async (_cfg, msgs, callbacks, signal, overrides) => {
      expect(signal).toBe(controller.signal)
      expect(overrides).toEqual({ temperature: 0.5, max_tokens: 100 })
      const content = msgs[0].content as Array<{ text: string }>
      expect(content[0].text).toContain("Text before image")
      expect(content[0].text).toContain("Figure 3: Q2 revenue")
      expect(content[0].text).toContain("as shown above")
      callbacks.onToken("caption")
      callbacks.onDone()
    })

    const out = await captionImage(B64, "image/png", llmConfig, controller.signal, {
      contextBefore: "Figure 3: Q2 revenue",
      contextAfter: "as shown above",
      temperature: 0.5,
      maxTokens: 100,
    })
    expect(out).toBe("caption")
  })

  it("uses the context prompt when only the after-context is non-empty", async () => {
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken("fig")
      callbacks.onDone()
    })
    const out = await captionImage(B64, "image/png", llmConfig, undefined, {
      contextAfter: "the chart below",
    })
    expect(out).toBe("fig")
    expect(firstMessageText()).toContain("Text after image")
    expect(firstMessageText()).toContain("the chart below")
  })

  it("uses the context prompt when only the before-context is non-empty", async () => {
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken("x")
      callbacks.onDone()
    })
    await captionImage(B64, "image/png", llmConfig, undefined, { contextBefore: "  label  " })
    expect(firstMessageText()).toContain("Text before image")
    expect(firstMessageText()).toContain("label")
  })

  it("falls back to the fixed prompt when both contexts are whitespace-only", async () => {
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken("x")
      callbacks.onDone()
    })
    await captionImage(B64, "image/png", llmConfig, undefined, {
      contextBefore: "   ",
      contextAfter: "",
    })
    expect(firstMessageText()).toBe(CAPTION_PROMPT)
  })

  it("applies the maxTokens default when only temperature is provided", async () => {
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken("x")
      callbacks.onDone()
    })
    await captionImage(B64, "image/png", llmConfig, undefined, { temperature: 0.2 })
    expect(streamChatMock.mock.calls[0][4]).toEqual({ temperature: 0.2, max_tokens: 4096 })
  })

  it("applies the temperature default when only maxTokens is provided", async () => {
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onToken("x")
      callbacks.onDone()
    })
    await captionImage(B64, "image/png", llmConfig, undefined, { maxTokens: 50 })
    expect(streamChatMock.mock.calls[0][4]).toEqual({ temperature: 0, max_tokens: 50 })
  })

  it("rethrows the stream error so callers can apply fault tolerance", async () => {
    streamChatMock.mockImplementation(async (_cfg, _msgs, callbacks) => {
      callbacks.onError(new Error("provider down"))
    })
    await expect(captionImage(B64, "image/png", llmConfig)).rejects.toThrow("provider down")
  })
})

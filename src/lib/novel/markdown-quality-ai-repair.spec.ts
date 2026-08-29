import { describe, expect, it, vi } from "vitest"

import type { streamChat } from "@/lib/llm-client"
import { repairMarkdownFormatWithAi } from "./markdown-quality-ai-repair"

describe("repairMarkdownFormatWithAi", () => {
  it("把正文和动态 max_tokens 传给 streamChat 并聚合输出", async () => {
    const stream = vi.fn<typeof streamChat>(async (_config, messages, callbacks, _signal, overrides) => {
      expect(messages).toHaveLength(1)
      expect(messages[0]?.role).toBe("user")
      expect(messages[0]?.content).toContain("# 人物设定")
      expect(overrides).toEqual({ temperature: 0, max_tokens: 768 })
      callbacks.onToken("# 人物")
      callbacks.onToken("设定")
      callbacks.onDone()
    })

    const result = await repairMarkdownFormatWithAi({
      content: "# 人物设定",
      llmConfig: {} as Parameters<typeof streamChat>[0],
      signal: new AbortController().signal,
      maxTokens: 768,
      stream,
    })

    expect(result).toBe("# 人物设定")
    expect(stream).toHaveBeenCalledTimes(1)
  })
})

import { describe, expect, it, vi } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import type { ChatMessage, StreamCallbacks } from "@/lib/llm-client"
import {
  runDeepOutlineGeneration,
  type DeepOutlineGenerationDeps,
} from "./deep-outline-generation"

const llmConfig = {
  provider: "custom",
  apiKey: "test-key",
  model: "test-model",
  ollamaUrl: "",
  customEndpoint: "https://example.test/v1",
  maxContextSize: 120000,
  reasoning: { mode: "high" },
} satisfies LlmConfig

function createDeps(): DeepOutlineGenerationDeps {
  return {
    streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
      const prompt = messages.map((message) => String(message.content)).join("\n")
      const content = prompt.includes("自检")
        ? "结论：通过\n大纲承接合理。"
        : prompt.includes("草稿")
          ? "## 第八章细纲\n主角根据上一章线索进入旧屋。"
          : "大纲任务书：承接第七章，生成第八章细纲。"
      callbacks.onToken(content)
      callbacks.onDone()
    }),
  }
}

describe("runDeepOutlineGeneration", () => {
  it("falls back safely when outline context is missing", async () => {
    const deps = createDeps()
    const thinking: string[] = []
    const final: string[] = []

    const result = await runDeepOutlineGeneration(
      {
        llmConfig,
        userRequest: "生成第八章细纲",
        context: undefined as unknown as string,
        historyMessages: undefined,
      },
      {
        onThinking: (content) => thinking.push(content),
        onFinalContent: (content) => final.push(content),
      },
      deps,
    )

    expect(result.finalContent).toContain("第八章细纲")
    expect(final.join("")).toContain("第八章细纲")
    expect(thinking.join("\n")).toContain("阶段1：大纲上下文分析")
    expect(thinking.join("\n")).toContain("未读取到现有大纲或章节上下文")
  })

  it("publishes staged outline thinking and returns the final outline", async () => {
    const deps = createDeps()
    const thinking: string[] = []
    const final: string[] = []

    const result = await runDeepOutlineGeneration(
      {
        llmConfig,
        userRequest: "生成第八章细纲",
        context: "已有大纲：第七章结尾，主角拿到锈钥匙。",
        historyMessages: [],
      },
      {
        onThinking: (content) => thinking.push(content),
        onFinalContent: (content) => final.push(content),
      },
      deps,
    )

    expect(result.finalContent).toContain("第八章细纲")
    expect(final.join("")).toContain("第八章细纲")
    expect(thinking.join("\n")).toContain("阶段1：大纲上下文分析")
    expect(thinking.join("\n")).toContain("阶段2：大纲任务书")
    expect(thinking.join("\n")).toContain("阶段3：大纲草稿")
    expect(thinking.join("\n")).toContain("阶段4：大纲自检")
  })

  it("streams outline stage content into thinking while each stage is generating", async () => {
    const deps: DeepOutlineGenerationDeps = {
      streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const prompt = messages.map((message) => String(message.content)).join("\n")
        if (prompt.includes("自检")) {
          callbacks.onToken("结论")
          callbacks.onToken("：通过")
        } else if (prompt.includes("草稿")) {
          callbacks.onToken("草稿第一段")
          callbacks.onToken("草稿第二段")
        } else {
          callbacks.onToken("任务书第一段")
          callbacks.onToken("任务书第二段")
        }
        callbacks.onDone()
      }),
    }
    const thinking: string[] = []

    await runDeepOutlineGeneration(
      {
        llmConfig,
        userRequest: "生成第八章细纲",
        context: "已有大纲：第七章结尾，主角拿到锈钥匙。",
        historyMessages: [],
      },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )

    // F-4/PAT-G2: onUpdate is throttled (ONUPDATE_FLUSH_CHARS=256), so short
    // stage content (< 256 chars) no longer produces per-token intermediate
    // frames — only the final full frame is flushed. The full content still
    // reaches thinking, just at completion granularity instead of per-token.
    expect(thinking).toContain("## 阶段2：大纲任务书\n任务书第一段任务书第二段")
    expect(thinking).toContain("## 阶段3：大纲草稿\n草稿第一段草稿第二段")
    expect(thinking).toContain("## 阶段4：大纲自检\n结论：通过")
  })

  it("throws the stream error surfaced by onError", async () => {
    const deps: DeepOutlineGenerationDeps = {
      streamChat: vi.fn(async (_config: LlmConfig, _messages: ChatMessage[], callbacks: StreamCallbacks) => {
        callbacks.onError(new Error("upstream exploded"))
        callbacks.onDone()
      }),
    }
    await expect(
      runDeepOutlineGeneration(
        { llmConfig, userRequest: "x", context: "ctx" },
        {},
        deps,
      ),
    ).rejects.toThrow("upstream exploded")
  })

  it("flushes onUpdate mid-stream once 256 chars accumulate (F-4 throttle)", async () => {
    const bigToken = "字".repeat(300)
    const deps: DeepOutlineGenerationDeps = {
      streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const prompt = messages.map((message) => String(message.content)).join("\n")
        callbacks.onToken(prompt.includes("草稿") ? bigToken : "short")
        callbacks.onDone()
      }),
    }
    const thinking: string[] = []
    await runDeepOutlineGeneration(
      { llmConfig, userRequest: "x", context: "ctx" },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )
    // 300-char token crosses the 256 threshold → intermediate flush emitted
    expect(thinking.some((t) => t.includes("阶段3：大纲草稿") && t.length > 300)).toBe(true)
  })

  it("formats recent history: filters non-user/assistant roles, slices last 6, truncates to 1200 chars", async () => {
    const capturedPrompts: string[] = []
    const deps: DeepOutlineGenerationDeps = {
      streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        capturedPrompts.push(messages.map((message) => String(message.content)).join("\n"))
        callbacks.onToken("ok")
        callbacks.onDone()
      }),
    }
    const thinking: string[] = []
    const longContent = "L".repeat(2000)
    const historyMessages: ChatMessage[] = [
      { role: "system", content: "系统提示不应出现" },
      { role: "user", content: "第零问" },
      { role: "assistant", content: "第零答" },
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" },
      { role: "assistant", content: longContent },
      { role: "user", content: "第三问" },
      { role: "assistant", content: "第三答" },
    ]
    await runDeepOutlineGeneration(
      { llmConfig, userRequest: "x", context: "ctx", historyMessages },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )
    expect(thinking.join("\n")).toContain("已纳入本轮大纲对话历史")
    const allPrompts = capturedPrompts.join("\n")
    expect(allPrompts).not.toContain("系统提示不应出现")
    expect(allPrompts).not.toContain("第零问") // sliced to last 6 → oldest dropped
    expect(allPrompts).toContain("第三问")
    expect(allPrompts).toContain("AI：".concat("L".repeat(1200)))
    expect(allPrompts).not.toContain("L".repeat(1201)) // truncated to 1200
    expect(allPrompts).toContain("用户：第二问")
  })

  it("reports missing user request in stage-1 thinking", async () => {
    const deps = createDeps()
    const thinking: string[] = []
    await runDeepOutlineGeneration(
      { llmConfig, userRequest: "" as unknown as string, context: "ctx" },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )
    expect(thinking.join("\n")).toContain("未提供用户要求")
  })

  it("triggers the final flush when only trailing tokens remain below the throttle", async () => {
    // token batch shorter than 256 in the last stage: intermediate flush
    // skipped, final flush must still deliver the full self-check content
    const deps: DeepOutlineGenerationDeps = {
      streamChat: vi.fn(async (_config: LlmConfig, messages: ChatMessage[], callbacks: StreamCallbacks) => {
        const prompt = messages.map((message) => String(message.content)).join("\n")
        if (prompt.includes("自检")) {
          callbacks.onToken("短")
          callbacks.onToken("结论")
        } else {
          callbacks.onToken("长".repeat(400))
        }
        callbacks.onDone()
      }),
    }
    const thinking: string[] = []
    await runDeepOutlineGeneration(
      { llmConfig, userRequest: "x", context: "ctx" },
      { onThinking: (content) => thinking.push(content) },
      deps,
    )
    expect(thinking).toContain("## 阶段4：大纲自检\n短结论")
  })
})

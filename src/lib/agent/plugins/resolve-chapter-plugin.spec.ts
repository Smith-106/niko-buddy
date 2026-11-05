import { describe, expect, it, vi } from "vitest"
import { createResolveChapterPlugin } from "./resolve-chapter-plugin"
import type { PrePluginInput } from "../pipeline"
import type { AgentConfig } from "../types"

/** 真实 AgentConfig 最小可用形态（供 PrePluginInput.agentConfig 使用，避免类型绕过）。 */
const mockAgentConfig: AgentConfig = {
  maxRounds: 4,
  tools: [],
  systemPrompt: "测试 Agent",
  llmConfig: {
    provider: "openai",
    apiKey: "",
    model: "test-model",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  },
}

const mockResolve = vi.hoisted(() => vi.fn())

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return {
    ...actual,
    resolveTargetChapterNumberForChat: mockResolve,
  }
})

function baseInput(overrides: Partial<PrePluginInput> = {}): PrePluginInput {
  return {
    userMessage: "继续写下一章",
    projectPath: "/test-project",
    agentConfig: mockAgentConfig,
    novelMode: true,
    taskRoute: { intent: "write_chapter", confidence: 0.9, chapterNumber: 5, extractedParams: {} },
    ...overrides,
  }
}

describe("createResolveChapterPlugin", () => {
  it("exposes name resolve_chapter and priority 20", () => {
    const plugin = createResolveChapterPlugin()
    expect(plugin.name).toBe("resolve_chapter")
    expect(plugin.priority).toBe(20)
  })

  it("returns empty when not in novel mode without resolving", async () => {
    mockResolve.mockReset()
    const plugin = createResolveChapterPlugin()
    const result = await plugin.run(baseInput({ novelMode: false }))
    expect(result).toEqual({})
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it("returns empty when there is no task route", async () => {
    mockResolve.mockReset()
    const plugin = createResolveChapterPlugin()
    const result = await plugin.run(baseInput({ taskRoute: null, effectiveTaskRoute: null }))
    expect(result).toEqual({})
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it("resolves the target chapter and rewrites chapterNumber + extractedParams", async () => {
    mockResolve.mockReset().mockResolvedValue(8)
    const plugin = createResolveChapterPlugin({
      selectedFile: "chapters/第7章.md",
      lastGeneratedChapterNumber: 7,
    })
    const result = await plugin.run(baseInput({}))

    expect(mockResolve).toHaveBeenCalledWith({
      projectPath: "/test-project",
      userRequest: "继续写下一章",
      routeIntent: "write_chapter",
      routeChapterNumber: 5,
      selectedFile: "chapters/第7章.md",
      lastGeneratedChapterNumber: 7,
    })
    expect(result.effectiveTaskRoute?.chapterNumber).toBe(8)
    expect(result.effectiveTaskRoute?.extractedParams?.chapterNumber).toBe("8")
    // other route fields are preserved
    expect(result.effectiveTaskRoute?.intent).toBe("write_chapter")
  })

  it("passes through the original route when the resolver returns undefined", async () => {
    mockResolve.mockReset().mockResolvedValue(undefined)
    const plugin = createResolveChapterPlugin()
    const input = baseInput({})
    const result = await plugin.run(input)
    expect(result.effectiveTaskRoute).toBe(input.taskRoute)
  })

  it("falls back to the original route and reports the error when resolving throws", async () => {
    mockResolve.mockReset().mockRejectedValue(new Error("fs boom"))
    const onError = vi.fn()
    const plugin = createResolveChapterPlugin({ onError })
    const input = baseInput({})
    const result = await plugin.run(input)

    expect(result.effectiveTaskRoute).toBe(input.taskRoute)
    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0][0] as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe("fs boom")
  })

  it("wraps non-Error rejections into an Error", async () => {
    mockResolve.mockReset().mockRejectedValue("string failure")
    const onError = vi.fn()
    const plugin = createResolveChapterPlugin({ onError })
    const result = await plugin.run(baseInput({}))

    expect(result.effectiveTaskRoute?.intent).toBe("write_chapter")
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as Error).message).toBe("string failure")
  })

  it("works without an onError callback when resolving throws", async () => {
    mockResolve.mockReset().mockRejectedValue(new Error("no listener"))
    const plugin = createResolveChapterPlugin()
    const result = await plugin.run(baseInput({}))
    expect(result.effectiveTaskRoute?.intent).toBe("write_chapter")
  })
})

import { describe, expect, it, vi } from "vitest"
import { createBuildContextPackPlugin } from "./build-context-pack-plugin"
import { createSoulDialogPlugin } from "./soul-dialog-plugin"
import { createPrePluginChain } from "../pipeline"
import type { PrePluginInput } from "../pipeline"
import type { AgentConfig } from "../types"
import type { ContextPack } from "@/lib/novel"

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

const mockContextPack: ContextPack = {
  task: "写第5章",
  chapterGoal: "第5章目标",
  outline: "大纲内容",
  recentSummaries: ["第4章摘要"],
  previousChapterEnding: "上一章结尾",
  characterStates: "人物状态",
  soulDoc: "灵魂文档",
  characterAuras: "",
  cognitionStates: "认知状态",
  foreshadowingStates: "伏笔状态",
  timeline: "时间线",
  relatedSettings: "相关设定",
  canonRules: "正史规则",
  writingStyle: "写作风格",
  searchResults: "搜索结果",
  graphSearchResults: "图谱搜索结果",
  mustDo: "必须做",
  mustAvoid: "必须避免",
  nextChapterAdvice: "下一章建议",
  revisionDirectives: "修订指令",
}

describe("BuildContextPackPlugin", () => {
  it("builds context pack in novel mode with task route", async () => {
    const mockBuild = vi.fn().mockResolvedValue(mockContextPack)
    const plugin = createBuildContextPackPlugin({ buildContextPack: mockBuild })

    const result = await plugin.run({
      userMessage: "写第5章",
      projectPath: "/test-project",
      agentConfig: mockAgentConfig,
      novelMode: true,
      taskRoute: { intent: "write_chapter", confidence: 0.9, chapterNumber: 5, extractedParams: {} },
    })

    expect(result.contextPack).toBeDefined()
    expect(result.contextPack?.task).toBe("写第5章")
    expect(mockBuild).toHaveBeenCalledWith("/test-project", "写第5章", 5)
  })

  it("uses effectiveTaskRoute if available", async () => {
    const mockBuild = vi.fn().mockResolvedValue(mockContextPack)
    const plugin = createBuildContextPackPlugin({ buildContextPack: mockBuild })

    await plugin.run({
      userMessage: "写章节",
      projectPath: "/test-project",
      agentConfig: mockAgentConfig,
      novelMode: true,
      taskRoute: { intent: "write_chapter", confidence: 0.9, extractedParams: {} },
      effectiveTaskRoute: { intent: "write_chapter", confidence: 0.9, chapterNumber: 7, extractedParams: { chapterNumber: "7" } },
    })

    expect(mockBuild).toHaveBeenCalledWith("/test-project", "写章节", 7)
  })

  it("returns empty when not in novel mode", async () => {
    const mockBuild = vi.fn().mockResolvedValue(mockContextPack)
    const plugin = createBuildContextPackPlugin({ buildContextPack: mockBuild })

    const result = await plugin.run({
      userMessage: "写第5章",
      projectPath: "/test-project",
      agentConfig: mockAgentConfig,
      novelMode: false,
    })

    expect(result.contextPack).toBeUndefined()
    expect(mockBuild).not.toHaveBeenCalled()
  })

  it("returns empty when no task route", async () => {
    const mockBuild = vi.fn().mockResolvedValue(mockContextPack)
    const plugin = createBuildContextPackPlugin({ buildContextPack: mockBuild })

    const result = await plugin.run({
      userMessage: "随便聊聊",
      projectPath: "/test-project",
      agentConfig: mockAgentConfig,
      novelMode: true,
      taskRoute: null,
    })

    expect(result.contextPack).toBeUndefined()
    expect(mockBuild).not.toHaveBeenCalled()
  })

  it("handles build error gracefully", async () => {
    const mockError = vi.fn()
    const mockBuild = vi.fn().mockRejectedValue(new Error("build failed"))
    const plugin = createBuildContextPackPlugin({ buildContextPack: mockBuild, onError: mockError })

    const result = await plugin.run({
      userMessage: "写第5章",
      projectPath: "/test-project",
      agentConfig: mockAgentConfig,
      novelMode: true,
      taskRoute: { intent: "write_chapter", confidence: 0.9, chapterNumber: 5, extractedParams: {} },
    })

    expect(result.contextPack).toBeUndefined()
    expect(mockError).toHaveBeenCalled()
  })

  it("loads classification before context and passes allowed categories to build", async () => {
    const mockBuild = vi.fn().mockResolvedValue(mockContextPack)
    const mockLoadClassification = vi.fn().mockResolvedValue({
      config: {
        routes: [
          {
            intent: "generate_outline",
            required: ["soul", "settings"],
            optional: ["outline"],
            forbidden: ["chapter_content", "recent_summaries"],
          },
        ],
      },
      source: "project",
    })
    const mockApplyRouteRules = vi.fn().mockReturnValue({
      pack: mockContextPack,
      blockedSources: ["chapter_content", "recent_summaries"],
      keptSources: ["soul", "settings", "outline"],
    })
    const plugin = createBuildContextPackPlugin({
      buildContextPack: mockBuild,
      enableClassification: true,
      loadClassificationConfig: mockLoadClassification,
      applyRouteRules: mockApplyRouteRules,
    })

    const result = await plugin.run({
      userMessage: "生成大纲",
      projectPath: "/test-project",
      agentConfig: mockAgentConfig,
      novelMode: true,
      taskRoute: { intent: "generate_outline", confidence: 0.9, extractedParams: {} },
    })

    expect(mockLoadClassification).toHaveBeenCalledWith("/test-project", undefined)
    expect(mockBuild).toHaveBeenCalledWith("/test-project", "生成大纲", undefined, {
      categories: ["soul", "settings", "outline"],
    })
    expect(result.routeSource).toBe("project")
    expect(result.blockedSources).toEqual(["chapter_content", "recent_summaries"])
  })
})

describe("SoulDialogPlugin", () => {
  it("stops chain when characterAuras present", async () => {
    const plugin = createSoulDialogPlugin()

    const result = await plugin.run({
      userMessage: "写第5章",
      projectPath: "/test-project",
      agentConfig: mockAgentConfig,
      novelMode: true,
      contextPack: { ...mockContextPack, characterAuras: "角色光环内容" },
    })

    expect(result.shouldStop).toBe(true)
    expect(result.stopReason).toBe("soul_dialog_confirmation_required")
  })

  it("does not stop when characterAuras empty", async () => {
    const plugin = createSoulDialogPlugin()

    const result = await plugin.run({
      userMessage: "写第5章",
      projectPath: "/test-project",
      agentConfig: mockAgentConfig,
      novelMode: true,
      contextPack: { ...mockContextPack, characterAuras: "" },
    })

    expect(result.shouldStop).toBeUndefined()
  })

  it("does nothing when not in novel mode", async () => {
    const plugin = createSoulDialogPlugin()

    const result = await plugin.run({
      userMessage: "写第5章",
      projectPath: "/test-project",
      agentConfig: mockAgentConfig,
      novelMode: false,
      contextPack: { ...mockContextPack, characterAuras: "角色光环内容" },
    })

    expect(result.shouldStop).toBeUndefined()
  })

  it("does nothing when no context pack", async () => {
    const plugin = createSoulDialogPlugin()

    const result = await plugin.run({
      userMessage: "写第5章",
      projectPath: "/test-project",
      agentConfig: mockAgentConfig,
      novelMode: true,
    })

    expect(result.shouldStop).toBeUndefined()
  })

  it("supports custom shouldRequest function", async () => {
    const customShould = vi.fn().mockReturnValue(true)
    const plugin = createSoulDialogPlugin({ shouldRequestSoulDialog: customShould })

    const result = await plugin.run({
      userMessage: "写第5章",
      projectPath: "/test-project",
      agentConfig: mockAgentConfig,
      novelMode: true,
      contextPack: mockContextPack,
    })

    expect(customShould).toHaveBeenCalledWith(mockContextPack)
    expect(result.shouldStop).toBe(true)
  })
})

describe("Task3: Plugin Chain Integration", () => {
  it("chains build_context_pack -> soul_dialog correctly", async () => {
    const mockBuild = vi.fn().mockResolvedValue({
      ...mockContextPack,
      characterAuras: "需要确认的角色光环",
      storyFrameworkBinding: "",
    })

    const chain = createPrePluginChain([
      createBuildContextPackPlugin({ buildContextPack: mockBuild }),
      createSoulDialogPlugin(),
    ])

    const result = await chain.run({
      userMessage: "写第5章",
      projectPath: "/test-project",
      agentConfig: mockAgentConfig,
      novelMode: true,
      taskRoute: { intent: "write_chapter", confidence: 0.9, chapterNumber: 5, extractedParams: {} },
    })

    expect(result.contextPack).toBeDefined()
    expect(result.shouldStop).toBe(true)
    expect(result.stopReason).toBe("soul_dialog_confirmation_required")
    expect(result.errors).toHaveLength(0)
  })

  it("continues chain when soul dialog not needed", async () => {
    const mockBuild = vi.fn().mockResolvedValue({
      ...mockContextPack,
      characterAuras: "",
      storyFrameworkBinding: "",
    })

    const chain = createPrePluginChain([
      createBuildContextPackPlugin({ buildContextPack: mockBuild }),
      createSoulDialogPlugin(),
    ])

    const result = await chain.run({
      userMessage: "写第5章",
      projectPath: "/test-project",
      agentConfig: mockAgentConfig,
      novelMode: true,
      taskRoute: { intent: "write_chapter", confidence: 0.9, chapterNumber: 5, extractedParams: {} },
    })

    expect(result.contextPack).toBeDefined()
    expect(result.shouldStop).toBeUndefined()
    expect(result.errors).toHaveLength(0)
  })
})

describe("BuildContextPackPlugin / 覆盖补齐", () => {
  function novelInput(overrides: Partial<PrePluginInput> = {}): PrePluginInput {
    return {
      userMessage: "写第5章",
      projectPath: "/test-project",
      agentConfig: mockAgentConfig,
      novelMode: true,
      taskRoute: { intent: "write_chapter", confidence: 0.9, chapterNumber: 5, extractedParams: {} },
      ...overrides,
    }
  }

  it("emits virtual-tool start/end around a successful build", async () => {
    const events: Array<{ event: string; data: any }> = []
    const mockBuild = vi.fn().mockResolvedValue(mockContextPack)
    const plugin = createBuildContextPackPlugin({
      buildContextPack: mockBuild,
      onVirtualTool: (event, _name, data) => {
        events.push({ event, data })
      },
    })

    const result = await plugin.run(novelInput({}))

    expect(result.contextPack).toBeDefined()
    expect(events).toHaveLength(2)
    expect(events[0].event).toBe("start")
    expect(String(events[0].data.callId)).toMatch(/^build_context_pack_/)
    expect(events[0].data.params).toMatchObject({
      projectPath: "/test-project",
      userMessage: "写第5章",
      chapterNumber: 5,
    })
    expect(events[1].event).toBe("end")
    expect(events[1].data.callId).toBe(events[0].data.callId)
    expect(events[1].data.status).toBe("done")
    const payload = JSON.parse(events[1].data.result)
    expect(payload.blockedSources).toEqual([])
    expect(payload.keptSources).toEqual([])
  })

  it("falls back to default routeSource when classification config loading fails", async () => {
    const mockBuild = vi.fn().mockResolvedValue(mockContextPack)
    const plugin = createBuildContextPackPlugin({
      buildContextPack: mockBuild,
      enableClassification: true,
      loadClassificationConfig: vi.fn().mockRejectedValue(new Error("config io boom")),
    })

    const result = await plugin.run(novelInput({ userMessage: "生成大纲" }))

    expect(result.routeSource).toBe("default")
    expect(result.classificationFallbackReason).toContain("分类路由应用失败")
    expect(result.contextPack).toBeDefined()
    // build still runs without category restriction
    expect(mockBuild).toHaveBeenCalledWith("/test-project", "生成大纲", 5)
  })

  it("falls back to default routeSource when applying route rules throws", async () => {
    const mockBuild = vi.fn().mockResolvedValue(mockContextPack)
    const plugin = createBuildContextPackPlugin({
      buildContextPack: mockBuild,
      enableClassification: true,
      loadClassificationConfig: vi.fn().mockResolvedValue({
        config: {
          routes: [
            {
              intent: "write_chapter",
              required: ["soul"],
              optional: ["outline"],
              forbidden: ["chapter_content"],
            },
          ],
        },
        source: "project",
      }),
      applyRouteRules: vi.fn().mockImplementation(() => {
        throw new Error("apply boom")
      }),
    })

    const result = await plugin.run(novelInput({}))

    expect(result.routeSource).toBe("default")
    expect(result.classificationFallbackReason).toContain("分类路由应用失败")
    expect(result.contextPack).toBeDefined()
  })

  it("reports loaded/blocked sources via onContextInfoUpdate", async () => {
    const onContextInfoUpdate = vi.fn()
    const mockBuild = vi.fn().mockResolvedValue(mockContextPack)
    const plugin = createBuildContextPackPlugin({
      buildContextPack: mockBuild,
      onContextInfoUpdate,
    })

    await plugin.run(novelInput({}))

    expect(onContextInfoUpdate).toHaveBeenCalledTimes(1)
    expect(onContextInfoUpdate).toHaveBeenCalledWith({
      loadedSources: [],
      blockedSources: [],
      routeSource: undefined,
      fallbackReason: undefined,
      classificationVersion: undefined,
    })
  })

  it("emits an error end event when the build throws and a virtual tool is attached", async () => {
    const events: Array<{ event: string; data: any }> = []
    const onError = vi.fn()
    const plugin = createBuildContextPackPlugin({
      buildContextPack: vi.fn().mockRejectedValue(new Error("build exploded")),
      onError,
      onVirtualTool: (event, _name, data) => {
        events.push({ event, data })
      },
    })

    const result = await plugin.run(novelInput({}))

    expect(result).toEqual({})
    expect(onError).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(2)
    expect(events[0].event).toBe("start")
    expect(events[1].event).toBe("end")
    expect(events[1].data.callId).toBe(events[0].data.callId)
    expect(events[1].data.status).toBe("error")
    expect(String(events[1].data.result)).toContain("build exploded")
  })
})

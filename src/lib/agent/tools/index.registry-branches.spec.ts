import { beforeEach, describe, expect, it, vi } from "vitest"
import { ToolRegistry } from "../registry"
import { registerAllBuiltInTools } from "./index"
import type { ContextPack, TaskRouteResult } from "@/lib/novel"

/**
 * `registerAllBuiltInTools` 的分支补测（覆盖率战役补齐）。
 *
 * 与 `index.spec.ts` 互补（不重写、不删既有用例）：既有 spec 只覆盖「禁用/白名单/MCP 透传」
 * 与 run_chapter_workflow 装配；本文件补 quality_iteration 三件套、virtual_tool_context 三件套、
 * token 预算优先级链，以及 list_outlines 注入的默认章号闭包。
 */

const budgetMocks = vi.hoisted(() => ({
  resolveContextPackTokenBudget: vi.fn(() => 777),
}))

vi.mock("@/lib/context-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/context-budget")>()
  return { ...actual, resolveContextPackTokenBudget: budgetMocks.resolveContextPackTokenBudget }
})

const outlineMocks = vi.hoisted(() => ({
  listOutlineEntries: vi.fn(async () => [
    {
      relativePath: "章纲/第003章.md",
      absolutePath: "/project/wiki/outlines/章纲/第003章.md",
      folder: "章纲",
      type: undefined,
      outlineType: undefined,
    },
  ]),
}))

vi.mock("./outline-list-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./outline-list-helpers")>()
  return { ...actual, listOutlineEntries: outlineMocks.listOutlineEntries }
})

const baseOptions = {
  wikiPath: "/project/wiki",
  getSkillConfig: () => null,
  getChatConversations: () => [],
  getOutlineConversations: () => [],
}

function taskRoute(chapterNumber?: number): TaskRouteResult {
  return { intent: "continue_chapter", confidence: 0.9, chapterNumber, extractedParams: {} }
}

const contextPack = { soulDoc: "灵魂", recentChapters: [] } as unknown as ContextPack

describe("registerAllBuiltInTools · quality_iteration 装配", () => {
  const deps = {
    scoreChapter: vi.fn(async () => ({ plot: 8 })),
    reviseChapter: vi.fn(async (content: string) => content),
  }

  beforeEach(() => vi.clearAllMocks())

  it("提供 qualityIteration 时注册 score_chapter / revise_chapter", () => {
    const registry = new ToolRegistry()
    registerAllBuiltInTools(registry, { ...baseOptions, qualityIteration: deps })
    expect(registry.has("score_chapter")).toBe(true)
    expect(registry.has("revise_chapter")).toBe(true)
    expect(registry.get("score_chapter")?.category).toBe("read")
  })

  it("qualityIteration 就绪但被 enabledToolNames 排除时两者都不注册", () => {
    const registry = new ToolRegistry()
    registerAllBuiltInTools(registry, { ...baseOptions, qualityIteration: deps, enabledToolNames: [] })
    expect(registry.has("score_chapter")).toBe(false)
    expect(registry.has("revise_chapter")).toBe(false)
  })

  it("未提供 qualityIteration 时不注册质量闭环工具", () => {
    const registry = new ToolRegistry()
    registerAllBuiltInTools(registry, baseOptions)
    expect(registry.has("score_chapter")).toBe(false)
    expect(registry.has("revise_chapter")).toBe(false)
  })
})

describe("registerAllBuiltInTools · MCP 过滤", () => {
  beforeEach(() => vi.clearAllMocks())

  it("MCP 工具名不在白名单时被跳过（不注册）", () => {
    const registry = new ToolRegistry()
    const mcpTool = {
      name: "mcp_graph_query",
      description: "Query graph",
      category: "read" as const,
      permission: "auto" as const,
      parameters: {},
      execute: async () => "ok",
    }
    registerAllBuiltInTools(registry, {
      ...baseOptions,
      mcpTools: [mcpTool],
      enabledToolNames: ["read_chapter"],
    })
    expect(registry.has("mcp_graph_query")).toBe(false)
    expect(registry.has("read_chapter")).toBe(true)
  })
})

describe("registerAllBuiltInTools · virtual_tool_context 装配", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    budgetMocks.resolveContextPackTokenBudget.mockReturnValue(777)
  })

  it("有 taskRoute 时注册 route_task + load_context", () => {
    const registry = new ToolRegistry()
    registerAllBuiltInTools(registry, {
      ...baseOptions,
      virtualToolContext: { userMessage: "继续写第三章", projectPath: "/project", taskRoute: taskRoute(3) },
    })
    expect(registry.has("route_task")).toBe(true)
    expect(registry.has("load_context")).toBe(true)
    // 无 contextPack → 不注册 trim_context（也不解析预算）
    expect(registry.has("trim_context")).toBe(false)
    expect(budgetMocks.resolveContextPackTokenBudget).not.toHaveBeenCalled()
  })

  it("无 taskRoute 时只注册 route_task，不注册 load_context", () => {
    const registry = new ToolRegistry()
    registerAllBuiltInTools(registry, {
      ...baseOptions,
      virtualToolContext: { userMessage: "写点什么", projectPath: "/project" },
    })
    expect(registry.has("route_task")).toBe(true)
    expect(registry.has("load_context")).toBe(false)
  })

  it("白名单排除 route_task 时虚拟路由工具不注册", () => {
    const registry = new ToolRegistry()
    registerAllBuiltInTools(registry, {
      ...baseOptions,
      virtualToolContext: { userMessage: "继续", projectPath: "/project", taskRoute: taskRoute(1) },
      enabledToolNames: ["read_chapter"],
    })
    expect(registry.has("route_task")).toBe(false)
    expect(registry.has("load_context")).toBe(false)
  })

  it("显式 tokenBudget 优先，不再解析模型窗口", () => {
    const registry = new ToolRegistry()
    registerAllBuiltInTools(registry, {
      ...baseOptions,
      virtualToolContext: {
        userMessage: "继续第三章",
        projectPath: "/project",
        contextPack,
        tokenBudget: 1234,
        maxContextSize: 9999,
      },
    })
    expect(registry.has("trim_context")).toBe(true)
    expect(budgetMocks.resolveContextPackTokenBudget).not.toHaveBeenCalled()
  })

  it("无 tokenBudget 时用 virtualToolContext.maxContextSize 解析预算", () => {
    const registry = new ToolRegistry()
    registerAllBuiltInTools(registry, {
      ...baseOptions,
      virtualToolContext: { userMessage: "继续", projectPath: "/project", contextPack, maxContextSize: 4096 },
      maxContextSize: 2048,
      llmConfig: { maxContextSize: 1024 } as never,
    })
    expect(registry.has("trim_context")).toBe(true)
    expect(budgetMocks.resolveContextPackTokenBudget).toHaveBeenCalledWith({ maxContextSize: 4096 })
  })

  it("virtualToolContext 未给窗口时回退 options.maxContextSize", () => {
    const registry = new ToolRegistry()
    registerAllBuiltInTools(registry, {
      ...baseOptions,
      virtualToolContext: { userMessage: "继续", projectPath: "/project", contextPack },
      maxContextSize: 2048,
      llmConfig: { maxContextSize: 1024 } as never,
    })
    expect(budgetMocks.resolveContextPackTokenBudget).toHaveBeenCalledWith({ maxContextSize: 2048 })
  })

  it("两级窗口都缺时回退 llmConfig.maxContextSize", () => {
    const registry = new ToolRegistry()
    registerAllBuiltInTools(registry, {
      ...baseOptions,
      virtualToolContext: { userMessage: "继续", projectPath: "/project", contextPack },
      llmConfig: { maxContextSize: 1024 } as never,
    })
    expect(budgetMocks.resolveContextPackTokenBudget).toHaveBeenCalledWith({ maxContextSize: 1024 })
  })
})

describe("registerAllBuiltInTools · list_outlines 默认章号闭包", () => {
  beforeEach(() => vi.clearAllMocks())

  it("taskRoute 带章号时 list_outlines 标注目标章", async () => {
    const registry = new ToolRegistry()
    registerAllBuiltInTools(registry, {
      ...baseOptions,
      virtualToolContext: { userMessage: "继续第三章", projectPath: "/project", taskRoute: taskRoute(7) },
    })
    const result = await registry.get("list_outlines")!.execute({})
    expect(result).toContain("本次目标章号：第 7 章")
  })

  it("无 virtualToolContext 时 list_outlines 不标注目标章", async () => {
    const registry = new ToolRegistry()
    registerAllBuiltInTools(registry, baseOptions)
    const result = await registry.get("list_outlines")!.execute({})
    expect(result).toContain("章纲/第003章.md")
    expect(result).not.toContain("本次目标章号")
  })
})

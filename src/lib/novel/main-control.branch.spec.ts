import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentRunCallbacks, AgentRunRecord } from "@/lib/agent/types"
import type { LlmConfig } from "@/stores/wiki-store"
import { useOutlineChatStore } from "@/stores/outline-chat-store"
import { listDirectory, readFile } from "@/commands/fs"
import { runMainControlAgent } from "./main-control"

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, listDirectory: vi.fn(), readFile: vi.fn() }
})

const LLM = { provider: "openai", model: "gpt-test", apiKey: "k", baseUrl: "" } as unknown as LlmConfig

function baseOptions(over: Record<string, unknown> = {}) {
  return {
    projectPath: "/p",
    wikiPath: "/p/wiki",
    goal: "随便聊聊",
    llmConfig: LLM,
    deps: {
      runner: {
        async run(
          _c: unknown,
          _r: unknown,
          _m: unknown,
          cb: AgentRunCallbacks,
        ): Promise<AgentRunRecord> {
          cb.onText("你好。")
          cb.onDone()
          return { toolCalls: [], roundsUsed: 1, finalText: "你好。" }
        },
      },
    },
    ...over,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(listDirectory).mockResolvedValue([])
  vi.mocked(readFile).mockResolvedValue("")
  useOutlineChatStore.setState({ conversations: [], activeConversationId: null, loaded: false })
})

/**
 * main-control.ts 分支补测（覆盖率战役第九批）。
 */
describe("main-control branch coverage", () => {
  it("parseDraftReceipts：有 ID 无章节名/字数时回退（178/179/180 右支）", async () => {
    const { parseDraftReceipts } = await import("./main-control")
    const drafts = parseDraftReceipts(["草稿ID: D1 已生成"])
    expect(drafts).toEqual([{ id: "D1", chapterName: "", words: undefined }])
  })

  it("onToolCall 无 arguments 时 params 回 {}（253 右支）", async () => {
    const calls: Array<{ id: string; name: string }> = [{ id: "c1", name: "read_chapter" }]
    const result = await runMainControlAgent(
      baseOptions({
        goal: "读第 3 章",
        deps: {
          runner: {
            async run(
              _c: unknown,
              _r: unknown,
              _m: unknown,
              cb: AgentRunCallbacks,
            ): Promise<AgentRunRecord> {
              for (const call of calls) {
                cb.onToolCall(call as unknown as { id: string; name: string; arguments: Record<string, unknown> })
                cb.onToolResult(call.id, "内容")
              }
              cb.onText("读完。")
              cb.onDone()
              return {
                toolCalls: calls.map((c) => ({
                  id: c.id,
                  name: c.name,
                  params: {},
                  result: "内容",
                  status: "done" as const,
                  startedAt: 0,
                  finishedAt: 0,
                })),
                roundsUsed: 1,
                finalText: "读完。",
              }
            },
          },
        },
      }) as never,
    )
    expect(result.ok).toBe(true)
    expect(result.steps[0]?.params).toEqual({})
  })

  it("onToolResult 未知 id 直接返回（263 真支）", async () => {
    const result = await runMainControlAgent(
      baseOptions({
        deps: {
          runner: {
            async run(
              _c: unknown,
              _r: unknown,
              _m: unknown,
              cb: AgentRunCallbacks,
            ): Promise<AgentRunRecord> {
              cb.onToolResult("ghost", "幽灵结果")
              cb.onText("完成。")
              cb.onDone()
              return { toolCalls: [], roundsUsed: 1, finalText: "完成。" }
            },
          },
        },
      }) as never,
    )
    expect(result.ok).toBe(true)
    expect(result.steps).toEqual([])
  })

  it("onToolError 已知/未知 id 双支（271 双向）", async () => {
    const known = await runMainControlAgent(
      baseOptions({
        deps: {
          runner: {
            async run(
              _c: unknown,
              _r: unknown,
              _m: unknown,
              cb: AgentRunCallbacks,
            ): Promise<AgentRunRecord> {
              cb.onToolCall({ id: "e1", name: "read_chapter", arguments: {} })
              cb.onToolError("e1", "读失败")
              cb.onText("")
              cb.onDone()
              return { toolCalls: [], roundsUsed: 1, finalText: "" }
            },
          },
        },
      }) as never,
    )
    expect(known.steps[0]?.status).toBe("error")
    expect(known.steps[0]?.error).toBe("读失败")

    const unknown = await runMainControlAgent(
      baseOptions({
        deps: {
          runner: {
            async run(
              _c: unknown,
              _r: unknown,
              _m: unknown,
              cb: AgentRunCallbacks,
            ): Promise<AgentRunRecord> {
              cb.onToolError("ghost", "幽灵错误")
              cb.onText("完成。")
              cb.onDone()
              return { toolCalls: [], roundsUsed: 1, finalText: "完成。" }
            },
          },
        },
      }) as never,
    )
    expect(unknown.steps).toEqual([])
  })

  it("空终稿但有草稿仍判 ok（435 草稿支）", async () => {
    const result = await runMainControlAgent(
      baseOptions({
        goal: "写第 3 章",
        deps: {
          runner: {
            async run(
              _c: unknown,
              _r: unknown,
              _m: unknown,
              cb: AgentRunCallbacks,
            ): Promise<AgentRunRecord> {
              cb.onToolCall({ id: "w1", name: "write_chapter", arguments: {} })
              cb.onToolResult(
                "w1",
                "已生成章节草稿「第3章 旧梦」\n草稿ID: draft_x1\n字数：1200字",
              )
              cb.onDone()
              return { toolCalls: [], roundsUsed: 1, finalText: "" }
            },
          },
        },
      }) as never,
    )
    expect(result.ok).toBe(true)
    expect(result.drafts).toHaveLength(1)
  })

  it("record 无 toolCalls 且 runner 抛错走 catch（418 真支/289 右支）", async () => {
    const result = await runMainControlAgent({
      projectPath: "/p",
      wikiPath: "/p/wiki",
      goal: "随便聊聊",
      llmConfig: LLM,
      deps: {
        runner: {
          async run(): Promise<AgentRunRecord> {
            throw new Error("断网了")
          },
        },
      },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe("断网了")
  })

  it("onError 与 throw 并存时保留 onError（418 假支）", async () => {
    const result = await runMainControlAgent(
      baseOptions({
        deps: {
          runner: {
            async run(
              _c: unknown,
              _r: unknown,
              _m: unknown,
              cb: AgentRunCallbacks,
            ): Promise<AgentRunRecord> {
              cb.onError(new Error("回调错误"))
              throw new Error("抛出错误")
            },
          },
        },
      }) as never,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe("回调错误")
  })

  it("record toolCalls 缺 params/status 元信息走兜底（425/426/428/429 右支）", async () => {
    const result = await runMainControlAgent(
      baseOptions({
        deps: {
          runner: {
            async run(): Promise<AgentRunRecord> {
              return {
                toolCalls: [
                  {
                    id: "r1",
                    name: "read_chapter",
                    params: undefined as unknown as Record<string, unknown>,
                    result: "",
                    status: "error" as const,
                    startedAt: 0,
                    finishedAt: 7,
                  },
                ],
                roundsUsed: 1,
                finalText: "",
              }
            },
          },
        },
      }) as never,
    )
    expect(result.steps[0]?.params).toEqual({})
    expect(result.steps[0]?.status).toBe("error")
  })

  it("兜底上下文无章号无计划时回空对象（310/313 假支）", async () => {
    const { ToolRegistry } = await import("@/lib/agent/registry")
    const registry = new ToolRegistry()
    const fake = {
      async run(
        _c: unknown,
        _r: unknown,
        _m: unknown,
        cb: AgentRunCallbacks,
      ): Promise<AgentRunRecord> {
        cb.onText("好.")
        cb.onDone()
        return { toolCalls: [], roundsUsed: 1, finalText: "好." }
      },
    }
    await runMainControlAgent({
      projectPath: "/p",
      wikiPath: "/p/wiki",
      goal: "今天天气怎么样",
      llmConfig: LLM,
      aiWorkflowMode: "standard",
      runDeepChapterGeneration: (() => ({})) as never,
      deps: { runner: fake, registry },
    })
    const tool = registry.get("run_chapter_workflow") as unknown as {
      buildRequiredToolFallbackParams: (input: { taskGoal: string }) => Record<string, unknown>
    }
    expect(tool.buildRequiredToolFallbackParams).toBeDefined()
    // 非写作目标：无结构化章号、无确认计划 → 仅 userRequest（两个三元均走假支）
    const params = tool.buildRequiredToolFallbackParams({ taskGoal: "今天天气怎么样" })
    expect(params).not.toHaveProperty("chapterNumber")
    expect(params).not.toHaveProperty("planBlueprint")
  })

  it("默认 runner 构造且上游失败时走 catch（289 右支）", async () => {
    const { ToolRegistry } = await import("@/lib/agent/registry")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no net")))
    try {
      const result = await runMainControlAgent({
        projectPath: "/p",
        wikiPath: "/p/wiki",
        goal: "随便聊聊",
        llmConfig: LLM,
        deps: { registry: new ToolRegistry() },
      })
      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()
    } finally {
      vi.unstubAllGlobals()
    }
  }, 30000)
})

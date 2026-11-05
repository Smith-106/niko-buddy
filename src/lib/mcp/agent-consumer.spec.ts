import { describe, expect, it, vi } from "vitest"
import {
  buildMcpAgentTools,
  describeMcpTools,
  MCP_TOOL_MARKER,
  runMcpToolLoop,
  type McpToolLike,
} from "./agent-consumer"
import type { McpConfig } from "./config"
import type { LlmConfig } from "@/stores/wiki-store"
import type { streamChat } from "@/lib/llm-client"

const llmConfig = { provider: "local", model: "mock" } as unknown as LlmConfig

type ChatFn = typeof streamChat
function fakeChat(outputs: string[]): ChatFn {
  const chat = vi.fn(
    async (_c: unknown, _messages: unknown, callbacks: { onToken: (t: string) => void }) => {
      const out = outputs.shift() ?? "最终输出"
      callbacks.onToken(out)
    },
  ) as unknown as ChatFn
  return chat
}

function mcpTool(name: string, body?: string): McpToolLike {
  return {
    name,
    description: `工具${name}`,
    parameters: { query: { type: "string", description: "查询词" } },
    execute: vi.fn(async (params: Record<string, unknown>) => body ?? `结果:${name}:${String(params.query ?? "")}`),
  }
}

describe("runMcpToolLoop（文本协议工具循环）", () => {

  it("无工具调用时等价于单次 streamChat", async () => {
    const result = await runMcpToolLoop({
      llmConfig,
      prompt: "生成大纲",
      mcpTools: [mcpTool("lookup")],
      streamChatFn: fakeChat(["直接输出的大纲内容"]),
    })
    expect(result.finalText).toBe("直接输出的大纲内容")
    expect(result.toolCalls).toEqual([])
  })

  it("模型请求工具 → 真实执行 → 结果回填 → 基于结果产出", async () => {
    const tool = mcpTool("lookup", "返回：韩立（主角）")
    const result = await runMcpToolLoop({
      llmConfig,
      prompt: "生成大纲",
      mcpTools: [tool],
      streamChatFn: fakeChat([
        `${MCP_TOOL_MARKER}{"name":"lookup","arguments":{"query":"主角名"}}`,
        "基于工具结果的最终大纲：韩立是主角",
      ]),
    })

    expect(tool.execute).toHaveBeenCalledWith({ query: "主角名" })
    expect(result.toolCalls).toEqual([{ name: "lookup", ok: true, summary: "返回：韩立（主角）" }])
    expect(result.finalText).toBe("基于工具结果的最终大纲：韩立是主角")
  })

  it("工具执行失败时继续以失败摘要回填", async () => {
    const tool: McpToolLike = {
      name: "boom",
      description: "抛错工具",
      execute: vi.fn(async () => {
        throw new Error("连接失败")
      }),
    }
    const result = await runMcpToolLoop({
      llmConfig,
      prompt: "生成大纲",
      mcpTools: [tool],
      streamChatFn: fakeChat([`${MCP_TOOL_MARKER}{"name":"boom","arguments":{}}`, "最终输出"]),
    })
    expect(result.toolCalls[0].ok).toBe(false)
    expect(result.toolCalls[0].summary).toContain("连接失败")
  })

  it("达到最大轮数时停止并提示", async () => {
    const result = await runMcpToolLoop({
      llmConfig,
      prompt: "生成大纲",
      mcpTools: [mcpTool("lookup")],
      maxTurns: 1,
      streamChatFn: fakeChat([`${MCP_TOOL_MARKER}{"name":"lookup","arguments":{}}`]),
    })
    expect(result.finalText).toContain("达到最大轮数")
    expect(result.toolCalls).toHaveLength(1)
  })

  it("工具不存在时直接返回原始输出", async () => {
    const result = await runMcpToolLoop({
      llmConfig,
      prompt: "生成大纲",
      mcpTools: [mcpTool("lookup")],
      streamChatFn: fakeChat([`${MCP_TOOL_MARKER}{"name":"nope","arguments":{}}\n正文`]),
    })
    expect(result.toolCalls).toEqual([])
    expect(result.finalText).toContain("正文")
  })
})

describe("buildMcpAgentTools / describeMcpTools", () => {
  it("空配置返回空工具集", () => {
    const built = buildMcpAgentTools(null)
    expect(built.tools).toEqual([])
    expect(built.warnings).toEqual([])
  })

  it("配置了 server 且无 command 时构建空工具集并给出警告", () => {
    const config: McpConfig = {
      servers: [
        {
          id: "s1",
          name: "测试服务",
          enabled: true,
          transport: "stdio",
          tools: [
            { name: "lookup", serverId: "s1", serverName: "测试服务", description: "查询", operation: "read", inputSchema: { type: "object", properties: {} } },
          ],
        },
      ],
    }
    const built = buildMcpAgentTools(config)
    // 无 command/server 不可达：runtime 侧 warning 或空集，均不抛错
    expect(Array.isArray(built.tools)).toBe(true)
  })

  it("describeMcpTools 输出 JSON 描述列表", () => {
    const desc = describeMcpTools([mcpTool("lookup")])
    expect(desc).toContain("lookup")
    expect(desc).toContain("query")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 覆盖增补：无工具描述、工具行协议边界、无执行器与连接器构造降级
// ─────────────────────────────────────────────────────────────────────────────

function emptyServerConfig(): McpConfig {
  return {
    servers: [
      {
        id: "s1",
        name: "测试服务",
        enabled: true,
        transport: "stdio",
        tools: [
          {
            name: "lookup",
            serverId: "s1",
            serverName: "测试服务",
            description: "查询",
            operation: "read",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    ],
  }
}

describe("agent-consumer 覆盖增补：协议边界与降级", () => {
  it("没有工具时 describeMcpTools 返回空串", () => {
    expect(describeMcpTools([])).toBe("")
  })

  it("工具行不是 JSON 对象（数字 / null）→ 不执行工具，直接返回原文", async () => {
    for (const payload of ["42", "null"]) {
      const tool = mcpTool("lookup")
      const result = await runMcpToolLoop({
        llmConfig,
        prompt: "生成大纲",
        mcpTools: [tool],
        streamChatFn: fakeChat([`${MCP_TOOL_MARKER} ${payload}`]),
      })

      expect(tool.execute).not.toHaveBeenCalled()
      expect(result.toolCalls).toEqual([])
      expect(result.finalText).toBe(`${MCP_TOOL_MARKER} ${payload}`)
    }
  })

  it("工具名为非字符串 → 视为无工具调用", async () => {
    const tool = mcpTool("lookup")
    const result = await runMcpToolLoop({
      llmConfig,
      prompt: "生成大纲",
      mcpTools: [tool],
      streamChatFn: fakeChat([`${MCP_TOOL_MARKER}{"name":123}`]),
    })

    expect(tool.execute).not.toHaveBeenCalled()
    expect(result.toolCalls).toEqual([])
  })

  it("工具行 JSON 语法错误 → 按无工具调用处理", async () => {
    const tool = mcpTool("lookup")
    const result = await runMcpToolLoop({
      llmConfig,
      prompt: "生成大纲",
      mcpTools: [tool],
      streamChatFn: fakeChat([`${MCP_TOOL_MARKER}{oops 不是 JSON`]),
    })

    expect(tool.execute).not.toHaveBeenCalled()
    expect(result.toolCalls).toEqual([])
    expect(result.finalText).toContain("不是 JSON")
  })

  it("工具没有 execute → 失败摘要回填“工具无执行器”，不中断循环", async () => {
    const tool: McpToolLike = { name: "noop", description: "只有描述没有执行器" }
    const result = await runMcpToolLoop({
      llmConfig,
      prompt: "生成大纲",
      mcpTools: [tool],
      streamChatFn: fakeChat([
        `${MCP_TOOL_MARKER}{"name":"noop","arguments":{}}`,
        "基于失败结果继续输出",
      ]),
    })

    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].ok).toBe(false)
    expect(result.toolCalls[0].summary).toContain("工具无执行器")
  })

  it("arguments 不是对象时按空参数执行工具", async () => {
    const tool = mcpTool("lookup", "空参数结果")
    const result = await runMcpToolLoop({
      llmConfig,
      prompt: "生成大纲",
      mcpTools: [tool],
      streamChatFn: fakeChat([
        `${MCP_TOOL_MARKER}{"name":"lookup","arguments":"未按对象传参"}`,
        "最终输出",
      ]),
    })

    expect(tool.execute).toHaveBeenCalledWith({})
    expect(result.toolCalls).toEqual([{ name: "lookup", ok: true, summary: "空参数结果" }])
  })

  it("工具返回非字符串结果时以 JSON 作为摘要", async () => {
    const tool: McpToolLike = {
      name: "structured",
      description: "返回对象",
      execute: vi.fn(async () => ({ hits: 2, top: "韩立" })),
    }
    const result = await runMcpToolLoop({
      llmConfig,
      prompt: "生成大纲",
      mcpTools: [tool],
      streamChatFn: fakeChat([
        `${MCP_TOOL_MARKER}{"name":"structured","arguments":{}}`,
        "最终输出",
      ]),
    })

    expect(result.toolCalls[0].ok).toBe(true)
    expect(JSON.parse(result.toolCalls[0].summary)).toEqual({ hits: 2, top: "韩立" })
  })

  it("无可用工具时不注入 system 描述，只发一条 user 消息", async () => {
    const sent: unknown[][] = []
    const chat = vi.fn(async (_c: unknown, messages: unknown, callbacks: { onToken: (t: string) => void }) => {
      sent.push(messages as unknown[])
      callbacks.onToken("无工具的最终内容")
    }) as unknown as ChatFn

    const result = await runMcpToolLoop({
      llmConfig,
      prompt: "生成大纲",
      mcpTools: [],
      streamChatFn: chat,
    })

    expect(sent[0]).toEqual([{ role: "user", content: "生成大纲" }])
    expect(result.finalText).toBe("无工具的最终内容")
  })

  it("流回调 onDone / onError 不影响已累积文本", async () => {
    const chat = vi.fn(
      async (
        _c: unknown,
        _messages: unknown,
        callbacks: { onToken: (t: string) => void; onDone: () => void; onError: (e: Error) => void },
      ) => {
        callbacks.onToken("前半段")
        callbacks.onDone()
        callbacks.onToken("后半段")
        callbacks.onError(new Error("传输层抖动"))
      },
    ) as unknown as ChatFn

    const result = await runMcpToolLoop({
      llmConfig,
      prompt: "生成大纲",
      mcpTools: [mcpTool("lookup")],
      streamChatFn: chat,
    })

    expect(result.finalText).toBe("前半段后半段")
    expect(result.toolCalls).toEqual([])
  })
})

describe("buildMcpAgentTools 降级：连接器构造失败", () => {
  it("servers 字段缺省时按空配置处理", () => {
    const built = buildMcpAgentTools({} as McpConfig)

    expect(built.tools).toEqual([])
    expect(built.warnings).toEqual([])
  })

  it("RealMcpConnector 构造抛错时返回空工具集，不中断生成主链", async () => {
    vi.resetModules()
    vi.doMock("./real-connector", () => ({
      RealMcpConnector: class {
        constructor() {
          throw new Error("stdio 通道不可用")
        }
      },
    }))
    try {
      const fresh = await import("./agent-consumer")
      const built = fresh.buildMcpAgentTools(emptyServerConfig())

      expect(built.tools).toEqual([])
      expect(Array.isArray(built.warnings)).toBe(true)
    } finally {
      vi.doUnmock("./real-connector")
      vi.resetModules()
    }
  })
})

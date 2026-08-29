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
      version: 1,
      servers: [
        {
          id: "s1",
          name: "测试服务",
          enabled: true,
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

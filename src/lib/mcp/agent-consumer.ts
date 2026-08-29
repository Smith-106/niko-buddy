/**
 * MCP 会话消费端（v2 MVP）
 *
 * v2 streamChat 不支持 OpenAI tools 参数，这里用文本协议实现工具循环：
 * - 把 MCP 工具以 JSON 描述注入 system prompt，指示模型在需要时输出一行
 *   `⚙️TOOL: {"name": "...", "arguments": {...}}`；
 * - 解析到工具调用行则经 RealMcpConnector stdio 通道真实执行 MCP 工具，
 *   把结果作为后续 user 消息回填，请求模型基于工具结果产出最终回答。
 *
 * 与 v3 chat-panel 的 agent pipeline 消费等价：用户配置 MCP server 后，
 * 生成流程的子智能体（大纲多智能体）可实际调用外部工具获取信息并产出结果。
 */
import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
import type { ChatMessage } from "@/lib/llm-providers"
import type { LlmConfig } from "@/stores/wiki-store"
import { buildMcpRuntime } from "./runtime"
import { RealMcpConnector } from "./real-connector"
import type { McpConfig } from "./config"
/** 结构兼容接口：mcp/types.Tool 与 agent/types.Tool 均可传入。 */
export interface McpToolLike {
  name: string
  description: string
  parameters?: Record<string, unknown>
  execute?: (params: Record<string, unknown>) => Promise<unknown>
}

export interface McpAgentTools {
  tools: McpToolLike[]
  warnings: string[]
}

/**
 * 从全局 MCP 配置构建可供 agent 会话消费的 MCP 工具集。
 * 工具声明缺失时返回空集 + 警告（不阻断生成主链）。
 */
export function buildMcpAgentTools(
  mcpConfig: McpConfig | null | undefined,
): McpAgentTools {
  if (!mcpConfig || (mcpConfig.servers ?? []).length === 0) {
    return { tools: [], warnings: [] }
  }
  let connector: RealMcpConnector | null = null
  try {
    connector = new RealMcpConnector(mcpConfig)
  } catch {
    connector = null
  }
  const { mcpTools, warnings } = buildMcpRuntime(
    mcpConfig,
    connector ? connector.caller : undefined,
  )
  return { tools: (connector ? mcpTools : []) as McpToolLike[], warnings }
}

/** 把 MCP 工具集转成模型可见的 JSON 描述。 */
export function describeMcpTools(tools: McpToolLike[]): string {
  if (tools.length === 0) return ""
  return tools
    .map((tool) =>
      JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
    )
    .join("\n")
}

export const MCP_TOOL_MARKER = "⚙️TOOL:"

interface ParsedToolCall {
  name: string
  arguments: Record<string, unknown>
}

function parseToolLine(line: string): ParsedToolCall | null {
  const payload = line.slice(MCP_TOOL_MARKER.length).trim()
  try {
    const parsed: unknown = JSON.parse(payload)
    if (typeof parsed !== "object" || parsed === null) return null
    const obj = parsed as Record<string, unknown>
    if (typeof obj.name !== "string") return null
    const args = obj.arguments
    return {
      name: obj.name,
      arguments: typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
    }
  } catch {
    return null
  }
}

/** 从模型输出中提取工具调用行（模型只应输出一行，取第一个出现的）。 */
function extractToolCallLine(text: string): string | null {
  const idx = text.indexOf(MCP_TOOL_MARKER)
  if (idx < 0) return null
  const lineStart = text.lastIndexOf("\n", idx) + 1
  const lineEnd = text.indexOf("\n", idx)
  return text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).trim()
}

export interface RunMcpToolLoopOptions {
  llmConfig: LlmConfig
  prompt: string
  mcpTools: McpToolLike[]
  maxTurns?: number
  signal?: AbortSignal
  /** 测试注入点：默认使用真实 streamChat。 */
  streamChatFn?: typeof streamChat
}

export interface RunMcpToolLoopResult {
  finalText: string
  toolCalls: Array<{ name: string; ok: boolean; summary: string }>
}

/**
 * 文本协议工具循环：streamChat → 解析 ⚙️TOOL: 行 → 执行 MCP 工具 → 回填结果再请求。
 * 无工具调用（或无可执行工具）时等价于单次 streamChat。
 */
export async function runMcpToolLoop(options: RunMcpToolLoopOptions): Promise<RunMcpToolLoopResult> {
  const { llmConfig, prompt, mcpTools, signal } = options
  const chat = options.streamChatFn ?? streamChat
  const maxTurns = Math.max(1, options.maxTurns ?? 2)
  const toolByName = new Map(mcpTools.map((tool) => [tool.name, tool]))

  const systemIntro =
    mcpTools.length > 0
      ? [
          "你是生成子智能体。以下外部工具可用（MCP）：",
          describeMcpTools(mcpTools),
          `如需使用工具，在回复中只用单独一行输出 ${MCP_TOOL_MARKER}{"name":"工具名","arguments":{...}}，不要输出其它内容；工具结果回填后请基于结果输出最终内容。不需要工具时直接输出最终内容。`,
        ].join("\n")
      : ""

  const toolCalls: RunMcpToolLoopResult["toolCalls"] = []
  const baseMessages: ChatMessage[] = systemIntro ? [{ role: "system", content: systemIntro }] : []
  let lastOutput = ""
  let lastCall: ParsedToolCall | null = null

  for (let turn = 0; turn < maxTurns; turn++) {
    let messages: ChatMessage[]
    if (turn === 0) {
      messages = [...baseMessages, { role: "user", content: prompt }]
    } else {
      messages = [
        ...baseMessages,
        { role: "user", content: prompt },
        { role: "assistant", content: `[工具调用] ${MCP_TOOL_MARKER}${JSON.stringify(lastCall)}` },
        {
          role: "user",
          content: `工具结果：${JSON.stringify(toolCalls[toolCalls.length - 1])}\n请基于以上结果输出最终内容。`,
        },
      ]
    }

    let current = ""
    const callbacks: StreamCallbacks = {
      onToken: (token) => {
        current += token
      },
      onDone: () => {},
      onError: () => {},
    }
    await chat(llmConfig, messages, callbacks, signal)
    lastOutput = current

    if (turn === 0) {
      const line = extractToolCallLine(lastOutput)
      const parsed = line ? parseToolLine(line) : null
      const tool = parsed ? toolByName.get(parsed.name) : undefined
      if (!parsed || !tool) {
        return { finalText: lastOutput, toolCalls }
      }
      lastCall = parsed
      let ok = false
      let summary = ""
      try {
        if (typeof tool.execute !== "function") throw new Error("工具无执行器")
        const result = await tool.execute(parsed.arguments)
        ok = true
        summary = typeof result === "string" ? result.slice(0, 4000) : JSON.stringify(result).slice(0, 4000)
      } catch (error) {
        ok = false
        summary = `工具执行失败：${error instanceof Error ? error.message : String(error)}`
      }
      toolCalls.push({ name: parsed.name, ok, summary })
      if (turn + 1 >= maxTurns) {
        return { finalText: `[MCP 工具 ${parsed.name} 已执行，但达到最大轮数（${maxTurns}），无法继续生成]`, toolCalls }
      }
      continue
    }
    return { finalText: lastOutput, toolCalls }
  }
  return { finalText: lastOutput, toolCalls }
}

import { describe, expect, it } from "vitest"
import { appendMcpCallTrace } from "./mcp-trace"
import type { AgentToolEvent } from "./types"
import type { ContextTrace } from "./context-trace"

function toolEvent(overrides: Partial<AgentToolEvent> = {}): AgentToolEvent {
  return {
    type: "result",
    callId: "call_1",
    name: "mcp_filesystem_read",
    params: {},
    timestamp: 1700000000000,
    ...overrides,
  }
}

function emptyTrace(): ContextTrace {
  return { id: "trace_1", startedAt: 1700000000000, toolCalls: [], status: "running" }
}

describe("appendMcpCallTrace", () => {
  it("非 mcp_ 工具事件原样返回同一 trace（无副作用）", () => {
    const trace = emptyTrace()
    const out = appendMcpCallTrace(trace, toolEvent({ name: "read_chapter" }))
    expect(out).toBe(trace)
    expect(out.contextInfo).toBeUndefined()
  })

  it("call_started 类型事件不记录调用", () => {
    const trace = emptyTrace()
    expect(appendMcpCallTrace(trace, toolEvent({ type: "call_started" }))).toBe(trace)
  })

  it("合法 JSON 结果按解析字段追加并创建兜底 contextInfo", () => {
    const trace = emptyTrace()
    const out = appendMcpCallTrace(
      trace,
      toolEvent({
        name: "mcp_filesystem_read",
        result: JSON.stringify({
          status: "ok",
          serverId: "filesystem",
          serverName: "FS",
          toolName: "read",
          summary: "读到 3 个文件",
        }),
      }),
    )
    expect(out).not.toBe(trace)
    expect(trace.contextInfo).toBeUndefined()
    expect(out.contextInfo?.intent).toBe("general_chat")
    expect(out.contextInfo?.mcpCalls).toHaveLength(1)
    expect(out.contextInfo?.mcpCalls?.[0]).toMatchObject({
      serverId: "filesystem",
      serverName: "FS",
      toolName: "read",
      status: "ok",
      summary: "读到 3 个文件",
      calledAt: 1700000000000,
    })
  })

  it("error 事件强制 status 为 error（即使 JSON 里是 ok）", () => {
    const out = appendMcpCallTrace(
      emptyTrace(),
      toolEvent({
        type: "error",
        name: "mcp_git_log",
        result: JSON.stringify({ status: "ok", serverId: "git" }),
      }),
    )
    expect(out.contextInfo?.mcpCalls?.[0]).toMatchObject({ status: "error", serverId: "git" })
  })

  it("JSON 缺字段时按事件名回退补齐", () => {
    const out = appendMcpCallTrace(
      emptyTrace(),
      toolEvent({ name: "mcp_git_log", result: JSON.stringify({ summary: "x" }) }),
    )
    expect(out.contextInfo?.mcpCalls?.[0]).toMatchObject({
      serverId: "git",
      serverName: "git",
      toolName: "log",
      status: "error",
    })
  })

  it("非法 JSON 走回退：按 mcp_<server>_<tool> 切分", () => {
    const out = appendMcpCallTrace(
      emptyTrace(),
      toolEvent({ name: "mcp_git_show_diff", result: "not-json{{{" }),
    )
    expect(out.contextInfo?.mcpCalls?.[0]).toMatchObject({
      serverId: "git",
      serverName: "git",
      toolName: "show_diff",
      status: "error",
      message: "not-json{{{",
    })
  })

  it("空结果走回退并使用默认失败文案", () => {
    for (const result of [undefined, ""] as const) {
      const out = appendMcpCallTrace(
        emptyTrace(),
        toolEvent({ name: "mcp_scripts_run", result }),
      )
      expect(out.contextInfo?.mcpCalls?.[0]).toMatchObject({
        serverId: "scripts",
        toolName: "run",
        message: "MCP 调用失败，普通 AI 会话可以继续。",
      })
    }
  })

  it("裸 mcp_ 名回退为空服务并保留原名作工具名", () => {
    const out = appendMcpCallTrace(emptyTrace(), toolEvent({ name: "mcp_" }))
    // "mcp_".split("_") → ["mcp", ""]：serverId 取到空串（解构缺省只对 undefined 生效）
    expect(out.contextInfo?.mcpCalls?.[0]).toMatchObject({
      serverId: "",
      serverName: "",
      toolName: "mcp_",
      status: "error",
      message: "MCP 调用失败，普通 AI 会话可以继续。",
    })
  })

  it("已有 contextInfo 时保留原字段并追加调用", () => {
    const trace = emptyTrace()
    trace.contextInfo = {
      intent: "write_chapter",
      confidence: 0.9,
      routeSource: "project",
      loadedSources: [],
      blockedSources: [],
      webSearches: [],
      mcpCalls: [
        {
          serverId: "old",
          serverName: "old",
          toolName: "ping",
          status: "ok",
          calledAt: 1,
        },
      ],
      retrievalHits: [],
      trimmedSections: [],
    }
    const out = appendMcpCallTrace(
      trace,
      toolEvent({
        name: "mcp_filesystem_write",
        result: JSON.stringify({ status: "ok" }),
      }),
    )
    expect(out.contextInfo?.intent).toBe("write_chapter")
    expect(out.contextInfo?.mcpCalls).toHaveLength(2)
    expect(out.contextInfo?.mcpCalls?.[0].serverId).toBe("old")
    expect(out.contextInfo?.mcpCalls?.[1]).toMatchObject({
      serverId: "filesystem",
      toolName: "write",
      status: "ok",
    })
  })
})

import { describe, expect, it, vi, beforeEach } from "vitest"
import { ToolRegistry } from "./registry"
import {
  approveConfirmedToolCall,
  executeAgentTool,
  isToolCallApproved,
  resetApprovedToolCalls,
} from "./tool-executor"
import type { AgentRunCallbacks, Tool, ToolCall } from "./types"

function makeCallbacks(): AgentRunCallbacks {
  return {
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onToolError: vi.fn(),
    onToolEvent: vi.fn(),
  } as unknown as AgentRunCallbacks
}

function makeConfirmWriteTool(execSpy: Tool["execute"]): Tool {
  return {
    name: "write_memory",
    description: "test confirm write tool",
    category: "write",
    permission: "confirm",
    parameters: {},
    generatePreview: async () => "PREVIEW:将写入记忆",
    execute: execSpy,
  }
}

const call: ToolCall = { id: "call-j09-1", name: "write_memory", arguments: { content: "x" } }

describe("tool-executor confirm 门控 (J09 F-J09-01)", () => {
  beforeEach(() => resetApprovedToolCalls())

  it("confirm 工具默认走 preview 返回 approval_required,不执行 execute", async () => {
    const registry = new ToolRegistry()
    const execSpy = vi.fn(async () => "EXECUTED")
    registry.register(makeConfirmWriteTool(execSpy))
    const res = await executeAgentTool(call, registry, makeCallbacks())
    expect(res.record.status).toBe("approval_required")
    expect(res.record.preview).toContain("PREVIEW")
    expect(execSpy).not.toHaveBeenCalled()
  })

  it("approveConfirmedToolCall 跳过 preview 真实执行", async () => {
    const registry = new ToolRegistry()
    const execSpy = vi.fn(async () => "EXECUTED-OK")
    registry.register(makeConfirmWriteTool(execSpy))
    // 先 preview
    await executeAgentTool(call, registry, makeCallbacks())
    expect(execSpy).not.toHaveBeenCalled()
    // 批准执行
    const res = await approveConfirmedToolCall(call, registry, makeCallbacks())
    expect(execSpy).toHaveBeenCalledTimes(1)
    expect(res?.record.status).toBe("done")
    expect(res?.responseText).toBe("EXECUTED-OK")
  })

  it("重复批准同一 callId 幂等——只执行一次", async () => {
    const registry = new ToolRegistry()
    const execSpy = vi.fn(async () => "EXECUTED")
    registry.register(makeConfirmWriteTool(execSpy))
    await approveConfirmedToolCall(call, registry, makeCallbacks())
    const second = await approveConfirmedToolCall(call, registry, makeCallbacks())
    expect(execSpy).toHaveBeenCalledTimes(1)
    expect(second).toBeNull()
    expect(isToolCallApproved("call-j09-1")).toBe(true)
  })

  it("不同 callId 各自独立批准", async () => {
    const registry = new ToolRegistry()
    const execSpy = vi.fn(async () => "EXECUTED")
    registry.register(makeConfirmWriteTool(execSpy))
    await approveConfirmedToolCall(call, registry, makeCallbacks())
    const other: ToolCall = { id: "call-j09-2", name: "write_memory", arguments: {} }
    const res = await approveConfirmedToolCall(other, registry, makeCallbacks())
    expect(execSpy).toHaveBeenCalledTimes(2)
    expect(res?.record.status).toBe("done")
  })
})

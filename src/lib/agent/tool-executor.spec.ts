import { describe, expect, it, vi, beforeEach } from "vitest"
import { ToolRegistry } from "./registry"
import {
  approveConfirmedToolCall,
  executeAgentTool,
  isToolCallApproved,
  rejectAgentToolCall,
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

/** 覆盖率战役增补：reject/unknown/auto 执行/错误终态/超时/取消/finalContent 全路径。 */

function makeAutoTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "read_note",
    description: "test auto read tool",
    category: "read",
    parameters: {},
    execute: async () => "NOTE-OK",
    ...overrides,
  }
}

describe("tool-executor 执行路径全覆盖", () => {
  beforeEach(() => resetApprovedToolCalls())

  it("rejectAgentToolCall 记录 error 并触发全部回调", () => {
    const cb = makeCallbacks()
    const res = rejectAgentToolCall(
      { id: "rej-1", name: "nope" },
      "直接拒绝",
      cb,
    )
    expect(res.success).toBe(false)
    expect(res.responseText).toBe("直接拒绝")
    expect(res.record.status).toBe("error")
    expect(res.record.result).toBe("直接拒绝")
    expect(res.record.params).toEqual({})
    expect(vi.mocked(cb.onToolCall)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rej-1", name: "nope" }),
    )
    expect(vi.mocked(cb.onToolError)).toHaveBeenCalledWith("rej-1", "直接拒绝")
    const events = vi.mocked(cb.onToolEvent!).mock.calls.map((c) => (c[0] as { type: string }).type)
    expect(events).toEqual(["call_started", "error"])
  })

  it("未知工具返回 error 且不抛", async () => {
    const cb = makeCallbacks()
    const res = await executeAgentTool(
      { id: "u-1", name: "ghost_tool", arguments: {} },
      new ToolRegistry(),
      cb,
    )
    expect(res.success).toBe(false)
    expect(res.record.status).toBe("error")
    expect(res.responseText).toContain("未知工具 ghost_tool")
    expect(vi.mocked(cb.onToolError)).toHaveBeenCalledWith("u-1", expect.stringContaining("未知工具"))
  })

  it("auto 工具正常执行返回 done 并触发 onToolResult", async () => {
    const registry = new ToolRegistry()
    registry.register(makeAutoTool())
    const cb = makeCallbacks()
    const res = await executeAgentTool(
      { id: "a-1", name: "read_note", arguments: { k: 1 } },
      registry,
      cb,
    )
    expect(res.success).toBe(true)
    expect(res.record.status).toBe("done")
    expect(res.responseText).toBe("NOTE-OK")
    expect(vi.mocked(cb.onToolResult)).toHaveBeenCalledWith("a-1", "NOTE-OK")
    const types = vi.mocked(cb.onToolEvent!).mock.calls.map((c) => (c[0] as { type: string }).type)
    expect(types).toEqual(["call_started", "result"])
  })

  it("write 类无 permission 默认走 confirm 预览（preview 复用 execute，不算真实执行）", async () => {
    const registry = new ToolRegistry()
    const execSpy = vi.fn(async () => "PREVIEW-AS-EXEC")
    registry.register({ ...makeAutoTool(), name: "w1", category: "write", execute: execSpy })
    const res = await executeAgentTool(
      { id: "w-1", name: "w1", arguments: {} },
      registry,
      makeCallbacks(),
    )
    expect(res.record.status).toBe("approval_required")
    // 无 generatePreview 时预览复用 execute 生成：调一次，但状态仍是预览态
    expect(execSpy).toHaveBeenCalledTimes(1)
    expect(res.record.preview).toBe("PREVIEW-AS-EXEC")
  })

  it("confirm 工具无 generatePreview 时用 execute 生成预览", async () => {
    const registry = new ToolRegistry()
    const execSpy = vi.fn(async () => "PREVIEW-VIA-EXECUTE")
    registry.register({
      name: "write_memory",
      description: "x",
      category: "write",
      permission: "confirm",
      parameters: {},
      execute: execSpy,
    })
    const res = await executeAgentTool(call, registry, makeCallbacks())
    expect(res.record.status).toBe("approval_required")
    expect(res.record.preview).toBe("PREVIEW-VIA-EXECUTE")
    expect(res.success).toBe(true)
    expect(res.responseText).toContain("尚未执行")
  })

  it("预览抛错返回 error（预览生成失败）", async () => {
    const registry = new ToolRegistry()
    registry.register({
      ...makeConfirmWriteTool(async () => "never"),
      generatePreview: async () => {
        throw new Error("boom-preview")
      },
    })
    const cb = makeCallbacks()
    const res = await executeAgentTool(call, registry, cb)
    expect(res.success).toBe(false)
    expect(res.record.status).toBe("error")
    expect(res.responseText).toContain("预览生成失败")
    expect(vi.mocked(cb.onToolError)).toHaveBeenCalledWith("call-j09-1", expect.stringContaining("boom-preview"))
  })

  it("execute 返回错误前缀字符串判 error，不走 done", async () => {
    const registry = new ToolRegistry()
    registry.register(makeAutoTool({ execute: async () => "错误: 读不到文件" }))
    const cb = makeCallbacks()
    const res = await executeAgentTool(
      { id: "e-1", name: "read_note", arguments: {} },
      registry,
      cb,
    )
    expect(res.success).toBe(false)
    expect(res.record.status).toBe("error")
    expect(vi.mocked(cb.onToolResult)).not.toHaveBeenCalled()
    expect(vi.mocked(cb.onToolError)).toHaveBeenCalledWith("e-1", "错误: 读不到文件")
  })

  it("execute 抛错返回 error 并带 错误: 前缀", async () => {
    const registry = new ToolRegistry()
    registry.register(
      makeAutoTool({
        execute: async () => {
          throw new Error("disk-gone")
        },
      }),
    )
    const res = await executeAgentTool(
      { id: "e-2", name: "read_note", arguments: {} },
      registry,
      makeCallbacks(),
    )
    expect(res.success).toBe(false)
    expect(res.record.status).toBe("error")
    expect(res.responseText).toContain("disk-gone")
  })

  it("abort 信号下抛错判 cancelled 且不调 onToolError", async () => {
    const registry = new ToolRegistry()
    registry.register(
      makeAutoTool({
        execute: async (_params, signal) => {
          await new Promise((r) => setTimeout(r, 5))
          if (signal?.aborted) throw new Error("aborted-by-test")
          return "late"
        },
      }),
    )
    const controller = new AbortController()
    const cb = makeCallbacks()
    const pending = executeAgentTool(
      { id: "c-1", name: "read_note", arguments: {} },
      registry,
      cb,
      controller.signal,
    )
    controller.abort()
    const res = await pending
    expect(res.record.status).toBe("cancelled")
    expect(res.success).toBe(false)
    expect(vi.mocked(cb.onToolError)).not.toHaveBeenCalled()
    const types = vi.mocked(cb.onToolEvent!).mock.calls.map((c) => (c[0] as { type: string }).type)
    expect(types).toContain("cancelled")
  })

  it("executeTimeoutMs=0 跳过超时门直接执行（withToolTimeout 早退分支）", async () => {
    const registry = new ToolRegistry()
    registry.register(makeAutoTool({ executeTimeoutMs: 0, execute: async () => "FAST" }))
    const res = await executeAgentTool(
      { id: "t-0", name: "read_note", arguments: {} },
      registry,
      makeCallbacks(),
    )
    expect(res.record.status).toBe("done")
    expect(res.responseText).toBe("FAST")
  })

  it("执行超时判 error（工具执行超时）", async () => {
    const registry = new ToolRegistry()
    registry.register(
      makeAutoTool({
        executeTimeoutMs: 15,
        execute: () => new Promise<string>(() => {}),
      }),
    )
    const res = await executeAgentTool(
      { id: "t-1", name: "read_note", arguments: {} },
      registry,
      makeCallbacks(),
    )
    expect(res.record.status).toBe("error")
    expect(res.responseText).toContain("工具执行超时")
  })

  it("onFinalContent 交付的终稿随成功返回（finalizesRun 链路）", async () => {
    const registry = new ToolRegistry()
    registry.register(
      makeAutoTool({
        execute: async (_params, _signal, ctx) => {
          ctx?.onFinalContent?.("FINAL-DRAFT")
          return "ok-body"
        },
      }),
    )
    const onFinalContent = vi.fn()
    const cb = { ...makeCallbacks(), onFinalContent } as unknown as AgentRunCallbacks
    const res = await executeAgentTool(
      { id: "f-1", name: "read_note", arguments: {} },
      registry,
      cb,
    )
    expect(res.success).toBe(true)
    expect(res.finalContent).toBe("FINAL-DRAFT")
    expect(onFinalContent).toHaveBeenCalledWith("FINAL-DRAFT")
  })

  it("预览阶段的 onFinalContent 被抑制（不污染终稿）", async () => {
    const registry = new ToolRegistry()
    registry.register({
      ...makeConfirmWriteTool(async () => "REAL-EXEC"),
      generatePreview: async (_params, _signal, ctx) => {
        ctx?.onFinalContent?.("SHOULD-NOT-LEAK")
        return "PREVIEW-X"
      },
    })
    const onFinalContent = vi.fn()
    const cb = { ...makeCallbacks(), onFinalContent } as unknown as AgentRunCallbacks
    const res = await executeAgentTool(call, registry, cb)
    expect(res.record.status).toBe("approval_required")
    expect(res.finalContent).toBeUndefined()
    expect(onFinalContent).not.toHaveBeenCalled()
  })

  it("未批准过的 callId 查询为 false；reset 清空批准记录", async () => {
    expect(isToolCallApproved("never-approved")).toBe(false)
    const registry = new ToolRegistry()
    registry.register(makeConfirmWriteTool(async () => "X"))
    await approveConfirmedToolCall(call, registry, makeCallbacks())
    expect(isToolCallApproved("call-j09-1")).toBe(true)
    resetApprovedToolCalls()
    expect(isToolCallApproved("call-j09-1")).toBe(false)
  })
})

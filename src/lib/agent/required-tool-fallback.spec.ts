/** C4 冒烟覆盖：src/lib/agent/required-tool-fallback.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it, vi } from "vitest"
import type { AgentRunCallbacks, AgentRunRecord, Tool, ToolCallStatus } from "./types"
import { ToolRegistry } from "./registry"
import type { ExecuteAgentToolResult } from "./tool-executor"
import { RequiredToolFallbackError } from "./required-tools-gate"
import { isRequiredToolExecutionFulfilled, executeRequiredToolFallback } from "./required-tool-fallback"
describe("required-tool-fallback.ts smoke", () => {
  it("exports isRequiredToolExecutionFulfilled", () => {
    expect(isRequiredToolExecutionFulfilled).toBeDefined()
  })
  it("exports executeRequiredToolFallback", () => {
    expect(executeRequiredToolFallback).toBeDefined()
  })
})

function makeTool(overrides: Partial<Tool> & { name: string }): Tool {
  return {
    description: overrides.name,
    category: "action",
    permission: "auto",
    parameters: {},
    execute: async () => "ok",
    ...overrides,
  }
}

function makeRecord(status: ToolCallStatus = "done"): AgentRunRecord["toolCalls"][number] {
  return { id: "c1", name: "t", params: {}, result: "ok", status, startedAt: 0, finishedAt: 1 }
}

function executedResult(
  status: ToolCallStatus,
  finalContent?: string,
): ExecuteAgentToolResult {
  return {
    record: makeRecord(status),
    responseText: status === "done" ? "ok" : "错误: boom",
    success: status === "done",
    ...(finalContent === undefined ? {} : { finalContent }),
  }
}

function makeCallbacks(): AgentRunCallbacks {
  return {
    onText: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onToolError: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  }
}

function makeRunRecord(): AgentRunRecord {
  return { toolCalls: [], roundsUsed: 0, finalText: "" }
}

describe("isRequiredToolExecutionFulfilled（履约判据）", () => {
  it("工具不存在 / 未 done / 终稿工具无正文均判未履约", () => {
    const plain = makeTool({ name: "plain" })
    expect(isRequiredToolExecutionFulfilled(undefined, executedResult("done"))).toBe(false)
    expect(isRequiredToolExecutionFulfilled(plain, executedResult("error"))).toBe(false)
    expect(
      isRequiredToolExecutionFulfilled(makeTool({ name: "fin", finalizesRun: true }), executedResult("done")),
    ).toBe(false)
  })

  it("终稿工具交付非空正文才算履约（纯空白不算）", () => {
    const fin = makeTool({ name: "fin", finalizesRun: true })
    expect(isRequiredToolExecutionFulfilled(fin, executedResult("done", "   "))).toBe(false)
    expect(isRequiredToolExecutionFulfilled(fin, executedResult("done", "终稿"))).toBe(true)
  })

  it("非终稿工具 done 即履约", () => {
    expect(isRequiredToolExecutionFulfilled(makeTool({ name: "plain" }), executedResult("done"))).toBe(true)
  })
})

describe("executeRequiredToolFallback（确定性兜底）", () => {
  it("缺失工具未注册或未提供兜底入口 → attempted=false，不执行任何工具", async () => {
    const registry = new ToolRegistry()
    registry.register(makeTool({ name: "no_hook" }))
    const callbacks = makeCallbacks()
    const record = makeRunRecord()

    const result = await executeRequiredToolFallback({
      missingTools: ["unknown", "no_hook"],
      taskGoal: "写第 3 章",
      registry,
      callbacks,
      record,
    })

    expect(result).toEqual({ attempted: false, satisfiedTools: [] })
    expect(callbacks.onToolCall).not.toHaveBeenCalled()
    expect(record.toolCalls).toEqual([])
  })

  it("兜底参数构造失败 → fail-loud（不静默跳过必调工具）", async () => {
    const registry = new ToolRegistry()
    registry.register(
      makeTool({
        name: "broken",
        buildRequiredToolFallbackParams: () => {
          throw new Error("no chapter context")
        },
      }),
    )
    const record = makeRunRecord()

    const result = await executeRequiredToolFallback({
      missingTools: ["broken"],
      taskGoal: "写第 3 章",
      registry,
      callbacks: makeCallbacks(),
      record,
    })

    expect(result.attempted).toBe(true)
    expect(result.toolName).toBe("broken")
    expect(result.satisfiedTools).toEqual([])
    expect(result.error).toBeInstanceOf(RequiredToolFallbackError)
    expect(result.error?.toolName).toBe("broken")
    expect(result.error?.message).toContain("无法构造兜底参数：no chapter context")
    expect(record.toolCalls).toEqual([])
  })

  it("用 taskGoal 构造参数执行非终稿工具 → 履约计入 satisfiedTools 并写入 record", async () => {
    const seen: Array<Record<string, unknown>> = []
    const goalInputs: Array<{ taskGoal: string }> = []
    const registry = new ToolRegistry()
    registry.register(
      makeTool({
        name: "recall",
        buildRequiredToolFallbackParams: (input) => {
          goalInputs.push(input)
          return { query: input.taskGoal }
        },
        execute: async (params) => {
          seen.push(params)
          return "recalled"
        },
      }),
    )
    const record = makeRunRecord()

    const result = await executeRequiredToolFallback({
      missingTools: ["recall"],
      taskGoal: "写第 3 章",
      registry,
      callbacks: makeCallbacks(),
      record,
    })

    expect(goalInputs).toEqual([{ taskGoal: "写第 3 章" }])
    expect(seen).toEqual([{ query: "写第 3 章" }])
    expect(result).toEqual({ attempted: false, satisfiedTools: ["recall"] })
    expect(record.toolCalls).toHaveLength(1)
    expect(record.toolCalls[0]).toMatchObject({ name: "recall", status: "done" })
  })

  it("工具执行失败 → 带 responseText 的 fail-loud，且 satisfiedTools 不虚报", async () => {
    const registry = new ToolRegistry()
    registry.register(
      makeTool({
        name: "boom",
        buildRequiredToolFallbackParams: () => ({}),
        execute: async () => {
          throw new Error("boom")
        },
      }),
    )
    const record = makeRunRecord()

    const result = await executeRequiredToolFallback({
      missingTools: ["boom"],
      taskGoal: "g",
      registry,
      callbacks: makeCallbacks(),
      record,
    })

    expect(result.attempted).toBe(true)
    expect(result.satisfiedTools).toEqual([])
    expect(result.error?.toolName).toBe("boom")
    expect(result.error?.message).toContain("错误: boom")
    expect(record.toolCalls[0]?.status).toBe("error")
  })

  it("终稿工具执行完成但未交付正文 → fail-loud（不得当作已履约）", async () => {
    const registry = new ToolRegistry()
    registry.register(
      makeTool({
        name: "finalize_silent",
        finalizesRun: true,
        buildRequiredToolFallbackParams: () => ({}),
      }),
    )

    const result = await executeRequiredToolFallback({
      missingTools: ["finalize_silent"],
      taskGoal: "g",
      registry,
      callbacks: makeCallbacks(),
      record: makeRunRecord(),
    })

    expect(result.attempted).toBe(true)
    expect(result.satisfiedTools).toEqual([])
    expect(result.error?.message).toContain("工具执行完成，但没有交付终稿正文")
  })

  it("终稿工具交付正文 → 返回 finalContent 并先累计前面的 satisfiedTools", async () => {
    const registry = new ToolRegistry()
    registry.register(
      makeTool({ name: "first", buildRequiredToolFallbackParams: () => ({}) }),
    )
    registry.register(
      makeTool({
        name: "writer",
        finalizesRun: true,
        buildRequiredToolFallbackParams: () => ({}),
        execute: async (_params, _signal, context) => {
          context?.onFinalContent?.("  第 3 章终稿  ")
          return "delivered"
        },
      }),
    )
    const finalContentDelivered: string[] = []
    const callbacks = makeCallbacks()
    callbacks.onFinalContent = (content) => finalContentDelivered.push(content)
    const record = makeRunRecord()

    const result = await executeRequiredToolFallback({
      missingTools: ["first", "writer"],
      taskGoal: "g",
      registry,
      callbacks,
      record,
    })

    expect(result).toEqual({
      attempted: true,
      toolName: "writer",
      satisfiedTools: ["first", "writer"],
      finalContent: "第 3 章终稿",
    })
    expect(finalContentDelivered).toEqual(["  第 3 章终稿  "])
    expect(record.toolCalls.map((call) => call.name)).toEqual(["first", "writer"])
  })
})

/**
 * tool-events — 工具事件到 run record / activity stage 的归约。
 * 三条链路：run 记录累积、运行中记录结算、活动时间线事件映射。
 */
import { describe, expect, it } from "vitest"
import {
  activityEventFromAgentToolEvent,
  applyAgentToolActivityEvent,
  applyAgentToolEvent,
  settleRunningAgentToolCalls,
} from "./tool-events"
import type { AgentRunRecord, AgentToolEvent } from "./types"

type ToolCallRecord = AgentRunRecord["toolCalls"][number]

function ev(overrides: Partial<AgentToolEvent> = {}): AgentToolEvent {
  return {
    type: "call_started",
    callId: "c1",
    name: "read_chapter",
    params: { chapter: 1 },
    timestamp: 1000,
    ...overrides,
  }
}

function record(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "c1",
    name: "read_chapter",
    params: {},
    result: "",
    status: "running",
    startedAt: 1000,
    finishedAt: 0,
    ...overrides,
  } as ToolCallRecord
}

describe("applyAgentToolEvent：新增记录", () => {
  it("records 为 undefined 时从空数组起算", () => {
    const out = applyAgentToolEvent(undefined, ev())
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("c1")
  })

  it("call_started 状态为 running，finishedAt 置 0", () => {
    const out = applyAgentToolEvent(undefined, ev({ type: "call_started", timestamp: 1234 }))
    expect(out[0].status).toBe("running")
    expect(out[0].startedAt).toBe(1234)
    expect(out[0].finishedAt).toBe(0)
  })

  it("result 状态为 done，finishedAt 取事件时间", () => {
    const out = applyAgentToolEvent(undefined, ev({ type: "result", result: "正文", timestamp: 2000 }))
    expect(out[0].status).toBe("done")
    expect(out[0].result).toBe("正文")
    expect(out[0].finishedAt).toBe(2000)
  })

  it("error 状态为 error", () => {
    expect(applyAgentToolEvent(undefined, ev({ type: "error" }))[0].status).toBe("error")
  })

  it("approval_required 状态为 approval_required", () => {
    expect(applyAgentToolEvent(undefined, ev({ type: "approval_required" }))[0].status).toBe(
      "approval_required",
    )
  })

  it("cancelled 没有专门状态，落到 running（刻画现有行为）", () => {
    const out = applyAgentToolEvent(undefined, ev({ type: "cancelled" }))
    expect(out[0].status).toBe("running")
    expect(out[0].finishedAt).toBe(1000)
  })

  it("result 缺省时写入空串而不是 undefined", () => {
    expect(applyAgentToolEvent(undefined, ev({ type: "result" }))[0].result).toBe("")
  })

  it("新记录追加在末尾，不影响既有顺序", () => {
    const existing = [record({ id: "a" }), record({ id: "b" })]
    const out = applyAgentToolEvent(existing, ev({ callId: "c" }))
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"])
  })
})

describe("applyAgentToolEvent：更新既有记录", () => {
  it("按 callId 命中并就地更新，不改变长度", () => {
    const existing = [record({ id: "a" }), record({ id: "c1" })]
    const out = applyAgentToolEvent(existing, ev({ type: "result", result: "新正文" }))
    expect(out).toHaveLength(2)
    expect(out[1].result).toBe("新正文")
    expect(out[1].status).toBe("done")
  })

  it("事件未带 parentCallId/preview 时保留记录里已有的值", () => {
    const existing = [
      record({ id: "c1", parentCallId: "p1", preview: "旧预览" } as Partial<ToolCallRecord>),
    ]
    const out = applyAgentToolEvent(existing, ev({ type: "result", result: "x" }))
    expect(out[0].parentCallId).toBe("p1")
    expect(out[0].preview).toBe("旧预览")
  })

  it("事件带 parentCallId/preview 时覆盖旧值", () => {
    const existing = [
      record({ id: "c1", parentCallId: "p1", preview: "旧预览" } as Partial<ToolCallRecord>),
    ]
    const out = applyAgentToolEvent(
      existing,
      ev({ type: "result", parentCallId: "p2", preview: "新预览" }),
    )
    expect(out[0].parentCallId).toBe("p2")
    expect(out[0].preview).toBe("新预览")
  })

  it("事件未带 result 时保留记录里已有的结果", () => {
    const existing = [record({ id: "c1", result: "已有结果" })]
    const out = applyAgentToolEvent(existing, ev({ type: "result" }))
    expect(out[0].result).toBe("已有结果")
  })

  it("call_started 不推进 finishedAt，其它类型才推进", () => {
    const existing = [record({ id: "c1", finishedAt: 555 })]
    const stillRunning = applyAgentToolEvent(existing, ev({ type: "call_started", timestamp: 9999 }))
    expect(stillRunning[0].finishedAt).toBe(555)
    const done = applyAgentToolEvent(existing, ev({ type: "result", timestamp: 9999 }))
    expect(done[0].finishedAt).toBe(9999)
  })

  it("name 与 params 总是以事件为准覆盖", () => {
    const existing = [record({ id: "c1", name: "old", params: { a: 1 } })]
    const out = applyAgentToolEvent(existing, ev({ name: "new_tool", params: { b: 2 } }))
    expect(out[0].name).toBe("new_tool")
    expect(out[0].params).toEqual({ b: 2 })
  })

  it("startedAt 不被覆盖", () => {
    const existing = [record({ id: "c1", startedAt: 111 })]
    const out = applyAgentToolEvent(existing, ev({ type: "result", timestamp: 9999 }))
    expect(out[0].startedAt).toBe(111)
  })
})

describe("settleRunningAgentToolCalls", () => {
  it("records 为 undefined 时原样返回 undefined", () => {
    expect(settleRunningAgentToolCalls(undefined)).toBeUndefined()
  })

  it("只结算 running 的记录，其它状态原样保留", () => {
    const records = [
      record({ id: "a", status: "running" }),
      record({ id: "b", status: "done" }),
      record({ id: "c", status: "error" }),
      record({ id: "d", status: "approval_required" }),
    ]
    const out = settleRunningAgentToolCalls(records, "done", 7777)
    expect(out?.map((r) => r.status)).toEqual(["done", "done", "error", "approval_required"])
    expect(out?.[0].finishedAt).toBe(7777)
    expect(out?.[1].finishedAt).toBe(0)
  })

  it("默认结算为 done", () => {
    const out = settleRunningAgentToolCalls([record({ status: "running" })])
    expect(out?.[0].status).toBe("done")
  })

  it("可指定 cancelled / error 等结算状态", () => {
    const out = settleRunningAgentToolCalls([record({ status: "running" })], "cancelled", 1)
    expect(out?.[0].status).toBe("cancelled")
  })

  it("传入 result 时覆盖；不传时保留原 result", () => {
    const records = [record({ status: "running", result: "原值" })]
    expect(settleRunningAgentToolCalls(records, "done", 1, "新值")?.[0].result).toBe("新值")
    expect(settleRunningAgentToolCalls(records, "done", 1)?.[0].result).toBe("原值")
  })

  it("空数组返回空数组", () => {
    expect(settleRunningAgentToolCalls([], "done", 1)).toEqual([])
  })
})

describe("activityEventFromAgentToolEvent", () => {
  it("带 parentCallId 的 chapter_* 子步骤返回 null（避免双轨重复）", () => {
    expect(
      activityEventFromAgentToolEvent(
        ev({ name: "chapter_write", parentCallId: "p1" }),
      ),
    ).toBeNull()
  })

  it("不带 parentCallId 的 chapter_* 不跳过", () => {
    expect(activityEventFromAgentToolEvent(ev({ name: "chapter_write" }))).not.toBeNull()
  })

  it("网页研究类工具映射到 external_search 阶段", () => {
    const out = activityEventFromAgentToolEvent(
      ev({ name: "web_search", params: { query: "某主题" } }),
    )
    expect(out?.stageId).toBe("external_search")
    expect(out?.kind).toBe("web_search")
    expect(typeof out?.title).toBe("string")
  })

  it("网页研究类工具出错时 kind 为 error", () => {
    const out = activityEventFromAgentToolEvent(ev({ name: "read_web_page", type: "error" }))
    expect(out?.kind).toBe("error")
  })

  it("网页研究类工具其它类型映射为 done", () => {
    const out = activityEventFromAgentToolEvent(
      ev({ name: "summarize_search_results", type: "result" }),
    )
    expect(out?.kind).toBe("web_search")
  })

  it("chapter_* 映射到 chapter_workflow 阶段，result 时 kind 为 stage_output", () => {
    const out = activityEventFromAgentToolEvent(
      ev({ name: "chapter_plan", type: "result", params: { title: "标题来自参数" } }),
    )
    expect(out?.stageId).toBe("chapter_workflow")
    expect(out?.kind).toBe("stage_output")
    expect(out?.title).toBe("标题来自参数")
  })

  it("chapter_* 出错时 kind 为 error", () => {
    const out = activityEventFromAgentToolEvent(ev({ name: "chapter_plan", type: "error" }))
    expect(out?.kind).toBe("error")
  })

  it("chapter_* 的 params.title 不是字符串时退回默认标题", () => {
    const out = activityEventFromAgentToolEvent(
      ev({ name: "chapter_plan", type: "result", params: { title: 123 } }),
    )
    expect(out?.title).not.toBe("")
    expect(typeof out?.title).toBe("string")
  })

  it("普通工具原样透传活动事件", () => {
    const out = activityEventFromAgentToolEvent(ev({ name: "read_chapter", type: "result", result: "正文" }))
    expect(out).not.toBeNull()
    expect(out?.toolCallId).toBe("c1")
  })
})

describe("applyAgentToolActivityEvent", () => {
  it("活动事件为 null 时返回原 stages；原 stages 为 undefined 时返回空数组", () => {
    const skip = ev({ name: "chapter_write", parentCallId: "p1" })
    expect(applyAgentToolActivityEvent(undefined, skip)).toEqual([])
    const stages = [{ id: "s1" }] as unknown as Parameters<typeof applyAgentToolActivityEvent>[0]
    expect(applyAgentToolActivityEvent(stages, skip)).toBe(stages)
  })

  it("有活动事件时写入 stages", () => {
    const out = applyAgentToolActivityEvent(undefined, ev({ name: "read_chapter", type: "result", result: "正文" }))
    expect(out.length).toBeGreaterThan(0)
  })
})

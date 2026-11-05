import { describe, expect, it } from "vitest"
import {
  activityEventFromToolEvent,
  appendAgentActivityEvent,
  applyAgentActivityEvent,
  createAgentActivityEvent,
  createStageStartedEvent,
  getDefaultOpenAgentStageId,
  prepareAgentStagesForDisplay,
  resolveAgentStageTitle,
  settleRunningAgentStages,
  summarizeAgentStage,
} from "./activity-trace"
import type { AgentActivityEvent, AgentStageTrace, AgentToolEvent } from "./types"

function event(partial: Partial<AgentActivityEvent> & { stageId: string }): AgentActivityEvent {
  return {
    id: `e-${partial.stageId}-${partial.kind ?? "tool_call"}`,
    kind: "tool_call",
    title: "t",
    content: "c",
    timestamp: 1000,
    ...partial,
  }
}

function stage(partial: Partial<AgentStageTrace> & { id: string }): AgentStageTrace {
  return {
    title: `title-${partial.id}`,
    status: "pending",
    summary: `summary-${partial.id}`,
    events: [],
    ...partial,
  }
}

function toolEvent(partial: Partial<AgentToolEvent> & { name: string }): AgentToolEvent {
  return {
    type: "result",
    callId: "c1",
    params: {},
    timestamp: 1000,
    ...partial,
  }
}

describe("createAgentActivityEvent", () => {
  it("裁剪标题、保留时间戳与透传字段", () => {
    const ev = createAgentActivityEvent({
      id: "1",
      stageId: "s",
      kind: "tool_call",
      title: "  调用  ",
      content: "  内容  ",
      toolCallId: "tc",
      timestamp: 42,
    })
    expect(ev).toEqual({
      id: "1",
      stageId: "s",
      kind: "tool_call",
      title: "调用",
      content: "内容",
      sourceRefs: undefined,
      toolCallId: "tc",
      timestamp: 42,
    })
  })
  it("空标题回落阶段事件", () => {
    const ev = createAgentActivityEvent({ id: "1", stageId: "s", kind: "tool_call", title: "   ", content: "x", timestamp: 1 })
    expect(ev.title).toBe("阶段事件")
  })
  it("nullish 内容回落占位", () => {
    const ev = createAgentActivityEvent({ id: "1", stageId: "s", kind: "tool_call", title: "t", content: undefined as unknown as string, timestamp: 1 })
    expect(ev.content).toBe("本阶段未返回可展示内容。")
  })
  it.each([[""], ["undefined"], ["null"], ["   "]])("无意义内容 %s 回落占位", (content) => {
    const ev = createAgentActivityEvent({ id: "1", stageId: "s", kind: "tool_call", title: "t", content, timestamp: 1 })
    expect(ev.content).toBe("本阶段未返回可展示内容。")
  })
  it("默认时间戳接近当前时间", () => {
    const before = Date.now()
    const ev = createAgentActivityEvent({ id: "1", stageId: "s", kind: "tool_call", title: "t", content: "x" })
    expect(ev.timestamp).toBeGreaterThanOrEqual(before)
    expect(Date.now() - ev.timestamp).toBeLessThan(5000)
  })
})

describe("createStageStartedEvent", () => {
  it("summary 优先，无 summary 用 title", () => {
    const ev = createStageStartedEvent({ stageId: "s", title: "T", summary: "S", timestamp: 7 })
    expect(ev).toMatchObject({ id: "s:started:7", stageId: "s", kind: "stage_started", title: "进入阶段", content: "S", timestamp: 7 })
    const ev2 = createStageStartedEvent({ stageId: "s", title: "T", summary: "", timestamp: 8 })
    expect(ev2.content).toBe("T")
  })
  it("缺 timestamp 时默认当前时间", () => {
    const before = Date.now()
    const ev = createStageStartedEvent({ stageId: "s", title: "T", summary: "S" })
    expect(ev.id.startsWith("s:started:")).toBe(true)
    expect(ev.timestamp).toBeGreaterThanOrEqual(before)
  })
})

describe("append/applyAgentActivityEvent", () => {
  it("空列表追加创建新阶段并进入 running", () => {
    const ev = event({ stageId: "read_context", kind: "stage_started", title: "开始", content: "读", timestamp: 5 })
    const stages = appendAgentActivityEvent(undefined, ev)
    expect(stages).toHaveLength(1)
    expect(stages[0].id).toBe("read_context")
    expect(stages[0].title).toBe("读取上下文")
    expect(stages[0].status).toBe("running")
    expect(stages[0].startedAt).toBe(5)
    expect(stages[0].events).toHaveLength(1)
  })
  it("同阶段事件按时间排序追加", () => {
    const base = [stage({ id: "s", status: "running", startedAt: 1, events: [event({ stageId: "s", timestamp: 10 })] })]
    const next = applyAgentActivityEvent(base, event({ stageId: "s", timestamp: 3 }))
    expect(next[0].events.map((e) => e.timestamp)).toEqual([3, 10])
    expect(next[0].startedAt).toBe(1)
  })
  it("多阶段时只替换命中阶段", () => {
    const base = [stage({ id: "a", status: "running" }), stage({ id: "b", status: "pending" })]
    const next = applyAgentActivityEvent(base, event({ stageId: "b", kind: "stage_started", content: "进B", timestamp: 4 }))
    expect(next.find((s) => s.id === "a")!.status).toBe("done")
    expect(next.find((s) => s.id === "b")!.status).toBe("running")
    expect(next).toHaveLength(2)
  })
  it("未知 stageId 用事件标题作标题", () => {
    const next = applyAgentActivityEvent([], event({ stageId: "mystery", kind: "stage_started", title: "自定义", content: "x", timestamp: 1 }))
    expect(next[0].title).toBe("自定义")
  })
  it("error 事件置 error 并更新摘要", () => {
    const base = [stage({ id: "s", status: "running", startedAt: 1 })]
    const next = applyAgentActivityEvent(base, event({ stageId: "s", kind: "error", content: "炸了", timestamp: 9 }))
    expect(next[0].status).toBe("error")
    expect(next[0].summary).toBe("炸了")
    expect(next[0].finishedAt).toBe(9)
  })
  it("stage_output 置 done 并更新摘要", () => {
    const base = [stage({ id: "s", status: "running", startedAt: 1 })]
    const next = applyAgentActivityEvent(base, event({ stageId: "s", kind: "stage_output", content: "产出", timestamp: 9 }))
    expect(next[0].status).toBe("done")
    expect(next[0].summary).toBe("产出")
    expect(next[0].finishedAt).toBe(9)
  })
  it("终态阶段不再被普通事件改写状态", () => {
    const base = [stage({ id: "s", status: "done" })]
    const next = applyAgentActivityEvent(base, event({ stageId: "s", kind: "tool_call", content: "后续", timestamp: 9 }))
    expect(next[0].status).toBe("done")
    expect(next[0].summary).toBe("summary-s")
  })
  it("tool_call 命中确认词进入 approval_required", () => {
    const base = [stage({ id: "s", status: "running" })]
    const next = applyAgentActivityEvent(base, event({ stageId: "s", kind: "tool_call", content: "需要确认后才能保存", timestamp: 9 }))
    expect(next[0].status).toBe("approval_required")
    expect(next[0].finishedAt).toBeUndefined()
  })
  it("final_output 覆盖 cancelled 为 done", () => {
    const base = [stage({ id: "s", status: "cancelled" })]
    const next = applyAgentActivityEvent(base, event({ stageId: "s", kind: "final_output", content: "终稿", timestamp: 9 }))
    expect(next[0].status).toBe("done")
    expect(next[0].summary).toBe("终稿")
  })
})

describe("stage_started 连带结算", () => {
  it("新阶段启动时结算其他 running/pending 顺序阶段", () => {
    const stages = [
      stage({ id: "read_context", status: "running", startedAt: 1 }),
      stage({ id: "chapter_workflow", status: "running", startedAt: 1 }),
      stage({ id: "final_output", status: "done", startedAt: 1 }),
    ]
    const next = applyAgentActivityEvent(stages, event({ stageId: "generate_draft", kind: "stage_started", content: "开写", timestamp: 50 }))
    expect(next.find((s) => s.id === "read_context")!.status).toBe("done")
    expect(next.find((s) => s.id === "read_context")!.finishedAt).toBe(50)
    expect(next.find((s) => s.id === "chapter_workflow")!.status).toBe("running")
    expect(next.find((s) => s.id === "final_output")!.status).toBe("done")
    expect(next.find((s) => s.id === "generate_draft")).toBeDefined()
  })
  it("同 id 阶段不被自己结算", () => {
    const stages = [stage({ id: "a", status: "running", startedAt: 1 }), stage({ id: "b", status: "running", startedAt: 1 })]
    const next = applyAgentActivityEvent(stages, event({ stageId: "a", kind: "stage_started", content: "再进A", timestamp: 50 }))
    expect(next.find((s) => s.id === "a")!.status).toBe("running")
    expect(next.find((s) => s.id === "b")!.status).toBe("done")
  })
  it("被结算的空摘要阶段从事件汇总", () => {
    const stages = [stage({ id: "a", status: "running", summary: "", events: [event({ stageId: "a", content: "进展中", timestamp: 2 })] })]
    const next = applyAgentActivityEvent(stages, event({ stageId: "b", kind: "stage_started", content: "进B", timestamp: 50 }))
    expect(next.find((s) => s.id === "a")!.summary).toBe("进展中")
  })
  it("非 stage_started 事件不结算其他阶段", () => {
    const stages = [stage({ id: "a", status: "running" })]
    const next = applyAgentActivityEvent(stages, event({ stageId: "b", kind: "tool_call", content: "x", timestamp: 5 }))
    expect(next.find((s) => s.id === "a")!.status).toBe("running")
  })
})

describe("summarizeAgentStage", () => {
  it("优先取最新输出事件并截断 90 字", () => {
    const s = stage({
      id: "s",
      events: [
        event({ stageId: "s", kind: "stage_output", content: "旧", timestamp: 1 }),
        event({ stageId: "s", kind: "final_output", content: `新${"y".repeat(200)}`, timestamp: 2 }),
      ],
    })
    const summary = summarizeAgentStage(s)
    expect(summary).toBe(`${`新${"y".repeat(200)}`.slice(0, 90)}...`)
  })
  it("空内容输出事件被跳过取后备", () => {
    const s = stage({
      id: "s",
      events: [
        event({ stageId: "s", kind: "tool_call", content: "后备", timestamp: 1 }),
        { ...event({ stageId: "s", kind: "stage_output", timestamp: 2 }), content: "" },
      ],
    })
    expect(summarizeAgentStage(s)).toBe("后备")
  })
  it("无输出事件时取最后一条有内容事件", () => {
    const s = stage({
      id: "s",
      events: [event({ stageId: "s", kind: "tool_call", content: "  第一   条  ", timestamp: 1 })],
    })
    expect(summarizeAgentStage(s)).toBe("第一 条")
  })
  it("无事件时回落 stage.summary，再回落占位", () => {
    expect(summarizeAgentStage(stage({ id: "s", summary: "已有摘要" }))).toBe("已有摘要")
    expect(summarizeAgentStage(stage({ id: "s", summary: "" }))).toBe("本阶段暂无摘要。")
  })
})

describe("getDefaultOpenAgentStageId", () => {
  it("优先级 running > approval > error", () => {
    const stages = [
      stage({ id: "e", status: "error", startedAt: 1 }),
      stage({ id: "a", status: "approval_required", startedAt: 1 }),
      stage({ id: "r", status: "running", startedAt: 1 }),
    ]
    expect(getDefaultOpenAgentStageId(stages)).toBe("r")
    expect(getDefaultOpenAgentStageId(stages.filter((s) => s.id !== "r"))).toBe("a")
    expect(getDefaultOpenAgentStageId(stages.filter((s) => s.id === "e"))).toBe("e")
  })
  it("无时间戳时按事件时间取最近，全无时取靠后", () => {
    const withEvents = stage({ id: "w", status: "error", events: [event({ stageId: "w", content: "x", timestamp: 5 })] })
    const bare = stage({ id: "n", status: "error" })
    expect(getDefaultOpenAgentStageId([bare, withEvents])).toBe("w")
    expect(getDefaultOpenAgentStageId([bare, stage({ id: "m", status: "error" })])).toBe("m")
  })
  it("靠前已是最近时保留靠前", () => {
    const stages = [stage({ id: "new", status: "running", startedAt: 9 }), stage({ id: "old", status: "running", startedAt: 1 })]
    expect(getDefaultOpenAgentStageId(stages)).toBe("new")
  })
  it("同状态取最近启动；平局取靠后", () => {
    const stages = [
      stage({ id: "old", status: "running", startedAt: 1 }),
      stage({ id: "new", status: "running", startedAt: 5 }),
    ]
    expect(getDefaultOpenAgentStageId(stages)).toBe("new")
    const tied = [stage({ id: "x", status: "error", startedAt: 3 }), stage({ id: "y", status: "error", startedAt: 3 })]
    expect(getDefaultOpenAgentStageId(tied)).toBe("y")
  })
  it("无可展开返回 null", () => {
    expect(getDefaultOpenAgentStageId([stage({ id: "d", status: "done" })])).toBeNull()
    expect(getDefaultOpenAgentStageId([])).toBeNull()
  })
})

describe("prepareAgentStagesForDisplay", () => {
  it("undefined 返回空数组", () => {
    expect(prepareAgentStagesForDisplay(undefined)).toEqual([])
  })
  it("顺序与时间皆相同时保持原序", () => {
    const stages = [stage({ id: "zz-b" }), stage({ id: "zz-a" })]
    expect(prepareAgentStagesForDisplay(stages).map((s) => s.id)).toEqual(["zz-b", "zz-a"])
  })
  it("存在细粒度章节阶段时隐藏聚合 chapter_workflow", () => {
    const stages = [stage({ id: "chapter_workflow" }), stage({ id: "generate_draft" })]
    const visible = prepareAgentStagesForDisplay(stages)
    expect(visible.map((s) => s.id)).toEqual(["generate_draft"])
  })
  it("无细粒度阶段时保留聚合阶段", () => {
    const stages = [stage({ id: "chapter_workflow" }), stage({ id: "react_tools" })]
    expect(prepareAgentStagesForDisplay(stages).map((s) => s.id)).toEqual(["react_tools", "chapter_workflow"])
  })
  it("按展示顺序排，未知 id 沉底并按时间与原序稳定", () => {
    const stages = [
      stage({ id: "final_output", startedAt: 9 }),
      stage({ id: "zzz", startedAt: 1 }),
      stage({ id: "task_understanding", startedAt: 8 }),
      stage({ id: "yyy" }),
    ]
    expect(prepareAgentStagesForDisplay(stages).map((s) => s.id)).toEqual([
      "task_understanding",
      "final_output",
      "zzz",
      "yyy",
    ])
  })
})

describe("settleRunningAgentStages", () => {
  it("undefined 透传", () => {
    expect(settleRunningAgentStages(undefined)).toBeUndefined()
  })
  it("running/pending 被结算，其他状态原样保留", () => {
    const running = stage({ id: "r", status: "running", summary: "", events: [event({ stageId: "r", content: "进展", timestamp: 1 })] })
    const done = stage({ id: "d", status: "done" })
    const next = settleRunningAgentStages([running, done], "cancelled", 99)!
    expect(next[0]).toMatchObject({ status: "cancelled", finishedAt: 99, summary: "进展" })
    expect(next[1]).toBe(done)
  })
  it("默认结算为 done", () => {
    const next = settleRunningAgentStages([stage({ id: "p", status: "pending" })], undefined, 5)!
    expect(next[0].status).toBe("done")
    expect(next[0].finishedAt).toBe(5)
  })
})

describe("activityEventFromToolEvent", () => {
  it("五种状态文案", () => {
    expect(activityEventFromToolEvent(toolEvent({ name: "x", type: "call_started" })).title).toBe("开始调用：x")
    expect(activityEventFromToolEvent(toolEvent({ name: "x", type: "result" })).title).toBe("调用完成：x")
    expect(activityEventFromToolEvent(toolEvent({ name: "x", type: "approval_required" })).title).toBe("等待确认：x")
    expect(activityEventFromToolEvent(toolEvent({ name: "x", type: "cancelled" })).title).toBe("已取消：x")
    expect(activityEventFromToolEvent(toolEvent({ name: "x", type: "error" })).title).toBe("调用失败：x")
  })
  it("kind 推断：skill / mcp / web / read / 默认", () => {
    expect(activityEventFromToolEvent(toolEvent({ name: "apply_skill" })).kind).toBe("skill_used")
    expect(activityEventFromToolEvent(toolEvent({ name: "mcp_proxy" })).kind).toBe("mcp_call")
    expect(activityEventFromToolEvent(toolEvent({ name: "web_search" })).kind).toBe("web_search")
    expect(activityEventFromToolEvent(toolEvent({ name: "search_chapters" })).kind).toBe("web_search")
    expect(activityEventFromToolEvent(toolEvent({ name: "read_chapter" })).kind).toBe("read_source")
    expect(activityEventFromToolEvent(toolEvent({ name: "write_chapter" })).kind).toBe("tool_call")
  })
  it("stageId 推断全分支", () => {
    const ids: [string, string][] = [
      ["web_search", "external_search"],
      ["read_web_page", "external_search"],
      ["summarize_search_results", "external_search"],
      ["read_chapter", "read_context"],
      ["chapter_context", "read_context"],
      ["apply_skill", "capability_selection"],
      ["search_chapters", "external_search"],
      ["run_chapter_workflow", "chapter_workflow"],
      ["chapter_draft", "chapter_workflow"],
      ["write_chapter", "write_confirmation"],
      ["save_doc", "write_confirmation"],
      ["modify_doc", "write_confirmation"],
      ["route_task", "react_tools"],
    ]
    for (const [name, stageId] of ids) {
      expect(activityEventFromToolEvent(toolEvent({ name })).stageId, name).toBe(stageId)
    }
  })
  it("content 优先级：result 展示 > preview > params", () => {
    const display = activityEventFromToolEvent(
      toolEvent({ name: "web_search", result: JSON.stringify({ content: "摘要", items: [] }), preview: "p", params: { q: "1" } }),
    )
    expect(display.content).toBe("摘要")
    const preview = activityEventFromToolEvent(toolEvent({ name: "x", preview: "预", params: { q: "1" } }))
    expect(preview.content).toBe("预")
    const params = activityEventFromToolEvent(toolEvent({ name: "x", params: { q: "1" } }))
    expect(params.content).toBe("q: 1")
    const empty = activityEventFromToolEvent(toolEvent({ name: "x" }))
    expect(empty.content).toBe("已调用工具。")
  })
  it("id/toolCallId/时间戳透传", () => {
    const ev = activityEventFromToolEvent(toolEvent({ name: "x", callId: "cc", timestamp: 77 }))
    expect(ev.id).toBe("tool:cc:result:77")
    expect(ev.toolCallId).toBe("cc")
    expect(ev.timestamp).toBe(77)
  })
  it("params.sources 字符串数组 → web refs", () => {
    const ev = activityEventFromToolEvent(toolEvent({ name: "web_search", params: { sources: ["指南 https://example.com/a"] } }))
    expect(ev.sourceRefs).toEqual([{ title: "指南", path: "https://example.com/a", type: "web" }])
  })
  it("params.sources 优先于 result", () => {
    const ev = activityEventFromToolEvent(
      toolEvent({
        name: "web_search",
        params: { sources: ["A https://a.com"] },
        result: JSON.stringify({ results: [{ url: "https://b.com", title: "B" }] }),
      }),
    )
    expect(ev.sourceRefs).toEqual([{ title: "A", path: "https://a.com", type: "web" }])
  })
  it("params.sources 非数组时忽略并看 result", () => {
    const ev = activityEventFromToolEvent(toolEvent({ name: "web_search", params: { sources: "x" }, result: "not json" }))
    expect(ev.sourceRefs).toBeUndefined()
  })
  it("result JSON results 数组 → web refs", () => {
    const ev = activityEventFromToolEvent(
      toolEvent({ name: "web_search", result: JSON.stringify({ results: [{ url: "https://example.com/b", title: "B" }] }) }),
    )
    expect(ev.sourceRefs).toEqual([{ title: "B", path: "https://example.com/b", type: "web" }])
  })
  it("result results 无有效 ref 时继续向下找", () => {
    const ev = activityEventFromToolEvent(
      toolEvent({ name: "web_search", result: JSON.stringify({ results: [{}, null, "s", { url: 5, title: 6 }] }) }),
    )
    expect(ev.sourceRefs).toBeUndefined()
  })
  it("result results 混合条目只收有效", () => {
    const ev = activityEventFromToolEvent(
      toolEvent({ name: "web_search", result: JSON.stringify({ results: [null, "s", {}, { url: "https://u", title: "T" }] }) }),
    )
    expect(ev.sourceRefs).toEqual([{ title: "T", path: "https://u", type: "web" }])
  })
  it("result items 内 results 展平，脏条目跳过", () => {
    const ev = activityEventFromToolEvent(
      toolEvent({
        name: "web_search",
        result: JSON.stringify({ items: [{ results: [{ url: "https://u1", title: "T1" }, {}, null] }, { results: "x" }, null, 5] }),
      }),
    )
    expect(ev.sourceRefs).toEqual([{ title: "T1", path: "https://u1", type: "web" }])
  })
  it("result 仅 url 时标题回落 url", () => {
    const ev = activityEventFromToolEvent(toolEvent({ name: "web_search", result: JSON.stringify({ url: "https://solo.com" }) }))
    expect(ev.sourceRefs).toEqual([{ title: "https://solo.com", path: "https://solo.com", type: "web" }])
  })
  it("result results 非数组时跳过该分支", () => {
    const ev = activityEventFromToolEvent(toolEvent({ name: "web_search", result: JSON.stringify({ results: "nope" }) }))
    expect(ev.sourceRefs).toBeUndefined()
  })
  it("result results 内 url-only/title-only 条目", () => {
    const ev = activityEventFromToolEvent(
      toolEvent({ name: "web_search", result: JSON.stringify({ results: [{ url: "https://u" }, { title: "T" }] }) }),
    )
    expect(ev.sourceRefs).toEqual([
      { title: "https://u", path: "https://u", type: "web" },
      { title: "T", path: undefined, type: "web" },
    ])
  })
  it("result 单 url/title → 单 ref；两者皆无 → undefined", () => {
    const one = activityEventFromToolEvent(
      toolEvent({ name: "web_search", result: JSON.stringify({ url: "https://u", title: "T" }) }),
    )
    expect(one.sourceRefs).toEqual([{ title: "T", path: "https://u", type: "web" }])
    const titleOnly = activityEventFromToolEvent(toolEvent({ name: "web_search", result: JSON.stringify({ title: "T" }) }))
    expect(titleOnly.sourceRefs).toEqual([{ title: "T", path: undefined, type: "web" }])
    const none = activityEventFromToolEvent(toolEvent({ name: "web_search", result: JSON.stringify({ other: 1 }) }))
    expect(none.sourceRefs).toBeUndefined()
  })
  it("垃圾 result → sourceRefs undefined（不崩）", () => {
    expect(activityEventFromToolEvent(toolEvent({ name: "web_search", result: "not json at all" })).sourceRefs).toBeUndefined()
  })
  it("result 数组 JSON → sourceRefs undefined（非对象守卫）", () => {
    expect(activityEventFromToolEvent(toolEvent({ name: "web_search", result: "[1,2]" })).sourceRefs).toBeUndefined()
  })
  it("sources 对象条目：url/path/type 语义", () => {
    const ev = activityEventFromToolEvent(
      toolEvent({
        name: "web_search",
        params: {
          sources: [
            "标题 — https://example.com/em",
            "https://bare.com/x",
            "纯文本标签",
            { title: "T", path: "/p", type: "file" },
            { url: "https://only-url.com" },
            { title: "", path: "" },
            "",
            42,
          ],
        },
      }),
    )
    expect(ev.sourceRefs).toEqual([
      { title: "标题", path: "https://example.com/em", type: "web" },
      { title: "https://bare.com/x", path: "https://bare.com/x", type: "web" },
      { title: "纯文本标签", path: undefined, type: "web" },
      { title: "T", path: "/p", type: "file" },
      { title: "https://only-url.com", path: "https://only-url.com", type: "web" },
    ])
  })
  it("path 兜底标题、无 title/path 跳过", () => {
    const ev = activityEventFromToolEvent(
      toolEvent({ name: "web_search", params: { sources: [{ path: "/p/only" }, { foo: 1 }, { title: "", path: "" }] } }),
    )
    expect(ev.sourceRefs).toEqual([{ title: "/p/only", path: "/p/only", type: "web" }])
  })
  it("前导分隔符标题保留原样（trim 后 match[1] 非空）", () => {
    const ev = activityEventFromToolEvent(toolEvent({ name: "web_search", params: { sources: [" — https://e.com/x"] } }))
    expect(ev.sourceRefs).toEqual([{ title: "—", path: "https://e.com/x", type: "web" }])
  })
  it("纯标题对象 path 为 undefined", () => {
    const ev = activityEventFromToolEvent(toolEvent({ name: "web_search", params: { sources: [{ title: "纯标题" }] } }))
    expect(ev.sourceRefs).toEqual([{ title: "纯标题", path: undefined, type: "web" }])
  })
  it("连字符分隔标签解析", () => {
    const ev = activityEventFromToolEvent(toolEvent({ name: "web_search", params: { sources: ["A - https://a.com"] } }))
    expect(ev.sourceRefs).toEqual([{ title: "A", path: "https://a.com", type: "web" }])
  })
})

describe("resolveAgentStageTitle", () => {
  it("已知 id 返回中文", () => {
    expect(resolveAgentStageTitle("task_understanding")).toBe("任务理解")
    expect(resolveAgentStageTitle("final_output")).toBe("最终输出")
    expect(resolveAgentStageTitle("react_tools")).toBe("工具调用")
  })
  it("未知 id 用 fallback，再用 id 本身", () => {
    expect(resolveAgentStageTitle("mystery", "回落")).toBe("回落")
    expect(resolveAgentStageTitle("mystery")).toBe("mystery")
  })
})

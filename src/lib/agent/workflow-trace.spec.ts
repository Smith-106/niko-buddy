import { describe, expect, it } from "vitest"
import {
  buildAgentWorkflowSteps,
  getWorkflowToolDescription,
  getWorkflowToolResultDisplay,
  isWebResearchToolName,
  type WorkflowToolCall,
} from "./workflow-trace"
import type { ContextTrace, TraceContextInfo } from "./context-trace"

function call(partial: Partial<WorkflowToolCall> & { name: string }): WorkflowToolCall {
  return {
    id: `c-${partial.name}`,
    params: {},
    status: "done",
    startedAt: 1000,
    ...partial,
  }
}

function traceCall(partial: Partial<ContextTrace["toolCalls"][number]> & { name: string }) {
  return {
    id: `t-${partial.name}`,
    category: "read" as const,
    params: {},
    status: "done" as const,
    startedAt: 1000,
    ...partial,
  }
}

const BASE_INFO: TraceContextInfo = {
  intent: "write_chapter",
  confidence: 0.86,
  routeSource: "default",
  loadedSources: [],
  blockedSources: [],
  retrievalHits: [],
  trimmedSections: [],
}

function contextTrace(partial: Partial<ContextTrace> = {}): ContextTrace {
  return {
    id: "ctx-1",
    startedAt: 500,
    toolCalls: [],
    status: "done",
    ...partial,
  } as ContextTrace
}

describe("isWebResearchToolName", () => {
  it("命中集合返回 true", () => {
    expect(isWebResearchToolName("web_search")).toBe(true)
    expect(isWebResearchToolName("read_web_page")).toBe(true)
    expect(isWebResearchToolName("summarize_search_results")).toBe(true)
  })
  it("集合外返回 false", () => {
    expect(isWebResearchToolName("read_chapter")).toBe(false)
    expect(isWebResearchToolName("")).toBe(false)
  })
})

describe("getWorkflowToolResultDisplay", () => {
  it("undefined 返回空串", () => {
    expect(getWorkflowToolResultDisplay(undefined)).toBe("")
  })
  it("content + items 数组时返回 content", () => {
    const raw = JSON.stringify({ content: "  精选摘要  ", items: [{ a: 1 }] })
    expect(getWorkflowToolResultDisplay(raw)).toBe("精选摘要")
  })
  it("content + searchedNames 数组时返回 content", () => {
    const raw = JSON.stringify({ content: "人名结果", searchedNames: ["a"] })
    expect(getWorkflowToolResultDisplay(raw)).toBe("人名结果")
  })
  it("content 为空时回落原文", () => {
    const raw = JSON.stringify({ content: "   ", items: [] })
    expect(getWorkflowToolResultDisplay(raw)).toBe(raw)
  })
  it("无 items/searchedNames 时回落原文", () => {
    const raw = JSON.stringify({ content: "只有正文" })
    expect(getWorkflowToolResultDisplay(raw)).toBe(raw)
  })
  it("数组 JSON 回落原文", () => {
    expect(getWorkflowToolResultDisplay("[1,2]")).toBe("[1,2]")
  })
  it("非法 JSON 回落 trim 原文", () => {
    expect(getWorkflowToolResultDisplay("  plain text  ")).toBe("plain text")
  })
  it("空串返回空串", () => {
    expect(getWorkflowToolResultDisplay("   ")).toBe("")
  })
})

describe("getWorkflowToolDescription", () => {
  const cases: { name: string; params?: Record<string, unknown>; expected: string }[] = [
    { name: "read_chapter", params: { name: "a\\b\\第一章.md" }, expected: "读取章节《第一章.md》" },
    { name: "read_chapter", params: {}, expected: "读取章节" },
    { name: "read_outline", params: { title: "大纲/主线.json" }, expected: "读取大纲《主线.json》" },
    { name: "read_outline", expected: "读取大纲" },
    { name: "read_memory", params: { path: "mem/人物.md" }, expected: "读取记忆「人物.md」" },
    { name: "read_memory", expected: "读取记忆" },
    { name: "read_deduction", params: { name: "推演1" }, expected: "读取推演「推演1」" },
    { name: "read_deduction", expected: "读取推演" },
    { name: "read_chat_history", params: { conversationTitle: "会话A" }, expected: "读取 AI 会话「会话A」" },
    { name: "read_chat_history", params: {}, expected: "读取 AI 会话" },
    { name: "read_outline_history", params: { conversationId: "conv-9" }, expected: "读取 AI 大纲「conv-9」" },
    { name: "read_outline_history", expected: "读取 AI 大纲" },
    { name: "search_chapters", params: { keyword: "伏笔" }, expected: "搜索章节关键词「伏笔」" },
    { name: "search_chapters", params: { query: "  " }, expected: "搜索章节资料" },
    { name: "summarize_search_results", params: { query: " AI " }, expected: "整理「AI」的搜索摘要" },
    { name: "summarize_search_results", expected: "整理搜索结果摘要" },
    { name: "list_chapters", expected: "整理资料范围" },
    { name: "list_outlines", expected: "整理资料范围" },
    { name: "list_memories", expected: "整理资料范围" },
    { name: "list_deductions", expected: "整理资料范围" },
    { name: "write_chapter", params: { name: "草稿\\新章.md" }, expected: "生成章节写入草稿《新章.md》" },
    { name: "write_chapter", expected: "生成章节写入草稿" },
    { name: "write_outline_node", params: { nodeTitle: "节点", outlineName: "主线" }, expected: "生成大纲节点写入草稿「节点」到「主线」" },
    { name: "write_outline_node", params: { nodeTitle: "节点" }, expected: "生成大纲节点写入草稿「节点」" },
    { name: "write_outline_node", expected: "生成大纲节点写入草稿" },
    { name: "write_memory", params: { title: "记忆点" }, expected: "生成记忆写入草稿「记忆点」" },
    { name: "write_memory", expected: "生成记忆写入草稿" },
    { name: "apply_skill", params: { skillName: "去AI味" }, expected: "应用技能「去AI味」" },
    { name: "apply_skill", params: {}, expected: "应用写作技能" },
    { name: "route_task", expected: "识别任务意图" },
    { name: "load_context", expected: "加载小说上下文" },
    { name: "trim_context", expected: "整理上下文长度" },
    { name: "run_chapter_workflow", expected: "运行章节工作流" },
    { name: "chapter_context", expected: "读取章节上下文" },
    { name: "chapter_previous_analysis", expected: "分析前情章节" },
    { name: "chapter_task_brief", expected: "生成写作任务书" },
    { name: "chapter_draft", expected: "生成章节正文初稿" },
    { name: "chapter_expansion", expected: "正文扩写补足" },
    { name: "chapter_review", expected: "执行 AI 审稿" },
    { name: "chapter_revision", expected: "自动返修章节正文" },
    { name: "chapter_post_revision_review", expected: "返修后角色一致性复审" },
    { name: "chapter_final_polish", expected: "简单审查与去AI味" },
    { name: "chapter_execution_report", expected: "检查章节执行清单" },
    { name: "chapter_execution_repair", expected: "返修执行清单失败项" },
    { name: "chapter_execution_recheck", expected: "复检章节执行清单" },
    { name: "chapter_plan_compliance", expected: "检查章节计划履约度" },
    { name: "chapter_plan_deviation_repair", expected: "返修章节计划偏离点" },
    { name: "chapter_plan_deviation_recheck", expected: "复检章节计划履约度" },
    { name: "chapter_complete", expected: "完成多任务写作循环" },
    { name: "some_unknown_tool", expected: "some_unknown_tool" },
  ]
  for (const { name, params, expected } of cases) {
    it(`${name} ${JSON.stringify(params ?? {})} → ${expected}`, () => {
      expect(getWorkflowToolDescription(call({ name, params: params ?? {} }))).toBe(expected)
    })
  }
  it("数字参数转字符串", () => {
    expect(getWorkflowToolDescription(call({ name: "read_chapter", params: { name: 42 } }))).toBe(
      "读取章节《42》",
    )
  })
  it("空白字符串参数被跳过", () => {
    expect(
      getWorkflowToolDescription(call({ name: "read_chapter", params: { name: "   ", title: "T" } })),
    ).toBe("读取章节《T》")
  })
  it("全斜杠路径回落原文", () => {
    expect(getWorkflowToolDescription(call({ name: "read_memory", params: { path: "///" } }))).toBe(
      "读取记忆「///」",
    )
  })
  it("末尾斜杠路径取最后一段", () => {
    expect(getWorkflowToolDescription(call({ name: "read_memory", params: { path: "a/b/" } }))).toBe(
      "读取记忆「b」",
    )
  })
})

describe("web_search 描述分支", () => {
  it("失败：query + message", () => {
    const c = call({
      name: "web_search",
      status: "error",
      params: { query: "ai" },
      result: JSON.stringify({ status: "error", message: "timeout  x   y" }),
    })
    expect(getWorkflowToolDescription(c)).toBe("联网搜索「ai」失败：timeout x y")
  })
  it("失败：仅 query（parsed 状态 error）", () => {
    const c = call({
      name: "web_search",
      params: { query: "ai" },
      result: JSON.stringify({ status: "error" }),
    })
    expect(getWorkflowToolDescription(c)).toBe("联网搜索「ai」失败")
  })
  it("失败：仅 message", () => {
    const c = call({
      name: "web_search",
      status: "error",
      params: {},
      result: JSON.stringify({ status: "error", message: "boom" }),
    })
    expect(getWorkflowToolDescription(c)).toBe("联网搜索失败：boom")
  })
  it("失败：无 query 无 message", () => {
    const c = call({ name: "web_search", status: "error", params: {}, result: "{}" })
    expect(getWorkflowToolDescription(c)).toBe("联网搜索失败")
  })
  it("未配置：有 query / 无 query", () => {
    expect(
      getWorkflowToolDescription(
        call({ name: "web_search", params: { query: "q" }, result: JSON.stringify({ status: "not_configured" }) }),
      ),
    ).toBe("联网搜索「q」未执行：未配置外部搜索")
    expect(
      getWorkflowToolDescription(
        call({ name: "web_search", params: {}, result: JSON.stringify({ status: "not_configured" }) }),
      ),
    ).toBe("联网搜索未执行：未配置外部搜索")
  })
  it("成功：query + resultCount", () => {
    expect(
      getWorkflowToolDescription(
        call({ name: "web_search", params: { query: "ai" }, result: JSON.stringify({ resultCount: 7 }) }),
      ),
    ).toBe("联网搜索「ai」（7 条来源）")
  })
  it("成功：items 内 results 计数", () => {
    const raw = JSON.stringify({ items: [{ results: [1, 2] }, { results: [] }, {}, null, 5, { results: "x" }] })
    expect(getWorkflowToolDescription(call({ name: "web_search", params: { query: "q" }, result: raw }))).toBe(
      "联网搜索「q」（2 条来源）",
    )
  })
  it("成功：仅 query", () => {
    expect(getWorkflowToolDescription(call({ name: "web_search", params: { query: "q" }, result: "{}" }))).toBe(
      "联网搜索「q」",
    )
  })
  it("成功：仅条数", () => {
    expect(
      getWorkflowToolDescription(call({ name: "web_search", params: {}, result: JSON.stringify({ resultCount: 3 }) })),
    ).toBe("联网搜索（3 条来源）")
  })
  it("成功：无 query 无条数", () => {
    expect(getWorkflowToolDescription(call({ name: "web_search", params: {}, result: "oops" }))).toBe("联网搜索")
  })
  it("长 message 被截断", () => {
    const long = `m${"x".repeat(100)}`
    const c = call({
      name: "web_search",
      status: "error",
      params: { query: "q" },
      result: JSON.stringify({ status: "error", message: long }),
    })
    const text = getWorkflowToolDescription(c)
    expect(text.endsWith("…")).toBe(true)
    expect(text.length).toBeLessThan(`联网搜索「q」失败：${long}`.length)
  })
})

describe("read_web_page 描述分支", () => {
  it("成功：优先用页面标题", () => {
    expect(
      getWorkflowToolDescription(
        call({ name: "read_web_page", params: { url: "https://example.com/a" }, result: JSON.stringify({ title: " T " }) }),
      ),
    ).toBe("读取网页「T」")
  })
  it("成功：无标题时用短链接（去 www、去尾斜杠）", () => {
    expect(
      getWorkflowToolDescription(
        call({ name: "read_web_page", params: { url: "https://www.example.com/a/b/" }, result: "{}" }),
      ),
    ).toBe("读取网页「example.com/a/b」")
  })
  it("成功：根路径只保留 host", () => {
    expect(
      getWorkflowToolDescription(call({ name: "read_web_page", params: { url: "https://example.com/" }, result: "{}" })),
    ).toBe("读取网页「example.com」")
  })
  it("成功：非法 url 回落原文", () => {
    expect(
      getWorkflowToolDescription(call({ name: "read_web_page", params: { url: "nota-url" }, result: "{}" })),
    ).toBe("读取网页「nota-url」")
  })
  it("成功：无 url 无标题", () => {
    expect(getWorkflowToolDescription(call({ name: "read_web_page", params: {}, result: "{}" }))).toBe("读取网页")
  })
  it("失败：label + message", () => {
    const c = call({
      name: "read_web_page",
      status: "error",
      params: { url: "https://example.com/a" },
      result: JSON.stringify({ status: "error", message: "  404   not found  " }),
    })
    expect(getWorkflowToolDescription(c)).toBe("读取网页「example.com/a」失败：404 not found")
  })
  it("失败：仅 label", () => {
    const c = call({
      name: "read_web_page",
      params: { url: "https://example.com/a" },
      result: JSON.stringify({ status: "error" }),
    })
    expect(getWorkflowToolDescription(c)).toBe("读取网页「example.com/a」失败")
  })
  it("失败：仅 message", () => {
    const c = call({
      name: "read_web_page",
      status: "error",
      params: {},
      result: JSON.stringify({ status: "error", message: "boom" }),
    })
    expect(getWorkflowToolDescription(c)).toBe("读取网页失败：boom")
  })
  it("失败：两者皆无", () => {
    const c = call({ name: "read_web_page", status: "error", params: {}, result: "{}" })
    expect(getWorkflowToolDescription(c)).toBe("读取网页失败")
  })
})

describe("buildAgentWorkflowSteps", () => {
  it("无调用且无 contextInfo 返回空数组", () => {
    expect(buildAgentWorkflowSteps({})).toEqual([])
    expect(buildAgentWorkflowSteps({ toolCalls: [] })).toEqual([])
  })
  it("有 contextInfo 即使无调用也生成 6 步", () => {
    const steps = buildAgentWorkflowSteps({ contextTrace: contextTrace({ contextInfo: { ...BASE_INFO } }) })
    expect(steps.map((s) => s.id)).toEqual(["intent", "skill", "context", "tool", "decision", "validation"])
  })
  it("优先使用显式 toolCalls；contextTrace 兜底映射 result/error", () => {
    const steps = buildAgentWorkflowSteps({
      contextTrace: contextTrace({
        toolCalls: [
          traceCall({ name: "read_chapter", params: { name: "A" }, error: "E1" }),
          traceCall({ name: "read_outline", params: { name: "B" } }),
        ],
      }),
    })
    const ctx = steps.find((s) => s.id === "context")!
    expect(ctx.details.map((d) => d.value)).toContain("读取章节《A》")
    expect(steps.find((s) => s.id === "tool")!.status).toBe("done")
  })
  it("显式 toolCalls 非空时直接使用", () => {
    const steps = buildAgentWorkflowSteps({ toolCalls: [call({ name: "route_task", params: { intent: "general_chat" } })] })
    expect(steps.find((s) => s.id === "intent")!.summary).toContain("普通问答")
  })
  it("未知 intent 透传原文", () => {
    const steps = buildAgentWorkflowSteps({ toolCalls: [call({ name: "route_task", params: { intent: "custom_flow" } })] })
    expect(steps.find((s) => s.id === "intent")!.summary).toContain("custom_flow")
  })
  it("intent：无 route、无 info → pending 等待判断", () => {
    const steps = buildAgentWorkflowSteps({ toolCalls: [call({ name: "read_chapter" })] })
    const intent = steps.find((s) => s.id === "intent")!
    expect(intent.status).toBe("pending")
    expect(intent.summary).toContain("正在根据用户输入判断任务目标")
    expect(intent.details).toEqual([{ label: "任务意图", value: "等待模型判断" }])
    expect(intent.startedAt).toBeUndefined()
  })
  it("intent：info 含置信度与路由来源", () => {
    const steps = buildAgentWorkflowSteps({
      contextTrace: contextTrace({ startedAt: 111, contextInfo: { ...BASE_INFO } }),
    })
    const intent = steps.find((s) => s.id === "intent")!
    expect(intent.status).toBe("done")
    expect(intent.summary).toBe("识别为“生成小说章节”，按该目标准备资料和输出格式。")
    expect(intent.details).toEqual([
      { label: "任务意图", value: "生成小说章节", tone: "success" },
      { label: "置信度", value: "86%" },
      { label: "路由来源", value: "default" },
    ])
    expect(intent.startedAt).toBe(111)
  })
  it("intent：route 调用决定状态与时间", () => {
    const steps = buildAgentWorkflowSteps({
      toolCalls: [call({ name: "route_task", status: "running", startedAt: 5, finishedAt: 9, params: {} })],
    })
    const intent = steps.find((s) => s.id === "intent")!
    expect(intent.status).toBe("running")
    expect(intent.startedAt).toBe(5)
    expect(intent.finishedAt).toBe(9)
  })
  it("skill：无技能调用给 muted 占位", () => {
    const steps = buildAgentWorkflowSteps({ toolCalls: [call({ name: "read_chapter" })] })
    const skill = steps.find((s) => s.id === "skill")!
    expect(skill.status).toBe("done")
    expect(skill.summary).toBe("本轮未调用专用技能。")
    expect(skill.details).toEqual([{ label: "技能", value: "未调用专用技能", tone: "muted" }])
    expect(skill.startedAt).toBeUndefined()
    expect(skill.finishedAt).toBeUndefined()
  })
  it("skill：去重并标记失败 tone", () => {
    const dup = { name: "apply_skill", params: { skillName: "S" }, startedAt: 10, finishedAt: 20 }
    const steps = buildAgentWorkflowSteps({
      toolCalls: [call({ ...dup, id: "a" }), call({ ...dup, id: "b" }), call({ name: "apply_skill", status: "error", params: { skillName: "坏" }, startedAt: 1, finishedAt: 2 })],
    })
    const skill = steps.find((s) => s.id === "skill")!
    expect(skill.status).toBe("error")
    expect(skill.summary).toBe("已应用 2 个写作技能约束。")
    expect(skill.details).toEqual([
      { label: "使用技能", value: "应用技能「S」", tone: "success" },
      { label: "使用技能", value: "应用技能「坏」", tone: "error" },
    ])
    expect(skill.startedAt).toBe(1)
    expect(skill.finishedAt).toBe(20)
  })
  it("context：空记录给 muted 占位", () => {
    const steps = buildAgentWorkflowSteps({ toolCalls: [call({ name: "route_task" })] })
    const ctx = steps.find((s) => s.id === "context")!
    expect(ctx.summary).toBe("未加载额外资料。")
    expect(ctx.details).toEqual([{ label: "上下文", value: "没有需要展开的读取记录", tone: "muted" }])
  })
  it("context：running 中调用优先展示正在处理", () => {
    const steps = buildAgentWorkflowSteps({
      toolCalls: [
        call({ name: "list_chapters", startedAt: 1 }),
        call({ name: "read_chapter", status: "running", params: { name: "A" }, startedAt: 2 }),
      ],
    })
    const ctx = steps.find((s) => s.id === "context")!
    expect(ctx.status).toBe("running")
    expect(ctx.summary).toBe("正在读取章节《A》。")
    expect(ctx.details[0]).toEqual({ label: "资料范围", value: "已整理 1 类资料范围", tone: "success" })
    expect(ctx.details[1]).toEqual({ label: "正在处理", value: "读取章节《A》", tone: "warning" })
    expect(ctx.startedAt).toBe(1)
  })
  it("context：失败 tone + 预算 + 完成计数", () => {
    const steps = buildAgentWorkflowSteps({
      toolCalls: [
        call({ name: "read_chapter", status: "error", params: { name: "A" }, startedAt: 3, finishedAt: 8 }),
        call({ name: "read_outline", params: { name: "B" }, startedAt: 1, finishedAt: 2 }),
        call({ name: "load_context", startedAt: 4, finishedAt: 5 }),
      ],
      contextTrace: contextTrace({ contextInfo: { ...BASE_INFO, contextBudget: { used: 500, limit: 900 } } }),
    })
    const ctx = steps.find((s) => s.id === "context")!
    expect(ctx.status).toBe("error")
    expect(ctx.summary).toBe("已整理资料范围，并读取 1 项相关内容。")
    expect(ctx.details).toContainEqual({ label: "读取失败", value: "读取章节《A》", tone: "error" })
    expect(ctx.details).toContainEqual({ label: "上下文预算", value: "500 / 900 字符" })
    expect(ctx.details).toContainEqual({ label: "已读取", value: "加载小说上下文", tone: "success" })
    expect(ctx.finishedAt).toBe(8)
  })
  it("context：有详情但无范围无完成时用首条详情作摘要", () => {
    const steps = buildAgentWorkflowSteps({ toolCalls: [call({ name: "trim_context" })] })
    const ctx = steps.find((s) => s.id === "context")!
    expect(ctx.summary).toBe("整理上下文长度")
  })
  it("context：trace running 时空调用也 running", () => {
    const steps = buildAgentWorkflowSteps({ contextTrace: contextTrace({ status: "running", contextInfo: { ...BASE_INFO } }) })
    expect(steps.find((s) => s.id === "context")!.status).toBe("running")
  })
  it("context：过滤 NaN 时间", () => {
    const steps = buildAgentWorkflowSteps({
      toolCalls: [call({ name: "read_chapter", startedAt: Number.NaN }), call({ name: "read_outline", startedAt: 7, finishedAt: 9 })],
    })
    const ctx = steps.find((s) => s.id === "context")!
    expect(ctx.startedAt).toBe(7)
    expect(ctx.finishedAt).toBe(9)
  })
  it("tool：空调用占位", () => {
    const steps = buildAgentWorkflowSteps({ toolCalls: [call({ name: "route_task" }), call({ name: "apply_skill" })] })
    const tool = steps.find((s) => s.id === "tool")!
    expect(tool.summary).toBe("本轮没有工具调用。")
    expect(tool.details).toEqual([{ label: "工具", value: "无工具调用", tone: "muted" }])
  })
  it("tool：计数摘要 + 章节工作流口径 + parentCallId", () => {
    const steps = buildAgentWorkflowSteps({
      toolCalls: [
        call({ name: "read_chapter", id: "p", params: { name: "A" } }),
        call({ name: "write_chapter", parentCallId: "p", status: "approval_required", params: {} }),
        call({ name: "read_outline", status: "error", params: {} }),
      ],
    })
    const tool = steps.find((s) => s.id === "tool")!
    expect(tool.status).toBe("approval_required")
    expect(tool.summary).toBe("章节工作流调用 3 个步骤，1 个完成，1 个等待确认，1 个失败。")
    expect(tool.details).toContainEqual({ label: "等待确认", value: "生成章节写入草稿", tone: "warning" })
    expect(tool.details).toContainEqual({ label: "失败", value: "读取大纲", tone: "error" })
  })
  it("tool：cancelled 状态透出", () => {
    const steps = buildAgentWorkflowSteps({ toolCalls: [call({ name: "read_chapter", status: "cancelled" })] })
    expect(steps.find((s) => s.id === "tool")!.status).toBe("cancelled")
  })
  it("decision：写入待确认分支", () => {
    const steps = buildAgentWorkflowSteps({
      toolCalls: [call({ name: "write_chapter", status: "approval_required", params: {} })],
    })
    const d = steps.find((s) => s.id === "decision")!
    expect(d.summary).toBe("判断本轮涉及写入，必须等待用户确认后才能保存。")
    expect(d.details[1]).toEqual({ label: "写入安全", value: "写入草稿需要用户确认，不自动保存。", tone: "warning" })
  })
  it("decision：协议格式分支", () => {
    const steps = buildAgentWorkflowSteps({
      toolCalls: [call({ name: "read_chapter" })],
      contextTrace: contextTrace({ contextInfo: { ...BASE_INFO, resultProtocol: { type: "chapter", valid: true, warnings: [], errors: [], validatedAt: 1 } } }),
    })
    const d = steps.find((s) => s.id === "decision")!
    expect(d.summary).toBe("判断最终结果应保持“chapter”格式，不把过程分析混入正文。")
    expect(d.details[1]).toEqual({ label: "写入安全", value: "未触发自动写入。", tone: "muted" })
  })
  it("decision：默认分支", () => {
    const steps = buildAgentWorkflowSteps({ toolCalls: [call({ name: "read_chapter" })] })
    expect(steps.find((s) => s.id === "decision")!.summary).toBe(
      "判断最终回复应按用户任务直接输出，过程只保留在折叠面板。",
    )
  })
  it("validation：无协议占位 + trace error 透出", () => {
    const steps = buildAgentWorkflowSteps({
      toolCalls: [call({ name: "read_chapter" })],
      contextTrace: contextTrace({ status: "error" }),
    })
    const v = steps.find((s) => s.id === "validation")!
    expect(v.status).toBe("error")
    expect(v.summary).toBe("结果将按任务类型输出，避免混入过程说明。")
    expect(v.details).toEqual([{ label: "校验", value: "等待最终结果格式校验。", tone: "muted" }])
  })
  it("validation：通过带警告", () => {
    const steps = buildAgentWorkflowSteps({
      toolCalls: [call({ name: "read_chapter" })],
      contextTrace: contextTrace({
        contextInfo: {
          ...BASE_INFO,
          resultProtocol: { type: "outline", valid: true, warnings: ["w1"], errors: [], validatedAt: 321 },
        },
      }),
    })
    const v = steps.find((s) => s.id === "validation")!
    expect(v.status).toBe("done")
    expect(v.summary).toBe("结果已按“outline”格式校验。")
    expect(v.details).toContainEqual({ label: "期望类型", value: "outline" })
    expect(v.details).toContainEqual({ label: "校验结果", value: "通过", tone: "success" })
    expect(v.details).toContainEqual({ label: "警告", value: "w1", tone: "warning" })
    expect(v.finishedAt).toBe(321)
  })
  it("validation：协议缺 warnings/errors 数组时不崩", () => {
    const bare = { type: "chapter", valid: true, validatedAt: 2 } as unknown as {
      type: "chapter"
      valid: boolean
      validatedAt: number
    }
    const steps = buildAgentWorkflowSteps({
      toolCalls: [call({ name: "read_chapter" })],
      contextTrace: contextTrace({ contextInfo: { ...BASE_INFO, resultProtocol: bare as never } }),
    })
    const v = steps.find((s) => s.id === "validation")!
    expect(v.status).toBe("done")
    expect(v.details).toEqual([
      { label: "期望类型", value: "chapter" },
      { label: "校验结果", value: "通过", tone: "success" },
    ])
  })
  it("validation：未通过带错误", () => {
    const steps = buildAgentWorkflowSteps({
      toolCalls: [call({ name: "read_chapter" })],
      contextTrace: contextTrace({
        contextInfo: {
          ...BASE_INFO,
          resultProtocol: { type: "memory", valid: false, warnings: [], errors: ["e1"], validatedAt: 9 },
        },
      }),
    })
    const v = steps.find((s) => s.id === "validation")!
    expect(v.status).toBe("error")
    expect(v.summary).toBe("结果未通过“memory”格式校验。")
    expect(v.details).toContainEqual({ label: "校验结果", value: "未通过", tone: "error" })
    expect(v.details).toContainEqual({ label: "错误", value: "e1", tone: "error" })
  })
})

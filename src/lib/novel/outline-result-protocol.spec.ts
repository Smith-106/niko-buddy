import { describe, expect, it } from "vitest"
import {
  coerceOutlineSubAgentResult,
  parseOutlineSubAgentResult,
} from "./outline-result-protocol"

function validPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    agent_id: "agent-1",
    agent_name: "世界观Agent",
    stage: "worldview",
    used_skills: ["skill-a", 42, null],
    confidence: 0.9,
    summary: "已定稿世界观。",
    content_markdown: "# 世界观\n\n正文内容。",
    constraints: ["保持黑暗基调", 7],
    writeback_items: [
      { type: "角色", name: "林川", content: "复仇者", target_folder: "roles" },
      "not-an-object",
      { type: "地点", name: "苏晚城", content: "边塞", targetFolder: "places" },
      { type: "裸条目", name: "n", content: "c" },
    ],
    risks: ["战力膨胀"],
    questions: ["是否保留支线？", 9],
    ...overrides,
  })
}

describe("parseOutlineSubAgentResult", () => {
  it("解析纯 JSON 并映射 snake_case、过滤非字符串数组项", () => {
    const result = parseOutlineSubAgentResult(validPayload())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.agentId).toBe("agent-1")
    expect(result.value.agentName).toBe("世界观Agent")
    expect(result.value.stage).toBe("worldview")
    expect(result.value.usedSkills).toEqual(["skill-a"])
    expect(result.value.confidence).toBe(0.9)
    expect(result.value.summary).toBe("已定稿世界观。")
    expect(result.value.contentMarkdown).toBe("# 世界观\n\n正文内容。")
    expect(result.value.constraints).toEqual(["保持黑暗基调"])
    expect(result.value.risks).toEqual(["战力膨胀"])
    expect(result.value.questions).toEqual(["是否保留支线？"])
  })

  it("回写条目同时兼容 target_folder 与 targetFolder，过滤非对象并补空串", () => {
    const result = parseOutlineSubAgentResult(validPayload())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.writebackItems).toEqual([
      { type: "角色", name: "林川", content: "复仇者", targetFolder: "roles" },
      { type: "地点", name: "苏晚城", content: "边塞", targetFolder: "places" },
      { type: "裸条目", name: "n", content: "c", targetFolder: "" },
    ])
  })

  it("解析 ```json 围栏包裹的载荷", () => {
    const result = parseOutlineSubAgentResult(`\`\`\`json\n${validPayload()}\n\`\`\``)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.agentId).toBe("agent-1")
    expect(result.value.summary).toBe("已定稿世界观。")
  })

  it("解析无语言标记的围栏包裹载荷", () => {
    const result = parseOutlineSubAgentResult(`\`\`\`\n${validPayload()}\n\`\`\``)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.agentName).toBe("世界观Agent")
  })

  it("从前后散文里抽取首个 { 到末个 } 的 JSON", () => {
    const result = parseOutlineSubAgentResult(`前言说明如下：\n${validPayload()}\n以上是全部输出。`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.stage).toBe("worldview")
  })

  it("非 JSON 文本返回 JSON 解析失败", () => {
    const result = parseOutlineSubAgentResult("纯文本说明，没有任何结构。")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("JSON 解析失败")
  })

  it("JSON 数组载荷返回必须是对象错误", () => {
    const result = parseOutlineSubAgentResult("[1, 2, 3]")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("必须是 JSON 对象")
  })

  it("JSON 标量载荷返回必须是对象错误", () => {
    const result = parseOutlineSubAgentResult("\"just a string\"")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("必须是 JSON 对象")
  })

  it("缺失字段时逐个列出缺失名", () => {
    const payload = JSON.parse(validPayload()) as Record<string, unknown>
    delete payload.summary
    delete payload.risks
    const result = parseOutlineSubAgentResult(JSON.stringify(payload))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("缺少必要字段")
    expect(result.error).toContain("summary")
    expect(result.error).toContain("risks")
  })

  it("空字符串字段同样视为缺失", () => {
    const result = parseOutlineSubAgentResult(validPayload({ summary: "" }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("summary")
  })

  it("非数组的 used_skills 等字段回退为空数组", () => {
    const result = parseOutlineSubAgentResult(validPayload({ used_skills: "skill-a", constraints: 42, questions: 42, writeback_items: { a: 1 } }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.usedSkills).toEqual([])
    expect(result.value.constraints).toEqual([])
    expect(result.value.questions).toEqual([])
    expect(result.value.writebackItems).toEqual([])
  })
})

describe("coerceOutlineSubAgentResult", () => {
  const context = { agentId: "agent-1", agentName: "世界观Agent" }

  it("空文本返回未返回内容错误并点名 Agent", () => {
    const result = coerceOutlineSubAgentResult("   \n  ", context)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("未返回内容")
    expect(result.error).toContain("世界观Agent")
  })

  it("合法 JSON 直接透传解析结果", () => {
    const result = coerceOutlineSubAgentResult(validPayload(), context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.agentId).toBe("agent-1")
    expect(result.value.confidence).toBe(0.9)
    expect(result.value.risks).toEqual(["战力膨胀"])
  })

  it("散文 Markdown 回退接入并携带解析错误", () => {
    const result = coerceOutlineSubAgentResult("# 第一章\n## 第二节\n正文第三行", context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.agentId).toBe("agent-1")
    expect(result.value.agentName).toBe("世界观Agent")
    expect(result.value.stage).toBe("markdown_fallback")
    expect(result.value.usedSkills).toEqual([])
    expect(result.value.confidence).toBe(0.55)
    expect(result.value.summary).toBe("第一章；第二节")
    expect(result.value.contentMarkdown).toBe("# 第一章\n## 第二节\n正文第三行")
    expect(result.value.constraints).toEqual([])
    expect(result.value.writebackItems).toEqual([])
    expect(result.value.questions).toEqual([])
    expect(result.value.risks).toHaveLength(1)
    expect(result.value.risks[0]).toContain("Markdown 内容容错接入")
  })

  it("回退时沿用上下文的 stage 与 usedSkills", () => {
    const result = coerceOutlineSubAgentResult(
      "纯散文正文",
      { agentId: "a9", agentName: "N", stage: "outline", usedSkills: ["s"] },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.stage).toBe("outline")
    expect(result.value.usedSkills).toEqual(["s"])
  })

  it("回退摘要只取前两行并截断到 120 字", () => {
    const long = `# ${"甲".repeat(80)}\n## ${"乙".repeat(80)}\n第三行`
    const result = coerceOutlineSubAgentResult(long, context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.summary.length).toBeLessThanOrEqual(120)
    expect(result.value.summary).toContain("；")
  })

  it("全空标题行回退默认摘要", () => {
    const result = coerceOutlineSubAgentResult("# \n## ", context)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.summary).toBe("已输出本 Agent 负责内容。")
  })
})

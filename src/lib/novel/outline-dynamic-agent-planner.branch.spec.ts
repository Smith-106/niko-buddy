import { describe, expect, it } from "vitest"
import {
  buildDynamicOutlinePlannerPrompt,
  parseDynamicOutlinePlan,
} from "./outline-dynamic-agent-planner"

/**
 * 分支覆盖增补（BRANCH-BRIEF 第二批：outline-dynamic-agent-planner 27 miss）。
 * 只增补新用例，不改动既有 spec。
 */

function validTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "a",
    name: "人物关系 Agent",
    dimension: "人物关系",
    skillNames: [],
    taskPrompt: "补齐人物关系",
    ...overrides,
  }
}

describe("动态大纲规划器分支增补", () => {
  it("空用户任务与空摘要落到占位文案", () => {
    const prompt = buildDynamicOutlinePlannerPrompt({
      userTask: "",
      projectSummary: "",
      existingModules: ["世界观"],
      missingModules: ["伏笔"],
      skills: [{ name: "人物设计", description: "设计关系", stages: ["planning"], kinds: ["planning"] }],
    })
    expect(prompt).toContain("（未提供）")
    expect(prompt).toContain("（暂无摘要）")
  })

  it("空模块列表渲染为「- 无」", () => {
    const prompt = buildDynamicOutlinePlannerPrompt({
      userTask: "t",
      projectSummary: "s",
      existingModules: [],
      missingModules: [],
      skills: [],
    })
    expect(prompt).toContain("- 无")
  })

  it("Skill 缺描述/缺阶段/缺类型时落到未标注文案", () => {
    const prompt = buildDynamicOutlinePlannerPrompt({
      userTask: "t",
      projectSummary: "s",
      existingModules: ["m"],
      missingModules: ["n"],
      skills: [{ name: "光杆Skill", description: "", stages: [], kinds: [] }],
    })
    expect(prompt).toContain("未说明")
    expect(prompt).toContain("未标注")
  })

  it("无 JSON 的纯文本返回「未返回 JSON 对象」错误", () => {
    const result = parseDynamicOutlinePlan("这里没有任何花括号也没有方括号纯文本")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("未返回 JSON 对象")
  })

  it("无 tasks 数组的 JSON 对象返回缺 tasks 错误", () => {
    const result = parseDynamicOutlinePlan(JSON.stringify({ foo: 1 }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("缺少 tasks 数组")
  })

  it("顶层 tasks 数组可被直接解析", () => {
    const result = parseDynamicOutlinePlan(JSON.stringify([validTask()]))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan).toHaveLength(1)
      expect(result.plan[0]?.id).toBe("a")
    }
  })

  it("非对象任务返回序号化错误", () => {
    const result = parseDynamicOutlinePlan(JSON.stringify({ tasks: [[1, 2]] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("第 1 个任务不是对象")
  })

  it("兼容 agent_name / work_dimension / skill_names / task_prompt / depends_on 别名", () => {
    const result = parseDynamicOutlinePlan(
      JSON.stringify({
        tasks: [
          {
            id: "x",
            agent_name: "别名 Agent",
            work_dimension: "人物关系",
            skill_names: [],
            task_prompt: "做事",
            depends_on: [],
          },
        ],
      }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.plan[0]?.name).toBe("别名 Agent")
      expect(result.plan[0]?.dimension).toBe("人物关系")
    }
  })

  it("缺 taskPrompt 的任务返回缺字段错误", () => {
    const result = parseDynamicOutlinePlan(
      JSON.stringify({ tasks: [{ id: "a", name: "A", dimension: "D" }] }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("缺少 id、name、dimension 或 taskPrompt")
  })

  it("非字符串 id 被视为空并报错", () => {
    const result = parseDynamicOutlinePlan(
      JSON.stringify({ tasks: [{ id: 123, name: "A", dimension: "D", taskPrompt: "做事" }] }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("缺少 id、name、dimension 或 taskPrompt")
  })

  it("转义引号与反斜杠的 taskPrompt 可被正确提取", () => {
    const result = parseDynamicOutlinePlan(
      '{"tasks": [{"id": "a", "name": "A", "dimension": "D", "taskPrompt": "说 \\"你好\\" 并继续"}]}',
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.plan[0]?.taskPrompt).toContain('"你好"')
  })

  it("availableSkillNames 全命中时通过校验", () => {
    const result = parseDynamicOutlinePlan(
      JSON.stringify({ tasks: [validTask({ skillNames: ["人物设计"] })] }),
      ["人物设计"],
    )
    expect(result.ok).toBe(true)
  })

  it("伏笔/题材/设定维度映射到 legacy kind", () => {
    const foreshadow = parseDynamicOutlinePlan(JSON.stringify({ tasks: [validTask({ dimension: "伏笔悬念" })] }))
    expect(foreshadow.ok).toBe(true)
    if (foreshadow.ok) expect(foreshadow.plan[0]?.kind).toBe("foreshadowing")

    const topic = parseDynamicOutlinePlan(JSON.stringify({ tasks: [validTask({ dimension: "题材卖点" })] }))
    expect(topic.ok).toBe(true)
    if (topic.ok) expect(topic.plan[0]?.kind).toBe("topic")

    const setting = parseDynamicOutlinePlan(JSON.stringify({ tasks: [validTask({ dimension: "世界观设定" })] }))
    expect(setting.ok).toBe(true)
    if (setting.ok) expect(setting.plan[0]?.kind).toBe("setting")
  })
})

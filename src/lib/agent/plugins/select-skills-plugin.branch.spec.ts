import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createSelectSkillsPlugin, buildSelectedSkillsPrompt, selectSkillsForRoute } from "./select-skills-plugin"
import { normalizeUserSkill, SKILL_ROUTE_CATEGORY_IDS } from "@/lib/novel"
import type { NovelTaskIntent, UserSkill } from "@/lib/novel"
import type { AgentConfig } from "@/lib/agent/types"
import type { NovelConfig, TaskPromptKey } from "@/stores/wiki-store"
import type { TaskRouteResult } from "@/lib/novel/task-router"
import * as llmClient from "@/lib/llm-client"
import * as hasUsableLlmModule from "@/lib/has-usable-llm"
import * as capabilityRetrieval from "../capability-retrieval"
import * as capabilityTraceStore from "../capability-trace-store"
import type { CapabilityDoc } from "../capability-retrieval"

/**
 * 分支覆盖增补（BRANCH-BRIEF：select-skills-plugin 30 miss）。只增补，不改既有用例。
 * 禁止 any 断言：AgentConfig 用完整字面量构造；NovelConfig 用精确断言。
 */

function skill(partial: Partial<UserSkill>): UserSkill {
  return normalizeUserSkill({
    id: partial.id,
    name: partial.name,
    description: partial.description ?? "",
    kind: partial.kind,
    stages: partial.stages,
    modes: partial.modes,
    content: partial.content ?? `${partial.name} content`,
    source: partial.source ?? "project",
    categoryId: partial.categoryId,
    priority: partial.priority,
  })
}

function testAgentConfig(): AgentConfig {
  return {
    maxRounds: 1,
    tools: [],
    systemPrompt: "test",
    llmConfig: {
      provider: "claude-code",
      apiKey: "",
      model: "test",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 100000,
    },
  }
}

function taskSkillNames(patch: Partial<Record<TaskPromptKey, string[]>>): NovelConfig {
  return {
    taskSkillNames: { writing: [], outline: [], review: [], summary: [], extract: [], ...patch },
  } as NovelConfig
}

function writeRoute(intent: NovelTaskIntent = "write_chapter"): TaskRouteResult {
  return { intent, confidence: 0.95, extractedParams: {} }
}

const availableSkills = [
  skill({ id: "chapter-bridge", name: "章节承接", kind: ["structure"], stages: ["planning", "drafting"], modes: ["standard", "strict"] }),
  skill({ id: "next-plan", name: "下一章计划", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"] }),
  skill({ id: "motivation", name: "人物动机", kind: ["planning"], stages: ["planning", "drafting"], modes: ["standard", "strict"] }),
  skill({ id: "conflict", name: "冲突升级", kind: ["structure"], stages: ["drafting"], modes: ["standard", "strict"] }),
  skill({ id: "plot-review", name: "剧情自检", kind: ["review"], stages: ["review"], modes: ["standard", "strict"] }),
  skill({ id: "output-protocol", name: "正文输出协议", kind: ["output"], stages: ["output"], modes: ["fast", "standard", "strict"] }),
  skill({ id: "de-ai", name: "基础去AI味", kind: ["style"], stages: ["rewrite", "output"], modes: ["fast", "standard", "strict"] }),
]

describe("SelectSkillsPlugin 分支增补", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("novelMode 下无任务路由时直接返回空技能", async () => {
    const plugin = createSelectSkillsPlugin()
    const result = await plugin.run({
      userMessage: "帮我写下一章",
      projectPath: "/project",
      agentConfig: testAgentConfig(),
      novelMode: true,
      aiWorkflowMode: "standard",
      availableSkills,
    })
    expect(result.selectedSkills).toEqual([])
  })

  it("availableSkills 缺省时走空池：选中为空、缺失名单非空", async () => {
    const plugin = createSelectSkillsPlugin()
    const result = await plugin.run({
      userMessage: "帮我写下一章",
      projectPath: "/project",
      agentConfig: testAgentConfig(),
      novelMode: true,
      aiWorkflowMode: "standard",
      taskRoute: writeRoute(),
    })
    expect(result.selectedSkills).toEqual([])
    const missingCount = Array.isArray(result.missingSkillNames) ? result.missingSkillNames.length : 0
    expect(missingCount).toBeGreaterThan(0)
  })

  it("任务级覆盖全命中时缺失名单为空", async () => {
    const plugin = createSelectSkillsPlugin()
    const result = await plugin.run({
      userMessage: "帮我写下一章",
      projectPath: "/project",
      agentConfig: testAgentConfig(),
      novelMode: true,
      aiWorkflowMode: "standard",
      availableSkills,
      taskRoute: writeRoute(),
      novelConfig: taskSkillNames({ writing: ["人物动机"] }),
    })
    expect(result.selectedSkills?.map((item) => item.name)).toEqual([
      "人物动机",
      "正文输出协议",
      "基础去AI味",
    ])
    const missingNames = Array.isArray(result.missingSkillNames) ? result.missingSkillNames : []
    expect(missingNames).toEqual(["long-form-drafting"])
  })

  it("大纲路由名命中但无可用技能时回退到形状选择", async () => {
    const pool = [
      skill({ id: "ob", name: "章纲结构", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.outline }),
      skill({ id: "ch", name: "人物动机", kind: ["structure"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.character }),
    ]
    const selected = selectSkillsForRoute(pool, "generate_outline", "standard", "请帮我写故事大纲")
    expect(selected.map((item) => item.name)).toEqual(["章纲结构", "人物动机"])
  })

  it("strict 大纲走 8 上限", async () => {
    const pool = [
      skill({ id: "o1", name: "纲1", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.outline }),
      skill({ id: "o2", name: "纲2", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.outline }),
      skill({ id: "o3", name: "纲3", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.outline }),
      skill({ id: "o4", name: "纲4", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.outline }),
      skill({ id: "o5", name: "纲5", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.outline }),
      skill({ id: "o6", name: "纲6", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.outline }),
      skill({ id: "s1", name: "支1", kind: ["structure"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.character }),
      skill({ id: "s2", name: "支2", kind: ["structure"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.character }),
      skill({ id: "s3", name: "支3", kind: ["structure"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.character }),
    ]
    const selected = selectSkillsForRoute(pool, "generate_outline", "strict", "随便写点什么")
    expect(selected).toHaveLength(8)
    expect(selected.map((item) => item.name)).toEqual(["纲1", "纲2", "纲3", "纲4", "纲5", "纲6", "支1", "支2"])
  })

  it("大纲合并去重并在超限时截断", async () => {
    const dup = skill({ id: "o1", name: "纲1", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.outline })
    const pool = [
      dup,
      skill({ id: "o2", name: "纲2", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.outline }),
      skill({ id: "o3", name: "纲3", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.outline }),
      skill({ id: "o1-dup", name: "纲1", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.outline }),
      skill({ id: "o4", name: "纲4", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.outline }),
      skill({ id: "o5", name: "纲5", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.outline }),
      skill({ id: "o6", name: "纲6", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.outline }),
      skill({ id: "s1", name: "支1", kind: ["structure"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.character }),
      skill({ id: "s2", name: "支2", kind: ["structure"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.character }),
      skill({ id: "s3", name: "支3", kind: ["structure"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.character }),
    ]
    // o1-dup 与首个同名不同 id：按 id 去重不触发；构造同 id 重复
    const sameIdDup = { ...pool[0] as UserSkill, name: "纲1" }
    const withSameId = [pool[0], pool[1], pool[2], sameIdDup, pool[4], pool[5], pool[6], pool[7], pool[8], pool[9]] as UserSkill[]
    const selected = selectSkillsForRoute(withSameId, "generate_outline", "standard", "随便写点什么")
    expect(selected.map((item) => item.name)).toEqual(["纲1", "纲2", "纲3", "纲4", "支1"])
  })

  it("全非写作路由技能时回退到全池偏好选择", async () => {
    const pool = [
      skill({ id: "only", name: "章纲甲", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.outline }),
    ]
    const selected = selectSkillsForRoute(pool, "write_chapter", "standard", "写下一章")
    expect(selected.map((item) => item.name)).toEqual(["章纲甲"])
  })

  it("strict 写作填满 14 上限并在超限时截断（含 rewrite 纯阶段技能）", async () => {
    const strictNames = ["章节承接", "下一章计划", "人物动机", "冲突升级", "剧情自检", "正文输出协议", "主线检查", "伏笔管理", "节奏检查", "结尾钩子"]
    const pool: UserSkill[] = [
      ...strictNames.map((name, index) =>
        skill({ id: `w${index}`, name, kind: ["structure"], stages: ["drafting"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.writing }),
      ),
      ...["自创1", "自创2", "自创3", "自创4", "自创5", "自创6"].map((name, index) =>
        skill({ id: `x${index}`, name, kind: ["knowledge"], stages: ["rewrite"], modes: ["strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.writing }),
      ),
    ]
    const selected = selectSkillsForRoute(pool, "write_chapter", "strict", "写下一章")
    expect(selected).toHaveLength(14)
    expect(selected.slice(0, 10).map((item) => item.name)).toEqual(strictNames)
    expect(selected.slice(10).map((item) => item.name)).toEqual(["自创1", "自创2", "自创3", "自创4"])
  })

  it("有描述的技能渲染说明行", async () => {
    const prompt = buildSelectedSkillsPrompt([
      skill({ id: "d1", name: "有述", kind: ["planning"], stages: ["planning"], modes: ["standard"], description: "用途甲", content: "规则甲" }),
    ])
    expect(prompt).toContain("说明：用途甲")
    expect(prompt).toContain("规则甲")
  })

  function docFromSkill(s: UserSkill): CapabilityDoc {
    return {
      id: s.id,
      name: s.name,
      label: [...s.kind, ...s.stages].join(" "),
      tags: [...s.modes].join(" "),
      description: s.description ?? "",
      content: s.content ?? "",
      source: s.source,
      modes: [...s.modes],
      intents: [],
      permission: "auto",
      ref: s,
    }
  }

  it("规划器成功且无预置 capabilities 时仅合并规划结果", async () => {
    const plugin = createSelectSkillsPlugin()
    const combatPlan = skill({ id: "plan-combat", name: "战斗编排", kind: ["structure"], stages: ["drafting"], modes: ["standard", "strict"] })
    vi.spyOn(hasUsableLlmModule, "hasUsableLlm").mockReturnValue(true)
    vi.spyOn(capabilityRetrieval, "retrieveCapabilities").mockReturnValue({
      candidates: [{ doc: docFromSkill(combatPlan), score: 9 }],
      filteredOut: [],
    })
    vi.spyOn(llmClient, "streamChat").mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken(
        JSON.stringify({
          nodes: [
            { id: "n1", name: "战斗编排", capabilityId: "plan-combat", dependsOn: [], permission: "auto", reason: "先编排", finalReview: false },
          ],
        }),
      )
      callbacks.onDone()
    })
    const traceSpy = vi.spyOn(capabilityTraceStore, "appendCapabilityTrace").mockResolvedValue(undefined)

    const result = await plugin.run({
      userMessage: "写一段战斗",
      projectPath: "/project",
      agentConfig: testAgentConfig(),
      novelMode: true,
      aiWorkflowMode: "standard",
      availableSkills: [...availableSkills, combatPlan],
      taskRoute: writeRoute(),
      planExecuteEnabled: true,
    })
    expect(result.selectedCapabilities).toHaveLength(1)
    expect(result.selectedCapabilities?.[0]).toMatchObject({ skillId: "plan-combat", reason: "先编排" })
    expect(traceSpy).toHaveBeenCalledTimes(1)
  })

  it("规划器菱形依赖按拓扑排序、无理由节点落默认文案", async () => {
    const plugin = createSelectSkillsPlugin()
    const capA = skill({ id: "cap-a", name: "能力A", kind: ["structure"], stages: ["drafting"], modes: ["standard", "strict"] })
    const capB = skill({ id: "cap-b", name: "能力B", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"] })
    const capC = skill({ id: "cap-c", name: "能力C", kind: ["review"], stages: ["review"], modes: ["standard", "strict"] })
    vi.spyOn(hasUsableLlmModule, "hasUsableLlm").mockReturnValue(true)
    vi.spyOn(capabilityRetrieval, "retrieveCapabilities").mockReturnValue({
      candidates: [
        { doc: docFromSkill(capA), score: 9 },
        { doc: docFromSkill(capB), score: 8 },
        { doc: docFromSkill(capC), score: 7 },
      ],
      filteredOut: [],
    })
    vi.spyOn(llmClient, "streamChat").mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken(
        JSON.stringify({
          nodes: [
            { id: "n1", name: "能力A", capabilityId: "cap-a", dependsOn: [] },
            { id: "n2", name: "能力B", capabilityId: "cap-b", dependsOn: [], reason: "辅" },
            { id: "n3", name: "能力C", capabilityId: "cap-c", dependsOn: ["n1", "n2"], reason: "合" },
          ],
        }),
      )
      callbacks.onDone()
    })
    vi.spyOn(capabilityTraceStore, "appendCapabilityTrace").mockResolvedValue(undefined)

    const result = await plugin.run({
      userMessage: "写一段群像",
      projectPath: "/project",
      agentConfig: testAgentConfig(),
      novelMode: true,
      aiWorkflowMode: "standard",
      availableSkills: [...availableSkills, capA, capB, capC],
      taskRoute: writeRoute(),
      planExecuteEnabled: true,
    })
    const plannedNames = (result.selectedCapabilities ?? []).map((t) => t.name)
    expect(plannedNames).toEqual(["能力A", "能力B", "能力C"])
    // n1 无 reason → 默认文案；n3 菱形依赖仍排在 n1/n2 之后
    expect(result.selectedCapabilities?.[0]?.reason).toBe("能力规划器选中")
    expect(result.selectedCapabilities?.[2]).toMatchObject({ skillId: "cap-c", reason: "合" })
    expect(result.selectedSkills?.map((item) => item.name)).toContain("能力C")
  })
})

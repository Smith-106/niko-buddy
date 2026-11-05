import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { createSelectSkillsPlugin, buildSelectedSkillsPrompt, selectSkillsForRoute } from "./select-skills-plugin"
import { normalizeUserSkill, SKILL_ROUTE_CATEGORY_IDS } from "@/lib/novel"
import type { NovelTaskIntent, UserSkill } from "@/lib/novel"
import * as llmClient from "@/lib/llm-client"
import * as hasUsableLlmModule from "@/lib/has-usable-llm"
import * as capabilityRetrieval from "../capability-retrieval"
import * as capabilityTraceStore from "../capability-trace-store"
import type { CapabilityDoc } from "../capability-retrieval"

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
  })
}

const availableSkills = [
  skill({ id: "chapter-bridge", name: "章节承接", kind: ["structure"], stages: ["planning", "drafting"], modes: ["standard", "strict"] }),
  skill({ id: "next-plan", name: "下一章计划", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"] }),
  skill({ id: "motivation", name: "人物动机", kind: ["planning"], stages: ["planning", "drafting"], modes: ["standard", "strict"] }),
  skill({ id: "conflict", name: "冲突升级", kind: ["structure"], stages: ["drafting"], modes: ["standard", "strict"] }),
  skill({ id: "plot-review", name: "剧情自检", kind: ["review"], stages: ["review"], modes: ["standard", "strict"] }),
  skill({ id: "output-protocol", name: "正文输出协议", kind: ["output"], stages: ["output"], modes: ["fast", "standard", "strict"] }),
  skill({ id: "de-ai", name: "基础去AI味", kind: ["style"], stages: ["rewrite", "output"], modes: ["fast", "standard", "strict"] }),
  skill({ id: "mainline", name: "主线检查", kind: ["review"], stages: ["review"], modes: ["strict"] }),
  skill({ id: "foreshadow", name: "伏笔管理", kind: ["structure", "review"], stages: ["planning", "review"], modes: ["strict"] }),
  skill({ id: "pace", name: "节奏检查", kind: ["review"], stages: ["review"], modes: ["strict"] }),
  skill({ id: "hook", name: "结尾钩子", kind: ["structure"], stages: ["drafting", "review"], modes: ["strict"] }),
  skill({ id: "knowledge", name: "世界观资料", kind: ["knowledge"], stages: ["planning"], modes: ["standard", "strict"] }),
]

describe("SelectSkillsPlugin", () => {
  it("selects old fast lightweight skills for standard mode", async () => {
    const plugin = createSelectSkillsPlugin()

    const result = await plugin.run({
      userMessage: "帮我写下一章",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      aiWorkflowMode: "standard",
      availableSkills,
      taskRoute: { intent: "write_chapter", confidence: 0.95, extractedParams: {} },
    })

    expect(result.selectedSkills?.map((item) => item.name)).toEqual([
      "正文输出协议",
      "基础去AI味",
    ])
  })

  it("does not supplement standard lightweight writing with uploaded skills", async () => {
    const plugin = createSelectSkillsPlugin()

    const result = await plugin.run({
      userMessage: "帮我写下一章",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      aiWorkflowMode: "standard",
      availableSkills: [
        ...availableSkills,
        skill({
          id: "skill:three-four",
          name: "三翻四抖",
          kind: ["structure", "planning"],
          stages: ["planning", "drafting"],
          modes: ["standard", "strict"],
          content: "三次转折，四次震惊。",
          source: "uploaded",
          priority: 25,
        }),
      ],
      taskRoute: { intent: "write_chapter", confidence: 0.95, extractedParams: {} },
    })

    expect(result.selectedSkills?.map((item) => item.name)).toEqual([
      "正文输出协议",
      "基础去AI味",
    ])
  })

  it("does not auto-select skills in fast mode", async () => {
    const plugin = createSelectSkillsPlugin()

    const result = await plugin.run({
      userMessage: "直接写下一章",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      aiWorkflowMode: "fast",
      availableSkills,
      taskRoute: { intent: "write_chapter", confidence: 0.95, extractedParams: {} },
    })

    expect(result.selectedSkills).toEqual([])
  })

  // ── 能力规划器灰度降级：planExecuteEnabled=true 但 spec 环境无可用 LLM，
  //    planCapabilitySelection 应静默回退到查表结果（与不开启时一致）。──
  it("planner path degrades to deterministic table when LLM unavailable", async () => {
    const plugin = createSelectSkillsPlugin()
    const base = {
      userMessage: "帮我写下一章",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      aiWorkflowMode: "standard" as const,
      availableSkills,
      taskRoute: { intent: "write_chapter" as NovelTaskIntent, confidence: 0.95, extractedParams: {} },
    }
    const off = await plugin.run({ ...base, planExecuteEnabled: false })
    const on = await plugin.run({ ...base, planExecuteEnabled: true })
    // 无 LLM 时规划器回退 → 两者选中技能一致（零回归）
    expect(on.selectedSkills?.map((s) => s.name)).toEqual(off.selectedSkills?.map((s) => s.name))
  })

  it("selects writing route skills for key chapter writing", async () => {
    const plugin = createSelectSkillsPlugin()

    const result = await plugin.run({
      userMessage: "帮我写关键转折章",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      aiWorkflowMode: "strict",
      availableSkills,
      taskRoute: { intent: "write_chapter", confidence: 0.95, extractedParams: {} },
    })

    expect(result.selectedSkills?.map((item) => item.name)).toEqual([
      "正文输出协议",
      "基础去AI味",
    ])
  })

  it("does not select skills outside novel routed tasks", async () => {
    const plugin = createSelectSkillsPlugin()

    const result = await plugin.run({
      userMessage: "你好",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: false,
      aiWorkflowMode: "standard",
      availableSkills,
    })

    expect(result.selectedSkills).toEqual([])
  })

  it("builds a prompt section that hides skill analysis from final prose", () => {
    const prompt = buildSelectedSkillsPrompt([
      skill({ id: "three-four", name: "三翻四抖", kind: ["structure"], stages: ["planning", "drafting"], modes: ["standard"], content: "三次转折，四次震惊。" }),
    ])

    expect(prompt).toContain("本次启用 Skill")
    expect(prompt).toContain("三翻四抖")
    expect(prompt).toContain("三次转折，四次震惊。")
    expect(prompt).toContain("不要在最终回复中解释 Skill")
  })

  it("routes outline generation to outline folders and excludes writing-only skills", () => {
    const selected = selectSkillsForRoute([
      skill({
        id: "outline-plan",
        name: "章纲结构",
        kind: ["planning"],
        stages: ["planning"],
        modes: ["standard", "strict"],
        categoryId: SKILL_ROUTE_CATEGORY_IDS.outline,
      }),
      skill({
        id: "character",
        name: "人物动机",
        kind: ["structure"],
        stages: ["planning"],
        modes: ["standard", "strict"],
        categoryId: SKILL_ROUTE_CATEGORY_IDS.character,
      }),
      skill({
        id: "writing",
        name: "正文输出协议",
        kind: ["output"],
        stages: ["output"],
        modes: ["standard", "strict"],
        categoryId: SKILL_ROUTE_CATEGORY_IDS.writing,
      }),
    ], "generate_outline", "standard")

    expect(selected.map((item) => item.name)).toEqual(["章纲结构", "人物动机"])
  })

  it("routes chapter writing to writing folders when categorized skills exist", () => {
    const selected = selectSkillsForRoute([
      skill({
        id: "outline-plan",
        name: "下一章计划",
        kind: ["planning"],
        stages: ["planning"],
        modes: ["standard", "strict"],
        categoryId: SKILL_ROUTE_CATEGORY_IDS.outline,
      }),
      skill({
        id: "writing-output",
        name: "正文输出协议",
        kind: ["output"],
        stages: ["output"],
        modes: ["standard", "strict"],
        categoryId: SKILL_ROUTE_CATEGORY_IDS.writing,
      }),
      skill({
        id: "writing-style",
        name: "场景描写",
        kind: ["style"],
        stages: ["drafting"],
        modes: ["standard", "strict"],
        categoryId: SKILL_ROUTE_CATEGORY_IDS.writing,
      }),
    ], "write_chapter", "strict")

    expect(selected.map((item) => item.name)).toEqual(["正文输出协议", "场景描写"])
  })

  it("injects canonical drafting and scene skills before Chinese helpers", () => {
    const selected = selectSkillsForRoute([
      skill({ id: "long", name: "long-form-drafting", kind: ["output"], stages: ["drafting"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.writing }),
      skill({ id: "combat", name: "combat-action", kind: ["style"], stages: ["drafting"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.writing }),
      skill({ id: "protocol", name: "正文输出协议", kind: ["output"], stages: ["output"], modes: ["standard", "strict"], categoryId: SKILL_ROUTE_CATEGORY_IDS.writing }),
    ], "write_chapter", "standard", "编写一章战斗场景")

    expect(selected.map((item) => item.name)).toEqual([
      "long-form-drafting",
      "combat-action",
      "正文输出协议",
    ])
  })

  it("prepends @ selected skills and canonical name hits before auto-routed skills", async () => {
    const plugin = createSelectSkillsPlugin()
    const combat = skill({
      id: "combat",
      name: "combat-action",
      kind: ["style"],
      stages: ["drafting"],
      modes: ["fast", "standard", "strict"],
      categoryId: SKILL_ROUTE_CATEGORY_IDS.writing,
    })

    const fromName = await plugin.run({
      userMessage: "写下一章 combat-action",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      aiWorkflowMode: "standard",
      availableSkills: [...availableSkills, combat],
      taskRoute: { intent: "write_chapter", confidence: 0.95, extractedParams: {} },
    })
    expect(fromName.selectedSkills?.map((item) => item.name)).toEqual([
      "combat-action",
      "正文输出协议",
      "基础去AI味",
    ])

    const fromToken = await plugin.run({
      userMessage: "写下一章",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      aiWorkflowMode: "standard",
      availableSkills: [...availableSkills, combat],
      selectedSkills: [combat],
      taskRoute: { intent: "write_chapter", confidence: 0.95, extractedParams: {} },
    })
    expect(fromToken.selectedSkills?.map((item) => item.name)).toEqual([
      "combat-action",
      "正文输出协议",
      "基础去AI味",
    ])
  })

  it("keeps explicit skills in fast mode without auto-selecting helpers", async () => {
    const plugin = createSelectSkillsPlugin()
    const combat = skill({
      id: "combat",
      name: "combat-action",
      kind: ["style"],
      stages: ["drafting"],
      modes: ["fast", "standard", "strict"],
      categoryId: SKILL_ROUTE_CATEGORY_IDS.writing,
    })

    const result = await plugin.run({
      userMessage: "直接写下一章 combat-action",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      aiWorkflowMode: "fast",
      availableSkills: [...availableSkills, combat],
      selectedSkills: [combat],
      taskRoute: { intent: "write_chapter", confidence: 0.95, extractedParams: {} },
    })

    expect(result.selectedSkills?.map((item) => item.name)).toEqual(["combat-action"])
  })
})

describe("SelectSkillsPlugin 覆盖加深（W-mode 补齐）", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function docFromSkill(skill: UserSkill): CapabilityDoc {
    return {
      id: skill.id,
      name: skill.name,
      label: [...skill.kind, ...skill.stages].join(" "),
      tags: [...skill.modes].join(" "),
      description: skill.description ?? "",
      content: skill.content ?? "",
      source: skill.source,
      modes: [...skill.modes],
      intents: [],
      permission: "auto",
      ref: skill,
    }
  }

  function baseRun(overrides: Record<string, unknown> = {}) {
    return {
      userMessage: "帮我写下一章",
      projectPath: "/project",
      agentConfig: {} as any,
      novelMode: true,
      aiWorkflowMode: "standard" as const,
      availableSkills,
      taskRoute: { intent: "write_chapter" as NovelTaskIntent, confidence: 0.95, extractedParams: {} },
      ...overrides,
    }
  }

  it("modeSkills 为空时直接返回空数组", () => {
    expect(selectSkillsForRoute([], "write_chapter", "standard")).toEqual([])
    expect(
      selectSkillsForRoute(
        [skill({ id: "fast-only", name: "快写", kind: ["output"], stages: ["output"], modes: ["fast"] })],
        "write_chapter",
        "standard",
      ),
    ).toEqual([])
  })

  it("generate_outline 命中路由名时直接返回路由技能", () => {
    const routed = selectSkillsForRoute(
      [
        skill({ id: "o1", name: "outline-master-builder", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"] }),
        skill({ id: "o2", name: "outline-final-assembler", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"] }),
      ],
      "generate_outline",
      "standard",
      "请帮我写故事大纲",
    )
    expect(routed.map((item) => item.name)).toEqual(["outline-master-builder", "outline-final-assembler"])
  })

  it("generate_outline 无路由命中且无大纲/支援技能时回退到通用形状选择", () => {
    const fallback = selectSkillsForRoute(
      [
        skill({ id: "g1", name: "zzz-qaq-1", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"], description: "", tags: [] }),
        skill({ id: "g2", name: "zzz-qaq-2", kind: ["structure"], stages: ["output"], modes: ["standard", "strict"], description: "", tags: [] }),
      ],
      "generate_outline",
      "standard",
      "随便写点什么",
    )
    expect(fallback.map((item) => item.name).sort()).toEqual(["zzz-qaq-1", "zzz-qaq-2"])
  })

  it("review 意图按分选形：strict 取 8、standard 取 5，kind 未命中走 stages 分支", () => {
    const reviewPool = [
      skill({ id: "r1", name: "审校A", kind: ["review"], stages: ["review"], modes: ["standard", "strict"] }),
      skill({ id: "r2", name: "知识库", kind: ["knowledge", "output"], stages: ["output"], modes: ["standard", "strict"], source: "built-in", priority: 10 }),
      skill({ id: "r3", name: "风格C", kind: ["style"], stages: ["review"], modes: ["standard", "strict"] }),
      skill({ id: "r4", name: "无关D", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"] }),
      skill({ id: "r5", name: "审校E", kind: ["review"], stages: ["review"], modes: ["standard", "strict"] }),
      skill({ id: "r6", name: "审校F", kind: ["review"], stages: ["review"], modes: ["standard", "strict"] }),
      skill({ id: "r7", name: "审校G", kind: ["review"], stages: ["review"], modes: ["standard", "strict"] }),
      skill({ id: "r8", name: "审校H", kind: ["review"], stages: ["review"], modes: ["standard", "strict"] }),
    ]
    const strictRes = selectSkillsForRoute(reviewPool, "review_chapter", "strict")
    expect(strictRes.map((item) => item.name)).toEqual([
      "知识库",
      "审校A",
      "审校E",
      "审校F",
      "审校G",
      "审校H",
      "风格C",
    ])
    const standardRes = selectSkillsForRoute(reviewPool, "lint_chapter", "standard")
    expect(standardRes.map((item) => item.name)).toEqual([
      "知识库",
      "审校A",
      "审校E",
      "审校F",
      "审校G",
    ])
  })

  it("query 意图按分选形：strict 取 6、standard 取 3", () => {
    const queryPool = [
      skill({ id: "q1", name: "知识检索", kind: ["knowledge"], stages: ["planning"], modes: ["standard", "strict"] }),
      skill({ id: "q2", name: "情节审查", kind: ["review"], stages: ["review"], modes: ["standard", "strict"] }),
      skill({ id: "q3", name: "终稿输出", kind: ["output"], stages: ["output"], modes: ["standard", "strict"] }),
      skill({ id: "q4", name: "风格润色", kind: ["style"], stages: ["drafting"], modes: ["standard", "strict"] }),
      skill({ id: "q5", name: "考据考证", kind: ["knowledge"], stages: ["output"], modes: ["standard", "strict"] }),
    ]
    expect(selectSkillsForRoute(queryPool, "search_plot", "strict").map((item) => item.name)).toEqual([
      "知识检索",
      "情节审查",
      "终稿输出",
      "考据考证",
    ])
    expect(selectSkillsForRoute(queryPool, "timeline_query", "standard").map((item) => item.name)).toEqual([
      "知识检索",
      "情节审查",
      "终稿输出",
    ])
  })

  it("未知意图返回空数组", () => {
    expect(selectSkillsForRoute(availableSkills, "extract_memory", "standard")).toEqual([])
  })

  it("写作偏好名全部未命中时回退到写作 fallback（去AI味被排除）", () => {
    const customPool = [
      skill({ id: "c1", name: "自创A", kind: ["planning"], stages: ["drafting"], modes: ["standard"], priority: 20, description: "", tags: [] }),
      skill({ id: "c2", name: "自创B", kind: ["knowledge"], stages: ["drafting"], modes: ["standard"], priority: 30, description: "", tags: [] }),
      skill({ id: "c3", name: "去AI味", kind: ["style"], stages: ["output"], modes: ["standard"], priority: 10, description: "", tags: [] }),
    ]
    const res = selectSkillsForRoute(customPool, "write_chapter", "standard", "帮我写下一章")
    expect(res.map((item) => item.name)).toEqual(["自创A", "自创B"])
  })

  it("空技能 prompt 返回空串", () => {
    expect(buildSelectedSkillsPrompt([])).toBe("")
    expect(buildSelectedSkillsPrompt(undefined)).toBe("")
  })

  it("effectiveTaskRoute 优先于 taskRoute", async () => {
    const plugin = createSelectSkillsPlugin()
    const reviewPool = [
      skill({ id: "r1", name: "审校A", kind: ["review"], stages: ["review"], modes: ["standard", "strict"] }),
      skill({ id: "r2", name: "知识库", kind: ["knowledge", "output"], stages: ["output"], modes: ["standard", "strict"] }),
    ]
    const result = await plugin.run(
      baseRun({
        availableSkills: reviewPool,
        taskRoute: { intent: "write_chapter" as NovelTaskIntent, confidence: 0.9, extractedParams: {} },
        effectiveTaskRoute: { intent: "review_chapter" as NovelTaskIntent, confidence: 0.99, extractedParams: {} },
      }),
    )
    expect(result.selectedSkills?.map((item) => item.name)).toContain("审校A")
    expect(result.missingSkillNames ?? []).toEqual([])
  })

  it("任务级名单覆盖生效：用户名单前置、缺失进 missingSkillNames", async () => {
    const plugin = createSelectSkillsPlugin()
    const result = await plugin.run(
      baseRun({
        novelConfig: { taskSkillNames: { writing: ["人物动机", "不存在技能X"] } } as any,
      }),
    )
    expect(result.selectedSkills?.map((item) => item.name)).toEqual([
      "人物动机",
      "正文输出协议",
      "基础去AI味",
    ])
    expect(result.missingSkillNames).toContain("不存在技能X")
  })

  it("任务级名单全部缺失时保持查表结果、缺失仍上报", async () => {
    const plugin = createSelectSkillsPlugin()
    const off = await plugin.run(baseRun())
    const on = await plugin.run(
      baseRun({
        novelConfig: { taskSkillNames: { writing: ["全都不存在1", "全都不存在2"] } } as any,
      }),
    )
    expect(on.selectedSkills).toEqual(off.selectedSkills)
    expect(on.missingSkillNames).toEqual(expect.arrayContaining(["全都不存在1", "全都不存在2"]))
  })

  it("outline 任务级名单覆盖走 outline 键", async () => {
    const plugin = createSelectSkillsPlugin()
    const outlineSkill = skill({
      id: "ob",
      name: "章纲结构",
      kind: ["planning"],
      stages: ["planning"],
      modes: ["standard", "strict"],
      categoryId: SKILL_ROUTE_CATEGORY_IDS.outline,
    })
    const result = await plugin.run(
      baseRun({
        userMessage: "请生成大纲",
        availableSkills: [outlineSkill],
        taskRoute: { intent: "generate_outline" as NovelTaskIntent, confidence: 0.95, extractedParams: {} },
        novelConfig: { taskSkillNames: { outline: ["章纲结构", "幽灵技能"] } } as any,
      }),
    )
    expect(result.selectedSkills?.[0]?.name).toBe("章纲结构")
    expect(result.missingSkillNames).toContain("幽灵技能")
  })

  it("review 任务级名单覆盖会把用户名单排到最前", async () => {
    const plugin = createSelectSkillsPlugin()
    const result = await plugin.run(
      baseRun({
        userMessage: "帮我审稿",
        taskRoute: { intent: "review_chapter" as NovelTaskIntent, confidence: 0.95, extractedParams: {} },
        novelConfig: { taskSkillNames: { review: ["世界观资料", "幽灵R"] } } as any,
      }),
    )
    expect(result.selectedSkills?.map((item) => item.name)).toEqual([
      "世界观资料",
      "剧情自检",
      "正文输出协议",
      "基础去AI味",
    ])
    expect(result.missingSkillNames).toContain("幽灵R")
  })

  it("非 writing/outline/review 意图不走任务级覆盖", async () => {
    const plugin = createSelectSkillsPlugin()
    const off = await plugin.run(
      baseRun({
        userMessage: "查一下伏笔",
        taskRoute: { intent: "search_plot" as NovelTaskIntent, confidence: 0.95, extractedParams: {} },
      }),
    )
    const on = await plugin.run(
      baseRun({
        userMessage: "查一下伏笔",
        taskRoute: { intent: "search_plot" as NovelTaskIntent, confidence: 0.95, extractedParams: {} },
        novelConfig: { taskSkillNames: { writing: ["人物动机"] } } as any,
      }),
    )
    expect(on.selectedSkills).toEqual(off.selectedSkills)
    expect(on.missingSkillNames ?? []).toEqual([])
  })

  it("规划器成功：按拓扑序并入技能并携带 trace（含去重）", async () => {
    const plugin = createSelectSkillsPlugin()
    const combatPlan = skill({ id: "plan-combat", name: "战斗编排", kind: ["structure"], stages: ["drafting"], modes: ["standard", "strict"] })
    const scenePlan = skill({ id: "plan-scene", name: "场景描写", kind: ["style"], stages: ["drafting"], modes: ["standard", "strict"] })
    vi.spyOn(hasUsableLlmModule, "hasUsableLlm").mockReturnValue(true)
    vi.spyOn(capabilityRetrieval, "retrieveCapabilities").mockReturnValue({
      candidates: [
        { doc: docFromSkill(combatPlan), score: 9 },
        { doc: docFromSkill(scenePlan), score: 8 },
      ],
      filteredOut: [{ id: "zzz", reason: "low score" }],
    })
    vi.spyOn(llmClient, "streamChat").mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken(
        JSON.stringify({
          nodes: [
            { id: "n1", name: "战斗编排", capabilityId: "plan-combat", dependsOn: [], permission: "auto", reason: "先编排战斗", finalReview: false },
            { id: "n2", name: "场景描写", capabilityId: "plan-scene", dependsOn: ["n1"], permission: "auto", reason: "再补场景", finalReview: false },
            { id: "n3", name: "战斗编排又用", capabilityId: "plan-combat", dependsOn: ["n1"], permission: "auto", reason: "复用", finalReview: false },
          ],
        }),
      )
      callbacks.onDone()
    })
    const traceSpy = vi.spyOn(capabilityTraceStore, "appendCapabilityTrace").mockResolvedValue(undefined)

    const result = await plugin.run(
      baseRun({
        userMessage: "写一段激烈的战斗",
        availableSkills: [...availableSkills, combatPlan, scenePlan],
        planExecuteEnabled: true,
        selectedCapabilities: [{ id: "pre", name: "预置", kind: "user_skill", permission: "auto", reason: "预置" }],
      }),
    )

    expect(result.selectedSkills?.map((item) => item.name)).toEqual([
      "正文输出协议",
      "基础去AI味",
      "战斗编排",
      "场景描写",
    ])
    expect(result.selectedCapabilities).toHaveLength(3)
    expect(result.selectedCapabilities?.[1]).toMatchObject({ skillId: "plan-combat", reason: "先编排战斗" })
    expect(result.selectedCapabilities?.[2]).toMatchObject({ skillId: "plan-scene", reason: "再补场景" })
    expect(traceSpy).toHaveBeenCalledTimes(1)
    const record = traceSpy.mock.calls[0][1]
    expect(record.outcome).toBe("success")
    expect(record.retrieved).toEqual(["plan-combat", "plan-scene"])
    expect(record.filteredOut).toEqual([{ id: "zzz", reason: "low score" }])
    expect(record.planned).toHaveLength(2)
  })

  it("规划器流错误：静默回退查表并记录 error trace", async () => {
    const plugin = createSelectSkillsPlugin()
    vi.spyOn(hasUsableLlmModule, "hasUsableLlm").mockReturnValue(true)
    vi.spyOn(capabilityRetrieval, "retrieveCapabilities").mockReturnValue({
      candidates: [{ doc: docFromSkill(skill({ id: "x", name: "候选X", kind: ["planning"], stages: ["planning"], modes: ["standard"] })), score: 5 }],
      filteredOut: [],
    })
    vi.spyOn(llmClient, "streamChat").mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onError(new Error("planner boom"))
    })
    const traceSpy = vi.spyOn(capabilityTraceStore, "appendCapabilityTrace").mockResolvedValue(undefined)

    const input = baseRun({ userMessage: "写一段激烈的战斗", planExecuteEnabled: true })
    const [on, off] = await Promise.all([
      plugin.run(input),
      plugin.run({ ...input, planExecuteEnabled: false }),
    ])
    expect(on.selectedSkills).toEqual(off.selectedSkills)
    expect(on.selectedCapabilities).toBeUndefined()
    expect(traceSpy).toHaveBeenCalledTimes(1)
    expect(traceSpy.mock.calls[0][1].outcome).toBe("error")
  })

  it("规划器解析失败：回退查表并记录 empty trace", async () => {
    const plugin = createSelectSkillsPlugin()
    vi.spyOn(hasUsableLlmModule, "hasUsableLlm").mockReturnValue(true)
    vi.spyOn(capabilityRetrieval, "retrieveCapabilities").mockReturnValue({
      candidates: [{ doc: docFromSkill(skill({ id: "x", name: "候选X", kind: ["planning"], stages: ["planning"], modes: ["standard"] })), score: 5 }],
      filteredOut: [],
    })
    vi.spyOn(llmClient, "streamChat").mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken("纯文本无 JSON")
      callbacks.onDone()
    })
    const traceSpy = vi.spyOn(capabilityTraceStore, "appendCapabilityTrace").mockResolvedValue(undefined)

    const input = baseRun({ planExecuteEnabled: true })
    const [on, off] = await Promise.all([
      plugin.run(input),
      plugin.run({ ...input, planExecuteEnabled: false }),
    ])
    expect(on.selectedSkills).toEqual(off.selectedSkills)
    expect(traceSpy).toHaveBeenCalledTimes(1)
    expect(traceSpy.mock.calls[0][1].outcome).toBe("empty")
  })

  it("规划器召回无候选：回退查表并记录 empty trace", async () => {
    const plugin = createSelectSkillsPlugin()
    vi.spyOn(hasUsableLlmModule, "hasUsableLlm").mockReturnValue(true)
    vi.spyOn(capabilityRetrieval, "retrieveCapabilities").mockReturnValue({
      candidates: [],
      filteredOut: [{ id: "zzz", reason: "low score" }],
    })
    const traceSpy = vi.spyOn(capabilityTraceStore, "appendCapabilityTrace").mockResolvedValue(undefined)

    const input = baseRun({ planExecuteEnabled: true })
    const [on, off] = await Promise.all([
      plugin.run(input),
      plugin.run({ ...input, planExecuteEnabled: false }),
    ])
    expect(on.selectedSkills).toEqual(off.selectedSkills)
    expect(traceSpy).toHaveBeenCalledTimes(1)
    const record = traceSpy.mock.calls[0][1]
    expect(record.outcome).toBe("empty")
    expect(record.detail).toBe("召回无候选")
    expect(record.retrieved).toEqual([])
  })

  it("projectPath 缺省时 trace 落盘跳过但主链不受影响", async () => {
    const plugin = createSelectSkillsPlugin()
    vi.spyOn(hasUsableLlmModule, "hasUsableLlm").mockReturnValue(true)
    vi.spyOn(capabilityRetrieval, "retrieveCapabilities").mockReturnValue({ candidates: [], filteredOut: [] })
    const traceSpy = vi.spyOn(capabilityTraceStore, "appendCapabilityTrace").mockResolvedValue(undefined)

    const input = baseRun({ projectPath: "", planExecuteEnabled: true })
    const [on, off] = await Promise.all([
      plugin.run(input),
      plugin.run({ ...input, planExecuteEnabled: false }),
    ])
    expect(on.selectedSkills).toEqual(off.selectedSkills)
    expect(traceSpy).not.toHaveBeenCalled()
  })
})

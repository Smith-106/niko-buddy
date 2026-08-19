import { describe, expect, it } from "vitest"
import {
  appendPlanningBlockToTaskBrief,
  buildPlanningPrefillBlock,
  taskBriefHasPlanningBlock,
  PLANNING_BLOCK_MARKER,
} from "./prefill"
import { buildChapterPlanView, type ChapterPlanInput } from "./aggregate"

function makePlanInput(): ChapterPlanInput {
  return {
    currentChapter: 8,
    chapterOutline: "林动在青山镇与应欢欢重逢",
    foreshadowing: {
      lastUpdated: "",
      items: [
        {
          id: "f1",
          name: "青铜古戒",
          description: "",
          status: "planted",
          plantedChapter: 2,
          advancedChapters: [],
          relatedCharacters: [],
          relatedEvents: [],
          notes: "",
        },
      ],
    },
    characterStates: {
      lastUpdated: "",
      characters: [
        {
          characterName: "林动",
          currentLocation: "青山镇",
          status: "健康",
          equipment: [],
          abilities: [],
          relationships: {},
          lastUpdatedChapter: 3,
          lastUpdatedAt: "",
        },
      ],
    },
    appearances: [{ character: "林动", chapters: [1, 3, 5] }],
    subplots: [
      {
        id: "s1",
        title: "宗门大比",
        status: "active",
        startChapter: 1,
        relatedCharacters: [],
        summary: "",
        progress: ["第1章：报名", "第2章：初赛", "第3章：复赛", "第4章：决赛"],
        notes: "",
      },
    ],
  }
}

describe("buildPlanningPrefillBlock", () => {
  it("渲染三类数据块并带 marker", () => {
    const plan = buildChapterPlanView(makePlanInput())
    const block = buildPlanningPrefillBlock(plan)
    expect(block).toContain(PLANNING_BLOCK_MARKER)
    expect(block).toContain("伏笔债务")
    expect(block).toContain("角色出场")
    expect(block).toContain("支线推进")
    expect(block).toContain("青铜古戒")
    expect(block).toContain("林动")
    expect(block).toContain("宗门大比")
  })

  it("degraded 维度渲染可见标记而非崩溃", () => {
    const plan = buildChapterPlanView(makePlanInput())
    plan.foreshadowing.status = "degraded"
    plan.characters.status = "degraded"
    plan.threads.status = "degraded"
    const block = buildPlanningPrefillBlock(plan)
    expect(block).toContain("数据源不可用")
    expect(block).toContain("伏笔债务")
    expect(block).toContain("角色出场")
    expect(block).toContain("支线推进")
  })

  it("超长块带截断标记", () => {
    const longPlan = buildChapterPlanView(makePlanInput())
    longPlan.characters.items[0].name = "林动".repeat(2000)
    const block = buildPlanningPrefillBlock(longPlan)
    expect(block.length).toBeLessThanOrEqual(1200 + 8)
    expect(block).toContain("已截断")
  })

  it("warning 级伏笔渲染 [warning] 行", () => {
    const plan = buildChapterPlanView({
      ...makePlanInput(),
      currentChapter: 20,
      foreshadowing: {
        lastUpdated: "",
        items: [
          {
            id: "f1",
            name: "神秘黑衣人",
            description: "",
            status: "advanced",
            plantedChapter: 1,
            advancedChapters: [1],
            relatedCharacters: [],
            relatedEvents: [],
            notes: "",
          },
        ],
      },
    })
    const block = buildPlanningPrefillBlock(plan)
    expect(block).toContain("  - [warning] 神秘黑衣人")
  })

  it("逾期未出场角色渲染 due 行", () => {
    const plan = buildChapterPlanView({
      ...makePlanInput(),
      currentChapter: 20,
      chapterOutline: "林动在青山镇修炼",
      characterStates: {
        lastUpdated: "",
        characters: [
          {
            characterName: "应欢欢",
            currentLocation: "",
            status: "",
            equipment: [],
            abilities: [],
            relationships: {},
            lastUpdatedChapter: 1,
            lastSeenChapter: 1,
            lastUpdatedAt: "",
          },
        ],
      },
      appearances: [],
    })
    const block = buildPlanningPrefillBlock(plan)
    expect(block).toContain("逾期未出场：应欢欢")
  })

  it("report 为 null 且状态 ok → 伏笔块静默跳过（防御分支）", () => {
    const plan = buildChapterPlanView(makePlanInput())
    plan.foreshadowing.report = null
    const block = buildPlanningPrefillBlock(plan)
    expect(block).not.toContain("伏笔债务")
    expect(block).toContain("角色出场")
  })

  it("大纲命中角色：无 lastSeen → ?；空状态 → 无状态后缀；isAlive false → 已退场", () => {
    const plan = buildChapterPlanView({
      ...makePlanInput(),
      chapterOutline: "林动在青山镇修炼",
      characterStates: {
        lastUpdated: "",
        characters: [
          {
            characterName: "林动",
            currentLocation: "",
            status: "",
            equipment: [],
            abilities: [],
            relationships: {},
            lastUpdatedChapter: 0,
            isAlive: false,
            lastUpdatedAt: "",
          },
        ],
      },
      appearances: [],
    })
    const block = buildPlanningPrefillBlock(plan)
    expect(block).toContain("上次出场第?章")
    expect(block).toContain("已退场")
    expect(block).not.toContain("，状态：")
  })

  it("支线 transitionViolation → 行尾标注", () => {
    const plan = buildChapterPlanView(makePlanInput())
    plan.threads.items[0] = {
      ...plan.threads.items[0],
      arcState: "Rising",
      transitionViolation: "Resolved 后仍有新增进度条目",
    }
    const block = buildPlanningPrefillBlock(plan)
    expect(block).toContain("Resolved 后仍有新增进度条目")
  })
})

describe("appendPlanningBlockToTaskBrief", () => {
  it("plan 为 null/undefined → 原样返回（fail-open）", () => {
    const brief = "写作任务书：写一章"
    expect(appendPlanningBlockToTaskBrief(brief, null)).toBe(brief)
    expect(appendPlanningBlockToTaskBrief(brief, undefined)).toBe(brief)
  })

  it("追加块到末尾且 base 原样保留（append-only）", () => {
    const brief = "写作任务书：写一章"
    const plan = buildChapterPlanView(makePlanInput())
    const out = appendPlanningBlockToTaskBrief(brief, plan)
    expect(out.startsWith(brief)).toBe(true)
    expect(out).toContain(PLANNING_BLOCK_MARKER)
    expect(out.length).toBeGreaterThan(brief.length)
  })

  it("空 task-brief → 仅返回块", () => {
    const plan = buildChapterPlanView(makePlanInput())
    const out = appendPlanningBlockToTaskBrief("", plan)
    expect(out).toContain(PLANNING_BLOCK_MARKER)
  })
})

describe("taskBriefHasPlanningBlock", () => {
  it("marker 检测（守卫在注入点，镜像 structure-plan 先例）", () => {
    const plan = buildChapterPlanView(makePlanInput())
    const once = appendPlanningBlockToTaskBrief("brief", plan)
    expect(taskBriefHasPlanningBlock(once)).toBe(true)
    // append-only：重复追加不覆盖既有内容（去重由注入点 taskBriefHasPlanningBlock 守卫）
    const twice = appendPlanningBlockToTaskBrief(once, plan)
    expect(twice.startsWith(once)).toBe(true)
    expect(twice.split(PLANNING_BLOCK_MARKER).length - 1).toBe(2)
  })

  it("无 marker → false", () => {
    expect(taskBriefHasPlanningBlock("普通任务书")).toBe(false)
  })
})

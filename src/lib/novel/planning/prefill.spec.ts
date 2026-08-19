import { describe, expect, it } from "vitest"
import {
  appendPlanningBlockToTaskBrief,
  buildPlanningPrefillBlock,
  taskBriefHasPlanningBlock,
  PLANNING_BLOCK_MARKER,
} from "./prefill"
import { buildChapterPlanView, type ChapterPlanInput } from "./aggregate"
import type { ForeshadowingStore } from "../foreshadowing-tracker"
import type { CharacterStateStore } from "../character-state"
import type { Subplot } from "../subplot-board"

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

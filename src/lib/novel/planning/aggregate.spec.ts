import { describe, expect, it } from "vitest"
import { buildChapterPlanView, type ChapterPlanInput } from "./aggregate"
import type { ForeshadowingStore } from "../foreshadowing-tracker"
import type { CharacterStateStore } from "../character-state"
import type { Subplot } from "../subplot-board"

function makeForeshadowingStore(): ForeshadowingStore {
  return {
    lastUpdated: "2026-08-18T00:00:00.000Z",
    items: [
      {
        id: "f1",
        name: "青铜古戒",
        description: "主角戒指的秘密",
        status: "planted",
        plantedChapter: 2,
        advancedChapters: [],
        relatedCharacters: ["林动"],
        relatedEvents: [],
        notes: "",
      },
      {
        id: "f2",
        name: "神秘黑衣人",
        description: "幕后黑手",
        status: "advanced",
        plantedChapter: 1,
        advancedChapters: [5],
        relatedCharacters: [],
        relatedEvents: [],
        notes: "",
      },
      {
        id: "f3",
        name: "已回收伏笔",
        description: "已解决",
        status: "resolved",
        plantedChapter: 1,
        advancedChapters: [3],
        resolvedChapter: 4,
        relatedCharacters: [],
        relatedEvents: [],
        notes: "",
      },
    ],
  }
}

function makeCharacterStore(): CharacterStateStore {
  return {
    lastUpdated: "2026-08-18T00:00:00.000Z",
    characters: [
      {
        characterName: "林动",
        currentLocation: "青山镇",
        status: "健康",
        equipment: [],
        abilities: [],
        relationships: {},
        lastUpdatedChapter: 3,
        lastUpdatedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        characterName: "应欢欢",
        currentLocation: "道宗",
        status: "闭关",
        equipment: [],
        abilities: [],
        relationships: {},
        lastUpdatedChapter: 1,
        lastUpdatedAt: "2026-08-01T00:00:00.000Z",
      },
    ],
  }
}

function makeSubplots(): Subplot[] {
  return [
    {
      id: "s1",
      title: "宗门大比",
      status: "active",
      startChapter: 1,
      relatedCharacters: ["林动"],
      summary: "",
      progress: ["第1章：报名", "第2章：初赛", "第3章：复赛", "第4章：决赛"],
      notes: "",
    },
    {
      id: "s2",
      title: "寻父线",
      status: "active",
      startChapter: 1,
      relatedCharacters: [],
      summary: "",
      progress: ["第1章：线索"],
      notes: "",
    },
  ]
}

function makeInput(overrides: Partial<ChapterPlanInput> = {}): ChapterPlanInput {
  return {
    currentChapter: 8,
    chapterOutline: "林动在青山镇与应欢欢重逢，宗门大比决战开启",
    foreshadowing: makeForeshadowingStore(),
    characterStates: makeCharacterStore(),
    appearances: [
      { character: "林动", chapters: [1, 2, 3, 5, 7] },
      { character: "应欢欢", chapters: [1] },
    ],
    subplots: makeSubplots(),
    ...overrides,
  }
}

describe("buildChapterPlanView", () => {
  it("组合三类数据并产出 summary（债务分/开放支线/逾期角色）", () => {
    const view = buildChapterPlanView(makeInput())
    expect(view.chapterNumber).toBe(8)
    expect(view.summary.openThreads).toBe(2)
    // 逾期角色：应欢欢上次第1章出场，距第8章 7 章 < 10 → 不计；林动大纲命中 → 不计
    expect(view.summary.charactersDue).toBe(0)
    expect(view.foreshadowing.status).toBe("ok")
    expect(view.characters.status).toBe("ok")
    expect(view.threads.status).toBe("ok")
  })

  it("伏笔按 debtLevel 排序且 resolved 被排除", () => {
    const view = buildChapterPlanView(makeInput())
    const names = view.foreshadowing.report!.items.map((i) => i.name)
    // 第2章植入的 planted 伏笔（8-2=6 章）应为 critical 或 warning，排在 advanced 之前
    expect(names).not.toContain("已回收伏笔")
    expect(names[0]).toBe("青铜古戒")
  })

  it("角色按大纲命中优先、其次最久未出场排序", () => {
    // 大纲只命中林动（应欢欢不在大纲 → 未命中优先序靠后）
    const view = buildChapterPlanView(makeInput({ chapterOutline: "林动在青山镇修炼，宗门大比决战开启" }))
    const items = view.characters.items
    expect(items[0].name).toBe("林动")
    expect(items[0].inCurrentOutline).toBe(true)
    expect(items[1].name).toBe("应欢欢")
    expect(items[1].inCurrentOutline).toBe(false)
    // 应欢欢 store.lastSeenChapter=1，快照出场 [1] → 距第8章 7 章
    expect(items[1].chaptersSinceSeen).toBe(7)
  })

  it("lastSeen 取 store 与快照出场索引的较新者", () => {
    const view = buildChapterPlanView(makeInput({ chapterOutline: "林动在青山镇修炼" }))
    const lin = view.characters.items.find((c) => c.name === "林动")!
    // store.lastSeenChapter=3，快照出场末位 7 → 取 7
    expect(lin.lastSeenChapter).toBe(7)
    expect(lin.chaptersSinceSeen).toBe(1)
  })

  it("dormantThreshold 生效：超过阈值的未出场角色计入 charactersDue", () => {
    const view = buildChapterPlanView(
      makeInput({ chapterOutline: "林动在青山镇修炼，宗门大比决战开启" }),
      { dormantThreshold: 5 },
    )
    expect(view.summary.charactersDue).toBe(1)
  })

  it("无大纲时 inCurrentOutline 全 false 且不抛错", () => {
    const view = buildChapterPlanView(makeInput({ chapterOutline: undefined }))
    expect(view.characters.items.every((c) => !c.inCurrentOutline)).toBe(true)
  })

  it("空数据源 → ok 状态 + 空列表（合法空数据非 degraded）", () => {
    const view = buildChapterPlanView(
      makeInput({
        foreshadowing: { items: [], lastUpdated: "" },
        characterStates: { characters: [], lastUpdated: "" },
        appearances: [],
        subplots: [],
      }),
    )
    expect(view.foreshadowing.status).toBe("ok")
    expect(view.foreshadowing.report!.items).toEqual([])
    expect(view.characters.items).toEqual([])
    expect(view.threads.items).toEqual([])
    expect(view.summary.openThreads).toBe(0)
  })

  it("foreshadowingTopN / charactersTopN 截断生效", () => {
    const view = buildChapterPlanView(makeInput(), { foreshadowingTopN: 1, charactersTopN: 1 })
    expect(view.foreshadowing.report!.items).toHaveLength(1)
    expect(view.characters.items).toHaveLength(1)
  })
})

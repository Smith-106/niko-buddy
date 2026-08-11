import { describe, expect, it } from "vitest"
import { contextPackToPrompt, type ContextPack } from "./context-engine"

function basePack(over: Partial<ContextPack> = {}): ContextPack {
  return {
    task: "写第7章",
    chapterGoal: "推进主线",
    mustDo: ["完成对峙"],
    mustAvoid: ["OOC"],
    soulDoc: "冷峻现实主义",
    outline: "卷1 第7章大纲…",
    recentSummaries: ["第6章摘要"],
    characterStates: "白昼：持戒",
    recentChapterContents: ["超长正文" + "甲".repeat(500)],
    canonRules: ["禁止时间旅行"],
    communitySummaries: "社区A：码头势力",
    activeEntities: [{ name: "白昼", tags: ["主角"] }],
    ...over,
  } as ContextPack
}

describe("layered recall + section budget (S2)", () => {
  it("default omits L0 recentChapterContents", () => {
    const p = contextPackToPrompt(basePack(), undefined, { layeredRecall: "default" })
    expect(p).toContain("写第7章")
    expect(p).toContain("推进主线")
    expect(p).not.toContain("超长正文")
  })

  it("full includes L0 recentChapterContents", () => {
    const p = contextPackToPrompt(basePack(), undefined, { layeredRecall: "full" })
    expect(p).toContain("超长正文")
  })

  it("scenario_persona without temporal skips canonRules", () => {
    const p = contextPackToPrompt(basePack(), undefined, {
      layeredRecall: "scenario_persona",
      temporalFactsEnabled: false,
    })
    expect(p).not.toContain("禁止时间旅行")
    expect(p).toContain("冷峻现实主义")
  })

  it("sectionCharBudget truncates long sections", () => {
    const p = contextPackToPrompt(basePack({ soulDoc: "魂".repeat(200) }), undefined, {
      sectionCharBudget: 40,
      layeredRecall: "default",
    })
    expect(p).toContain("…")
    expect(p.length).toBeLessThan(contextPackToPrompt(basePack({ soulDoc: "魂".repeat(200) })).length)
  })

  it("activeEntities only with temporal or full", () => {
    const pack = basePack({
      characterStates: "角色状态占位",
      activeEntities: [{ entityId: "ent-probe", name: "实体探针XYZ", type: "character", tags: ["主角"] }],
    })
    const off = contextPackToPrompt(pack, undefined, {
      layeredRecall: "default",
      temporalFactsEnabled: false,
    })
    expect(off).not.toContain("实体探针XYZ")
    const on = contextPackToPrompt(pack, undefined, {
      layeredRecall: "default",
      temporalFactsEnabled: true,
    })
    expect(on).toContain("实体探针XYZ")
  })
})

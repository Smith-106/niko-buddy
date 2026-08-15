import { describe, expect, it } from "vitest"
import {
  buildRelatedChapters,
  findOverdueForeshadowing,
  relatedChaptersToContextText,
  buildAppearancesFromSnapshots,
  RelatedChaptersInput,
} from "./related-chapters"

function makeInput(overrides: Partial<RelatedChaptersInput> = {}): RelatedChaptersInput {
  return {
    currentChapter: 20,
    chapterOutline: "白砚与苏未晞对峙，轩辕剑的秘密浮出水面。",
    foreshadowing: {
      items: [
        { id: "f1", name: "轩辕剑封印", description: "剑中封印的真相", status: "planted", plantedChapter: 3, advancedChapters: [], relatedCharacters: ["白砚"], relatedEvents: [], notes: "" },
        { id: "f2", name: "玉佩来历", description: "玉佩的来龙去脉", status: "advanced", plantedChapter: 5, advancedChapters: [12], relatedCharacters: ["苏未晞"], relatedEvents: [], notes: "" },
        { id: "f3", name: "已解决伏笔", description: "x", status: "resolved", plantedChapter: 2, advancedChapters: [8], resolvedChapter: 9, relatedCharacters: [], relatedEvents: [], notes: "" },
      ],
      lastUpdated: "",
    },
    appearances: [
      { character: "白砚", chapters: [2, 8, 14] },
      { character: "苏未晞", chapters: [3, 9, 16] },
      { character: "路人甲", chapters: [1, 5] },
    ],
    stateChanges: [
      { entity: "白砚", chapter: 14, change: "得到轩辕剑" },
      { entity: "轩辕剑", chapter: 6, change: "剑身裂纹" },
    ],
    relationships: [
      { pair: "白砚-苏未晞", chapter: 9, description: "结盟" },
      { pair: "白砚-路人甲", chapter: 5, description: "旧识" },
    ],
    ...overrides,
  }
}

describe("S2a related-chapters 四维反查 (ainovel buildRelatedChapters)", () => {
  it("四维反查: 伏笔+出场+状态+关系全部命中", () => {
    const input = makeInput()
    const results = buildRelatedChapters(input)
    // recentWindow=10 → 只保留 <= 10 章
    const reasons = new Set(results.flatMap((r) => r.reasons))
    expect(reasons.has("foreshadow")).toBe(true) // 伏笔 3
    expect(reasons.has("character")).toBe(true) // 白砚最后出场 8? 但 8 < minChapter(10) ✓
    expect(reasons.has("state_change")).toBe(true) // 轩辕剑 15? 15 >= minChapter(10) 被 recentWindow 排除; 白砚 14 也排除
    expect(results.length).toBeGreaterThan(0)
    // 最近章优先排序
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.chapter).toBeLessThanOrEqual(results[i - 1]!.chapter)
    }
  })

  it("recentWindow 去噪: 最近 10 章内不推荐", () => {
    const input = makeInput()
    const results = buildRelatedChapters(input, { recentWindow: 10 })
    for (const r of results) {
      expect(r.chapter).toBeLessThanOrEqual(10)
      expect(r.chapter).toBeLessThan(20)
    }
  })

  it("maxResults 截断 (默认 5, ainovel 一致)", () => {
    const input = makeInput({
      appearances: Array.from({ length: 8 }, (_, i) => ({
        character: `角色${i}`,
        chapters: [1 + i],
      })),
      chapterOutline: "角色0 角色1 角色2 角色3 角色4 角色5 角色6 角色7",
    })
    const results = buildRelatedChapters(input)
    expect(results.length).toBeLessThanOrEqual(5)
  })

  it("resolved 伏笔不参与反查", () => {
    const input = makeInput()
    const results = buildRelatedChapters(input)
    for (const r of results) {
      expect(r.matchedEntities).not.toContain("已解决伏笔")
    }
  })

  it("同章多原因合并 (去重)", () => {
    // 白砚在 8 章出场且 8 章也有状态变化 → 同章两条原因合并
    const input = makeInput({
      appearances: [{ character: "白砚", chapters: [8] }],
      stateChanges: [{ entity: "白砚", chapter: 8, change: "重伤" }],
    })
    const results = buildRelatedChapters(input)
    const ch8 = results.find((r) => r.chapter === 8)
    expect(ch8).toBeDefined()
    expect(ch8!.reasons).toContain("character")
    expect(ch8!.reasons).toContain("state_change")
  })

  it("relatedChaptersToContextText 渲染文本", () => {
    const input = makeInput()
    const results = buildRelatedChapters(input)
    const text = relatedChaptersToContextText(results)
    expect(text).toContain("相关章节反查")
    if (results.length > 0) {
      expect(text).toContain("第")
      expect(text).toContain("章")
    }
  })
})

describe("S2a 伏笔台账接线 (逾期>5章→finding)", () => {
  it("planted 伏笔逾期超过阈值 → finding (与 foreshadowing-debt plantedStale=5 一致)", () => {
    const input = makeInput()
    const findings = findOverdueForeshadowing(input.foreshadowing, 20)
    // f1 planted 于 3, 当前 20 → 17 章 > 5 → finding
    expect(findings.length).toBe(1)
    expect(findings[0]!.name).toBe("轩辕剑封印")
    expect(findings[0]!.chaptersSincePlanted).toBe(17)
    expect(findings[0]!.finding).toContain("逾期")
  })

  it("advanced 状态伏笔不报逾期 (只查 planted)", () => {
    const input = makeInput()
    const findings = findOverdueForeshadowing(input.foreshadowing, 20)
    expect(findings.some((f) => f.name === "玉佩来历")).toBe(false)
  })

  it("阈值可配置", () => {
    const input = makeInput()
    // 阈值 20 → 17 章不算逾期
    const findings = findOverdueForeshadowing(input.foreshadowing, 20, { foreshadowStaleThreshold: 20 })
    expect(findings).toHaveLength(0)
  })
})

describe("S2a buildAppearancesFromSnapshots (快照→出场索引)", () => {
  it("从 ChapterSnapshot 构建角色出场索引 (去重升序)", () => {
    const snapshots = [
      { chapterNumber: 1, characters: ["白砚", "苏未晞"] },
      { chapterNumber: 3, characters: ["白砚"] },
      { chapterNumber: 5, characters: ["苏未晞", "路人甲"] },
    ] as unknown as Array<{ chapterNumber: number; characters: string[] }>
    const appearances = buildAppearancesFromSnapshots(snapshots as never)
    const baiyan = appearances.find((a) => a.character === "白砚")!
    expect(baiyan.chapters).toEqual([1, 3])
    const suwei = appearances.find((a) => a.character === "苏未晞")!
    expect(suwei.chapters).toEqual([1, 5])
  })
})

describe("S2a context-engine 融合 (buildRelatedChaptersContext)", () => {
  it("组合四维反查 + 伏笔逾期 finding → 注入文本", async () => {
    const { buildRelatedChaptersContext } = await import("./context-engine")
    const input = makeInput()
    const result = buildRelatedChaptersContext({
      currentChapter: 20,
      chapterOutline: "白砚与苏未晞对峙，轩辕剑的秘密浮出水面。",
      foreshadowing: input.foreshadowing,
      appearances: input.appearances,
      stateChanges: input.stateChanges,
      relationships: input.relationships,
    })
    expect(result.related.length).toBeGreaterThan(0)
    expect(result.overdueFindings.length).toBe(1) // 轩辕剑封印 逾期 17 章
    expect(result.text).toContain("相关章节反查")
    expect(result.text).toContain("伏笔逾期提醒")
    expect(result.text).toContain("轩辕剑封印")
  })

  it("无相关内容时 text 为空串", async () => {
    const { buildRelatedChaptersContext } = await import("./context-engine")
    const emptyStore = { items: [], lastUpdated: "" }
    const result = buildRelatedChaptersContext({
      currentChapter: 20,
      chapterOutline: "",
      foreshadowing: emptyStore,
    })
    expect(result.related).toHaveLength(0)
    expect(result.overdueFindings).toHaveLength(0)
    expect(result.text).toBe("")
  })

  it("snapshots 构造 appearances (融合路径)", async () => {
    const { buildRelatedChaptersContext } = await import("./context-engine")
    const input = makeInput()
    const snapshots = [
      { chapterNumber: 8, characters: ["白砚"] },
      { chapterNumber: 6, characters: ["白砚"] },
    ]
    const result = buildRelatedChaptersContext({
      currentChapter: 20,
      chapterOutline: "白砚归来",
      foreshadowing: { items: [], lastUpdated: "" },
      snapshots: snapshots as never,
    })
    expect(result.related.some((r) => r.reasons.includes("character") && r.chapter === 8)).toBe(true)
  })
})

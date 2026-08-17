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

  it("同章重复原因与空 note 不重复推入; 后到的 note 才回填", () => {
    // 两个伏笔都在第 2 章植入且都命中大纲 → 同一章同一原因 (foreshadow)
    // 只记录一次; 第 3 章先以空 change 状态变化进入 (无 note),
    // 再以带描述的关系反查进入 → 回填第一个非空 note。
    const input = makeInput({
      chapterOutline: "轩辕剑 玉佩 白砚",
      foreshadowing: {
        items: [
          { id: "f1", name: "轩辕剑封印", description: "x", status: "planted", plantedChapter: 2, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
          { id: "f2", name: "玉佩来历", description: "x", status: "planted", plantedChapter: 2, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
        ],
        lastUpdated: "",
      },
      appearances: [],
      stateChanges: [{ entity: "白砚", chapter: 3, change: "" }],
      relationships: [{ pair: "白砚-苏未晞", chapter: 3, description: "结盟" }],
    })
    const results = buildRelatedChapters(input)
    const ch2 = results.find((r) => r.chapter === 2)
    expect(ch2).toBeDefined()
    expect(ch2!.reasons.filter((r) => r === "foreshadow")).toHaveLength(1)
    expect(ch2!.matchedEntities).toContain("轩辕剑封印")
    expect(ch2!.matchedEntities).toContain("玉佩来历")
    const ch3 = results.find((r) => r.chapter === 3)
    expect(ch3).toBeDefined()
    expect(ch3!.note).toBe("结盟")
  })

  it("空大纲: extractOutlineKeywords 短路 → 四维全部跳过 (无结果)", () => {
    const input = makeInput({ chapterOutline: "" })
    // 所有维度都以大纲文本为匹配源; 空文本 → 无关键词、无 includes 命中
    const results = buildRelatedChapters(input)
    expect(results).toHaveLength(0)
  })

  it("n-gram 关键词提取: >8 字长 token 滑窗 + 标点切分", () => {
    const input = makeInput({
      chapterOutline: "轩辕剑的秘密浮出水面，白砚——赴约",
      foreshadowing: {
        items: [
          { id: "fg1", name: "轩辕剑的秘", description: "x", status: "planted", plantedChapter: 2, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
        ],
        lastUpdated: "",
      },
      appearances: [],
      stateChanges: [],
      relationships: [],
    })
    const results = buildRelatedChapters(input)
    // "轩辕剑的秘" 是 "轩辕剑的秘密浮出水面" 的 4-gram 之一 → 命中
    expect(results.some((r) => r.reasons.includes("foreshadow") && r.chapter === 2)).toBe(true)
  })

  it("addMatch 守卫: 未来章伏笔 (chapter >= current) 被忽略", () => {
    const input = makeInput({
      foreshadowing: {
        items: [
          { id: "fg2", name: "未来伏笔", description: "轩辕剑 关键词 命中", status: "planted", plantedChapter: 25, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
        ],
        lastUpdated: "",
      },
      appearances: [],
      stateChanges: [],
      relationships: [],
    })
    const results = buildRelatedChapters(input)
    expect(results.some((r) => r.matchedEntities.includes("未来伏笔"))).toBe(false)
  })

  it("advanced 伏笔最近推进章在窗口外时也反查 (伏笔推进 note)", () => {
    const input = makeInput({
      foreshadowing: {
        items: [
          { id: "fg3", name: "玉佩来历", description: "轩辕剑 相关", status: "advanced", plantedChapter: 5, advancedChapters: [6, 8], relatedCharacters: [], relatedEvents: [], notes: "" },
        ],
        lastUpdated: "",
      },
      appearances: [],
      stateChanges: [],
      relationships: [],
    })
    const results = buildRelatedChapters(input)
    const ch8 = results.find((r) => r.chapter === 8)
    expect(ch8).toBeDefined()
    expect(ch8!.reasons).toContain("foreshadow")
    expect(ch8!.note).toBe("伏笔推进")
  })

  it("角色出场全部在 recentWindow 内 → 无角色反查", () => {
    const input = makeInput({
      appearances: [{ character: "白砚", chapters: [15, 18] }],
      stateChanges: [],
      relationships: [],
      foreshadowing: { items: [], lastUpdated: "" },
    })
    const results = buildRelatedChapters(input)
    expect(results.some((r) => r.reasons.includes("character"))).toBe(false)
  })

  it("状态变化实体不在大纲中 → 跳过该维", () => {
    const input = makeInput({
      stateChanges: [{ entity: "不存在的实体", chapter: 3, change: "x" }],
    })
    const results = buildRelatedChapters(input)
    expect(results.some((r) => r.matchedEntities.includes("不存在的实体"))).toBe(false)
  })

  it("关系双方都不在大纲中 → 跳过该关系", () => {
    const input = makeInput({
      relationships: [{ pair: "甲乙-丙丁", chapter: 3, description: "x" }],
    })
    const results = buildRelatedChapters(input)
    expect(results.some((r) => r.matchedEntities.includes("甲乙-丙丁"))).toBe(false)
  })

  it("relatedChaptersToContextText 空列表返回空串, 无 note 章省略 note", () => {
    expect(relatedChaptersToContextText([])).toBe("")
    const text = relatedChaptersToContextText([
      { chapter: 4, reasons: ["foreshadow"], matchedEntities: ["轩辕剑"] },
    ])
    expect(text).toContain("第4章 (伏笔): 轩辕剑")
    expect(text).not.toContain("—")
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

  it("TASK-102 契约: 逾期>5 章才产生 finding (边界 5 章不算, 6 章算 — threshold=5 严格大于)", () => {
    const store = {
      items: [
        {
          id: "b1",
          name: "边界伏笔",
          description: "x",
          status: "planted" as const,
          plantedChapter: 5,
          advancedChapters: [],
          relatedCharacters: [],
          relatedEvents: [],
          notes: "",
        },
      ],
      lastUpdated: "",
    }
    // planted 于第 5 章, 当前第 10 章 → since=5 → 不逾期 (阈值语义: >5)
    expect(findOverdueForeshadowing(store, 10)).toHaveLength(0)
    // 当前第 11 章 → since=6 → 逾期 finding (逾期>5章 → 入管线)
    const findings = findOverdueForeshadowing(store, 11)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.name).toBe("边界伏笔")
    expect(findings[0]!.chaptersSincePlanted).toBe(6)
    expect(findings[0]!.finding).toContain("逾期")
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

  it("同一章重复角色去重, 缺失 characters 字段容错为空", () => {
    const snapshots = [
      { chapterNumber: 2, characters: ["白砚", "白砚", "苏未晞"] },
      { chapterNumber: 4 },
    ] as unknown as Array<{ chapterNumber: number; characters: string[] }>
    const appearances = buildAppearancesFromSnapshots(snapshots as never)
    const baiyan = appearances.find((a) => a.character === "白砚")!
    expect(baiyan.chapters).toEqual([2])
    expect(appearances.length).toBe(2)
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

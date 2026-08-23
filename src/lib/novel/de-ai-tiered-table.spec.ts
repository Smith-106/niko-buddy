import { describe, expect, it } from "vitest"
import {
  TIERED_DEAI_TABLE,
  computeTieredDeAiStats,
  detectTieredDeAi,
  filterTieredDeAiHitsByTier,
  groupTieredDeAiByTier,
  groupTieredDeAiByCategory,
  type TieredDeAiTier,
  type TieredDeAiCategory,
} from "./de-ai-tiered-table"

describe("de-ai-tiered-table — F-009 分级替换表", () => {
  // ── 112 词完整性 ──
  it("TIERED_DEAI_TABLE 共 112 词 (62 1A + 38 1B + 12 3)", () => {
    expect(TIERED_DEAI_TABLE.length).toBe(112)
    const byTier = groupTieredDeAiByTier()
    expect(byTier["1A"].length).toBe(62)
    expect(byTier["1B"].length).toBe(38)
    expect(byTier["3"].length).toBe(12)
  })

  it("computeTieredDeAiStats 统计一致", () => {
    const stats = computeTieredDeAiStats()
    expect(stats.totalEntries).toBe(112)
    expect(stats.tierCounts["1A"]).toBe(62)
    expect(stats.tierCounts["1B"]).toBe(38)
    expect(stats.tierCounts["3"]).toBe(12)
    expect(stats.uniqueTerms).toBe(112) // 无重复词
  })

  // ── 无重复词条 ──
  it("所有 term 唯一 (无重复)", () => {
    const terms = TIERED_DEAI_TABLE.map((e) => e.term)
    const unique = new Set(terms)
    expect(unique.size).toBe(terms.length)
  })

  // ── 权重范围合法 ──
  it("权重范围 0-1 合法", () => {
    const stats = computeTieredDeAiStats()
    expect(stats.weightRange.min).toBeGreaterThanOrEqual(0)
    expect(stats.weightRange.max).toBeLessThanOrEqual(1)
    // 1A 权重 >= 0.6
    for (const entry of TIERED_DEAI_TABLE) {
      if (entry.tier === "1A") {
        expect(entry.weight).toBeGreaterThanOrEqual(0.6)
      }
    }
    // 1B 权重 0.3-0.5
    for (const entry of TIERED_DEAI_TABLE) {
      if (entry.tier === "1B") {
        expect(entry.weight).toBeGreaterThanOrEqual(0.3)
        expect(entry.weight).toBeLessThanOrEqual(0.5)
      }
    }
    // 3 权重 < 0.3
    for (const entry of TIERED_DEAI_TABLE) {
      if (entry.tier === "3") {
        expect(entry.weight).toBeLessThanOrEqual(0.2)
      }
    }
  })

  // ── 3 档分类正确 ──
  it("每个条目有 valid tier", () => {
    const validTiers: TieredDeAiTier[] = ["1A", "1B", "3"]
    for (const entry of TIERED_DEAI_TABLE) {
      expect(validTiers).toContain(entry.tier)
    }
  })

  it("每个条目有 category 和 suggestion", () => {
    for (const entry of TIERED_DEAI_TABLE) {
      expect(entry.category).toBeTruthy()
      expect(entry.suggestion).toBeTruthy()
    }
  })

  it("所有条目的 term 非空", () => {
    for (const entry of TIERED_DEAI_TABLE) {
      expect(entry.term.trim()).toBeTruthy()
    }
  })

  // ── 分类覆盖 ──
  it("1A 覆盖所有核心分类 (总结腔/解释腔/模板句首/空洞形容/转折滥用/AI特征词/套话/机械句式/叙事缺陷/冗余)", () => {
    const byCategory = groupTieredDeAiByCategory()
    const expected1ACategories: TieredDeAiCategory[] = [
      "总结腔", "解释腔", "模板句首", "空洞形容", "转折滥用",
      "AI特征词", "套话", "机械句式", "叙事缺陷", "冗余",
    ]
    for (const cat of expected1ACategories) {
      expect(byCategory[cat]).toBeDefined()
      expect(byCategory[cat]!.length).toBeGreaterThan(0)
    }
  })

  it("1B 覆盖弱信号分类 (装饰副词/模糊限制/冗余修饰/节奏拖沓/机械过渡/平淡动作/解释腔弱化)", () => {
    const byCategory = groupTieredDeAiByCategory()
    const expected1BCategories: TieredDeAiCategory[] = [
      "装饰副词", "模糊限制", "冗余修饰", "节奏拖沓", "机械过渡", "平淡动作", "解释腔弱化",
    ]
    for (const cat of expected1BCategories) {
      expect(byCategory[cat]).toBeDefined()
      expect(byCategory[cat]!.length).toBeGreaterThan(0)
    }
  })

  it("3 覆盖弱提示分类 (轻度AI腔/弱解释/通用模糊)", () => {
    const byCategory = groupTieredDeAiByCategory()
    const expected3Categories: TieredDeAiCategory[] = ["轻度AI腔", "弱解释", "通用模糊"]
    for (const cat of expected3Categories) {
      expect(byCategory[cat]).toBeDefined()
      expect(byCategory[cat]!.length).toBeGreaterThan(0)
    }
  })

  // ── detectTieredDeAi 检测 ──
  it("detectTieredDeAi 检测 1A 高权重词", () => {
    const text = "显然，事实上这一切都毫无疑问。"
    const hits = detectTieredDeAi(text)
    expect(hits.length).toBeGreaterThanOrEqual(3)
    const terms = hits.map((h) => h.entry.term)
    expect(terms).toContain("显然")
    expect(terms).toContain("事实上")
    expect(terms).toContain("这一切")
    expect(terms).toContain("毫无疑问")
  })

  it("detectTieredDeAi 检测 1B 低权重词", () => {
    const text = "他缓缓点了点头，过了一会儿才开口。"
    const hits = detectTieredDeAi(text)
    expect(hits.length).toBeGreaterThanOrEqual(2)
    const terms = hits.map((h) => h.entry.term)
    expect(terms).toContain("缓缓")
    expect(terms).toContain("过了一会儿")
  })

  it("detectTieredDeAi 检测 3 弱提示词", () => {
    const text = "他不禁下意识地感到某种不安。"
    const hits = detectTieredDeAi(text)
    expect(hits.length).toBeGreaterThanOrEqual(2)
    const terms = hits.map((h) => h.entry.term)
    expect(terms).toContain("不禁")
    expect(terms).toContain("下意识")
  })

  it("detectTieredDeAi 空文本返回空数组", () => {
    expect(detectTieredDeAi("")).toEqual([])
    expect(detectTieredDeAi(null as unknown as string)).toEqual([])
  })

  it("detectTieredDeAi 干净文本返回空数组", () => {
    const text = "白昼。他推开门，看见旧钥匙。"
    expect(detectTieredDeAi(text)).toEqual([])
  })

  it("detectTieredDeAi 统计命中次数", () => {
    const text = "但是……但是……但是。然而。"
    const hits = detectTieredDeAi(text)
    const but = hits.find((h) => h.entry.term === "但是")
    expect(but).toBeDefined()
    expect(but!.count).toBe(3)
    const ran = hits.find((h) => h.entry.term === "然而")
    expect(ran).toBeDefined()
    expect(ran!.count).toBe(1)
  })

  // ── filterTieredDeAiHitsByTier ──
  it("filterTieredDeAiHitsByTier 按 tier 过滤", () => {
    const text = "显然，他缓缓点了点头，不禁感到不安。"
    const hits = detectTieredDeAi(text)
    const highHits = filterTieredDeAiHitsByTier(hits, "1A")
    const lowHits = filterTieredDeAiHitsByTier(hits, "1B")
    const weakHits = filterTieredDeAiHitsByTier(hits, "3")
    expect(highHits.length).toBeGreaterThan(0)
    expect(lowHits.length).toBeGreaterThan(0)
    expect(weakHits.length).toBeGreaterThan(0)
    for (const h of highHits) expect(h.entry.tier).toBe("1A")
    for (const h of lowHits) expect(h.entry.tier).toBe("1B")
    for (const h of weakHits) expect(h.entry.tier).toBe("3")
  })

  // ── groupTieredDeAiByCategory ──
  it("groupTieredDeAiByCategory 分组覆盖所有分类", () => {
    const byCategory = groupTieredDeAiByCategory()
    const categoryCount = Object.keys(byCategory).length
    expect(categoryCount).toBeGreaterThanOrEqual(17) // 至少 17 个分类
    // 各分类总词数 = 112
    const total = Object.values(byCategory).reduce((s, entries) => s + entries.length, 0)
    expect(total).toBe(112)
  })
})
import { describe, expect, it } from "vitest"

import { detectAssetExtractionGaps, type ExtractionGapInput } from "./asset-extraction-gap"

// 多字名：单字名在本口径里恒 N/A（无法可靠判人），所以缺口判定必须用可靠名做夹具。
const TEXT = [
  "张三推门进来，李四正在擦剑。",
  "王五站在门外，谁也没说话。",
  "张三对李四说：这次我们一起去。",
].join("\n")

const BASE: ExtractionGapInput = {
  chapterNumber: 7,
  chapterText: TEXT,
  characters: [
    { characterName: "张三", relationships: {} },
    { characterName: "李四", relationships: {} },
  ],
  charactersLoaded: true,
  wikiCharacterNames: ["张三", "李四", "王五"],
  wikiLoaded: true,
}

describe("detectAssetExtractionGaps", () => {
  it("wiki 有人物实体、正文出现、角色状态没有 → character_not_in_state，带章号证据", () => {
    const result = detectAssetExtractionGaps(BASE)
    const gap = result.gaps.find((item) => item.code === "character_not_in_state")
    expect(gap?.subject).toBe("王五")
    expect(gap?.evidence).toContain("第 7 章")
    expect(gap?.evidence).toContain("王五")
    expect(result.checked).toBe(true)
  })

  it("同句共现但两侧都没有关系 → relationship_not_in_state（去重、句内顺序）", () => {
    const result = detectAssetExtractionGaps(BASE)
    const pairs = result.gaps
      .filter((item) => item.code === "relationship_not_in_state")
      .map((item) => item.subject)
    expect(pairs).toEqual(["张三→李四"])
    // 张三/李四 在两句里都出现，仍然只报一条
    expect(pairs).toHaveLength(1)
  })

  it("任一侧已有该关系 → 不算缺口", () => {
    const result = detectAssetExtractionGaps({
      ...BASE,
      characters: [
        { characterName: "张三", relationships: { 李四: "并肩多年的搭档" } },
        { characterName: "李四", relationships: {} },
      ],
    })
    expect(result.gaps.some((item) => item.code === "relationship_not_in_state")).toBe(false)
  })

  it("单字名恒 N/A：wiki 有「王」、正文只有「王府」也不报缺口", () => {
    const result = detectAssetExtractionGaps({
      ...BASE,
      chapterText: "他走进王府，院中无人。",
      characters: [{ characterName: "长庚", relationships: {} }],
      wikiCharacterNames: ["王"],
    })
    expect(result.gaps).toEqual([])
    expect(result.na.some((line) => line.includes("单字名无法可靠判定"))).toBe(true)
    expect(result.na.some((line) => line.includes("王"))).toBe(true)
  })

  it("单字名也被排除在关系候选之外（王→李四 不产生假关系）", () => {
    const result = detectAssetExtractionGaps({
      ...BASE,
      chapterText: "王府与李四旧识重逢。",
      characters: [
        { characterName: "王", relationships: {} },
        { characterName: "李四", relationships: {} },
      ],
      wikiCharacterNames: ["王", "李四"],
    })
    expect(result.gaps.filter((item) => item.code === "relationship_not_in_state")).toEqual([])
  })

  it("最长匹配：更长的已知名覆盖时不算短名出现（王 ⊂ 王府）", () => {
    const result = detectAssetExtractionGaps({
      ...BASE,
      chapterText: "他走进王府，院中无人。",
      characters: [{ characterName: "长庚", relationships: {} }],
      wikiCharacterNames: ["王", "王府"],
    })
    // 「王府」本身是 wiki 实体且命中 → 只有它进缺口，「王」被覆盖不算
    const subjects = result.gaps.map((item) => item.subject).sort()
    expect(subjects).toEqual(["王府"])
  })

  it("关系候选有上限：同句多人只列最近的 N 条，并写明截断", () => {
    const names = ["甲一", "乙二", "丙三", "丁四", "戊五", "己六", "庚七"]
    const result = detectAssetExtractionGaps({
      ...BASE,
      chapterText: `${names.join("、")}都在场。`,
      characters: names.map((name) => ({ characterName: name, relationships: {} })),
      wikiCharacterNames: [],
    })
    const pairs = result.gaps.filter((item) => item.code === "relationship_not_in_state")
    expect(names.length * (names.length - 1) / 2).toBe(21)
    expect(pairs.length).toBe(20)
    expect(result.na.some((line) => line.includes("只列前 20 条"))).toBe(true)
  })

  it("写明共现只是候选、不做语义判断（不把同框当定论）", () => {
    const result = detectAssetExtractionGaps(BASE)
    expect(result.na.some((line) => line.includes("同句共现") && line.includes("候选"))).toBe(true)
  })

  it("角色状态未装载 → 零缺口 + N/A，绝不报「没有缺口」", () => {
    const result = detectAssetExtractionGaps({ ...BASE, charactersLoaded: false })
    expect(result.gaps).toEqual([])
    expect(result.proposals).toEqual([])
    expect(result.checked).toBe(false)
    expect(result.na.some((line) => line.includes("角色状态未装载"))).toBe(true)
    expect(result.na.some((line) => line.includes("不是「没有缺口」"))).toBe(true)
  })

  it("wiki 未装载 → 不判人物缺口，但关系缺口仍可判", () => {
    const result = detectAssetExtractionGaps({ ...BASE, wikiLoaded: false })
    expect(result.gaps.some((item) => item.code === "character_not_in_state")).toBe(false)
    expect(result.gaps.some((item) => item.code === "relationship_not_in_state")).toBe(true)
    expect(result.na.some((line) => line.includes("wiki 人物实体未装载"))).toBe(true)
  })

  it("没有正文 → 全部 N/A，不给空结论", () => {
    const result = detectAssetExtractionGaps({ ...BASE, chapterText: "   " })
    expect(result.gaps).toEqual([])
    expect(result.checked).toBe(false)
    expect(result.na.some((line) => line.includes("没有可检查的正文"))).toBe(true)
  })

  it("世界构建/场景恒为 N/A（无结构化真源，不猜实体）", () => {
    const result = detectAssetExtractionGaps(BASE)
    expect(result.na.some((line) => line.includes("世界构建与场景"))).toBe(true)
  })

  it("建议文本是可直接落的草稿描述，且明确不写盘", () => {
    const result = detectAssetExtractionGaps(BASE)
    const characterProposal = result.proposals.find((item) => item.kind === "character")!
    const relationProposal = result.proposals.find((item) => item.kind === "relationship")!
    expect(characterProposal.title).toContain("补角色资产：王五")
    expect(characterProposal.body).toContain("accept")
    expect(relationProposal.title).toContain("补关系资产：张三→李四")
    expect(relationProposal.body).toContain("避免「友」「敌」")
  })

  it("未知章号时证据不带章号，但仍给片段", () => {
    const result = detectAssetExtractionGaps({ ...BASE, chapterNumber: null })
    const gap = result.gaps.find((item) => item.code === "character_not_in_state")!
    expect(gap.evidence.startsWith("第 ")).toBe(false)
    expect(gap.evidence).toContain("王五")
  })

  it("counts 反映规模，且正文识别出的人名计入", () => {
    const result = detectAssetExtractionGaps(BASE)
    expect(result.counts.wikiCharacters).toBe(3)
    expect(result.counts.stateCharacters).toBe(2)
    expect(result.counts.mentionedCharacters).toBe(3)
  })

  it("长证据被截断并带省略号（不把整章塞进面板）", () => {
    const long = `${"前".repeat(200)}张三与李四在此相遇。`
    const result = detectAssetExtractionGaps({ ...BASE, chapterText: long })
    const gap = result.gaps.find((item) => item.code === "relationship_not_in_state")!
    expect(Array.from(gap.evidence).length).toBeLessThan(120)
    expect(gap.evidence).toContain("…")
  })
})

import { describe, expect, it } from "vitest"

import { detectAssetExtractionGaps, type ExtractionGapInput } from "./asset-extraction-gap"

const TEXT = [
  "甲推门进来，乙正在擦剑。",
  "丙站在门外，谁也没说话。",
  "甲对乙说：这次我们一起去。",
].join("\n")

const BASE: ExtractionGapInput = {
  chapterNumber: 7,
  chapterText: TEXT,
  characters: [
    { characterName: "甲", relationships: {} },
    { characterName: "乙", relationships: {} },
  ],
  charactersLoaded: true,
  wikiCharacterNames: ["甲", "乙", "丙"],
  wikiLoaded: true,
}

describe("detectAssetExtractionGaps", () => {
  it("wiki 有人物实体、正文出现、角色状态没有 → character_not_in_state，带章号证据", () => {
    const result = detectAssetExtractionGaps(BASE)
    const gap = result.gaps.find((item) => item.code === "character_not_in_state")
    expect(gap?.subject).toBe("丙")
    expect(gap?.evidence).toContain("第 7 章")
    expect(gap?.evidence).toContain("丙")
  })

  it("同句共现但两侧都没有关系 → relationship_not_in_state（按码点序、去重）", () => {
    const result = detectAssetExtractionGaps(BASE)
    const pairs = result.gaps
      .filter((item) => item.code === "relationship_not_in_state")
      .map((item) => item.subject)
    expect(pairs).toEqual(["甲→乙"])
    // 甲/乙 在两句里都出现，仍然只报一条
    expect(pairs).toHaveLength(1)
  })

  it("任一侧已有该关系 → 不算缺口", () => {
    const result = detectAssetExtractionGaps({
      ...BASE,
      characters: [
        { characterName: "甲", relationships: { 乙: "并肩多年的搭档" } },
        { characterName: "乙", relationships: {} },
      ],
    })
    expect(result.gaps.some((item) => item.code === "relationship_not_in_state")).toBe(false)
  })

  it("单字名字要有边界：「王」不该命中「王府」", () => {
    const result = detectAssetExtractionGaps({
      ...BASE,
      chapterText: "他走进王府，院中无人。",
      characters: [{ characterName: "王", relationships: {} }],
      wikiCharacterNames: ["王"],
    })
    expect(result.gaps).toEqual([])
  })

  it("角色状态未装载 → 零缺口 + N/A，绝不报「没有缺口」", () => {
    const result = detectAssetExtractionGaps({ ...BASE, charactersLoaded: false })
    expect(result.gaps).toEqual([])
    expect(result.proposals).toEqual([])
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
    expect(characterProposal.title).toContain("补角色资产：丙")
    expect(characterProposal.body).toContain("accept")
    expect(relationProposal.title).toContain("补关系资产：甲→乙")
    expect(relationProposal.body).toContain("避免「友」「敌」")
  })

  it("未知章号时证据不带章号，但仍给片段", () => {
    const result = detectAssetExtractionGaps({ ...BASE, chapterNumber: null })
    const gap = result.gaps.find((item) => item.code === "character_not_in_state")!
    expect(gap.evidence.startsWith("第 ")).toBe(false)
    expect(gap.evidence).toContain("丙")
  })

  it("counts 反映规模，且正文识别出的人名计入", () => {
    const result = detectAssetExtractionGaps(BASE)
    expect(result.counts.wikiCharacters).toBe(3)
    expect(result.counts.stateCharacters).toBe(2)
    expect(result.counts.mentionedCharacters).toBe(3)
  })

  it("长证据被截断并带省略号（不把整章塞进面板）", () => {
    const long = `${"前".repeat(200)}甲与乙在此相遇。`
    const result = detectAssetExtractionGaps({ ...BASE, chapterText: long })
    const gap = result.gaps.find((item) => item.code === "relationship_not_in_state")!
    expect(Array.from(gap.evidence).length).toBeLessThan(120)
    expect(gap.evidence).toContain("…")
  })
})

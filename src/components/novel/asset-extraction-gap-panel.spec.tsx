// @vitest-environment jsdom
/**
 * 面板契约：缺口必须真的显示出来，且「未装载 / 无正文」不得被说成「已齐」。
 */
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { detectAssetExtractionGaps } from "@/lib/novel"

import { AssetExtractionGapPanel } from "./asset-extraction-gap-panel"

const INPUT = {
  chapterNumber: 3,
  chapterText: "甲推门进来，乙正在擦剑。\n丙站在门外。",
  characters: [
    { characterName: "甲", relationships: {} },
    { characterName: "乙", relationships: {} },
  ],
  charactersLoaded: true,
  wikiCharacterNames: ["甲", "乙", "丙"],
  wikiLoaded: true,
}

afterEach(cleanup)

describe("AssetExtractionGapPanel", () => {
  it("列出人物缺口与关系缺口，并带上证据片段", () => {
    render(<AssetExtractionGapPanel input={INPUT} />)
    const character = screen.getByTestId("asset-extraction-gap-character_not_in_state-0")
    expect(character.textContent).toContain("丙")
    expect(character.textContent).toContain("第 3 章")
    expect(screen.getByTestId("asset-extraction-gap-relationship_not_in_state-0")).toBeTruthy()
  })

  it("摘要显示真实计数（不是只显示结论）", () => {
    render(<AssetExtractionGapPanel input={INPUT} />)
    const summary = screen.getByTestId("asset-extraction-gap-summary").textContent ?? ""
    expect(summary).toContain("缺口：2 条")
    expect(summary).toContain("角色状态：2 人")
  })

  it("补充建议明确要求 accept 后才生效（Draft-first 口径）", () => {
    render(<AssetExtractionGapPanel input={INPUT} />)
    const proposals = screen.getByTestId("asset-extraction-gap-proposals").textContent ?? ""
    expect(proposals).toContain("accept")
    expect(proposals).toContain("补角色资产：丙")
  })

  it("角色状态未装载 → 空态文案不许说成「资产已齐」，且 N/A 写清原因", () => {
    render(<AssetExtractionGapPanel input={{ ...INPUT, charactersLoaded: false }} />)
    expect(screen.getByTestId("asset-extraction-gap-empty").textContent).toContain("不代表")
    expect(screen.getByTestId("asset-extraction-gap-na").textContent).toContain("角色状态未装载")
  })

  it("世界构建/场景恒为 N/A（不猜实体）", () => {
    render(<AssetExtractionGapPanel input={INPUT} />)
    expect(screen.getByTestId("asset-extraction-gap-na").textContent).toContain("世界构建与场景")
  })

  it("注入 projection 时优先使用注入值（不再重算）", () => {
    const projection = detectAssetExtractionGaps({ ...INPUT, chapterText: "" })
    render(<AssetExtractionGapPanel projection={projection} input={INPUT} />)
    expect(screen.getByTestId("asset-extraction-gap-empty")).toBeTruthy()
  })
})

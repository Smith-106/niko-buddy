import { describe, expect, it } from "vitest"
import { chapterMarkdownHasBody, decideChapterSaveStrategy, detectGeneratedTargetChapterNumber } from "./chapter-save-strategy"

describe("decideChapterSaveStrategy", () => {
  it("always saves to the next chapter when there is no explicit generated chapter target", () => {
    const result = decideChapterSaveStrategy({
      selectedChapterNumber: 1,
      generatedTargetChapterNumber: null,
      generatedTargetExists: false,
    })

    expect(result).toEqual({
      action: "direct_next_chapter",
    })
  })

  it("still creates the explicit target chapter when it does not yet exist", () => {
    const result = decideChapterSaveStrategy({
      selectedChapterNumber: 1,
      generatedTargetChapterNumber: 7,
      generatedTargetExists: false,
    })

    expect(result).toEqual({
      action: "direct_explicit_target_new",
      targetChapterNumber: 7,
    })
  })

  it("falls back to the next chapter when the explicit target chapter already exists", () => {
    const result = decideChapterSaveStrategy({
      selectedChapterNumber: 1,
      generatedTargetChapterNumber: 7,
      generatedTargetExists: true,
    })

    expect(result).toEqual({
      action: "direct_next_chapter",
    })
  })

  it("still falls back to the next chapter when the explicit generated target chapter already exists", () => {
    const result = decideChapterSaveStrategy({
      selectedChapterNumber: 1,
      generatedTargetChapterNumber: 7,
      generatedTargetExists: true,
    })

    expect(result).toEqual({
      action: "direct_next_chapter",
    })
  })
})

describe("detectGeneratedTargetChapterNumber", () => {
  it("detects an explicit generated chapter number from Chinese or English chapter titles", () => {
    expect(detectGeneratedTargetChapterNumber("# 第7章 夜雨旧屋\n\n正文内容")).toBe(7)
    expect(detectGeneratedTargetChapterNumber("# Chapter 7 Cold Key\n\nBody content")).toBe(7)
    expect(detectGeneratedTargetChapterNumber("普通正文，没有章节号")).toBeNull()
    expect(detectGeneratedTargetChapterNumber("正文提到第3章的旧事，不应被当成目标章节。\n\n后来他又翻到第12章。")).toBeNull()
    expect(detectGeneratedTargetChapterNumber("---\ntype: chapter\nchapter_number: 4\n---\n\n# 第8章 新的一夜\n\n正文回顾第1章。")).toBe(8)
  })
})

describe("chapterMarkdownHasBody", () => {
  it("空内容与 frontmatter-only 均视为没有正文", () => {
    expect(chapterMarkdownHasBody("")).toBe(false)
    expect(chapterMarkdownHasBody("   \n  ")).toBe(false)
    expect(chapterMarkdownHasBody("---\ntype: chapter\nchapter_number: 7\n---\n")).toBe(false)
  })

  it("存在非空白正文（含仅标题）视为已有内容", () => {
    expect(chapterMarkdownHasBody("---\ntype: chapter\n---\n\n# 第7章\n\n正文")).toBe(true)
    expect(chapterMarkdownHasBody("# 第7章 标题")).toBe(true)
    expect(chapterMarkdownHasBody("正文片段")).toBe(true)
  })
})

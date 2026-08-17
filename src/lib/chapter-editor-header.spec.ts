import { describe, expect, it } from "vitest"
import { buildChapterEditorHeader } from "./chapter-editor-header"

describe("buildChapterEditorHeader", () => {
  it("reads the heading and draft status from plain markdown", () => {
    const header = buildChapterEditorHeader("# 第一章\n\n正文")
    expect(header.heading).toBe("第一章")
    expect(header.status).toBe("draft")
    expect(header.statusLabel).toEqual(expect.any(String))
    expect(header.wordCountLabel).toBe("2字")
    expect(header.titleInputWidthCh).toBeGreaterThanOrEqual(4)
  })

  it("falls back to the frontmatter title when there is no heading", () => {
    const markdown = "---\ntitle: 来自元数据\n---\n正文"
    const header = buildChapterEditorHeader(markdown)
    expect(header.heading).toBe("来自元数据")
  })

  it("falls back to empty heading when neither heading nor title exists", () => {
    const header = buildChapterEditorHeader("正文没有标题")
    expect(header.heading).toBe("")
    expect(header.titleInputWidthCh).toBe(4)
  })

  it("normalizes the chapter status from frontmatter", () => {
    const markdown = "---\nchapter_status: final\n---\n# 终章\n\n正文"
    const header = buildChapterEditorHeader(markdown)
    expect(header.status).toBe("final")
    expect(header.statusLabel).toEqual(expect.any(String))
  })

  it("counts body words excluding frontmatter and heading", () => {
    const markdown = "---\ntitle: 章\n---\n# 第一章\n\n甲乙丙丁"
    expect(buildChapterEditorHeader(markdown).wordCountLabel).toBe("4字")
  })

  it("computes the input width with double width for CJK characters", () => {
    const markdown = "# 一二三四五六\n\n正文"
    // 6 CJK chars → visual width 12
    expect(buildChapterEditorHeader(markdown).titleInputWidthCh).toBe(12)
  })

  it("treats ASCII headings as single-width characters", () => {
    const markdown = "# Chapter One\n\nbody"
    expect(buildChapterEditorHeader(markdown).titleInputWidthCh).toBe(11)
  })
})

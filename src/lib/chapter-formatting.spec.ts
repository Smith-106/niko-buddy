import { describe, expect, it } from "vitest"
import { formatChapterWriting } from "./chapter-formatting"

describe("formatChapterWriting", () => {
  it("returns empty output for empty input", () => {
    expect(formatChapterWriting("")).toBe("")
  })

  it("preserves frontmatter and indents normal paragraphs with full-width spaces", () => {
    const input = "---\ntitle: 章\n---\n第一段内容。\n\n第二段内容。"
    const out = formatChapterWriting(input)
    expect(out.startsWith("---\ntitle: 章\n---\n")).toBe(true)
    expect(out).toContain("　　第一段内容。")
    expect(out).toContain("　　第二段内容。")
  })

  it("strips existing full-width and ASCII leading spaces before indenting", () => {
    const out = formatChapterWriting("  已有缩进的内容\n　　tab")
    expect(out).toContain("　　已有缩进的内容")
    expect(out).toContain("　　tab")
  })

  it("keeps structural markdown lines unindented", () => {
    const input = ["普通段落。", "", "# 标题", "> 引用", "- 列表项", "1. 编号项", "| 表 | 格 |", "---"].join("\n")
    const out = formatChapterWriting(input)
    expect(out).toContain("# 标题")
    expect(out).toContain("> 引用")
    expect(out).toContain("- 列表项")
    expect(out).toContain("1. 编号项")
    expect(out).toContain("| 表 | 格 |")
    expect(out).toContain("---") // hr line stays unindented
  })

  it("separates structural lines with blank lines", () => {
    const out = formatChapterWriting("普通段落。\n- 列表项")
    expect(out).toBe("　　普通段落。\n\n- 列表项")
  })

  it("treats long horizontal rules as structural (unindented)", () => {
    const out = formatChapterWriting("前文。\n----")
    expect(out).toContain("----")
    expect(out).not.toContain("　　----")
  })

  it("handles fenced code blocks verbatim", () => {
    const input = "普通段落。\n```ts\nconst x = 1\n\n未缩进代码\n```\n后续段落。"
    const out = formatChapterWriting(input)
    expect(out).toContain("```ts")
    expect(out).toContain("const x = 1")
    expect(out).toContain("未缩进代码")
    expect(out).toContain("　　后续段落。")
    // inside fence the blank line stays untouched
    expect(out).toContain("const x = 1\n\n未缩进代码")
  })

  it("handles unclosed fences", () => {
    const out = formatChapterWriting("```\n里面\n未闭合")
    expect(out).toBe("```\n里面\n未闭合")
  })

  it("does not insert a blank before a fence that directly follows a fence", () => {
    const out = formatChapterWriting("```\na\n```\n```\nb\n```")
    expect(out).toBe("```\na\n```\n```\nb\n```")
  })

  it("does not insert a blank before a structural line that directly follows a fence", () => {
    const out = formatChapterWriting("```\na\n```\n- item")
    expect(out).toBe("```\na\n```\n- item")
  })

  it("inserts a blank before a normal paragraph that follows a structural line", () => {
    const out = formatChapterWriting("普通段落。\n\n- 列表项\n\n又一段。")
    expect(out).toBe("　　普通段落。\n\n- 列表项\n\n　　又一段。")
  })

  it("removes trailing whitespace from each line", () => {
    const out = formatChapterWriting("内容。   \n\n更多。\t")
    expect(out).toContain("内容。")
    expect(out).not.toContain("内容。   ")
  })

  it("collapses consecutive blank lines and trims trailing blanks", () => {
    const out = formatChapterWriting("一段。\n\n\n\n\n二段。\n\n\n")
    // blank runs between consecutive normal paragraphs collapse away (lastKind guard)
    expect(out).toBe("　　一段。\n　　二段。")
  })

  it("indents consecutive normal paragraphs without inserting blanks between them", () => {
    const out = formatChapterWriting("一段。\n二段。")
    expect(out).toBe("　　一段。\n　　二段。")
  })

  it("trims trailing blank lines left inside an unclosed fence", () => {
    // The in-fence branch pushes blank lines verbatim; a trailing blank run
    // after an unclosed fence must be popped by the trailing-strip loop.
    const out = formatChapterWriting("文本。\n```\ncode\n\n\n")
    expect(out).toBe("　　文本。\n\n```\ncode")
    expect(out.endsWith("\n")).toBe(false)
  })
})

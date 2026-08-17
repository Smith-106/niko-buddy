import { describe, expect, it } from "vitest"
import { countChapterBodyWords } from "./chapter-word-count"

describe("countChapterBodyWords", () => {
  it("counts characters in the body without frontmatter", () => {
    const markdown = [
      "---",
      "type: chapter",
      "chapter_number: 1",
      "---",
      "第一章 启程",
      "",
      "夜色如水，风从山脊上掠过。",
      "",
      "她抬起头。",
    ].join("\n")
    // 第一章启程(6) + 夜色如水，风从山脊上掠过。(13) + 她抬起头。(4)
    expect(countChapterBodyWords(markdown)).toBe(23)
  })

  it("excludes the first heading line", () => {
    const markdown = "# 标题\n正文内容"
    expect(countChapterBodyWords(markdown)).toBe(4)
  })

  it("strips whitespace and full-width spaces before counting", () => {
    const markdown = "第一个词  第二个词\n\n　　第三个词"
    // 第一个词(4) + 第二个词(4) + 第三个词(4)
    expect(countChapterBodyWords(markdown)).toBe(12)
  })

  it("works for content without any frontmatter", () => {
    expect(countChapterBodyWords("纯正文")).toBe(3)
  })

  it("returns zero for empty content", () => {
    expect(countChapterBodyWords("")).toBe(0)
    expect(countChapterBodyWords("\n\n  \n")).toBe(0)
  })
})

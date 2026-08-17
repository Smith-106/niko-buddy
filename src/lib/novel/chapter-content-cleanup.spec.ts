import { describe, expect, it } from "vitest"
import {
  cleanGeneratedChapterContentForSave,
  cleanGeneratedChapterContentWithTitle,
} from "./chapter-content-cleanup"

describe("cleanGeneratedChapterContentWithTitle", () => {
  it("extracts a # 第X章 heading as title and preserves it in the content", () => {
    const result = cleanGeneratedChapterContentWithTitle(
      "# 第3章 初入江湖\n\n\n> 引用块\n\n---\n\n正文第一段。\n\n第二段。",
    )
    expect(result.title).toBe("第3章 初入江湖")
    expect(result.content).toContain("# 第3章 初入江湖")
    expect(result.content).toContain("正文第一段。")
    expect(result.content).not.toContain("引用块")
  })

  it("extracts a plain 第X章 heading without #", () => {
    const result = cleanGeneratedChapterContentWithTitle(
      "第5章 风起\n\n正文内容。",
    )
    expect(result.title).toBe("第5章 风起")
    expect(result.content).toContain("第5章 风起")
    expect(result.content).toContain("正文内容。")
  })

  it("returns null title when no chapter heading is present", () => {
    const result = cleanGeneratedChapterContentWithTitle("直接开始的正文段落。")
    expect(result.title).toBeNull()
    expect(result.content).toBe("直接开始的正文段落。")
  })

  it("removes complete thinking blocks and truncates from an unclosed opening block", () => {
    const content = [
      "<thinking>内部思考内容</thinking>",
      "正式正文第一段。",
      "正文继续。",
      "<think>未闭合的思考",
      "这段尾巴也会被删掉",
    ].join("\n\n")
    const result = cleanGeneratedChapterContentWithTitle(content)
    expect(result.content).not.toContain("thinking")
    expect(result.content).not.toContain("思考")
    expect(result.content).toContain("正式正文第一段。")
    expect(result.content).toContain("正文继续。")
    // the unclosed <think> eats everything from its opening tag to the end
    expect(result.content).not.toContain("这段尾巴也会被删掉")
  })

  it("removes a stray closing thinking tag when no opening tag precedes it", () => {
    const result = cleanGeneratedChapterContentWithTitle("泄露的思考文本</thinking>\n正式正文。")
    expect(result.content).not.toContain("思考文本")
    expect(result.content).toContain("正式正文。")
  })

  it("strips citation syntax: html comments, reference lists, wikilink citations", () => {
    const content = [
      "<!-- 生成器注释 -->",
      "正文提及某设定[1]。",
      "[[相关条目]][1]",
      "[[另一条目]]",
      "[1]: https://example.com/source",
      "结尾段落。",
    ].join("\n")
    const result = cleanGeneratedChapterContentWithTitle(content)
    expect(result.content).not.toContain("生成器注释")
    expect(result.content).not.toContain("[1]")
    expect(result.content).not.toContain("[[")
    expect(result.content).toContain("正文提及某设定。")
    expect(result.content).toContain("结尾段落。")
  })

  it("collapses spaces before punctuation and normalizes excessive blank lines", () => {
    const result = cleanGeneratedChapterContentWithTitle("句子  ，带空格。\n\n\n\n\n结尾  。")
    expect(result.content).not.toContain("  ，")
    expect(result.content).not.toContain("\n\n\n")
    expect(result.content).toContain("句子，带空格。")
    expect(result.content).toContain("结尾。")
  })

  it("removes a trailing assistant offer to continue", () => {
    const result = cleanGeneratedChapterContentWithTitle(
      "# 第2章 出发\n\n正文内容。\n\n如果你愿意，我可以继续写下一章。",
    )
    expect(result.content).not.toContain("如果你愿意")
    expect(result.content).toContain("正文内容。")
  })

  it("strips leading blockquotes and horizontal rules before the body", () => {
    const result = cleanGeneratedChapterContentWithTitle(
      "# 第1章 开始\n\n> 编者按\n> 更多编者按\n\n---\n\n正文。",
    )
    expect(result.content).not.toContain("编者按")
    expect(result.content).not.toContain("---")
    expect(result.content).toContain("正文。")
  })
})

describe("cleanGeneratedChapterContentForSave", () => {
  it("removes the title line entirely (backward-compatible string return)", () => {
    const result = cleanGeneratedChapterContentForSave(
      "# 第3章 初入江湖\n\n正文内容。",
    )
    expect(result).not.toContain("第3章 初入江湖")
    expect(result).toContain("正文内容。")
  })

  it("strips thinking blocks, citations, blockquotes and separator lines", () => {
    const result = cleanGeneratedChapterContentForSave(
      "<thinking>思考</thinking>\n# 第4章 夜\n\n> 引用\n\n---\n\n正文[1]。\n\n[1]: https://example.com",
    )
    expect(result).not.toContain("思考")
    expect(result).not.toContain("引用")
    expect(result).not.toContain("[1]")
    expect(result).toContain("正文。")
  })

  it("strips a trailing assistant offer and collapses blank lines", () => {
    const result = cleanGeneratedChapterContentForSave(
      "# 第5章\n\n正文。\n\n\n\n需要的话我可以为你写下一章。",
    )
    expect(result).not.toContain("需要的话")
    expect(result).toContain("正文。")
    expect(result).not.toContain("\n\n\n")
  })

  it("returns empty-ish output for empty input", () => {
    expect(cleanGeneratedChapterContentForSave("")).toBe("")
    expect(cleanGeneratedChapterContentForSave("   ")).toBe("")
  })

  it("handles all-blank input (index runs past line array in both extractLeadingTitle and the main walk)", () => {
    const result = cleanGeneratedChapterContentWithTitle("\n\n\n")
    expect(result.title).toBeNull()
    expect(result.content).toBe("")
    const saved = cleanGeneratedChapterContentForSave("\n\n\n")
    expect(saved).toBe("")
  })

  it("handles a blockquote section that runs to the very end of the content", () => {
    const result = cleanGeneratedChapterContentWithTitle("# 第1章 开始\n\n> 引用到最后")
    expect(result.title).toBe("第1章 开始")
    expect(result.content).not.toContain("引用到最后")
  })

  it("handles content ending with blank lines after blockquotes and no separator line", () => {
    const result = cleanGeneratedChapterContentWithTitle("# 第1章 开始\n\n> 引用\n\n\n")
    expect(result.title).toBe("第1章 开始")
    expect(result.content).not.toContain("引用")
  })
})

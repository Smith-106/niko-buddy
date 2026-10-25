import { describe, expect, it } from "vitest"
import { parseReviewBlocks } from "./ingest"

const SOURCE = "source-doc.md"

function block(type: string, title: string, body: string): string {
  return `---REVIEW: ${type} | ${title}---\n${body}\n---END REVIEW---`
}

describe("parseReviewBlocks hardening", () => {
  it("解析行首合法块（含周围正文）", () => {
    const text = [
      "Some intro prose.",
      "",
      block(
        "contradiction",
        "Two pages disagree",
        "Pages conflict on the launch date.\nPAGES: wiki/a.md, wiki/b.md",
      ),
      "",
      "Trailing prose.",
    ].join("\n")
    const items = parseReviewBlocks(text, SOURCE)
    expect(items).toHaveLength(1)
    expect(items[0].type).toBe("contradiction")
    expect(items[0].title).toBe("Two pages disagree")
    expect(items[0].description).toContain("launch date")
    expect(items[0].affectedPages).toEqual(["wiki/a.md", "wiki/b.md"])
  })

  it("解析相邻双块且 body 不跨块吞噬", () => {
    const text = [
      block("suggestion", "First", "Body one."),
      "Some prose between blocks.",
      block("duplicate", "Second", "Body two."),
    ].join("\n")
    const items = parseReviewBlocks(text, SOURCE)
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe("First")
    expect(items[0].description).toBe("Body one.")
    expect(items[1].title).toBe("Second")
    expect(items[1].description).toBe("Body two.")
  })

  it("H1 标题行中的标记不被解析", () => {
    const text = [
      "# ---REVIEW: suggestion | Fake from heading---",
      "Body text.",
      "---END REVIEW---",
    ].join("\n")
    expect(parseReviewBlocks(text, SOURCE)).toHaveLength(0)
  })

  it("正文行内标记不被解析", () => {
    const text =
      "正文提到 ---REVIEW: suggestion | Inline--- 然后继续\nBody text.\n---END REVIEW---"
    expect(parseReviewBlocks(text, SOURCE)).toHaveLength(0)
  })

  it("围栏内标记不被解析，围栏外真块仍解析", () => {
    const text = [
      "Intro.",
      "",
      "```md",
      block("suggestion", "Fenced", "Fenced body."),
      "```",
      "",
      block("suggestion", "Real", "Real body."),
    ].join("\n")
    const items = parseReviewBlocks(text, SOURCE)
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe("Real")
  })

  it("围栏内假 END 不提前截断 body", () => {
    const text = [
      "---REVIEW: suggestion | Fence end---",
      "Intro line.",
      "```",
      "quoted example",
      "---END REVIEW---",
      "```",
      "Outro line.",
      "---END REVIEW---",
    ].join("\n")
    const items = parseReviewBlocks(text, SOURCE)
    expect(items).toHaveLength(1)
    expect(items[0].description).toContain("Intro line.")
    expect(items[0].description).toContain("Outro line.")
  })

  it("缺 END 的畸形块被忽略且不抛错", () => {
    const text = [
      block("suggestion", "Closed", "Closed body."),
      "---REVIEW: suggestion | Truncated---",
      "Body without end marker.",
    ].join("\n")
    expect(() => parseReviewBlocks(text, SOURCE)).not.toThrow()
    const items = parseReviewBlocks(text, SOURCE)
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe("Closed")
  })

  it("换行 header 的畸形块被忽略且不抛错", () => {
    const text = [
      "---REVIEW: contradiction |",
      "Split Title---",
      "Body here.",
      "---END REVIEW---",
    ].join("\n")
    expect(() => parseReviewBlocks(text, SOURCE)).not.toThrow()
    expect(parseReviewBlocks(text, SOURCE)).toHaveLength(0)
  })
})

import { describe, expect, it } from "vitest"
import { parseLintBlocks } from "./lint"

function block(type: string, severity: string, title: string, body: string): string {
  return `---LINT: ${type} | ${severity} | ${title}---\n${body}\n---END LINT---`
}

describe("parseLintBlocks hardening", () => {
  it("解析行首合法块（含周围正文）", () => {
    const text = [
      "Some intro prose.",
      "",
      block(
        "contradiction",
        "warning",
        "Short title",
        "Description here.\nPAGES: a.md, b.md",
      ),
      "",
      "Trailing prose.",
    ].join("\n")
    const results = parseLintBlocks(text)
    expect(results).toHaveLength(1)
    expect(results[0].type).toBe("semantic")
    expect(results[0].severity).toBe("warning")
    expect(results[0].page).toBe("Short title")
    expect(results[0].detail).toBe("[contradiction] Description here.")
    expect(results[0].affectedPages).toEqual(["a.md", "b.md"])
  })

  it("解析相邻双块且 body 不跨块吞噬", () => {
    const text = [
      block("stale", "info", "First", "Body one."),
      "Some prose between blocks.",
      block("suggestion", "info", "Second", "Body two."),
    ].join("\n")
    const results = parseLintBlocks(text)
    expect(results).toHaveLength(2)
    expect(results[0].page).toBe("First")
    expect(results[0].detail).toContain("Body one.")
    expect(results[1].page).toBe("Second")
    expect(results[1].detail).toContain("Body two.")
  })

  it("H1 标题行中的标记不被解析", () => {
    const text = [
      "# ---LINT: suggestion | info | Fake from heading---",
      "Body text.",
      "---END LINT---",
    ].join("\n")
    expect(parseLintBlocks(text)).toHaveLength(0)
  })

  it("正文行内标记不被解析", () => {
    const text =
      "正文提到 ---LINT: suggestion | info | Inline--- 然后继续\nBody text.\n---END LINT---"
    expect(parseLintBlocks(text)).toHaveLength(0)
  })

  it("围栏内标记不被解析，围栏外真块仍解析", () => {
    const text = [
      "Intro.",
      "",
      "```md",
      block("suggestion", "info", "Fenced", "Fenced body."),
      "```",
      "",
      block("suggestion", "info", "Real", "Real body."),
    ].join("\n")
    const results = parseLintBlocks(text)
    expect(results).toHaveLength(1)
    expect(results[0].page).toBe("Real")
  })

  it("围栏内假 END 不提前截断 body", () => {
    const text = [
      "---LINT: suggestion | info | Fence end---",
      "Intro line.",
      "```",
      "quoted example",
      "---END LINT---",
      "```",
      "Outro line.",
      "---END LINT---",
    ].join("\n")
    const results = parseLintBlocks(text)
    expect(results).toHaveLength(1)
    expect(results[0].detail).toContain("Intro line.")
    expect(results[0].detail).toContain("Outro line.")
  })

  it("缺 END 的畸形块被忽略且不抛错", () => {
    const text = [
      block("stale", "info", "Closed", "Closed body."),
      "---LINT: suggestion | info | Truncated---",
      "Body without end marker.",
    ].join("\n")
    expect(() => parseLintBlocks(text)).not.toThrow()
    const results = parseLintBlocks(text)
    expect(results).toHaveLength(1)
    expect(results[0].page).toBe("Closed")
  })

  it("换行 header 的畸形块被忽略且不抛错", () => {
    const text = [
      "---LINT: contradiction | warning |",
      "Split Title---",
      "Body here.",
      "---END LINT---",
    ].join("\n")
    expect(() => parseLintBlocks(text)).not.toThrow()
    expect(parseLintBlocks(text)).toHaveLength(0)
  })
})

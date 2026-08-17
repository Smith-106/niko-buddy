import { describe, expect, it } from "vitest"
import { parseFrontmatter } from "./frontmatter"

describe("parseFrontmatter", () => {
  it("returns null frontmatter and the raw body when none exists", () => {
    const result = parseFrontmatter("# Just a heading\n\nBody")
    expect(result.frontmatter).toBeNull()
    expect(result.body).toBe("# Just a heading\n\nBody")
    expect(result.rawBlock).toBe("")
  })

  it("parses a strict top-of-file frontmatter block", () => {
    const result = parseFrontmatter("---\ntitle: 第一章\ntags: [a, b]\n---\n\n正文")
    expect(result.frontmatter).toEqual({ title: "第一章", tags: ["a", "b"] })
    expect(result.body).toBe("正文")
    // The strict regex greedily absorbs the blank separator line after `---`.
    expect(result.rawBlock).toBe("---\ntitle: 第一章\ntags: [a, b]\n---\n\n")
  })

  it("handles CRLF line endings", () => {
    const result = parseFrontmatter("---\r\ntitle: 测试\r\n---\r\nbody")
    expect(result.frontmatter).toEqual({ title: "测试" })
    expect(result.body).toBe("body")
  })

  it("finds frontmatter not at the very top within the 6-line prefix window", () => {
    const content = "stray line\nmore\n---\ntitle: x\n---\nbody"
    const result = parseFrontmatter(content)
    expect(result.frontmatter).toEqual({ title: "x" })
    expect(result.body).toBe("body")
    // The unanchored fallback drops the first dash of the opening fence.
    expect(result.rawBlock).toBe("--\ntitle: x\n---\n")
  })

  it("rejects fallback frontmatter deeper than the prefix window", () => {
    const prefix = Array.from({ length: 8 }, (_, i) => `line${i}`).join("\n")
    const result = parseFrontmatter(`${prefix}\n---\ntitle: x\n---\nbody`)
    expect(result.frontmatter).toBeNull()
    expect(result.body).toBe(`${prefix}\n---\ntitle: x\n---\nbody`)
  })

  it("keeps the raw fallback body when the yaml fence wrapper is not directly attached", () => {
    // The fence-wrapper cleanup only triggers when the prefix is exactly the
    // fence; the unanchored fallback always consumes one dash, so the prefix
    // ends with `-` and the fence branch does not fire.
    const content = "```yaml\n---\ntitle: x\n---\n```\nbody"
    const result = parseFrontmatter(content)
    expect(result.frontmatter).toEqual({ title: "x" })
    expect(result.body).toBe("```\nbody")
  })

  it("repairs invalid wikilink list syntax and re-parses", () => {
    const content = "---\nrelated: [[a]], [[b]], [[c]]\n---\nbody"
    const result = parseFrontmatter(content)
    expect(result.frontmatter).toEqual({ related: ["[[a]]", "[[b]]", "[[c]]"] })
    expect(result.body).toBe("body")
  })

  it("returns null frontmatter when YAML is unparseable in both passes", () => {
    const content = "---\n: : : not valid\n---\nbody"
    const result = parseFrontmatter(content)
    expect(result.frontmatter).toBeNull()
    expect(result.body).toBe("body")
    expect(result.rawBlock).toBe("---\n: : : not valid\n---\n")
  })

  it("returns null frontmatter for non-object YAML payloads", () => {
    // Top-level arrays / scalars parse fine but cannot normalize to a map.
    const arrayResult = parseFrontmatter("---\n- a\n- b\n---\nbody")
    expect(arrayResult.frontmatter).toBeNull()
    expect(arrayResult.body).toBe("body")
    const scalarResult = parseFrontmatter("---\n42\n---\nbody")
    expect(scalarResult.frontmatter).toBeNull()
    expect(scalarResult.body).toBe("body")
  })

  it("normalizes non-string scalars, arrays and nested values", () => {
    const content = [
      "---",
      "num: 42",
      "flag: true",
      "empty:",
      "list: [1, 2]",
      "nested: {a: 1}",
      "date: 2026-01-15",
      "---",
      "body",
    ].join("\n")
    const result = parseFrontmatter(content)
    expect(result.frontmatter).toEqual({
      num: "42",
      flag: "true",
      empty: "",
      list: ["1", "2"],
      nested: '{"a":1}',
      date: "2026-01-15",
    })
  })

  it("stringifies circular YAML anchor structures via the JSON.stringify catch (defensive)", () => {
    // js-yaml 支持递归锚点 (a: &x {b: *x} → 循环引用对象)。该结构
    // JSON.stringify 抛 TypeError, stringifyScalar 的 catch 分支用 String(v) 兜底,
    // 保证循环结构也能以可见字符串形式出现在 UI 而不静默消失。
    const content = "---\na: &x {b: *x}\n---\nbody"
    const result = parseFrontmatter(content)
    expect(result.frontmatter?.a).toBe("[object Object]")
    expect(result.body).toBe("body")
  })

  it("keeps the literal raw block for round-trip preservation", () => {
    const content = "---\ntitle: 原样\n---\n\n正文"
    const result = parseFrontmatter(content)
    expect(result.rawBlock + result.body).toBe(content)
  })
})

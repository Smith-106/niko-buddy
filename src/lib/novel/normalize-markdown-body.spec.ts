import { describe, expect, it } from "vitest"
import { normalizeMarkdownBody } from "./normalize-markdown-body"

describe("normalizeMarkdownBody (55 号设计 W2-1)", () => {
  it("frontmatter 含会被规范化误伤的字符 (全角引号/3连感叹号) → 头块逐字节不变, 仅 body 规范化", () => {
    // 夹具必触发: 全角引号 “” 会被 normalizeQuotes 统一, 3 连感叹号会触发 REPEATED_PUNCT_RE
    // (撤销 frontmatter 保护时 title 行必然被改 → 用例红, 防空转)
    const input = [
      "---",
      'type: outline',
      'title: “真恩！！！”',
      "---",
      "",
      "他说道：“快走！”",
      "省略号……",
    ].join("\n")
    const out = normalizeMarkdownBody(input)
    // frontmatter 原样保留 (含全角引号与 3 连感叹号)
    expect(out).toContain('title: “真恩！！！”')
    expect(out).toContain("type: outline")
    // body 被规范化 (引号统一/感叹号降级)
    expect(out).not.toContain("他说道：“快走！”")
    expect(out).toContain("他说道")
  })

  it("无 frontmatter 输入 → 等价于全量 normalize (退化路径)", () => {
    const input = "他说道：“快走！”"
    const out = normalizeMarkdownBody(input)
    expect(out).not.toContain("“快走！”")
    expect(out).toContain("他说道")
  })

  it("幂等: 二次 normalize 无新增改动", () => {
    const input = [
      "---",
      "type: outline",
      'title: “真恩！！！”',
      "---",
      "",
      "他说道：“快走！”",
    ].join("\n")
    const once = normalizeMarkdownBody(input)
    const twice = normalizeMarkdownBody(once)
    expect(twice).toBe(once)
  })

  it("干净输入 → 逐字节不变 (零开销路径)", () => {
    const input = ["---", "type: outline", 'title: "普通标题"', "---", "", "正文内容。", ""].join("\n")
    expect(normalizeMarkdownBody(input)).toBe(input)
  })
})

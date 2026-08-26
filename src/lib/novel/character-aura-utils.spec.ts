import { describe, expect, it, vi, beforeEach } from "vitest"

const pinyinMock = vi.hoisted(() => vi.fn())
vi.mock("pinyin-pro", () => ({
  pinyin: pinyinMock,
}))

import {
  clipText,
  compressMarkdownForAuraContext,
  htmlToPlainText,
  markdownToPlainText,
  normalizeCharacterText,
  safeSkillSlug,
  splitSourceLines,
  storePath,
  toPinyin,
  toSimplified,
} from "./character-aura-utils"

describe("toPinyin", () => {
  beforeEach(() => {
    pinyinMock.mockReset()
  })

  it("joins tone-less pinyin array and lowercases", () => {
    pinyinMock.mockReturnValue(["Xiao", "Qing"])
    expect(toPinyin("小晴")).toBe("xiaoqing")
    expect(pinyinMock).toHaveBeenCalledWith("小晴", { toneType: "none", type: "array" })
  })

  it("falls back to lowercase text when pinyin-pro throws", () => {
    pinyinMock.mockImplementation(() => {
      throw new Error("boom")
    })
    expect(toPinyin("ABC")).toBe("abc")
  })
})

describe("toSimplified", () => {
  it("returns empty/falsy text unchanged", () => {
    expect(toSimplified("")).toBe("")
  })

  it("returns short text (<= 2 chars) unchanged", () => {
    expect(toSimplified("後時")).toBe("後時")
  })

  it("maps traditional characters and keeps unmapped chars", () => {
    expect(toSimplified("後時國")).toBe("后时国")
    expect(toSimplified("後A國")).toBe("后A国")
  })

  it("ISS-20260802-005：扩展表覆盖 400+ 高频繁字（時/車/龍/頭/點 等）", () => {
    // 高频基础字（原有 146 表）+ 扩展新增字
    expect(toSimplified("時間車龍頭點熱飯馬鳥魚風雲電")).toBe("时间车龙头点热饭马鸟鱼风云电")
    // 扩展字：言部/手部/貝部/頁部
    expect(toSimplified("認識說話課堂禮物歸來繼續戰勝")).toBe("认识说话课堂礼物归来继续战胜")
    // 未映射字符透传
    expect(toSimplified("康熙字典")).toBe("康熙字典")
  })

  it("ISS-20260802-005：生成表无自映射/无空值（结构性）", async () => {
    const { T2S_MAP } = await import("./t2s-map.generated")
    const entries = Object.entries(T2S_MAP)
    expect(entries.length).toBeGreaterThanOrEqual(400)
    for (const [t, s] of entries) {
      expect(t.length).toBe(1)
      expect(s.length).toBe(1)
      expect(t).not.toBe(s)
    }
  })
})

describe("safeSkillSlug", () => {
  it("appends a cleaned name to the id", () => {
    expect(safeSkillSlug("custom-1", "林动 的灵魂")).toBe("custom-1-林动-的灵魂")
  })

  it("returns the id alone when the name cleans to empty", () => {
    expect(safeSkillSlug("custom-1", "   !!!  ")).toBe("custom-1")
    expect(safeSkillSlug("custom-1", "")).toBe("custom-1")
  })

  it("strips leading/trailing separators", () => {
    expect(safeSkillSlug("custom-1", "-李清照-")).toBe("custom-1-李清照")
  })
})

describe("clipText", () => {
  it("returns short text unchanged after whitespace normalization", () => {
    expect(clipText("  短 文本  ", 100)).toBe("短 文本")
  })

  it("truncates long text with an ellipsis", () => {
    expect(clipText("一二三四五", 3)).toBe("一二三……")
  })
})

describe("markdownToPlainText", () => {
  it("strips headings, bullets, bold, code, links and collapses whitespace", () => {
    const input = [
      "# 标题",
      "- 要点 **加粗**",
      "正文 `code` 与 [链接](http://x)",
      "多   空格",
    ].join("\n")
    expect(markdownToPlainText(input)).toBe("标题 要点 加粗 正文 code 与 链接 多 空格")
  })
})

describe("htmlToPlainText", () => {
  it("removes scripts, styles, tags and decodes entities", () => {
    const html = [
      "<script>var x=1;</script>",
      "<style>.a{color:red}</style>",
      "<p>a&nbsp;b &amp; c &lt;d&gt; &quot;e&quot; &#39;f&#39;</p>",
    ].join("")
    expect(htmlToPlainText(html)).toBe("a b & c <d> \"e\" 'f'")
  })

  it("returns empty for tag-only content and truncates over 20000 chars", () => {
    expect(htmlToPlainText("<div><span></span></div>")).toBe("")
    const long = `<p>${"x".repeat(25000)}</p>`
    expect(htmlToPlainText(long).length).toBe(20000)
  })
})

describe("splitSourceLines", () => {
  it("handles undefined input", () => {
    expect(splitSourceLines(undefined)).toEqual([])
  })

  it("splits on newlines, trims and drops blanks", () => {
    expect(splitSourceLines("  a  \n\n b \r\n c ")).toEqual(["a", "b", "c"])
  })
})

describe("normalizeCharacterText", () => {
  it("NFKC-normalizes, strips whitespace/punctuation and lowercases", () => {
    expect(normalizeCharacterText("ＡＢＣ， 林动。")).toBe("abc林动")
  })

  it("keeps characters not covered by the punctuation set (e.g. nakaguro)", () => {
    expect(normalizeCharacterText("菜月・昴，林动。")).toBe("菜月・昴林动")
  })
})

describe("compressMarkdownForAuraContext", () => {
  it("drops frontmatter lines and keeps structured lines", () => {
    const md = [
      "---",
      "name: x",
      "description: y",
      "---",
      "# 标题",
      "- 要点",
      "正文：内容",
    ].join("\n")
    const out = compressMarkdownForAuraContext(md, 500)
    expect(out).toContain("标题")
    expect(out).toContain("要点")
    expect(out).not.toContain("name:")
    expect(out).not.toContain("---")
  })

  it("falls back to all cleaned lines when nothing looks structured", () => {
    const out = compressMarkdownForAuraContext("纯 文本 没有 结构", 500)
    expect(out).toBe("纯 文本 没有 结构")
  })

  it("appends an ellipsis when truncated at maxLength", () => {
    const out = compressMarkdownForAuraContext("A".repeat(300), 100)
    expect(out.length).toBe(101)
    expect(out.endsWith("…")).toBe(true)
  })
})

describe("storePath", () => {
  it("joins the normalized project path with the store file", () => {
    expect(storePath("E:\\Novel")).toBe("E:/Novel/.qmai/character-aura.json")
  })

  it("preserves a trailing slash from the normalized path", () => {
    expect(storePath("E:\\Novel\\")).toBe("E:/Novel//.qmai/character-aura.json")
  })
})

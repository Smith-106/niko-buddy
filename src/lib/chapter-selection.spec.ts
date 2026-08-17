import { describe, expect, it } from "vitest"
import {
  buildPolishSelectionMessages,
  rebuildChapterBody,
  replaceChapterBodySelection,
  replaceWholeChapterBody,
  splitChapterHeading,
  type ChapterBodySelection,
} from "./chapter-selection"

describe("splitChapterHeading", () => {
  it("extracts the first # heading and removes it from the body", () => {
    const { heading, body } = splitChapterHeading("# 第一章\n\n正文内容")
    expect(heading).toBe("第一章")
    expect(body).toBe("正文内容")
  })

  it("returns the whole markdown as body when no heading exists", () => {
    expect(splitChapterHeading("no heading here")).toEqual({ heading: "", body: "no heading here" })
  })

  it("removes leading blank lines after the heading", () => {
    const { body } = splitChapterHeading("# 标题\n\n\n\n内容")
    expect(body).toBe("内容")
  })
})

describe("rebuildChapterBody", () => {
  it("re-attaches a heading when present", () => {
    expect(rebuildChapterBody("第一章", "正文")).toBe("# 第一章\n\n正文")
  })

  it("returns the body untouched when no heading", () => {
    expect(rebuildChapterBody("", "正文")).toBe("正文")
  })
})

describe("replaceWholeChapterBody", () => {
  it("preserves frontmatter and heading while swapping the body", () => {
    const current = "---\ntitle: 第一章\n---\n# 第一章\n\n旧正文\n"
    const replacement = "# 第一章\n\n新正文内容\n"
    expect(replaceWholeChapterBody(current, replacement)).toBe(
      "---\ntitle: 第一章\n---\n# 第一章\n\n新正文内容\n",
    )
  })

  it("keeps the raw frontmatter block untouched", () => {
    const current = "---\ntitle: 特殊标题\nchapter_status: draft\n---\n# 第一章\n\n旧正文"
    const replacement = "# 第一章\n\n新正文"
    expect(replaceWholeChapterBody(current, replacement)).toBe(
      "---\ntitle: 特殊标题\nchapter_status: draft\n---\n# 第一章\n\n新正文",
    )
  })

  it("drops a replacement heading and reuses the current heading", () => {
    const current = "# 现在的标题\n\n旧正文"
    const replacement = "# 新标题\n\n新正文"
    expect(replaceWholeChapterBody(current, replacement)).toBe("# 现在的标题\n\n新正文")
  })
})

describe("buildPolishSelectionMessages", () => {
  it("builds a system + user message pair", () => {
    const messages = buildPolishSelectionMessages("选中的段落")
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe("system")
    expect(messages[1].role).toBe("user")
    expect(messages[1].content).toContain("选中的段落")
  })

  it("throws for empty or whitespace-only content", () => {
    expect(() => buildPolishSelectionMessages("")).toThrow("润色内容为空")
    expect(() => buildPolishSelectionMessages("   ")).toThrow("润色内容为空")
  })
})

describe("replaceChapterBodySelection", () => {
  const body = "第一段内容。\n\n第二段内容。"
  const selection: ChapterBodySelection = {
    start: 8,
    end: 14,
    text: "第二段内容。",
    bodySnapshot: body,
  }

  it("replaces the selected range when snapshots match", () => {
    const result = replaceChapterBodySelection(body, selection, "新的第二段。")
    expect(result).toEqual({ ok: true, body: "第一段内容。\n\n新的第二段。" })
  })

  it("rejects empty selections", () => {
    const result = replaceChapterBodySelection(body, { ...selection, text: "   " }, "x")
    expect(result).toEqual({ ok: false, reason: "empty" })
  })

  it("rejects stale body snapshots", () => {
    const result = replaceChapterBodySelection("别人已经改过的正文", selection, "x")
    expect(result).toEqual({ ok: false, reason: "changed" })
  })

  it("rejects selections whose text no longer matches the range", () => {
    const stale: ChapterBodySelection = { ...selection, text: "旧文本" }
    const result = replaceChapterBodySelection(body, stale, "x")
    expect(result).toEqual({ ok: false, reason: "changed" })
  })
})

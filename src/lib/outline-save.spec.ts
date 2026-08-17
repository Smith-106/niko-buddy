import { describe, expect, it } from "vitest"
import { prepareOutlineSaveDraft } from "./outline-save"

describe("outline save draft", () => {
  it("ignores frontmatter when deriving an outline title", () => {
    const draft = prepareOutlineSaveDraft(
      [
        "---",
        "type: outline-17",
        "title: \"旧标题\"",
        "---",
        "",
        "# 新的大纲标题",
        "",
        "大纲正文",
      ].join("\n"),
      [],
    )

    expect(draft.title).toBe("新的大纲标题")
    expect(draft.content).not.toContain("type: outline-17")
  })

  it("changes the title when it already exists in the outline library", () => {
    const draft = prepareOutlineSaveDraft("# 第1章\n\n新的章纲", ["第1章"])

    expect(draft.title).not.toBe("第1章")
    expect(draft.title).toBe("第1章-AI生成")
  })

  it("derives the title from a short standalone line when there is no heading", () => {
    const draft = prepareOutlineSaveDraft("短标题\n\n正文内容", [])
    expect(draft.title).toBe("短标题")
    expect(draft.content).toBe("短标题\n\n正文内容")
  })

  it("falls back to a date-stamped title when no line qualifies", () => {
    const longLine = "这行文字超过四十个字符所以不能作为短标题使用而且还在继续延长字数".repeat(2)
    const draft = prepareOutlineSaveDraft(
      [
        `- 列表项开头的行`, // starts with "-"
        `* 星号开头的行`, // starts with "*"
        `带:冒号的行`, // contains ":"
        "正文", // too short (2 chars)
        longLine, // too long
      ].join("\n"),
      [],
    )
    expect(draft.title).toMatch(/^AI大纲-\d{4}-\d{2}-\d{2}$/)
  })

  it("sanitizes unsafe filename characters and falls back when everything is stripped", () => {
    const draft = prepareOutlineSaveDraft("# 第1章/章:节*标题?\n\n正文", [])
    expect(draft.title).toBe("第1章章节标题")

    const stripped = prepareOutlineSaveDraft("# ?:*\n\n正文", [])
    expect(stripped.title).toMatch(/^AI大纲-\d{4}-\d{2}-\d{2}$/)
  })

  it("caps the title at 24 characters", () => {
    const long = "这是一个非常非常非常非常非常非常非常非常长的标题啊"
    const draft = prepareOutlineSaveDraft(`# ${long}\n\n正文`, [])
    expect(draft.title.length).toBeLessThanOrEqual(24)
    expect(draft.title).toBe(long.slice(0, 24))
  })

  it("keeps walking the suffix chain when the suffixed name also exists", () => {
    const draft = prepareOutlineSaveDraft("# T\n\n正文", ["T", "T-AI生成"])
    expect(draft.title).toBe("T-AI生成-2")
  })

  it("falls back to a Date.now suffix when all 99 candidates exist", () => {
    const existing = ["T", "T-AI生成", ...Array.from({ length: 98 }, (_, i) => `T-AI生成-${i + 2}`)]
    const draft = prepareOutlineSaveDraft("# T\n\n正文", existing)
    expect(draft.title).toMatch(/^T-AI生成-\d{13}$/)
  })

  it("trims and drops empty entries from existing titles before dedupe", () => {
    const draft = prepareOutlineSaveDraft("# T\n\n正文", ["  T  ", "   ", "", "T-AI生成"])
    expect(draft.title).toBe("T-AI生成-2")
  })
})

import { describe, expect, it } from "vitest"
import { parseSlugLine, validateScreenplayDraft } from "./screenplay-format"

describe("screenplay-format（吸收自 inkos script-writing 引擎层组件）", () => {
  it("parseSlugLine 解析规范场景标题（INT./EXT./I-E.）", () => {
    expect(parseSlugLine("INT. 废弃工厂 - 夜")).toEqual({
      intExt: "INT",
      location: "废弃工厂",
      timeOfDay: "夜",
    })
    expect(parseSlugLine("EXT. 城市天台 - 日")).toEqual({
      intExt: "EXT",
      location: "城市天台",
      timeOfDay: "日",
    })
    expect(parseSlugLine("I-E. 行驶的车内 - 黄昏")).toEqual({
      intExt: "I-E",
      location: "行驶的车内",
      timeOfDay: "黄昏",
    })
  })

  it("parseSlugLine 拒绝非标题行与残缺标题", () => {
    expect(parseSlugLine("他推开门走了进去。")).toBeNull()
    expect(parseSlugLine("INT. 只有地点")).toBeNull()
    expect(parseSlugLine("INT. - 夜")).toBeNull()
  })

  it("validateScreenplayDraft：正文在首个场景标题前 → error", () => {
    const result = validateScreenplayDraft(
      "他推开门。\nINT. 警局办公室 - 日\n林澈放下卷宗。",
    )
    expect(result.findings.some((f) => f.code === "missing_slug_after_action" && f.severity === "error")).toBe(true)
  })

  it("validateScreenplayDraft：规范两场景零 findings", () => {
    const result = validateScreenplayDraft(
      [
        "INT. 警局办公室 - 日",
        "林澈放下卷宗。",
        "",
        "EXT. 城市天台 - 夜",
        "风吹起他的衣角。",
      ].join("\n"),
    )
    expect(result.sceneCount).toBe(2)
    expect(result.findings).toEqual([])
  })

  it("validateScreenplayDraft：连续场景标题 warn + 空场景 warn", () => {
    const result = validateScreenplayDraft(
      ["INT. A - 日", "EXT. B - 夜", "正文"].join("\n"),
    )
    expect(result.findings.some((f) => f.code === "consecutive_slugs")).toBe(true)
    const empty = validateScreenplayDraft("INT. A - 日")
    expect(empty.findings.some((f) => f.code === "empty_scene")).toBe(true)
  })

  it("validateScreenplayDraft：非惯用时间 warn", () => {
    const result = validateScreenplayDraft(
      ["INT. A - 雾起时分", "正文"].join("\n"),
    )
    expect(
      result.findings.some((f) => f.code === "slug_time_unknown" && f.severity === "warn"),
    ).toBe(true)
  })

  it("确定性：同输入双跑全等", () => {
    const text = "INT. A - 日\n正文\nEXT. B - 夜\n更多正文"
    expect(JSON.stringify(validateScreenplayDraft(text))).toBe(
      JSON.stringify(validateScreenplayDraft(text)),
    )
  })
})

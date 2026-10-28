/** C4 冒烟覆盖：src/lib/novel/outline-quality-check.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { runVolumeOutlineQualityCheck, runChapterOutlineQualityCheck, summarizeChapterOutlineQuality, isLikelyChapterOutline, extractChapterOutlineStatus, checkFinaleVolumeDiscipline, formatOutlineQualityReport } from "./outline-quality-check"
describe("outline-quality-check.ts smoke", () => {
  it("exports runVolumeOutlineQualityCheck", () => {
    expect(runVolumeOutlineQualityCheck).toBeDefined()
  })
  it("exports runChapterOutlineQualityCheck", () => {
    expect(runChapterOutlineQualityCheck).toBeDefined()
  })
  it("exports summarizeChapterOutlineQuality", () => {
    expect(summarizeChapterOutlineQuality).toBeDefined()
  })
  it("exports isLikelyChapterOutline", () => {
    expect(isLikelyChapterOutline).toBeDefined()
  })
  it("exports extractChapterOutlineStatus", () => {
    expect(extractChapterOutlineStatus).toBeDefined()
  })
  it("exports checkFinaleVolumeDiscipline", () => {
    expect(checkFinaleVolumeDiscipline).toBeDefined()
  })

  it("names the missing volume headings", () => {
    const report = formatOutlineQualityReport("# 总大纲\n没有卷字段", "volume")
    expect(report).toContain("大纲审核：有缺项。")
    expect(report).toContain("本卷目标")
  })

  it("names missing chapter sections", () => {
    const report = formatOutlineQualityReport("# 章节细纲\n只有标题", "chapter")
    expect(report).toContain("章纲审核：有缺项。")
    expect(report).toContain("本章目标")
  })
})

describe("章纲钩子与爽点：标题存在但内容空壳", () => {
  const buildOutline = (enjoymentBody: string, hookBody: string) => [
    "## 章首钩子",
    "开篇第一屏：契约到期通知弹出，倒计时开始。",
    "## 爽点设计",
    enjoymentBody,
    "## 章尾钩子",
    hookBody,
  ].join("\n")

  it("只剩字段名没有内容 → warn（不阻断保存）", () => {
    const items = runChapterOutlineQualityCheck(
      buildOutline("- 本章核心爽点：\n- 爽点铺垫：\n- 爽点兑现方式：", "- 结尾落点：\n- 悬念或反转："),
    )
    const hooks = items.find((item) => item.category === "钩子与爽点")!
    expect(hooks.status).toBe("warn")
    expect(hooks.details?.join()).toContain("具体压迫源")
  })

  it("只剩套话 → warn", () => {
    const items = runChapterOutlineQualityCheck(buildOutline("- 本章核心爽点：有爽点", "- 结尾落点：留下悬念"))
    const hooks = items.find((item) => item.category === "钩子与爽点")!
    expect(hooks.status).toBe("warn")
  })

  it("写出可指认内容 → pass", () => {
    const items = runChapterOutlineQualityCheck(
      buildOutline(
        "- 本章核心爽点：白曦用“到账即还款”条款反将周砚一军，围观租体者第一次看到公司吃瘪\n- 爽点兑现方式：周砚被迫签字，灵压反噬回到他身上",
        "- 结尾落点：周砚递来补充协议，条款里写着白曦母亲的名字，下一章必须查清担保链",
      ),
    )
    const hooks = items.find((item) => item.category === "钩子与爽点")!
    expect(hooks.status).toBe("pass")
  })

  it("整节缺失仍是 error（空壳只是降级为 warn）", () => {
    const items = runChapterOutlineQualityCheck("## 章首钩子\n开篇有钩子。")
    const hooks = items.find((item) => item.category === "钩子与爽点")!
    expect(hooks.status).toBe("error")
  })
})

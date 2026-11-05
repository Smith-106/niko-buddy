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

describe("isLikelyChapterOutline", () => {
  it("内容含章纲关键词时判定为章纲", () => {
    expect(isLikelyChapterOutline("## 本章目标\n推进主线")).toBe(true)
  })

  it("内容无关但文件名带「细纲」时也判定为章纲", () => {
    expect(isLikelyChapterOutline("随便写点东西", "第3章细纲.md")).toBe(true)
  })

  it("内容与文件名都无关时返回 false", () => {
    expect(isLikelyChapterOutline("## 卷纲\n本卷目标：打完这一仗", "第一卷.md")).toBe(false)
  })
})

describe("extractChapterOutlineStatus", () => {
  it("解析出三种已知状态", () => {
    expect(extractChapterOutlineStatus("当前状态：已确认")).toBe("已确认")
    expect(extractChapterOutlineStatus("当前状态: 草稿")).toBe("草稿")
    expect(extractChapterOutlineStatus("当前状态：需修改")).toBe("需修改")
  })

  it("没有状态行时返回未知", () => {
    expect(extractChapterOutlineStatus("## 本章目标\n无状态标记")).toBe("未知")
  })

  it("状态值不在枚举内时也返回未知，不猜", () => {
    expect(extractChapterOutlineStatus("当前状态：写了一半")).toBe("未知")
  })
})

describe("summarizeChapterOutlineQuality", () => {
  it("空内容时 valid 为 false，errors 非空，items 覆盖全部章纲规则", () => {
    const summary = summarizeChapterOutlineQuality("")
    expect(summary.valid).toBe(false)
    expect(summary.errors.length).toBeGreaterThan(0)
    expect(summary.items).toHaveLength(10)
  })

  it("errors/warnings 都来自 items 的 details，没有 details 时回落到 message", () => {
    const summary = summarizeChapterOutlineQuality("")
    const errorItems = summary.items.filter((i) => i.status === "error")
    const expected = errorItems.flatMap((i) => (i.details?.length ? i.details : [i.message]))
    expect(summary.errors).toEqual(expected)
  })

  it("valid 与 errors 长度严格一致（有错误即不通过）", () => {
    const summary = summarizeChapterOutlineQuality("")
    expect(summary.valid).toBe(summary.errors.length === 0)
  })
})

describe("formatOutlineQualityReport", () => {
  it("章纲有缺项时输出标题 + 逐条问题", () => {
    const report = formatOutlineQualityReport("", "chapter")
    expect(report.startsWith("章纲审核：有缺项。")).toBe(true)
    expect(report).toContain("\n- ")
  })

  it("卷纲有缺项时用「大纲审核」标题", () => {
    const report = formatOutlineQualityReport("", "volume")
    expect(report.startsWith("大纲审核：有缺项。")).toBe(true)
  })

  it("问题项带 details 时逐条缩进列出", () => {
    const report = formatOutlineQualityReport("", "chapter")
    // 至少有一个规则返回 details（例如缺失章节清单），缩进两格
    expect(report).toMatch(/\n {2}- /)
  })
})

describe("runVolumeOutlineQualityCheck", () => {
  it("没有定位分布表时给出 warn 并跳过章节级检查", () => {
    const items = runVolumeOutlineQualityCheck("## 本卷目标\n打一场硬仗")
    const item = items.find((i) => i.category === "章节定位分布")
    expect(item?.status).toBe("warn")
    expect(item?.message).toContain("未解析到章节定位分布表")
  })

  it("结果恒为数组且每项都有 category/status/message", () => {
    for (const item of runVolumeOutlineQualityCheck("")) {
      expect(typeof item.category).toBe("string")
      expect(["pass", "warn", "error"]).toContain(item.status)
      expect(typeof item.message).toBe("string")
    }
  })
})

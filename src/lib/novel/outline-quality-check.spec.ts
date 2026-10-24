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

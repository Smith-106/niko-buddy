/** C4 冒烟覆盖：src/lib/novel/outline-quality-check.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { runVolumeOutlineQualityCheck, runChapterOutlineQualityCheck, summarizeChapterOutlineQuality, isLikelyChapterOutline, extractChapterOutlineStatus, checkFinaleVolumeDiscipline } from "./outline-quality-check"
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
})

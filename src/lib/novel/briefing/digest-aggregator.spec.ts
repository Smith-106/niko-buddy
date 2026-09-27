/** C4 冒烟覆盖：src/lib/novel/briefing/digest-aggregator.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { BRIEFING_SOURCE_KINDS, BRIEFING_PATHS, formatEmotionEntry, currentChapterOf, openDebtsOf, assertSourced, buildBriefingDigest } from "./digest-aggregator"
describe("digest-aggregator.ts smoke", () => {
  it("exports BRIEFING_SOURCE_KINDS", () => {
    expect(BRIEFING_SOURCE_KINDS).toBeDefined()
  })
  it("exports BRIEFING_PATHS", () => {
    expect(BRIEFING_PATHS).toBeDefined()
  })
  it("exports formatEmotionEntry", () => {
    expect(formatEmotionEntry).toBeDefined()
  })
  it("exports currentChapterOf", () => {
    expect(currentChapterOf).toBeDefined()
  })
  it("exports openDebtsOf", () => {
    expect(openDebtsOf).toBeDefined()
  })
  it("exports assertSourced", () => {
    expect(assertSourced).toBeDefined()
  })
  it("exports buildBriefingDigest", () => {
    expect(buildBriefingDigest).toBeDefined()
  })
})

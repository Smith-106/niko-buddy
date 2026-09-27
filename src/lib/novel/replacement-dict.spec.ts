/** C4 冒烟覆盖：src/lib/novel/replacement-dict.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { DELETE_ON_SIGHT, PHRASE_REPLACEMENTS, WORD_REPLACEMENTS, COLLOQUIAL_REPLACEMENTS, ALL_REPLACEMENTS, buildReplacementIndex, replacementDictStats } from "./replacement-dict"
describe("replacement-dict.ts smoke", () => {
  it("exports DELETE_ON_SIGHT", () => {
    expect(DELETE_ON_SIGHT).toBeDefined()
  })
  it("exports PHRASE_REPLACEMENTS", () => {
    expect(PHRASE_REPLACEMENTS).toBeDefined()
  })
  it("exports WORD_REPLACEMENTS", () => {
    expect(WORD_REPLACEMENTS).toBeDefined()
  })
  it("exports COLLOQUIAL_REPLACEMENTS", () => {
    expect(COLLOQUIAL_REPLACEMENTS).toBeDefined()
  })
  it("exports ALL_REPLACEMENTS", () => {
    expect(ALL_REPLACEMENTS).toBeDefined()
  })
  it("exports buildReplacementIndex", () => {
    expect(buildReplacementIndex).toBeDefined()
  })
  it("replacementDictStats() executes", async () => {
    await (replacementDictStats() as unknown as Promise<unknown>)
  })
})

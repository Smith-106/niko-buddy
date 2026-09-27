/** C4 冒烟覆盖：src/lib/novel/chapter-ingest-utils.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { parseFactsSubject, isCanonDualWriteEligible, extractFrontmatterString, extractFrontmatterNumber } from "./chapter-ingest-utils"
describe("chapter-ingest-utils.ts smoke", () => {
  it("exports parseFactsSubject", () => {
    expect(parseFactsSubject).toBeDefined()
  })
  it("exports isCanonDualWriteEligible", () => {
    expect(isCanonDualWriteEligible).toBeDefined()
  })
  it("exports extractFrontmatterString", () => {
    expect(extractFrontmatterString).toBeDefined()
  })
  it("exports extractFrontmatterNumber", () => {
    expect(extractFrontmatterNumber).toBeDefined()
  })
})

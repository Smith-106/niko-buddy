/** C4 冒烟覆盖：src/lib/novel/batch-replace/diff-model.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { MAX_FILES_PER_BATCH, diffLines, summarize, assessSafety, changedFilesOnly } from "./diff-model"
describe("diff-model.ts smoke", () => {
  it("exports MAX_FILES_PER_BATCH", () => {
    expect(MAX_FILES_PER_BATCH).toBeDefined()
  })
  it("exports diffLines", () => {
    expect(diffLines).toBeDefined()
  })
  it("exports summarize", () => {
    expect(summarize).toBeDefined()
  })
  it("exports assessSafety", () => {
    expect(assessSafety).toBeDefined()
  })
  it("exports changedFilesOnly", () => {
    expect(changedFilesOnly).toBeDefined()
  })
})

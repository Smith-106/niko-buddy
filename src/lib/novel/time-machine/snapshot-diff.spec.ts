/** C4 冒烟覆盖：src/lib/novel/time-machine/snapshot-diff.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { TRUTH_SURFACE_FILES, diffTotals, changedWorldStates, isEmptyDiff, touchesTruthSurface, formatFieldDiff, truncateValue, formatBytes } from "./snapshot-diff"
describe("snapshot-diff.ts smoke", () => {
  it("exports TRUTH_SURFACE_FILES", () => {
    expect(TRUTH_SURFACE_FILES).toBeDefined()
  })
  it("exports diffTotals", () => {
    expect(diffTotals).toBeDefined()
  })
  it("exports changedWorldStates", () => {
    expect(changedWorldStates).toBeDefined()
  })
  it("exports isEmptyDiff", () => {
    expect(isEmptyDiff).toBeDefined()
  })
  it("exports touchesTruthSurface", () => {
    expect(touchesTruthSurface).toBeDefined()
  })
  it("exports formatFieldDiff", () => {
    expect(formatFieldDiff).toBeDefined()
  })
  it("exports truncateValue", () => {
    expect(truncateValue).toBeDefined()
  })
  it("exports formatBytes", () => {
    expect(formatBytes).toBeDefined()
  })
})

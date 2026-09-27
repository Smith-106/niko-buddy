/** C4 冒烟覆盖：src/lib/novel/vector-search-core.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { VECTOR_WIKI_DIRS, extractTitle, runVectorSearchShared } from "./vector-search-core"
describe("vector-search-core.ts smoke", () => {
  it("exports VECTOR_WIKI_DIRS", () => {
    expect(VECTOR_WIKI_DIRS).toBeDefined()
  })
  it("exports extractTitle", () => {
    expect(extractTitle).toBeDefined()
  })
  it("exports runVectorSearchShared", () => {
    expect(runVectorSearchShared).toBeDefined()
  })
})

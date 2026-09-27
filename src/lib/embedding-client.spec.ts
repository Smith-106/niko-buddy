/** C4 冒烟覆盖：src/lib/embedding-client.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { embed, cosineSimilarity } from "./embedding-client"
describe("embedding-client.ts smoke", () => {
  it("exports embed", () => {
    expect(embed).toBeDefined()
  })
  it("exports cosineSimilarity", () => {
    expect(cosineSimilarity).toBeDefined()
  })
})

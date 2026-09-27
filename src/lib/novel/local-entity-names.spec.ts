/** C4 冒烟覆盖：src/lib/novel/local-entity-names.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { listLocalEntityNames, hasLocalEntityMention, detectLocalEntityMiss } from "./local-entity-names"
describe("local-entity-names.ts smoke", () => {
  it("exports listLocalEntityNames", () => {
    expect(listLocalEntityNames).toBeDefined()
  })
  it("exports hasLocalEntityMention", () => {
    expect(hasLocalEntityMention).toBeDefined()
  })
  it("exports detectLocalEntityMiss", () => {
    expect(detectLocalEntityMiss).toBeDefined()
  })
})

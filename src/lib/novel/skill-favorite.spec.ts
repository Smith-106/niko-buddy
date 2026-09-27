/** C4 冒烟覆盖：src/lib/novel/skill-favorite.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { buildWritingSnapshot, buildDeAiSnapshot, loadFavorites, saveFavorites } from "./skill-favorite"
describe("skill-favorite.ts smoke", () => {
  it("exports buildWritingSnapshot", () => {
    expect(buildWritingSnapshot).toBeDefined()
  })
  it("exports buildDeAiSnapshot", () => {
    expect(buildDeAiSnapshot).toBeDefined()
  })
  it("exports loadFavorites", () => {
    expect(loadFavorites).toBeDefined()
  })
  it("exports saveFavorites", () => {
    expect(saveFavorites).toBeDefined()
  })
})

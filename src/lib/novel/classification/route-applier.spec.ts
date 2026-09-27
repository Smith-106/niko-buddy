/** C4 冒烟覆盖：src/lib/novel/classification/route-applier.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { applyRouteRules, getCategoryFields, getAllCategories } from "./route-applier"
describe("route-applier.ts smoke", () => {
  it("exports applyRouteRules", () => {
    expect(applyRouteRules).toBeDefined()
  })
  it("exports getCategoryFields", () => {
    expect(getCategoryFields).toBeDefined()
  })
  it("getAllCategories() executes", async () => {
    await (getAllCategories() as unknown as Promise<unknown>)
  })
})

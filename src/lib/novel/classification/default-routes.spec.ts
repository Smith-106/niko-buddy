/** C4 冒烟覆盖：src/lib/novel/classification/default-routes.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { DEFAULT_CLASSIFICATION_ROUTES, DEFAULT_CLASSIFICATION_CONFIG, getDefaultRoute, hasDefaultRoute } from "./default-routes"
describe("default-routes.ts smoke", () => {
  it("exports DEFAULT_CLASSIFICATION_ROUTES", () => {
    expect(DEFAULT_CLASSIFICATION_ROUTES).toBeDefined()
  })
  it("exports DEFAULT_CLASSIFICATION_CONFIG", () => {
    expect(DEFAULT_CLASSIFICATION_CONFIG).toBeDefined()
  })
  it("exports getDefaultRoute", () => {
    expect(getDefaultRoute).toBeDefined()
  })
  it("exports hasDefaultRoute", () => {
    expect(hasDefaultRoute).toBeDefined()
  })
})

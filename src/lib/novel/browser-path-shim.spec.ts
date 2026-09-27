/** C4 冒烟覆盖：src/lib/novel/browser-path-shim.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { resolve, dirname, join, basename } from "./browser-path-shim"
describe("browser-path-shim.ts smoke", () => {
  it("exports resolve", () => {
    expect(resolve).toBeDefined()
  })
  it("exports dirname", () => {
    expect(dirname).toBeDefined()
  })
  it("exports join", () => {
    expect(join).toBeDefined()
  })
  it("exports basename", () => {
    expect(basename).toBeDefined()
  })
})

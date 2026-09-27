/** C4 冒烟覆盖：src/lib/novel/browser-fs-shim.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { readFileSync, readFile, existsSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "./browser-fs-shim"
describe("browser-fs-shim.ts smoke", () => {
  it("exports readFileSync", () => {
    expect(readFileSync).toBeDefined()
  })
  it("exports readFile", () => {
    expect(readFile).toBeDefined()
  })
  it("exports existsSync", () => {
    expect(existsSync).toBeDefined()
  })
  it("exports readdirSync", () => {
    expect(readdirSync).toBeDefined()
  })
  it("exports writeFileSync", () => {
    expect(writeFileSync).toBeDefined()
  })
  it("exports mkdirSync", () => {
    expect(mkdirSync).toBeDefined()
  })
  it("exports rmSync", () => {
    expect(rmSync).toBeDefined()
  })
})

import { describe, expect, it } from "vitest"
import { APP_NAME, formatAppTitle } from "./app-title"

describe("formatAppTitle", () => {
  it("returns the bare app name when no project is provided", () => {
    expect(formatAppTitle(null)).toBe(APP_NAME)
    expect(formatAppTitle(undefined)).toBe(APP_NAME)
  })

  it("returns the bare app name for empty or whitespace-only project names", () => {
    expect(formatAppTitle("")).toBe(APP_NAME)
    expect(formatAppTitle("   ")).toBe(APP_NAME)
  })

  it("trims the project name before appending", () => {
    expect(formatAppTitle("  星辰之海  ")).toBe(`${APP_NAME}｜星辰之海`)
  })

  it("appends a non-empty project name with the separator", () => {
    expect(formatAppTitle("我的小说")).toBe(`${APP_NAME}｜我的小说`)
  })
})

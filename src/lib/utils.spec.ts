import { describe, expect, it } from "vitest"
import { todayStamp, toErrorMessage } from "./utils"

describe("todayStamp", () => {
  it("默认返回今日 UTC YYYY-MM-DD", () => {
    expect(todayStamp()).toBe(new Date().toISOString().slice(0, 10))
    expect(todayStamp()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it("透传指定日期", () => {
    expect(todayStamp(new Date("2026-03-04T05:06:07Z"))).toBe("2026-03-04")
  })
})

describe("toErrorMessage", () => {
  it("Error 取 message，非 Error 用 String()", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom")
    expect(toErrorMessage("plain")).toBe("plain")
  })
})

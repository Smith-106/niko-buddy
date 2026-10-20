import { describe, expect, it } from "vitest"
import { bytesToHex, fnv1aHex, todayStamp, toErrorMessage } from "./utils"

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

describe("bytesToHex", () => {
  it("字节数组转小写 hex（补零）", () => {
    expect(bytesToHex([0, 15, 255])).toBe("000fff")
    expect(bytesToHex(new Uint8Array([0xab, 0x01]))).toBe("ab01")
    expect(bytesToHex([])).toBe("")
  })
})

describe("fnv1aHex", () => {
  it("确定性 8 位 hex，同内容同值", () => {
    expect(fnv1aHex("hello")).toBe("4f9f2cab")
    expect(fnv1aHex("hello")).toBe(fnv1aHex("hello"))
    expect(fnv1aHex("")).toMatch(/^[0-9a-f]{8}$/)
    expect(fnv1aHex("a")).not.toBe(fnv1aHex("b"))
  })
})

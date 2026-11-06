import { describe, expect, it, vi, afterEach } from "vitest"
import { bytesToHex, fnv1aHex, todayStamp, toErrorMessage, safeStorageGet } from "./utils"

// safeStorageGet 的两种可达环境：
// 1) SSR/隐私模式 —— 没有 localStorage（window 也不存在）；
// 2) 正常环境 —— 有 localStorage，必须原样读出已存值。
describe("safeStorageGet（无 localStorage 不抛错）", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("localStorage 缺失时返回 null（SSR/隐私模式）", () => {
    vi.stubGlobal("localStorage", undefined)
    expect(safeStorageGet("niko_buddy_fallback_fingerprint")).toBeNull()
  })

  it("localStorage 可用时读出原值，不把已存值吞成 null", () => {
    const getItem = vi.fn((key: string) => (key === "depth-preference" ? "deep" : null))
    vi.stubGlobal("localStorage", { getItem })
    expect(safeStorageGet("depth-preference")).toBe("deep")
    expect(getItem).toHaveBeenCalledWith("depth-preference")
  })
})

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

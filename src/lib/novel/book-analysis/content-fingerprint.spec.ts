// content-fingerprint.spec.ts
// 内容指纹模块测试（feature/book-analysis-reuse）
import { describe, it, expect } from "vitest"
import { fingerprintText, fingerprintFileSample } from "./content-fingerprint"

describe("content-fingerprint", () => {
  it("fingerprintText 对相同输入稳定", () => {
    expect(fingerprintText("hello world")).toBe(fingerprintText("hello world"))
  })
  it("fingerprintText 对不同输入差异", () => {
    expect(fingerprintText("hello world")).not.toBe(fingerprintText("hello WORLD"))
  })

  it("accepts an inherited Uint8Array input through the text fingerprint API runtime path", () => {
    const bytes = new TextEncoder().encode("bytes")
    expect(fingerprintText(bytes as unknown as string)).toMatch(/^[0-9a-f]{16}$/)
  })
  it("fingerprintFileSample 同时考虑 size + head + tail", () => {
    const a = "1234567890".repeat(200)
    const b = a + "x" // 改一个字符
    expect(fingerprintFileSample(a)).not.toBe(fingerprintFileSample(b))
  })
  it("fingerprintFileSample 返回 16 位 hex", () => {
    expect(fingerprintFileSample("abc")).toMatch(/^[0-9a-f]{16}$/)
  })
  it("fingerprintFileSample 大内容时纳入 head + tail（tail 分支）", () => {
    const content = "1234567890".repeat(200) // 2000 字符
    const sample = fingerprintFileSample(content, 500)
    expect(sample).toMatch(/^[0-9a-f]{16}$/)
    // 中间改动（长度不变，且不落入 head/tail 采样区）不影响指纹
    const middle = content.slice(0, 1000) + "ABCD" + content.slice(1004)
    expect(fingerprintFileSample(middle, 500)).toBe(sample)
  })
})

/**
 * mock-import-actual.spec.ts — partial-mock 封装自身的行为守卫
 */
import { describe, expect, it, vi } from "vitest"
import { mergeImportActual, mockImportActual } from "./mock-import-actual"

const ACTUAL = { a: 1, b: 2, fn: () => "actual" }

describe("mockImportActual", () => {
  it("保留 actual 字段并用 overrides 覆盖指定字段", async () => {
    const replaced = vi.fn(() => "mock")
    const factory = mockImportActual<typeof ACTUAL>(() => ({ fn: replaced }))
    const merged = await factory(async <T,>() => ACTUAL as T)
    expect(merged.a).toBe(1)
    expect(merged.b).toBe(2)
    expect(merged.fn).toBe(replaced)
  })

  it("overrides 可读取 actual 值（延迟到取回后执行）", async () => {
    const factory = mockImportActual<typeof ACTUAL>((actual) => ({ a: actual.a + 10 }))
    const merged = await factory(async <T,>() => ACTUAL as T)
    expect(merged.a).toBe(11)
    expect(merged.b).toBe(2)
  })

  it("mergeImportActual 支持显式 importActual 绑定", async () => {
    const merged = await mergeImportActual<typeof ACTUAL>(async <T,>() => ACTUAL as T, () => ({ b: 20 }))
    expect(merged).toMatchObject({ a: 1, b: 20 })
  })
})

import { afterEach, describe, expect, it, vi } from "vitest"
import { createHash, randomUUID } from "./browser-crypto-shim"

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("createHash", () => {
  it("永远抛错并指明浏览器无 node:crypto", () => {
    expect(() => createHash("sha256")).toThrow(
      "node:crypto unavailable in browser (shim)",
    )
  })

  it("缺省参数同样抛错（模块求值不崩、调用才崩）", () => {
    expect(() => createHash()).toThrow(/node:crypto unavailable/)
  })
})

describe("randomUUID", () => {
  it("优先委托给 crypto.randomUUID", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "delegated-uuid" })
    expect(randomUUID()).toBe("delegated-uuid")
  })

  it("原生 crypto.randomUUID 结果符合 RFC4122 v4", () => {
    // 不 stub：Node 19+ 自带 crypto.randomUUID，走第一分支
    expect(randomUUID()).toMatch(UUID_V4)
  })

  it("无 randomUUID 时用 getRandomValues 拼 v4（版本/变体位正确）", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (arr: Uint8Array) => arr.fill(7),
    })
    const id = randomUUID()
    expect(id).toMatch(UUID_V4)
    // b 全为 7：b6=(7&0x0f)|0x40=0x47 → 第三段首字符恒为 '4'；
    // b8=(7&0x3f)|0x80=0x87 → 第四段首字符恒为 '8'
    expect(id.split("-")[2][0]).toBe("4")
    expect(id.split("-")[3][0]).toBe("8")
    // 每次调用都重新取随机字节（非缓存常量）
    expect(id).toBe("07070707-0707-4707-8707-070707070707")
  })

  it("getRandomValues 返回递增字节时输出可精确推导", () => {
    // 实现每次取 1 字节（16 次调用各带全新 Uint8Array(1)），用计数器模拟递增流
    let next = 0
    vi.stubGlobal("crypto", {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = next++
        return arr
      },
    })
    const id = randomUUID()
    expect(id).toMatch(UUID_V4)
    // b[i]=i；b6=(6&0x0f)|0x40=0x46，b8=(8&0x3f)|0x80=0x88
    expect(id).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f")
  })

  it("非安全上下文（无 crypto）降级为 Math.random 且永不崩", () => {
    vi.stubGlobal("crypto", undefined)
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const id = randomUUID()
    // Math.random()=0.5 → 每字节 128=0x80；b6=(0x80&0x0f)|0x40=0x40，b8=(0x80&0x3f)|0x80=0x80
    expect(id).toMatch(UUID_V4)
    expect(id).toBe("80808080-8080-4080-8080-808080808080")
  })
})

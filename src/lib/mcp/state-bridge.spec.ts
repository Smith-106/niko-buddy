/**
 * 状态桥测试（方案 d23eb1df P0）。
 *
 * 重点不在 happy path，而在三条硬约束：
 * 1. 白名单外键必须被拒（否则桥就是任意 localStorage 读写通道）
 * 2. 任何异常必须回 error，不能静默丢弃（否则 Rust 只能靠 5s 超时兜底）
 * 3. P0 不得存在任何写操作
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  SETTINGS_BY_KEY,
  SETTINGS_CATALOG,
  isBridgeAllowedKey,
} from "./settings-catalog"
import { handleStateRequest, type StateRequestPayload } from "./state-bridge"

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function request(overrides: Partial<StateRequestPayload>): StateRequestPayload {
  return { id: "req-1", op: "get", ...overrides }
}

describe("settings catalog", () => {
  it("键名唯一", () => {
    const keys = SETTINGS_CATALOG.map((e) => e.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("索引与数组一致", () => {
    expect(SETTINGS_BY_KEY.size).toBe(SETTINGS_CATALOG.length)
  })

  it("P0 全部为只读", () => {
    expect(SETTINGS_CATALOG.every((e) => e.scope === "read")).toBe(true)
  })

  it("白名单按精确键名判定，不做前缀放行", () => {
    expect(isBridgeAllowedKey("niko-buddy-focus-mode")).toBe(true)
    // 同前缀但未登记的键必须拒绝——前缀匹配会把桥变成任意读写通道。
    expect(isBridgeAllowedKey("niko-buddy-not-registered")).toBe(false)
    expect(isBridgeAllowedKey("lk-something-else")).toBe(false)
  })
})

describe("handleStateRequest", () => {
  it("op=schema 返回全量目录", () => {
    const res = handleStateRequest(request({ op: "schema" }))
    expect(res.ok).toBe(true)
    expect(Array.isArray(res.value)).toBe(true)
    expect((res.value as unknown[]).length).toBe(SETTINGS_CATALOG.length)
  })

  it("op=list 返回每项的当前值", () => {
    store.set("niko-buddy-focus-mode", "1")
    const res = handleStateRequest(request({ op: "list" }))
    expect(res.ok).toBe(true)
    const entries = res.value as Array<{ key: string; value: string | null }>
    expect(entries.find((e) => e.key === "niko-buddy-focus-mode")?.value).toBe("1")
    // 未设置的键如实返回 null（"未设置"不等于"读不到"）。
    expect(entries.find((e) => e.key === "lk-chat-height")?.value).toBeNull()
  })

  it("op=get 返回已登记键的值", () => {
    store.set("lk-sidebar-collapsed", "true")
    const res = handleStateRequest(request({ key: "lk-sidebar-collapsed" }))
    expect(res.ok).toBe(true)
    expect((res.value as { value: string }).value).toBe("true")
  })

  it("op=get 拒绝未登记键", () => {
    const res = handleStateRequest(request({ key: "definitely-not-registered" }))
    expect(res.ok).toBe(false)
    expect(res.error).toContain("未登记")
  })

  it("op=get 缺少 key 时明确报错", () => {
    const res = handleStateRequest(request({}))
    expect(res.ok).toBe(false)
    expect(res.error).toContain("需要 key")
  })

  it("缺少 id 的请求被拒", () => {
    const res = handleStateRequest({ id: "", op: "schema" })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("id")
  })

  it("不支持的 op 明确报错而非静默成功", () => {
    const res = handleStateRequest({ id: "x", op: "set" as never })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("不支持的 op")
  })

  it("localStorage 抛错时转成 error 响应，不伪装成 null", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("storage disabled")
        },
      },
    })
    const res = handleStateRequest(request({ key: "niko-buddy-focus-mode" }))
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it("P0 不存在任何写操作入口", async () => {
    // 只读投影锁定的前端侧断言：模块导出里不得出现写函数。
    const mod = await import("./state-bridge")
    const exported = Object.keys(mod)
    expect(exported.filter((name) => /^(set|write|remove|delete|update)/i.test(name))).toEqual([])
  })
})

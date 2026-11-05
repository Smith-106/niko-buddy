import { describe, expect, it } from "vitest"
import {
  consumeUserMemoryLearningBudget,
  loadUserMemoryLearningBudget,
  resetUserMemoryLearningBudget,
} from "./learning-budget"

const BUDGET_KEY = "niko-buddy.user-memory-learning-budget.v1"

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  read(key: string) { return this.values.get(key) ?? null }
  write(key: string, value: string) { this.values.set(key, value) }
}

class ThrowingStorage implements Pick<Storage, "getItem" | "setItem"> {
  getItem() { return null }
  setItem() { throw new Error("quota exceeded") }
}

/** 固定的本地时间：dayKey 走本地时区，用本地构造保证断言与运行环境无关。 */
const NOW = new Date(2026, 6, 18, 8, 0, 0).getTime()
const TODAY = "2026-07-18"

describe("user memory learning budget", () => {
  it("达到每日调用上限后拒绝继续学习", () => {
    const storage = new MemoryStorage()
    const now = new Date("2026-07-18T08:00:00+08:00").getTime()

    expect(consumeUserMemoryLearningBudget(storage, 2, 100, now)).toBe(true)
    expect(consumeUserMemoryLearningBudget(storage, 2, 120, now)).toBe(true)
    expect(consumeUserMemoryLearningBudget(storage, 2, 80, now)).toBe(false)
    expect(loadUserMemoryLearningBudget(storage, now)).toMatchObject({ calls: 2, inputChars: 220 })
  })

  it("跨自然日自动重置", () => {
    const storage = new MemoryStorage()
    const firstDay = new Date("2026-07-18T08:00:00+08:00").getTime()
    const nextDay = new Date("2026-07-19T08:00:00+08:00").getTime()

    expect(consumeUserMemoryLearningBudget(storage, 1, 100, firstDay)).toBe(true)
    expect(consumeUserMemoryLearningBudget(storage, 1, 100, firstDay)).toBe(false)
    expect(consumeUserMemoryLearningBudget(storage, 1, 50, nextDay)).toBe(true)
    expect(loadUserMemoryLearningBudget(storage, nextDay)).toMatchObject({ calls: 1, inputChars: 50 })
  })
})

describe("loadUserMemoryLearningBudget — 无 storage / 脏数据降级", () => {
  it("没有 storage 时可读出当天零预算（不抛错、不返回旧日计数）", () => {
    expect(loadUserMemoryLearningBudget(null, NOW)).toEqual({ day: TODAY, calls: 0, inputChars: 0 })
  })

  it("storage 里没有预算键（getItem 返回 null）时返回当天零预算", () => {
    const storage = new MemoryStorage()

    expect(loadUserMemoryLearningBudget(storage, NOW)).toEqual({ day: TODAY, calls: 0, inputChars: 0 })
  })

  it("预算 JSON 被写坏时降级为当天零预算而不是抛错", () => {
    const storage = new MemoryStorage()
    storage.write(BUDGET_KEY, "{ not json")

    expect(loadUserMemoryLearningBudget(storage, NOW)).toEqual({ day: TODAY, calls: 0, inputChars: 0 })
  })

  it("存储的是跨日旧预算时按新的一天从零开始", () => {
    const storage = new MemoryStorage()
    storage.write(BUDGET_KEY, JSON.stringify({ day: "2026-07-17", calls: 9, inputChars: 4000 }))

    expect(loadUserMemoryLearningBudget(storage, NOW)).toEqual({ day: TODAY, calls: 0, inputChars: 0 })
  })

  it("字段类型/取值异常时归一为 0（负值与字符串计数都不得放大配额）", () => {
    const storage = new MemoryStorage()
    storage.write(BUDGET_KEY, JSON.stringify({ day: TODAY, calls: -3, inputChars: "1200" }))

    expect(loadUserMemoryLearningBudget(storage, NOW)).toEqual({ day: TODAY, calls: 0, inputChars: 0 })
  })

  it("非有限数值（Infinity）同样归一为 0", () => {
    const storage = new MemoryStorage()
    storage.write(BUDGET_KEY, '{"day":"2026-07-18","calls":1e999,"inputChars":1e999}')

    expect(loadUserMemoryLearningBudget(storage, NOW)).toEqual({ day: TODAY, calls: 0, inputChars: 0 })
  })
})

describe("consumeUserMemoryLearningBudget — 拒绝路径与写入失败", () => {
  it("dailyLimit=0 时一次都不消耗（已有预算不被改写）", () => {
    const storage = new MemoryStorage()

    expect(consumeUserMemoryLearningBudget(storage, 0, 100, NOW)).toBe(false)
    expect(storage.read(BUDGET_KEY)).toBeNull()
  })

  it("负的 dailyLimit 视作 0，直接拒绝", () => {
    const storage = new MemoryStorage()

    expect(consumeUserMemoryLearningBudget(storage, -5, 100, NOW)).toBe(false)
  })

  it("没有 storage 时放行但不记账（返回 true 且不抛错）", () => {
    expect(consumeUserMemoryLearningBudget(null, 3, 500, NOW)).toBe(true)
    expect(loadUserMemoryLearningBudget(null, NOW)).toEqual({ day: TODAY, calls: 0, inputChars: 0 })
  })

  it("预算写盘失败时返回 false（不假装已消耗）", () => {
    expect(consumeUserMemoryLearningBudget(new ThrowingStorage(), 3, 100, NOW)).toBe(false)
  })

  it("负的 inputChars 不会倒扣已累计字符数", () => {
    const storage = new MemoryStorage()
    storage.write(BUDGET_KEY, JSON.stringify({ day: TODAY, calls: 1, inputChars: 100 }))

    expect(consumeUserMemoryLearningBudget(storage, 5, -80, NOW)).toBe(true)
    expect(loadUserMemoryLearningBudget(storage, NOW)).toEqual({ day: TODAY, calls: 2, inputChars: 100 })
  })
})

describe("resetUserMemoryLearningBudget — 清空预算", () => {
  it("清空后当日预算回到零（day 置空使后续读取按新的一天计算）", () => {
    const storage = new MemoryStorage()
    storage.write(BUDGET_KEY, JSON.stringify({ day: TODAY, calls: 3, inputChars: 900 }))

    resetUserMemoryLearningBudget(storage)

    expect(storage.read(BUDGET_KEY)).toBe(JSON.stringify({ day: "", calls: 0, inputChars: 0 }))
    expect(loadUserMemoryLearningBudget(storage, NOW)).toEqual({ day: TODAY, calls: 0, inputChars: 0 })
    expect(consumeUserMemoryLearningBudget(storage, 1, 10, NOW)).toBe(true)
  })

  it("没有 storage 时静默返回", () => {
    expect(() => resetUserMemoryLearningBudget(null)).not.toThrow()
  })

  it("预算写盘失败时吞错（清空记忆不应被预算清理阻断）", () => {
    expect(() => resetUserMemoryLearningBudget(new ThrowingStorage())).not.toThrow()
  })
})

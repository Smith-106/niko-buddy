import { describe, expect, it } from "vitest"
import { consumeUserMemoryLearningBudget, loadUserMemoryLearningBudget } from "./learning-budget"

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

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

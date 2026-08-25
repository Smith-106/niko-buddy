import { describe, expect, it, beforeEach } from "vitest"
import { LOCK_WAIT_TIMEOUT_MS, __resetLocksForTest, withProjectLock } from "./novel-locks"

describe("Phase4 novel-locks (per-key async mutex)", () => {
  beforeEach(() => {
    __resetLocksForTest()
  })

  it("互斥：同一 key 并发任务串行执行（顺序与入队一致，FIFO）", async () => {
    const order: string[] = []
    const slow = withProjectLock("k", async () => {
      order.push("a-start")
      await new Promise((r) => setTimeout(r, 30))
      order.push("a-end")
    })
    const fast = withProjectLock("k", async () => {
      order.push("b")
    })
    await Promise.all([slow, fast])
    expect(order).toEqual(["a-start", "a-end", "b"])
  })

  it("不同 key 互不阻塞（并行执行）", async () => {
    let completed = 0
    const gate = new Promise<void>((r) => setTimeout(r, 20))
    await Promise.all([
      withProjectLock("x", async () => {
        await gate
        completed++
      }),
      withProjectLock("y", async () => {
        completed++
      }),
    ])
    expect(completed).toBe(2)
  })

  it("锁内抛错：后续排队者仍能继续（释放语义正确）", async () => {
    const order: string[] = []
    const failing = withProjectLock("k", async () => {
      order.push("a")
      throw new Error("boom")
    }).catch((e) => (order.push(`err:${(e as Error).message}`), undefined))
    const next = withProjectLock("k", async () => {
      order.push("b")
    })
    await Promise.all([failing, next])
    expect(order).toEqual(["a", "err:boom", "b"])
  })

  it("等待超时熔断：锁被长期占用时后续任务抛看门狗错误，且不卡死后续者", async () => {
    let releaseHeld!: () => void
    const held = new Promise<void>((r) => (releaseHeld = r))
    const holder = withProjectLock("k", () => held)
    const waiter = withProjectLock("k", async () => "done", 50).catch((e) => `err:${(e as Error).message}`)
    const result = await waiter
    expect(result).toContain("timeout")
    releaseHeld()
    await holder
    // 熔断后链已释放：后续任务可正常进入。
    const after = await withProjectLock("k", async () => "ok")
    expect(after).toBe("ok")
  })

  it("锁键空间隔离：ledger: 与 page: 前缀互不干扰", async () => {
    const order: string[] = []
    await Promise.all([
      withProjectLock("ledger:/p", async () => {
        order.push("l")
      }),
      withProjectLock("page:/p/x.md", async () => {
        order.push("p")
      }),
    ])
    expect(order.sort()).toEqual(["l", "p"])
  })
})

describe("Phase4 默认超时常量", () => {
  it("LOCK_WAIT_TIMEOUT_MS = 10s（看门狗验收）", () => {
    expect(LOCK_WAIT_TIMEOUT_MS).toBe(10_000)
  })
})

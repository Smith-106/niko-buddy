import { describe, expect, it, beforeEach } from "vitest"
import {
  LOCK_WAIT_TIMEOUT_MS,
  __resetLocksForTest,
  canonicalLockKey,
  withProjectLock,
} from "./novel-locks"
import { withProjectLock as withProjectLockCompat } from "@/lib/project-mutex"

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
describe("C1 锁族合并：跨族互斥 + 键归一（project-mutex 兼容层共享同一锁表）", () => {
  beforeEach(() => {
    __resetLocksForTest()
  })

  it("跨族互斥：兼容层取锁阻塞 novel-locks 同键（单锁表）", async () => {
    const order: string[] = []
    const gate = new Promise<void>((r) => setTimeout(r, 20))
    const holder = withProjectLockCompat("C1-proj", async () => {
      await gate
      order.push("compat-holder")
    })
    const waiterDone = withProjectLock("C1-proj", async () => {
      order.push("novel-waiter")
    })
    await Promise.resolve()
    await Promise.resolve()
    // holder 未释放前 waiter 不得进入（若两族各持独立 Map，此断言失败）。
    expect(order).toEqual([])
    await gate
    await holder
    await waiterDone
    expect(order).toEqual(["compat-holder", "novel-waiter"])
  })

  it("键归一：反斜杠/尾斜杠/复合键空尾段拼写命中同一把锁", () => {
    expect(canonicalLockKey("C:\\a\\b")).toBe(canonicalLockKey("C:/a/b"))
    expect(canonicalLockKey("C:/a/b/")).toBe(canonicalLockKey("C:/a/b"))
    expect(canonicalLockKey("C:/a/b/::chat-persist")).toBe(canonicalLockKey("C:/a/b::chat-persist"))
    // 命名空间前缀保留，不混同。
    expect(canonicalLockKey("ledger:C:/a")).not.toBe(canonicalLockKey("page:C:/a"))
  })

  it("键归一互斥：反斜杠+尾斜杠拼写与正斜杠拼写串行（同 project 不同调用面）", async () => {
    const order: string[] = []
    const slow = withProjectLock("C:\\w\\proj/", async () => {
      order.push("a-start")
      await new Promise((r) => setTimeout(r, 30))
      order.push("a-end")
    })
    const fast = withProjectLockCompat("C:/w/proj", async () => {
      order.push("b")
    })
    await Promise.all([slow, fast])
    expect(order).toEqual(["a-start", "a-end", "b"])
  })
})


/**
 * status-write-merge.spec.ts — T34 status 写入合并收敛测试（关键立即写 / 非关键合并+最小间隔 /
 * flush 于 accept/退出前）。deps 注入 + 受控时钟，零 fake timer。
 */

import { describe, expect, it, vi } from "vitest"
import {
  DEFAULT_STATUS_WRITE_MIN_INTERVAL_MS,
  createStatusWriteMerger,
  type StatusWriteMergerDeps,
} from "./status-write-merge"

function makeDeps(over: Partial<StatusWriteMergerDeps> = {}): {
  deps: StatusWriteMergerDeps
  writes: string[]
  clock: { t: number }
} {
  const writes: string[] = []
  const clock = { t: 1_000_000 }
  const deps: StatusWriteMergerDeps = {
    write: vi.fn(async (payload: string) => {
      writes.push(payload)
    }),
    now: vi.fn(() => clock.t),
    ...over,
  }
  return { deps, writes, clock }
}

describe("createStatusWriteMerger 构造护栏", () => {
  it("deps.write / deps.now 缺失或非函数 fail-fast", () => {
    expect(() => createStatusWriteMerger(null as unknown as StatusWriteMergerDeps)).toThrow(TypeError)
    expect(() =>
      createStatusWriteMerger({ write: undefined as unknown as () => Promise<void>, now: () => 0 }),
    ).toThrow(TypeError)
    expect(() =>
      createStatusWriteMerger({ write: async () => {}, now: undefined as unknown as () => number }),
    ).toThrow(TypeError)
  })

  it("非法 minIntervalMs 不抛错且回退默认值路径（行为用例见 drain 间隔断言）", async () => {
    expect(DEFAULT_STATUS_WRITE_MIN_INTERVAL_MS).toBeGreaterThan(0)
    const { deps, writes, clock } = makeDeps()
    const m = createStatusWriteMerger(deps, { minIntervalMs: Number.NaN })
    await m.schedule('{"a":1}', "non_critical")
    await expect(m.drain()).resolves.toBe(true) // 从未写过不受间隔约束
    expect(writes).toEqual(['{"a":1}'])
    clock.t += DEFAULT_STATUS_WRITE_MIN_INTERVAL_MS - 1
    await m.schedule('{"b":2}', "non_critical")
    await expect(m.drain()).resolves.toBe(false) // 默认 5s 间隔生效
    clock.t += 1
    await expect(m.drain()).resolves.toBe(true)
    expect(writes).toEqual(['{"a":1}', '{"b":2}'])
  })
})

describe("critical 关键转移立即写", () => {
  it("critical schedule 等待实际写完成后 resolve，绕过最小间隔", async () => {
    const { deps, writes, clock } = makeDeps()
    const m = createStatusWriteMerger(deps)
    clock.t += 60_000
    await m.schedule('{"s":"accepted"}', "critical")
    expect(writes).toEqual(['{"s":"accepted"}'])
    expect(m.stats().criticalWrites).toBe(1)
    expect(m.stats().lastWriteAtMs).toBe(clock.t)
    expect(m.hasPending()).toBe(false)
  })

  it("连续 critical 各自落盘不互相合并，按序串行（生命周期状态不可跳过持久化）", async () => {
    const { deps, writes } = makeDeps()
    const m = createStatusWriteMerger(deps)
    await Promise.all([
      m.schedule('{"n":1}', "critical"),
      m.schedule('{"n":2}', "critical"),
      m.schedule('{"n":3}', "critical"),
    ])
    // 三份关键转移全部落盘且保序；后两份提交时各自发现在途 pending → 合并压力计数 2。
    expect(writes).toEqual(['{"n":1}', '{"n":2}', '{"n":3}'])
    const s = m.stats()
    expect(s.criticalWrites).toBe(3)
    expect(s.mergedSubmissions).toBe(2)
    expect(m.hasPending()).toBe(false)
  })

  it("非字符串 payload reject 且不产生写入", async () => {
    const { deps, writes } = makeDeps()
    const m = createStatusWriteMerger(deps)
    await expect(m.schedule(42 as unknown as string, "critical")).rejects.toThrow(TypeError)
    await expect(m.schedule(undefined as unknown as string, "non_critical")).rejects.toThrow(TypeError)
    expect(writes).toHaveLength(0)
    expect(m.hasPending()).toBe(false)
  })
})

describe("non_critical 合并 + 最小间隔", () => {
  it("非关键提交不立即落盘，latest-wins 只保留最新 payload", async () => {
    const { deps, writes } = makeDeps()
    const m = createStatusWriteMerger(deps)
    await m.schedule('{"v":1}', "non_critical")
    await m.schedule('{"v":2}', "non_critical")
    expect(writes).toHaveLength(0)
    expect(m.hasPending()).toBe(true)
    await m.flush()
    expect(writes).toEqual(['{"v":2}'])
  })

  it("drain 在最小间隔内不动盘；到期后一次写出最新值", async () => {
    const { deps, writes, clock } = makeDeps()
    const m = createStatusWriteMerger(deps, { minIntervalMs: 5_000 })
    await m.schedule('{"t":1}', "non_critical")
    await expect(m.drain()).resolves.toBe(true) // 从未写过 → 先刷出建立落盘基准
    expect(writes).toEqual(['{"t":1}'])
    await m.schedule('{"t":2}', "non_critical") // latest-wins 覆盖 pending
    await expect(m.drain()).resolves.toBe(false) // 距上次落盘 < 5s
    expect(writes).toEqual(['{"t":1}'])
    clock.t += 5_000
    await expect(m.drain()).resolves.toBe(true)
    expect(writes).toEqual(['{"t":1}', '{"t":2}'])
    expect(m.stats().drainedWrites).toBe(2)
    expect(m.hasPending()).toBe(false)
  })

  it("从未写过时首个非关键 payload 允许被 drain 直接刷出", async () => {
    const { deps, writes } = makeDeps()
    const m = createStatusWriteMerger(deps, { minIntervalMs: 60_000 })
    await m.schedule('{"first":true}', "non_critical")
    await expect(m.drain()).resolves.toBe(true)
    expect(writes).toEqual(['{"first":true}'])
  })

  it("无 pending 时 drain/flush 均返回 false 零写盘", async () => {
    const { deps, writes } = makeDeps()
    const m = createStatusWriteMerger(deps)
    await expect(m.drain()).resolves.toBe(false)
    await expect(m.flush()).resolves.toBe(false)
    expect(writes).toHaveLength(0)
  })

  it("连续排队的两个 flush：首个落盘，第二个在队内发现 pending 已空返回 false（null 守卫分支）", async () => {
    const { deps, writes } = makeDeps()
    const m = createStatusWriteMerger(deps)
    await m.schedule('{"once":true}', "non_critical")
    const f1 = m.flush()
    const f2 = m.flush()
    await expect(f1).resolves.toBe(true)
    await expect(f2).resolves.toBe(false)
    expect(writes).toEqual(['{"once":true}'])
    expect(m.stats().flushedWrites).toBe(1)
  })
})

describe("flush 于 accept/退出前", () => {
  it("flush 强制写出 pending 并越过最小间隔", async () => {
    const { deps, writes } = makeDeps()
    const m = createStatusWriteMerger(deps, { minIntervalMs: 3_600_000 })
    await m.schedule('{"accept":true}', "non_critical")
    await expect(m.flush()).resolves.toBe(true) // 从未写过也不等待
    expect(writes).toEqual(['{"accept":true}'])
    expect(m.stats().flushedWrites).toBe(1)
  })

  it("critical 吸收未落盘的非关键心跳：只写关键快照本身（全量快照契约）", async () => {
    const { deps, writes } = makeDeps()
    const m = createStatusWriteMerger(deps)
    await m.schedule('{"heartbeat":1}', "non_critical")
    await m.schedule('{"heartbeat":2}', "non_critical") // latest-wins 吸收第一条
    await m.schedule('{"accepted":true}', "critical") // 关键快照在后构建、含全部先前状态
    expect(writes).toEqual(['{"accepted":true}'])
    const s = m.stats()
    expect(s.nonCriticalSchedules).toBe(2)
    expect(s.mergedSubmissions).toBe(2) // 心跳1被心跳2覆盖 + 心跳2被关键快照接管
    expect(s.criticalWrites).toBe(1)
    expect(m.hasPending()).toBe(false)
  })
})

describe("失败语义与统计", () => {
  it("写失败：错误如实上抛、pending 保留、后续 flush 重试成功", async () => {
    let fail = true
    const { deps, writes, clock } = makeDeps({
      write: vi.fn(async (payload: string) => {
        if (fail) throw new Error("disk full")
        writes.push(payload)
      }),
    })
    const m = createStatusWriteMerger(deps)
    clock.t += 1_000
    await expect(m.schedule('{"retry":true}', "non_critical")).resolves.toBeUndefined()
    await expect(m.flush()).rejects.toThrow("disk full")
    expect(m.hasPending()).toBe(true)
    fail = false
    await expect(m.flush()).resolves.toBe(true)
    expect(writes).toEqual(['{"retry":true}'])
    expect(m.stats().lastWriteAtMs).toBe(clock.t)
  })

  it("前序写失败不断链：后续操作照常执行", async () => {
    let calls = 0
    const { deps, writes } = makeDeps({
      write: vi.fn(async (payload: string) => {
        calls += 1
        if (calls === 1) throw new Error("boom")
        writes.push(payload)
      }),
    })
    const m = createStatusWriteMerger(deps)
    await expect(m.schedule('{"a":1}', "critical")).rejects.toThrow("boom")
    await m.schedule('{"b":2}', "critical") // 队列未被毒化
    expect(writes).toEqual(['{"b":2}'])
  })

  it("stats 快照计数完整（critical/drained/flushed/nonCritical/mergedSubmissions/lastWriteAtMs）", async () => {
    const { deps, writes, clock } = makeDeps()
    const m = createStatusWriteMerger(deps, { minIntervalMs: 1_000 })
    expect(m.stats().lastWriteAtMs).toBeNull()

    await m.schedule('{"h":1}', "non_critical")
    clock.t += 1_000
    await m.drain() // drained #1
    await m.schedule('{"h":2}', "non_critical")
    clock.t += 1_000
    await m.drain() // drained #2
    await m.schedule('{"final":true}', "critical") // critical #1
    const s = m.stats()
    expect(s.drainedWrites).toBe(2)
    expect(s.criticalWrites).toBe(1)
    expect(s.nonCriticalSchedules).toBe(2)
    expect(s.mergedSubmissions).toBe(0) // 每条提交时盘上无未落盘旧 payload（均已及时刷出）
    expect(s.flushedWrites).toBe(0)
    expect(s.lastWriteAtMs).toBe(clock.t)
    expect(writes).toHaveLength(3)
    expect(m.stats()).not.toBe(s) // 快照为新对象
  })

  it("drain 可传显式 now 参数覆盖注入时钟（节奏点驱动确定性）", async () => {
    const { deps, writes, clock } = makeDeps()
    const m = createStatusWriteMerger(deps, { minIntervalMs: 5_000 })
    await m.schedule('{"x":1}', "non_critical")
    await expect(m.drain()).resolves.toBe(true) // 建立落盘基准
    await m.schedule('{"x":2}', "non_critical")
    await expect(m.drain(clock.t + 4_999)).resolves.toBe(false) // 距基准 <5s
    await expect(m.drain(clock.t + 5_000)).resolves.toBe(true)
    expect(writes).toEqual(['{"x":1}', '{"x":2}'])
  })
})

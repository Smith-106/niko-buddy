import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  backoffDelayMs,
  createSemaphore,
  isTransientLlmError,
  runBatch,
  runWithBackoff,
} from "./concurrency"

describe("de-ai-batch concurrency — createSemaphore", () => {
  it("acquire 消耗许可，release 归还", async () => {
    const semaphore = createSemaphore(2)
    expect(semaphore.available).toBe(2)
    await semaphore.acquire()
    await semaphore.acquire()
    expect(semaphore.available).toBe(0)
    semaphore.release()
    expect(semaphore.available).toBe(1)
    semaphore.release()
    expect(semaphore.available).toBe(2)
  })

  it("acquire 超出许可时排队，release 唤醒等待者", async () => {
    const semaphore = createSemaphore(1)
    await semaphore.acquire()
    let released = false
    const waiter = semaphore.acquire().then(() => {
      released = true
    })
    await Promise.resolve()
    expect(released).toBe(false)
    semaphore.release()
    await waiter
    expect(released).toBe(true)
    expect(semaphore.available).toBe(0)
  })

  it("tryAcquire 无许可时返回 false 不排队", async () => {
    const semaphore = createSemaphore(1)
    expect(semaphore.tryAcquire()).toBe(true)
    expect(semaphore.tryAcquire()).toBe(false)
    semaphore.release()
    expect(semaphore.tryAcquire()).toBe(true)
  })

  it("limit 下限为 1", () => {
    expect(createSemaphore(0).available).toBe(1)
    expect(createSemaphore(-3).available).toBe(1)
  })
})

describe("de-ai-batch concurrency — backoffDelayMs", () => {
  it("指数退避：attempt 越大延迟越大（受 cap 约束）", () => {
    const random = () => 0.5 // 无抖动偏移
    const d0 = backoffDelayMs(0, 1000, 10000, 0, random)
    const d1 = backoffDelayMs(1, 1000, 10000, 0, random)
    const d2 = backoffDelayMs(2, 1000, 10000, 0, random)
    expect(d0).toBe(1000)
    expect(d1).toBe(2000)
    expect(d2).toBe(4000)
  })

  it("cap 上限生效", () => {
    const random = () => 0.5
    expect(backoffDelayMs(10, 1000, 10000, 0, random)).toBe(10000)
  })

  it("抖动 ±20% 范围内", () => {
    for (let i = 0; i < 50; i += 1) {
      const delay = backoffDelayMs(2, 1000, 10000, 0.2, Math.random)
      expect(delay).toBeGreaterThanOrEqual(3200)
      expect(delay).toBeLessThanOrEqual(4800)
    }
  })
})

describe("de-ai-batch concurrency — isTransientLlmError", () => {
  it("瞬时错误命中：429/5xx/限流/超时/网络", () => {
    expect(isTransientLlmError(new Error("HTTP 429 Too Many Requests"))).toBe(true)
    expect(isTransientLlmError(new Error("HTTP 503 Service Unavailable"))).toBe(true)
    expect(isTransientLlmError(new Error("rate limit exceeded"))).toBe(true)
    expect(isTransientLlmError(new Error("Request timed out after 10 min"))).toBe(true)
    expect(isTransientLlmError(new Error("network error: ECONNRESET"))).toBe(true)
    expect(isTransientLlmError(new Error("produced no meaningful stream output within 30 seconds"))).toBe(true)
  })

  it("非瞬时错误不命中：4xx 内容类/业务错误", () => {
    expect(isTransientLlmError(new Error("HTTP 400 bad request"))).toBe(false)
    expect(isTransientLlmError(new Error("HTTP 401 unauthorized"))).toBe(false)
    expect(isTransientLlmError(new Error("章节内容为空"))).toBe(false)
    expect(isTransientLlmError("plain string")).toBe(false)
  })
})

describe("de-ai-batch concurrency — runWithBackoff", () => {
  it("成功路径：不重试直接返回", async () => {
    const task = vi.fn(async () => "ok")
    const result = await runWithBackoff(task, { sleep: async () => {} })
    expect(result).toBe("ok")
    expect(task).toHaveBeenCalledTimes(1)
  })

  it("瞬时错误重试 maxRetries 次后成功", async () => {
    const task = vi.fn()
      .mockRejectedValueOnce(new Error("HTTP 429"))
      .mockRejectedValueOnce(new Error("HTTP 429"))
      .mockResolvedValueOnce("ok")
    const sleeps: number[] = []
    const result = await runWithBackoff(task, {
      maxRetries: 2,
      baseMs: 1000,
      capMs: 10000,
      jitter: 0,
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    expect(result).toBe("ok")
    expect(task).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([1000, 2000])
  })

  it("重试耗尽后抛出最后一次错误", async () => {
    const task = vi.fn().mockRejectedValue(new Error("HTTP 429"))
    await expect(
      runWithBackoff(task, { maxRetries: 1, sleep: async () => {} }),
    ).rejects.toThrow("HTTP 429")
    expect(task).toHaveBeenCalledTimes(2)
  })

  it("非瞬时错误不重试直接抛出", async () => {
    const task = vi.fn().mockRejectedValue(new Error("HTTP 400 bad request"))
    await expect(
      runWithBackoff(task, { maxRetries: 3, sleep: async () => {} }),
    ).rejects.toThrow("HTTP 400")
    expect(task).toHaveBeenCalledTimes(1)
  })

  it("自定义 shouldRetry 覆盖默认判定", async () => {
    const task = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok")
    const result = await runWithBackoff(task, {
      shouldRetry: () => true,
      sleep: async () => {},
    })
    expect(result).toBe("ok")
    expect(task).toHaveBeenCalledTimes(2)
  })
})

describe("de-ai-batch concurrency — runBatch", () => {
  it("处理全部队列项，并发受 concurrency 上限约束", async () => {
    const items = [1, 2, 3, 4, 5, 6]
    const active = { current: 0, max: 0 }
    const processed: number[] = []
    await runBatch(
      items,
      async (item) => {
        active.current += 1
        active.max = Math.max(active.max, active.current)
        await new Promise((resolve) => setTimeout(resolve, 5))
        processed.push(item)
        active.current -= 1
      },
      { concurrency: 3 },
    )
    expect(processed.sort((a, b) => a - b)).toEqual(items)
    expect(active.max).toBeLessThanOrEqual(3)
    expect(active.max).toBeGreaterThan(1)
  })

  it("单章失败被隔离，其余项继续处理", async () => {
    const processed: number[] = []
    await runBatch(
      [1, 2, 3],
      async (item) => {
        if (item === 2) throw new Error("boom")
        processed.push(item)
      },
      { concurrency: 2 },
    )
    expect(processed.sort()).toEqual([1, 3])
  })

  it("signal 中止后不再取新项", async () => {
    const controller = new AbortController()
    const processed: number[] = []
    await runBatch(
      [1, 2, 3, 4],
      async (item) => {
        if (item === 1) controller.abort()
        processed.push(item)
      },
      { concurrency: 1, signal: controller.signal },
    )
    expect(processed).toEqual([1])
  })

  it("空队列直接完成", async () => {
    await expect(runBatch([], async () => {}, { concurrency: 3 })).resolves.toBeUndefined()
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  FILE_LOCK_BASE_DELAY_MS,
  FILE_LOCK_MAX_ATTEMPTS,
  isTransientFileLockError,
  withFileLockRetry,
} from "./file-lock-guard"
import { logger } from "@/lib/utils"

const TRANSIENT_MESSAGES = [
  "Rename failed: sharing violation on 'chapter-01.tmp'",
  "The process cannot access the file because it is being used by another process.",
  "EBUSY: resource busy or locked, rename 'a.tmp' -> 'a.md'",
  "ETXTBSY: text file busy",
  "lock conflict while committing atomic write",
] as const

const NON_TRANSIENT = [
  "ENOENT: no such file or directory",
  "EACCES: permission denied",
  "disk full",
  "path not found",
  "",
] as const

function fakeSleep(records: number[]) {
  return vi.fn(async (ms: number): Promise<void> => {
    records.push(ms)
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(logger, "warn").mockImplementation(() => {})
})

describe("isTransientFileLockError", () => {
  it.each([...TRANSIENT_MESSAGES])("命中瞬态文案：%s", (message) => {
    expect(isTransientFileLockError(new Error(message))).toBe(true)
  })

  it("大小写不敏感：全大写同样命中", () => {
    for (const message of TRANSIENT_MESSAGES) {
      expect(isTransientFileLockError(new Error(message.toUpperCase()))).toBe(true)
    }
    expect(isTransientFileLockError("SHARING VIOLATION")).toBe(true)
    expect(isTransientFileLockError("ebusy")).toBe(true)
  })

  it("命中 Node code 字段（message 无关键字但 code=EBUSY）", () => {
    const err = new Error("rename failed") as NodeJS.ErrnoException
    err.code = "EBUSY"
    expect(isTransientFileLockError(err)).toBe(true)
  })

  it.each([...NON_TRANSIENT])("非瞬态文案一律 false：%s", (message) => {
    expect(isTransientFileLockError(new Error(message))).toBe(false)
    expect(isTransientFileLockError(message)).toBe(false)
  })
})

describe("withFileLockRetry", () => {
  it("瞬态错误 N 次后成功：调用次数精确 N+1，sleep 精确 N 次", async () => {
    let calls = 0
    const fn = vi.fn(async (): Promise<string> => {
      calls += 1
      if (calls <= 2) throw new Error("EBUSY: resource busy or locked")
      return "ok"
    })
    const delays: number[] = []
    const sleep = fakeSleep(delays)

    const result = await withFileLockRetry(fn, { sleep, random: () => 1 })

    expect(result).toBe("ok")
    expect(fn).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(delays).toEqual([5, 10])
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      "file-lock-guard",
      expect.stringContaining("1/5"),
      expect.objectContaining({ attempt: 1, maxAttempts: 5 }),
    )
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      "file-lock-guard",
      expect.stringContaining("2/5"),
      expect.objectContaining({ attempt: 2, maxAttempts: 5 }),
    )
  })

  it("非瞬态错误零重试：原引用抛出，sleep 与 warn 均零调用", async () => {
    const boom = new Error("ENOENT: no such file or directory")
    const fn = vi.fn(async (): Promise<never> => {
      throw boom
    })
    const sleep = vi.fn(async (_ms: number): Promise<void> => {})

    await expect(withFileLockRetry(fn, { sleep, random: () => 1 })).rejects.toBe(boom)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it("非瞬态字符串拒绝值同样零重试直接抛", async () => {
    const fn = vi.fn(async (): Promise<never> => {
      throw "path not found"
    })
    const sleep = vi.fn(async (_ms: number): Promise<void> => {})

    await expect(withFileLockRetry(fn, { sleep, random: () => 1 })).rejects.toBe(
      "path not found",
    )
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it("并发 burst 全部成功：各任务独立重试互不干扰", async () => {
    const BURST = 10
    const workers = Array.from({ length: BURST }, (_, index) => {
      let calls = 0
      const fn = vi.fn(async (): Promise<string> => {
        calls += 1
        if (calls === 1) {
          throw new Error(`sharing violation on worker-${index}.tmp`)
        }
        return `ok-${index}`
      })
      const delays: number[] = []
      const sleep = fakeSleep(delays)
      return { fn, sleep, delays, index, promise: withFileLockRetry(fn, { sleep, random: () => 1 }) }
    })

    const results = await Promise.all(workers.map((w) => w.promise))

    expect(results).toEqual(workers.map((w) => `ok-${w.index}`))
    for (const w of workers) {
      expect(w.fn).toHaveBeenCalledTimes(2)
      expect(w.sleep).toHaveBeenCalledTimes(1)
      expect(w.delays).toEqual([5])
    }
    expect(logger.warn).toHaveBeenCalledTimes(BURST)
  })

  it("退避延迟单调递增：默认基线 5ms + random=1 得 [5,10,20,40]", async () => {
    const delays: number[] = []
    const sleep = fakeSleep(delays)
    let calls = 0
    const fn = vi.fn(async (): Promise<string> => {
      calls += 1
      if (calls <= 4) throw new Error("EBUSY: resource busy or locked")
      return "ok"
    })

    // 刻意不传 baseDelayMs：断言默认基线即 5ms。
    const result = await withFileLockRetry(fn, {
      sleep,
      random: () => 1,
      maxAttempts: 5,
    })

    expect(result).toBe("ok")
    expect(FILE_LOCK_BASE_DELAY_MS).toBe(5)
    expect(fn).toHaveBeenCalledTimes(5)
    expect(sleep).toHaveBeenCalledTimes(4)
    expect(delays).toEqual([5, 10, 20, 40])
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i] as number).toBeGreaterThan(delays[i - 1] as number)
    }
  })

  it("耗尽默认 5 次后抛出最后一次原错误（默认 maxAttempts 不传即 5）", async () => {
    const last = new Error("lock conflict while committing atomic write")
    const fn = vi.fn(async (): Promise<never> => {
      throw last
    })
    const delays: number[] = []
    const sleep = fakeSleep(delays)

    // 刻意不传 maxAttempts：断言默认值即 5。
    await expect(
      withFileLockRetry(fn, { sleep, random: () => 1 }),
    ).rejects.toBe(last)
    expect(FILE_LOCK_MAX_ATTEMPTS).toBe(5)
    expect(fn).toHaveBeenCalledTimes(5)
    expect(sleep).toHaveBeenCalledTimes(4)
    expect(delays).toEqual([5, 10, 20, 40])
    expect(logger.warn).toHaveBeenCalledTimes(4)
  })

  it("delay 别名同样被用作等待函数", async () => {
    let calls = 0
    const fn = vi.fn(async (): Promise<string> => {
      calls += 1
      if (calls === 1) throw new Error("ETXTBSY: text file busy")
      return "ok"
    })
    const delays: number[] = []
    const delay = fakeSleep(delays)

    const result = await withFileLockRetry(fn, { delay, random: () => 1 })

    expect(result).toBe("ok")
    expect(fn).toHaveBeenCalledTimes(2)
    expect(delay).toHaveBeenCalledTimes(1)
    expect(delays).toEqual([5])
  })

  it("不传 sleep/delay 时走 defaultSleep 真实定时器：退避 0ms 后重试成功", async () => {
    let calls = 0
    const fn = vi.fn(async (): Promise<string> => {
      calls += 1
      if (calls === 1) throw new Error("EBUSY: resource busy or locked")
      return "ok"
    })

    const result = await withFileLockRetry(fn, { baseDelayMs: 0, random: () => 1 })

    expect(result).toBe("ok")
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe("errorText 的未知拒绝值分支（经 isTransientFileLockError 观察）", () => {
  it("纯对象只带 message：message 参与匹配", () => {
    expect(isTransientFileLockError({ message: "sharing violation on x.tmp" })).toBe(true)
  })

  it("纯对象只带 code：code 参与匹配", () => {
    expect(isTransientFileLockError({ code: "EBUSY" })).toBe(true)
  })

  it("纯对象 message + code 同时存在：两段参与匹配", () => {
    expect(isTransientFileLockError({ message: "rename failed", code: "ETXTBSY" })).toBe(true)
  })

  it("纯对象两者都无：退回 JSON.stringify 文本匹配", () => {
    expect(isTransientFileLockError({ detail: "lock conflict detected" })).toBe(true)
  })

  it("循环引用对象：JSON.stringify 抛错后落 String(err) 保底，不向外崩溃", () => {
    const circular: Record<string, unknown> = { name: "x" }
    circular.self = circular
    expect(() => isTransientFileLockError(circular)).not.toThrow()
    expect(isTransientFileLockError(circular)).toBe(false)
  })

  it("非对象原始值落 String(err)", () => {
    expect(isTransientFileLockError(42)).toBe(false)
    expect(isTransientFileLockError(null)).toBe(false)
    expect(isTransientFileLockError(undefined)).toBe(false)
    expect(isTransientFileLockError(true)).toBe(false)
  })
})

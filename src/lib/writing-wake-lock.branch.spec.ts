/**
 * writing-wake-lock.branch.spec.ts — 引用计数持锁的其余分支：
 *   - enabled=false / 非 Tauri 目标 → 直接执行 operation（不触碰 wake lock）
 *   - acquire 成功 → 任务结束后真正 release（finally 清 active）
 *   - operation 抛错 → 仍然 release，且队列的 rejection 处理器正常结算
 * 与 writing-wake-lock.spec.ts 互补（那里固定 isTauri=true 且只测了 acquire 失败路径）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { withWritingWakeLock } from "./writing-wake-lock"

const platform = vi.hoisted(() => ({ tauri: true }))

vi.mock("@/lib/platform", () => ({
  isTauri: () => platform.tauri,
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  invokeMock.mockReset()
  platform.tauri = true
})

describe("withWritingWakeLock — 直通路径（不持锁）", () => {
  it("enabled=false → 直接执行 operation，不调用 acquire/release", async () => {
    let calls = 0
    const result = await withWritingWakeLock(false, async () => {
      calls += 1
      return "draft"
    })
    expect(result).toBe("draft")
    expect(calls).toBe(1)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("非 Tauri 目标 → 直接执行 operation，不调用 acquire/release", async () => {
    platform.tauri = false
    let calls = 0
    const result = await withWritingWakeLock(true, async () => {
      calls += 1
      return 99
    })
    expect(result).toBe(99)
    expect(calls).toBe(1)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

describe("withWritingWakeLock — 持锁成功路径", () => {
  it("acquire 成功 → 任务结束后 release 一次，结果为任务返回值", async () => {
    invokeMock.mockResolvedValue(true)
    const result = await withWritingWakeLock(true, async () => "chapter")
    expect(result).toBe("chapter")
    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([
      "acquire_wake_lock",
      "release_wake_lock",
    ])
  })

  it("operation 抛错 → 仍然 release，错误原样上抛，下一个任务不受影响", async () => {
    invokeMock.mockResolvedValue(true)
    await expect(
      withWritingWakeLock(true, async () => {
        throw new Error("gen failed")
      }),
    ).rejects.toThrow("gen failed")
    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([
      "acquire_wake_lock",
      "release_wake_lock",
    ])

    // 队列的 rejection 结算后仍可继续排队新任务（不会卡死后续生成）
    invokeMock.mockClear()
    const next = await withWritingWakeLock(true, async () => "next")
    expect(next).toBe("next")
    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([
      "acquire_wake_lock",
      "release_wake_lock",
    ])
  })
})

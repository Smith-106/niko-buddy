import { describe, expect, it, vi, beforeEach } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { acquireWakeLock, releaseWakeLock, withWakeLock } from "./writing-wake-lock"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  isTauri: () => true,
}))

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  invokeMock.mockReset()
})

describe("writing-wake-lock", () => {
  it("acquireWakeLock 调用 acquire_wake_lock 命令", async () => {
    invokeMock.mockResolvedValue(true)
    const r = await acquireWakeLock()
    expect(r).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("acquire_wake_lock")
  })

  it("releaseWakeLock 调用 release_wake_lock 命令", async () => {
    invokeMock.mockResolvedValue(true)
    const r = await releaseWakeLock()
    expect(r).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith("release_wake_lock")
  })

  it("withWakeLock: 任务成功路径 acquire→task→release", async () => {
    invokeMock.mockResolvedValue(true)
    const result = await withWakeLock(Promise.resolve(42))
    expect(result).toBe(42)
    expect(invokeMock).toHaveBeenNthCalledWith(1, "acquire_wake_lock")
    expect(invokeMock).toHaveBeenNthCalledWith(2, "release_wake_lock")
  })

  it("withWakeLock: 任务抛错也会释放 wake lock（try/finally）", async () => {
    invokeMock.mockResolvedValue(true)
    const boom = Promise.reject(new Error("gen failed"))
    await expect(withWakeLock(boom)).rejects.toThrow("gen failed")
    expect(invokeMock).toHaveBeenNthCalledWith(1, "acquire_wake_lock")
    expect(invokeMock).toHaveBeenNthCalledWith(2, "release_wake_lock")
  })

  it("非 Windows 目标返回 false（no-op）", async () => {
    invokeMock.mockResolvedValue(false)
    const r = await acquireWakeLock()
    expect(r).toBe(false)
  })

  it("acquire invoke 拒绝时返回 false（不抛 unhandled rejection）", async () => {
    invokeMock.mockRejectedValue(new Error("bridge-missing"))
    await expect(acquireWakeLock()).resolves.toBe(false)
  })

  it("release invoke 拒绝时返回 false（finally 释放路径安全）", async () => {
    invokeMock.mockRejectedValue(new Error("bridge-missing"))
    await expect(releaseWakeLock()).resolves.toBe(false)
  })

  it("withWakeLock: acquire 失败仍执行任务且不抛错", async () => {
    invokeMock.mockRejectedValue(new Error("bridge-missing"))
    await expect(withWakeLock(Promise.resolve(7))).resolves.toBe(7)
  })

  it("withWritingWakeLock: Tauri 下 acquire 失败仍执行 operation 且不抛错", async () => {
    invokeMock.mockRejectedValue(new Error("bridge-missing"))
    const { withWritingWakeLock } = await import("./writing-wake-lock")
    await expect(withWritingWakeLock(true, async () => 42)).resolves.toBe(42)
  })
})

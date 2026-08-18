import { describe, expect, it, vi, beforeEach } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { acquireWakeLock, releaseWakeLock, withWakeLock } from "./writing-wake-lock"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
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
})

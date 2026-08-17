import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const isTauriMock = vi.fn()
const windowOpen = vi.fn()

const openerMocks = vi.hoisted(() => ({
  revealItemInDir: vi.fn(async () => undefined),
  openPath: vi.fn(async () => undefined),
}))

vi.mock("@/lib/platform", () => ({ isTauri: () => isTauriMock() }))

vi.mock("@tauri-apps/plugin-opener", () => openerMocks)

import { revealInFileManager } from "./reveal-in-file-manager"

beforeEach(() => {
  vi.clearAllMocks()
  isTauriMock.mockReset()
  // 重新挂载 mock（用例可能把字段置 undefined 模拟缺失，下个用例需恢复）
  openerMocks.revealItemInDir = vi.fn(async () => undefined)
  openerMocks.openPath = vi.fn(async () => undefined)
  windowOpen.mockReset()
  vi.stubGlobal("window", { open: windowOpen })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("revealInFileManager", () => {
  it("does nothing for an empty path", async () => {
    await revealInFileManager("")
    expect(windowOpen).not.toHaveBeenCalled()
    expect(openerMocks.revealItemInDir).not.toHaveBeenCalled()
  })

  it("uses revealItemInDir inside Tauri", async () => {
    isTauriMock.mockReturnValue(true)

    await revealInFileManager("C:/novel/ch1.md")

    expect(openerMocks.revealItemInDir).toHaveBeenCalledWith("C:/novel/ch1.md")
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it("falls back to openPath when revealItemInDir is missing", async () => {
    isTauriMock.mockReturnValue(true)
    openerMocks.revealItemInDir = undefined as never

    await revealInFileManager("C:/novel/ch1.md")

    expect(openerMocks.openPath).toHaveBeenCalledWith("C:/novel/ch1.md")
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it("falls back to the browser file:// URI when both opener functions are missing", async () => {
    isTauriMock.mockReturnValue(true)
    openerMocks.revealItemInDir = undefined as never
    openerMocks.openPath = undefined as never

    await revealInFileManager("C:\\novel\\ch1.md")

    expect(windowOpen).toHaveBeenCalledWith(
      "file://C:/novel/ch1.md",
      "_blank",
      "noopener,noreferrer",
    )
  })

  it("uses the browser fallback outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)

    await revealInFileManager("C:\\novel\\ch1.md")

    expect(windowOpen).toHaveBeenCalledWith(
      "file://C:/novel/ch1.md",
      "_blank",
      "noopener,noreferrer",
    )
  })

  it("falls back to the browser when the Tauri opener throws", async () => {
    isTauriMock.mockReturnValue(true)
    openerMocks.revealItemInDir.mockRejectedValue(new Error("opener broken"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    await revealInFileManager("C:/novel/ch1.md")

    expect(warnSpy).toHaveBeenCalledWith("[revealInFileManager] Tauri opener failed", expect.any(Error))
    expect(windowOpen).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("swallows browser fallback failures", async () => {
    isTauriMock.mockReturnValue(false)
    windowOpen.mockImplementation(() => {
      throw new Error("popup blocked")
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    await revealInFileManager("C:/novel/ch1.md")

    expect(warnSpy).toHaveBeenCalledWith("[revealInFileManager] Browser fallback failed", expect.any(Error))
    warnSpy.mockRestore()
  })
})

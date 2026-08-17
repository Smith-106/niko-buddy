import { afterEach, describe, expect, it, vi } from "vitest"
import { isTauri, pickDirectory, supportsDirectoryPicker } from "./platform"

const dialogOpenMock = vi.fn()

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => dialogOpenMock(...args),
}))

type WindowWithPicker = Window & {
  showDirectoryPicker?: () => Promise<{ name?: string } | undefined>
  prompt?: (message?: string) => string | null
}

function installWindow(overrides: Partial<WindowWithPicker> = {}): WindowWithPicker {
  const win = {
    prompt: vi.fn(() => null),
    ...overrides,
  } as unknown as WindowWithPicker
  vi.stubGlobal("window", win)
  return win
}

afterEach(() => {
  vi.unstubAllGlobals()
  dialogOpenMock.mockReset()
})

describe("isTauri", () => {
  it("returns false when there is no window (node runtime)", () => {
    expect(isTauri()).toBe(false)
  })

  it("returns false when the Tauri internals bridge is absent", () => {
    installWindow({})
    expect(isTauri()).toBe(false)
  })

  it("returns true when __TAURI_INTERNALS__ is present", () => {
    installWindow()
    ;(globalThis.window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    expect(isTauri()).toBe(true)
  })
})

describe("supportsDirectoryPicker", () => {
  it("returns false without a window", () => {
    expect(supportsDirectoryPicker()).toBe(false)
  })

  it("returns false when showDirectoryPicker is missing", () => {
    installWindow({})
    expect(supportsDirectoryPicker()).toBe(false)
  })

  it("returns true when showDirectoryPicker is a function", () => {
    installWindow({ showDirectoryPicker: vi.fn() })
    expect(supportsDirectoryPicker()).toBe(true)
  })
})

describe("pickDirectory", () => {
  it("uses the Tauri dialog inside Tauri", async () => {
    installWindow()
    ;(globalThis.window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    dialogOpenMock.mockResolvedValue("C:/selected")
    await expect(pickDirectory()).resolves.toBe("C:/selected")
    expect(dialogOpenMock).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "选择文件夹",
    })
  })

  it("returns null when the Tauri dialog is cancelled", async () => {
    installWindow()
    ;(globalThis.window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    dialogOpenMock.mockResolvedValue(null)
    await expect(pickDirectory()).resolves.toBeNull()
  })

  it("uses the File System Directory Picker when available", async () => {
    const showDirectoryPicker = vi.fn(async () => ({ name: "my-project" }))
    installWindow({ showDirectoryPicker })
    await expect(pickDirectory()).resolves.toBe("my-project")
    expect(showDirectoryPicker).toHaveBeenCalled()
  })

  it("returns null when the directory picker handle is missing", async () => {
    const showDirectoryPicker = vi.fn(async () => undefined)
    installWindow({ showDirectoryPicker })
    await expect(pickDirectory()).resolves.toBeNull()
  })

  it("returns null on AbortError from the directory picker", async () => {
    const showDirectoryPicker = vi.fn(async () => {
      throw new DOMException("user cancelled", "AbortError")
    })
    installWindow({ showDirectoryPicker })
    await expect(pickDirectory()).resolves.toBeNull()
  })

  it("rethrows non-Abort errors from the directory picker", async () => {
    const showDirectoryPicker = vi.fn(async () => {
      throw new Error("picker broken")
    })
    installWindow({ showDirectoryPicker })
    await expect(pickDirectory()).rejects.toThrow("picker broken")
  })

  it("falls back to window.prompt for bare-browser environments", async () => {
    const prompt = vi.fn(() => "C:/typed-path")
    installWindow({ prompt })
    await expect(pickDirectory()).resolves.toBe("C:/typed-path")
    expect(prompt).toHaveBeenCalledWith("请输入文件夹路径：")
  })

  it("returns null when the prompt is cancelled", async () => {
    const prompt = vi.fn(() => null)
    installWindow({ prompt })
    await expect(pickDirectory()).resolves.toBeNull()
  })
})

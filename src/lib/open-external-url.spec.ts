import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
  isTauri: vi.fn(),
}))
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }))
vi.mock("@/lib/platform", () => ({ isTauri: mocks.isTauri }))

const openUrlMock = mocks.openUrl
const isTauriMock = mocks.isTauri

import { openExternalUrl } from "./open-external-url"

const originalWindow = globalThis.window

beforeEach(() => {
  vi.clearAllMocks()
  isTauriMock.mockReturnValue(false)
  globalThis.window = { open: vi.fn() } as unknown as Window & typeof globalThis
})

afterEach(() => {
  globalThis.window = originalWindow
})

describe("openExternalUrl", () => {
  it("opens the URL via window.open in a non-Tauri environment", async () => {
    await openExternalUrl("https://example.com/page")
    expect(globalThis.window.open).toHaveBeenCalledWith(
      "https://example.com/page",
      "_blank",
      "noopener,noreferrer",
    )
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it("uses the Tauri opener plugin when running as a desktop app", async () => {
    isTauriMock.mockReturnValue(true)
    openUrlMock.mockResolvedValue(undefined)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await openExternalUrl("https://example.com")
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com")
    expect(globalThis.window.open).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("falls back to window.open when the Tauri opener rejects", async () => {
    isTauriMock.mockReturnValue(true)
    openUrlMock.mockRejectedValue(new Error("plugin missing"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await openExternalUrl("https://example.com")
    expect(openUrlMock).toHaveBeenCalledWith("https://example.com")
    expect(globalThis.window.open).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer",
    )
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

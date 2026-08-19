// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  dialogSave: vi.fn(),
  listen: vi.fn(),
  loadRegistry: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: mocks.dialogSave,
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}))

vi.mock("@/lib/project-identity", () => ({
  loadRegistry: mocks.loadRegistry,
}))

import { exportBackup, cancelBackup } from "./export"
import type { ExportResult } from "./types"

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mocks.dialogSave.mockResolvedValue("/out/qmai-backup.zip")
  mocks.invoke.mockResolvedValue({ success: true, warnings: [], fileCount: 3, totalSize: 100 })
  mocks.loadRegistry.mockResolvedValue({})
  mocks.listen.mockResolvedValue(() => {})
})

describe("exportBackup", () => {
  it("returns a cancelled result when save is dismissed", async () => {
    mocks.dialogSave.mockResolvedValue(null)
    const result = await exportBackup()
    expect(result.success).toBe(false)
    expect(result.error).toBe("用户取消了导出")
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("suggests a dated default file name", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 2, 5))
    await exportBackup()
    vi.useRealTimers()
    expect(mocks.dialogSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "qmai-backup-20260305.zip" }),
    )
  })

  it("collects prefixed localStorage entries and registry projects", async () => {
    localStorage.setItem("qmai:theme", "dark")
    localStorage.setItem("lk-cache", "x")
    localStorage.setItem("other", "y")
    mocks.loadRegistry.mockResolvedValue({
      a: { id: "a", path: "/A", name: "Alpha", lastOpened: 1 },
      b: { id: "b", path: "/B", name: "Beta", lastOpened: 2 },
    })
    const result = { success: true, warnings: [], fileCount: 2, totalSize: 10 }
    mocks.invoke.mockResolvedValue(result)

    await expect(exportBackup()).resolves.toBe(result)

    const params = mocks.invoke.mock.calls[0][1].params
    expect(params.localStorageData).toEqual({ "qmai:theme": "dark", "lk-cache": "x" })
    expect(params.projects).toEqual([
      { id: "a", path: "/A", name: "Alpha" },
      { id: "b", path: "/B", name: "Beta" },
    ])
  })

  it("excludes qmai_fallback_fingerprint from the collected localStorage", async () => {
    localStorage.setItem("qmai:theme", "dark")
    localStorage.setItem("qmai_fallback_fingerprint", "device-key-material")
    localStorage.setItem("qmai:other", "z")
    mocks.loadRegistry.mockResolvedValue({})
    mocks.invoke.mockResolvedValue({ success: true, warnings: [], fileCount: 0, totalSize: 0 })

    await exportBackup()

    const params = mocks.invoke.mock.calls[0][1].params
    expect(params.localStorageData).not.toHaveProperty("qmai_fallback_fingerprint")
    expect(params.localStorageData).toEqual({ "qmai:theme": "dark", "qmai:other": "z" })
  })

  it("forwards the invoke result and tears down the progress listener", async () => {
    const unlisten = vi.fn()
    mocks.listen.mockResolvedValue(unlisten)
    const onProgress = vi.fn()
    mocks.invoke.mockImplementation(async () => {
      const handler = mocks.listen.mock.calls[0]?.[1]
      handler?.({ payload: { phase: "pack" } })
      return { success: true, warnings: [], fileCount: 0, totalSize: 0, error: null } satisfies ExportResult
    })
    const result = await exportBackup(onProgress)
    expect(result.success).toBe(true)
    expect(onProgress).toHaveBeenCalledWith({ phase: "pack" })
    expect(unlisten).toHaveBeenCalled()
  })

  it("cancelBackup forwards to the cancel_backup command", async () => {
    await cancelBackup()
    expect(mocks.invoke).toHaveBeenCalledWith("cancel_backup")
  })

  it("skips null localStorage keys and null values", async () => {
    localStorage.setItem("qmai:a", "1")
    localStorage.setItem("qmai:b", "2") // 保证 length≥2，使 key(1) 分支可达
    const keySpy = vi.spyOn(Storage.prototype, "key").mockImplementation((index: number) =>
      index === 0 ? null : ("qmai:a" as unknown as string),
    )
    const getSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation((k: string) =>
      k === "qmai:a" ? null : localStorage.getItem(k),
    )
    mocks.loadRegistry.mockResolvedValue({})
    await exportBackup()
    expect(keySpy).toHaveBeenCalled()
    expect(getSpy).toHaveBeenCalledWith("qmai:a")
    keySpy.mockRestore()
    getSpy.mockRestore()
  })
})

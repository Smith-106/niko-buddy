// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  dialogOpen: vi.fn(),
  listen: vi.fn(),
  loadRegistry: vi.fn(),
  upsertProjectInfo: vi.fn(),
  refreshProjectState: vi.fn(),
  getProject: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.dialogOpen,
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}))

vi.mock("@/lib/project-identity", () => ({
  loadRegistry: mocks.loadRegistry,
  upsertProjectInfo: mocks.upsertProjectInfo,
}))

vi.mock("@/lib/project-refresh", () => ({
  refreshProjectState: mocks.refreshProjectState,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: () => ({ project: mocks.getProject() }) },
}))

import { importBackup } from "./import"
import type { ImportResult } from "./types"

function okResult(overrides: Partial<ImportResult> = {}): ImportResult {
  return {
    success: true,
    appState: null,
    localStorageData: null,
    projects: [],
    warnings: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getProject.mockReturnValue(null)
  mocks.dialogOpen.mockResolvedValue("/tmp/backup.zip")
  mocks.invoke.mockResolvedValue(okResult())
  mocks.loadRegistry.mockResolvedValue({})
  mocks.listen.mockResolvedValue(() => {})
})

describe("importBackup", () => {
  it("returns a cancelled result when no file is picked", async () => {
    mocks.dialogOpen.mockResolvedValue(null)
    const result = await importBackup("replace")
    expect(result.success).toBe(false)
    expect(result.error).toBe("用户取消了导入")
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("returns a cancelled result when a non-string path is returned", async () => {
    mocks.dialogOpen.mockResolvedValue(["a.zip"] as never)
    const result = await importBackup("replace")
    expect(result.success).toBe(false)
    expect(result.error).toBe("用户取消了导入")
  })

  it("passes params to the rust command and returns its result", async () => {
    const result = okResult({ warnings: ["w1"] })
    mocks.invoke.mockResolvedValue(result)
    await expect(importBackup("merge")).resolves.toBe(result)
    expect(mocks.invoke).toHaveBeenCalledWith("import_backup", {
      params: { zipPath: "/tmp/backup.zip", strategy: "merge", projects: undefined },
    })
  })

  it("forwards the failed result without touching storage", async () => {
    mocks.invoke.mockResolvedValue(okResult({ success: false, error: "boom" }))
    const result = await importBackup("replace")
    expect(result.success).toBe(false)
  })

  it("replaces qmai/lk- localStorage entries with the imported data", async () => {
    localStorage.setItem("qmai:theme", "old")
    localStorage.setItem("other-key", "keep")
    mocks.invoke.mockResolvedValue(
      okResult({ localStorageData: { "qmai:theme": "new", "lk-new": "v" } }),
    )
    await importBackup("replace")
    expect(localStorage.getItem("qmai:theme")).toBe("new")
    expect(localStorage.getItem("lk-new")).toBe("v")
    expect(localStorage.getItem("other-key")).toBe("keep")
  })

  it("protects the local qmai_fallback_fingerprint during restore", async () => {
    localStorage.setItem("qmai_fallback_fingerprint", "local-device-key")
    localStorage.setItem("qmai:theme", "old")
    mocks.invoke.mockResolvedValue(
      okResult({ localStorageData: { "qmai_fallback_fingerprint": "imported-key", "qmai:theme": "new" } }),
    )
    await importBackup("replace")
    expect(localStorage.getItem("qmai_fallback_fingerprint")).toBe("local-device-key")
    expect(localStorage.getItem("qmai:theme")).toBe("new")
  })

  it("registers restored projects and refreshes the currently open project", async () => {
    mocks.getProject.mockReturnValue({ id: "p1", name: "P", path: "/P" })
    mocks.loadRegistry.mockResolvedValue({ p1: { id: "p1", path: "/old", name: "Old", lastOpened: 0 } })
    mocks.invoke.mockResolvedValue(
      okResult({
        projects: [
          { id: "p1", name: "P", path: "/P", success: true },
          { id: "p2", name: "Q", path: "/Q", success: false },
        ],
      }),
    )
    await importBackup("replace")
    expect(mocks.upsertProjectInfo).toHaveBeenCalledTimes(1)
    expect(mocks.upsertProjectInfo).toHaveBeenCalledWith("p1", "/P", "Old") // existing name kept
    expect(mocks.refreshProjectState).toHaveBeenCalledWith("/P")
  })

  it("does not refresh when no restored project matches the open one", async () => {
    mocks.getProject.mockReturnValue({ id: "p9", name: "Z", path: "/Z" })
    mocks.invoke.mockResolvedValue(
      okResult({ projects: [{ id: "p1", name: "P", path: "/P", success: true }] }),
    )
    await importBackup("replace")
    expect(mocks.upsertProjectInfo).toHaveBeenCalledWith("p1", "/P", "P")
    expect(mocks.refreshProjectState).not.toHaveBeenCalled()
  })

  it("skips project registration when no projects restored", async () => {
    await importBackup("replace")
    expect(mocks.upsertProjectInfo).not.toHaveBeenCalled()
    expect(mocks.refreshProjectState).not.toHaveBeenCalled()
  })

  it("does nothing when no project is currently open", async () => {
    mocks.invoke.mockResolvedValue(
      okResult({ projects: [{ id: "p1", name: "P", path: "/P", success: true }] }),
    )
    await importBackup("replace")
    expect(mocks.upsertProjectInfo).toHaveBeenCalled()
    expect(mocks.refreshProjectState).not.toHaveBeenCalled()
  })

  it("wires up and tears down the progress listener", async () => {
    const unlisten = vi.fn()
    mocks.listen.mockResolvedValue(unlisten)
    const onProgress = vi.fn()
    mocks.invoke.mockImplementation(async () => {
      const handler = mocks.listen.mock.calls[0]?.[1]
      handler?.({ payload: { done: 1, total: 2 } })
      return okResult()
    })
    await importBackup("replace", undefined, onProgress)
    expect(mocks.listen).toHaveBeenCalledWith("backup-progress", expect.any(Function))
    expect(onProgress).toHaveBeenCalledWith({ done: 1, total: 2 })
    expect(unlisten).toHaveBeenCalled()
  })
})

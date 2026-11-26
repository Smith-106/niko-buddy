// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  dialogSave: vi.fn(),
  listen: vi.fn(),
  loadRegistry: vi.fn(),
  fileExists: vi.fn(async (_path: string) => false),
  listDirectory: vi.fn(async (_path: string) => [] as unknown[]),
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

vi.mock("@/commands/fs", () => ({
  fileExists: mocks.fileExists,
  listDirectory: mocks.listDirectory,
}))

vi.mock("@/lib/project-identity", () => ({
  loadRegistry: mocks.loadRegistry,
}))

import { exportBackup, cancelBackup, inventoryProjectBackupScope } from "./export"
import type { ExportResult } from "./types"

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mocks.dialogSave.mockResolvedValue("/out/niko-buddy-backup.zip")
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
      expect.objectContaining({ defaultPath: "niko-buddy-backup-20260305.zip" }),
    )
  })

  it("collects prefixed localStorage entries and registry projects", async () => {
    localStorage.setItem("niko-buddy:theme", "dark")
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
    expect(params.localStorageData).toEqual({ "niko-buddy:theme": "dark", "lk-cache": "x" })
    expect(params.projects).toEqual([
      { id: "a", path: "/A", name: "Alpha" },
      { id: "b", path: "/B", name: "Beta" },
    ])
  })

  it("excludes niko_buddy_fallback_fingerprint from the collected localStorage", async () => {
    localStorage.setItem("niko-buddy:theme", "dark")
    localStorage.setItem("niko_buddy_fallback_fingerprint", "device-key-material")
    localStorage.setItem("niko-buddy:other", "z")
    mocks.loadRegistry.mockResolvedValue({})
    mocks.invoke.mockResolvedValue({ success: true, warnings: [], fileCount: 0, totalSize: 0 })

    await exportBackup()

    const params = mocks.invoke.mock.calls[0][1].params
    expect(params.localStorageData).not.toHaveProperty("niko_buddy_fallback_fingerprint")
    expect(params.localStorageData).toEqual({ "niko-buddy:theme": "dark", "niko-buddy:other": "z" })
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
    localStorage.setItem("niko-buddy:a", "1")
    localStorage.setItem("niko-buddy:b", "2") // 保证 length≥2，使 key(1) 分支可达
    const keySpy = vi.spyOn(Storage.prototype, "key").mockImplementation((index: number) =>
      index === 0 ? null : ("niko-buddy:a" as unknown as string),
    )
    const getSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation((k: string) =>
      k === "niko-buddy:a" ? null : localStorage.getItem(k),
    )
    mocks.loadRegistry.mockResolvedValue({})
    await exportBackup()
    expect(keySpy).toHaveBeenCalled()
    expect(getSpy).toHaveBeenCalledWith("niko-buddy:a")
    keySpy.mockRestore()
    getSpy.mockRestore()
  })
})

describe("inventoryProjectBackupScope (P0-03)", () => {
  beforeEach(() => {
    mocks.fileExists.mockReset()
    mocks.listDirectory.mockReset()
  })

  it("returns zeroed inventory when projectPath is empty", async () => {
    const scope = await inventoryProjectBackupScope("")
    expect(scope).toEqual({
      chapters: 0,
      outlines: 0,
      settings: 0,
      snapshots: 0,
      qmDrafts: 0,
      status: 0,
      canonLancedb: 0,
      rootDocs: 0,
      knowledgeRoot: null,
    })
    expect(mocks.fileExists).not.toHaveBeenCalled()
  })

  it("prefers QM/ over wiki/ and counts all 8 backup categories while skipping backups/.t34c", async () => {
    const existing = new Set([
      "/book/QM",
      "/book/wiki",
      "/book/.novel/snapshots",
      "/book/.qm-drafts",
      "/book/.novel/status.json",
      "/book/.niko-buddy/lancedb",
      "/book/soul.md",
      "/book/purpose.md",
    ])
    mocks.fileExists.mockImplementation(async (p: string) => existing.has(p))
    mocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === "/book/QM") {
        return [
          {
            name: "chapters",
            path: "/book/QM/chapters",
            is_dir: true,
            children: [
              { name: "chapter-001.md", path: "/book/QM/chapters/chapter-001.md", is_dir: false },
              { name: "chapter-002.md", path: "/book/QM/chapters/chapter-002.md", is_dir: false },
            ],
          },
          {
            name: "outlines",
            path: "/book/QM/outlines",
            is_dir: true,
            children: [{ name: "vol1.md", path: "/book/QM/outlines/vol1.md", is_dir: false }],
          },
          {
            name: "entities",
            path: "/book/QM/entities",
            is_dir: true,
            children: [{ name: "hero.md", path: "/book/QM/entities/hero.md", is_dir: false }],
          },
          {
            name: "backups",
            path: "/book/QM/backups",
            is_dir: true,
            children: [{ name: "old.zip", path: "/book/QM/backups/old.zip", is_dir: false }],
          },
        ]
      }
      if (dir === "/book/.novel/snapshots") {
        return [{ name: "s1.json", path: "/book/.novel/snapshots/s1.json", is_dir: false }]
      }
      if (dir === "/book/.qm-drafts") {
        return [
          { name: "d1.md", path: "/book/.qm-drafts/d1.md", is_dir: false },
          { name: "d2.md", path: "/book/.qm-drafts/d2.md", is_dir: false },
        ]
      }
      if (dir === "/book/.niko-buddy/lancedb") {
        return [{ name: "facts.lance", path: "/book/.niko-buddy/lancedb/facts.lance", is_dir: false }]
      }
      return []
    })

    const scope = await inventoryProjectBackupScope("/book/")
    expect(scope).toEqual({
      chapters: 2,
      outlines: 1,
      settings: 1,
      snapshots: 1,
      qmDrafts: 2,
      status: 1,
      canonLancedb: 1,
      rootDocs: 2,
      knowledgeRoot: "QM",
    })
  })

  it("correctly counts QM/ chapters/outlines/settings when Rust listDirectory virtualizes paths to wiki/ with different drive case", async () => {
    const existing = new Set(["C:/Book/QM"])
    mocks.fileExists.mockImplementation(async (p: string) => existing.has(p))
    mocks.listDirectory.mockImplementation(async (dir: string) => {
      if (dir === "C:/Book/QM") {
        // 模拟 Rust build_tree 将 {root}/QM/... 虚拟化为 {root}/wiki/... 且带盘符大小写差异
        return [
          {
            name: "chapters",
            path: "c:/book/wiki/chapters",
            is_dir: true,
            children: [
              { name: "ch-001.md", path: "c:/book/wiki/chapters/ch-001.md", is_dir: false },
              { name: "ch-002.md", path: "C:/Book/wiki/chapters/ch-002.md", is_dir: false },
            ],
          },
          {
            name: "outlines",
            path: "C:/Book/wiki/outlines",
            is_dir: true,
            children: [{ name: "main.md", path: "C:/Book/wiki/outlines/main.md", is_dir: false }],
          },
          {
            name: "entities",
            path: "C:/Book/wiki/entities",
            is_dir: true,
            children: [{ name: "hero.md", path: "C:/Book/wiki/entities/hero.md", is_dir: false }],
          },
          {
            name: "backups",
            path: "C:/Book/wiki/backups",
            is_dir: true,
            children: [{ name: "skip.zip", path: "C:/Book/wiki/backups/skip.zip", is_dir: false }],
          },
        ]
      }
      return []
    })

    const scope = await inventoryProjectBackupScope("C:\\Book")
    expect(scope).toEqual({
      chapters: 2,
      outlines: 1,
      settings: 1,
      snapshots: 0,
      qmDrafts: 0,
      status: 0,
      canonLancedb: 0,
      rootDocs: 0,
      knowledgeRoot: "QM",
    })
  })
})

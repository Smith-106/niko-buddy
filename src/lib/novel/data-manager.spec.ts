import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  fileExists: vi.fn(),
  getFileSize: vi.fn(),
  pathIsDirectory: vi.fn(),
  copyDirectory: vi.fn(),
  copyFile: vi.fn(),
  createDirectory: vi.fn(),
  deleteFile: vi.fn(),
}))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    listDirectory: mocks.listDirectory,
    fileExists: mocks.fileExists,
    getFileSize: mocks.getFileSize,
    pathIsDirectory: mocks.pathIsDirectory,
    copyDirectory: mocks.copyDirectory,
    copyFile: mocks.copyFile,
    createDirectory: mocks.createDirectory,
    deleteFile: mocks.deleteFile,
  }
})

import { DATA_DOMAINS, domainRequiresTypedConfirm } from "./data-domain-registry"
import {
  listTrash,
  moveAllToTrash,
  moveDomainToTrash,
  restoreDomainFromTrash,
  statDomain,
} from "./data-manager"

const PP = "/proj/book"
const BASE = "/proj/book/.niko-buddy"

function dir(path: string, name = ""): FileNode {
  return { name: name || path.split("/").pop()!, path, is_dir: true }
}
function file(path: string, name = ""): FileNode {
  return { name: name || path.split("/").pop()!, path, is_dir: false }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fileExists.mockResolvedValue(false)
  mocks.listDirectory.mockResolvedValue([])
  mocks.getFileSize.mockResolvedValue(0)
  mocks.pathIsDirectory.mockResolvedValue(false)
  mocks.copyDirectory.mockResolvedValue([])
  mocks.copyFile.mockResolvedValue(undefined)
  mocks.createDirectory.mockResolvedValue(undefined)
  mocks.deleteFile.mockResolvedValue(undefined)
})

describe("data-domain-registry", () => {
  it("covers the known .niko-buddy data domains", () => {
    const ids = DATA_DOMAINS.map((d) => d.id)
    expect(ids).toContain("vector-index")
    expect(ids).toContain("caches")
    expect(ids).toContain("generation-history")
    expect(ids).toContain("knowledge-library")
    expect(ids).toContain("conversations")
    // 每个域都有 i18n key + 至少一个 relPath
    for (const d of DATA_DOMAINS) {
      expect(d.labelKey).toMatch(/^dataManager\.domain\./)
      expect(d.relPaths.length).toBeGreaterThan(0)
    }
  })

  it("flags user-content domains for typed confirm", () => {
    const user = DATA_DOMAINS.find((d) => d.id === "conversations")!
    const cache = DATA_DOMAINS.find((d) => d.id === "caches")!
    expect(domainRequiresTypedConfirm(user)).toBe(true)
    expect(domainRequiresTypedConfirm(cache)).toBe(false)
  })
})

describe("data-manager", () => {
  it("statDomain counts present paths and bytes", async () => {
    const domain = DATA_DOMAINS.find((d) => d.id === "vector-index")!
    mocks.fileExists.mockImplementation(async (p: string) =>
      p === `${BASE}/lancedb` || p === `${BASE}/lancedb/t.lance`,
    )
    // lancedb 是目录：pathIsDirectory=true → 递归；子文件 t.lance 返回 2048
    mocks.pathIsDirectory.mockImplementation(async (p: string) => p === `${BASE}/lancedb`)
    mocks.listDirectory.mockImplementation(async (p: string) =>
      p === `${BASE}/lancedb` ? [file(`${BASE}/lancedb/t.lance`)] : [],
    )
    mocks.getFileSize.mockImplementation(async () => 2048)
    const s = await statDomain(PP, domain)
    expect(s.presentPaths).toBe(1)
    expect(s.totalBytes).toBe(2048)
  })

  it("statDomain recurses into directories when backend reports dir size as 0 (DI-1)", async () => {
    // 真后端（Windows）目录 metadata.len()=Ok(0)：旧 pathSize 会直接把目录
    // 当「0 字节文件」返回 0；目录判定必须独立于 getFileSize。
    const domain = DATA_DOMAINS.find((d) => d.id === "vector-index")!
    mocks.fileExists.mockImplementation(async (p: string) =>
      p === `${BASE}/lancedb` || p === `${BASE}/lancedb/t.lance`,
    )
    mocks.pathIsDirectory.mockImplementation(async (p: string) => p === `${BASE}/lancedb`)
    mocks.listDirectory.mockImplementation(async (p: string) =>
      p === `${BASE}/lancedb` ? [file(`${BASE}/lancedb/t.lance`)] : [],
    )
    mocks.getFileSize.mockImplementation(async (p: string) =>
      p === `${BASE}/lancedb/t.lance` ? 4096 : 0,
    )
    const s = await statDomain(PP, domain)
    expect(s.presentPaths).toBe(1)
    expect(s.totalBytes).toBe(4096)
  })

  it("moveDomainToTrash copies then deletes existing paths", async () => {
    const domain = DATA_DOMAINS.find((d) => d.id === "vector-index")!
    mocks.fileExists.mockImplementation(async (p: string) => p === `${BASE}/lancedb`)
    mocks.pathIsDirectory.mockImplementation(async (p: string) => p === `${BASE}/lancedb`) // 目录
    const moved = await moveDomainToTrash(PP, domain, "2026-01-01_00-00-00")
    expect(moved).toBe(true)
    expect(mocks.copyDirectory).toHaveBeenCalledWith(
      `${BASE}/lancedb`,
      `${BASE}/.trash-bin/2026-01-01_00-00-00/vector-index/lancedb`,
    )
    expect(mocks.copyFile).not.toHaveBeenCalled()
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${BASE}/lancedb`)
    // 先复制后删除：delete 必须发生在 copy 成功之后
    expect(mocks.copyDirectory.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteFile.mock.invocationCallOrder[0],
    )
  })

  it("moveDomainToTrash treats a directory as directory even when get_file_size reports 0 (DI-1)", async () => {
    // 修复前：isDir 用 getFileSize 失败推断；Windows 真后端目录 len()=Ok(0)
    // → 误判为文件 → copyFile 分支。修复后必须走 copyDirectory。
    const domain = DATA_DOMAINS.find((d) => d.id === "vector-index")!
    mocks.fileExists.mockImplementation(async (p: string) => p === `${BASE}/lancedb`)
    mocks.pathIsDirectory.mockImplementation(async (p: string) => p === `${BASE}/lancedb`)
    mocks.getFileSize.mockResolvedValue(0)
    const moved = await moveDomainToTrash(PP, domain, "s")
    expect(moved).toBe(true)
    expect(mocks.copyDirectory).toHaveBeenCalledWith(
      `${BASE}/lancedb`,
      `${BASE}/.trash-bin/s/vector-index/lancedb`,
    )
    expect(mocks.copyFile).not.toHaveBeenCalled()
  })

  it("moveDomainToTrash aborts and never deletes the source directory when copy fails (DI-1)", async () => {
    // 修复前：copyDirectory/copyFile 失败被 `.catch(() => {})` 吞掉，随后无条件
    // deleteFile(src) 递归删源 —— 「可恢复」实为物理删除。现在失败必须上抛且保留源。
    const domain = DATA_DOMAINS.find((d) => d.id === "vector-index")!
    mocks.fileExists.mockImplementation(async (p: string) => p === `${BASE}/lancedb`)
    mocks.pathIsDirectory.mockImplementation(async (p: string) => p === `${BASE}/lancedb`)
    mocks.copyDirectory.mockRejectedValue(new Error("copy failed: access denied"))
    await expect(moveDomainToTrash(PP, domain, "s")).rejects.toThrow("copy failed: access denied")
    expect(mocks.deleteFile).not.toHaveBeenCalled()
  })

  it("moveDomainToTrash aborts and never deletes the source file when copy fails", async () => {
    const domain = {
      id: "character-assets",
      labelKey: "k",
      descKey: "k",
      relPaths: ["character-aura.json"],
      risk: "user" as const,
    }
    mocks.fileExists.mockImplementation(async (p: string) => p === `${BASE}/character-aura.json`)
    mocks.copyFile.mockRejectedValue(new Error("copy denied"))
    await expect(moveDomainToTrash(PP, domain, "s2")).rejects.toThrow("copy denied")
    expect(mocks.deleteFile).not.toHaveBeenCalled()
  })

  it("moveDomainToTrash returns false when nothing exists", async () => {
    const domain = DATA_DOMAINS.find((d) => d.id === "vector-index")!
    const moved = await moveDomainToTrash(PP, domain, "s")
    expect(moved).toBe(false)
    expect(mocks.deleteFile).not.toHaveBeenCalled()
  })

  it("moves a single-file domain via copyFile", async () => {
    // character-aura.json 是文件域
    const domain = {
      id: "character-assets",
      labelKey: "k",
      descKey: "k",
      relPaths: ["character-aura.json"],
      risk: "user" as const,
    }
    mocks.fileExists.mockImplementation(async (p: string) => p === `${BASE}/character-aura.json`)
    mocks.pathIsDirectory.mockResolvedValue(false) // 文件（非目录）
    const moved = await moveDomainToTrash(PP, domain, "s1")
    expect(moved).toBe(true)
    expect(mocks.copyFile).toHaveBeenCalledWith(
      `${BASE}/character-aura.json`,
      `${BASE}/.trash-bin/s1/character-assets/character-aura.json`,
    )
    expect(mocks.copyDirectory).not.toHaveBeenCalled()
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${BASE}/character-aura.json`)
    // 先复制后删除（文件路径同样受 copy-gate 保护）
    expect(mocks.copyFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteFile.mock.invocationCallOrder[0],
    )
  })

  it("listTrash returns batches with domain ids", async () => {
    mocks.fileExists.mockImplementation(async (p: string) => p === `${BASE}/.trash-bin`)
    mocks.listDirectory.mockImplementation(async (p: string) => {
      if (p === `${BASE}/.trash-bin`) return [dir(`${BASE}/.trash-bin/s1`, "s1")]
      if (p === `${BASE}/.trash-bin/s1`) return [dir(`${BASE}/.trash-bin/s1/caches`, "caches")]
      return []
    })
    const trash = await listTrash(PP)
    expect(trash).toEqual([{ stamp: "s1", domainIds: ["caches"] }])
  })

  it("restoreDomainFromTrash copies back to original location", async () => {
    const domain = DATA_DOMAINS.find((d) => d.id === "caches")!
    mocks.fileExists.mockImplementation(async (p: string) =>
      p === `${BASE}/.trash-bin/s1/caches` || p === `${BASE}/.trash-bin/s1/caches/ingest-cache`,
    )
    // ingest-cache 是目录
    mocks.pathIsDirectory.mockImplementation(async (p: string) => p === `${BASE}/.trash-bin/s1/caches/ingest-cache`)
    mocks.listDirectory.mockImplementation(async (p: string) =>
      p === `${BASE}/.trash-bin/s1/caches`
        ? [dir(`${BASE}/.trash-bin/s1/caches/ingest-cache`, "ingest-cache")]
        : [],
    )
    await restoreDomainFromTrash(PP, domain, "s1")
    expect(mocks.copyDirectory).toHaveBeenCalledWith(
      `${BASE}/.trash-bin/s1/caches/ingest-cache`,
      `${BASE}/ingest-cache`,
    )
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${BASE}/.trash-bin/s1/caches/ingest-cache`)
    // 先复制后删除：回收站源只在复制成功后删除
    expect(mocks.copyDirectory.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteFile.mock.invocationCallOrder[0],
    )
  })

  it("restoreDomainFromTrash keeps the trash source when copy back fails (DI-1)", async () => {
    const domain = DATA_DOMAINS.find((d) => d.id === "caches")!
    mocks.fileExists.mockImplementation(async (p: string) =>
      p === `${BASE}/.trash-bin/s1/caches` || p === `${BASE}/.trash-bin/s1/caches/ingest-cache`,
    )
    mocks.pathIsDirectory.mockImplementation(async (p: string) => p === `${BASE}/.trash-bin/s1/caches/ingest-cache`)
    mocks.listDirectory.mockImplementation(async (p: string) =>
      p === `${BASE}/.trash-bin/s1/caches`
        ? [dir(`${BASE}/.trash-bin/s1/caches/ingest-cache`, "ingest-cache")]
        : [],
    )
    mocks.copyDirectory.mockRejectedValue(new Error("disk full"))
    await expect(restoreDomainFromTrash(PP, domain, "s1")).rejects.toThrow("disk full")
    // 回收站源不得因为复制失败被删（否则恢复失败 + 数据彻底丢失）
    expect(mocks.deleteFile).not.toHaveBeenCalledWith(`${BASE}/.trash-bin/s1/caches/ingest-cache`)
  })

  it("moveAllToTrash iterates every domain", async () => {
    mocks.fileExists.mockResolvedValue(false)
    await moveAllToTrash(PP, "stamp")
    // 无内容时不删，但流程跑完
    expect(mocks.deleteFile).not.toHaveBeenCalled()
  })

  it("moveAllToTrash reports failures instead of silently succeeding (DI-1)", async () => {
    // 修复前：逐域 `.catch(() => {})` 静默吞错，整项目重置永远「成功」。
    mocks.fileExists.mockImplementation(async (p: string) =>
      p === `${BASE}/chapter-backups` || p === `${BASE}/lancedb`,
    )
    mocks.pathIsDirectory.mockImplementation(async (p: string) =>
      p === `${BASE}/chapter-backups` || p === `${BASE}/lancedb`,
    )
    mocks.copyDirectory.mockImplementation(async (src: string) => {
      if (src === `${BASE}/chapter-backups`) throw new Error("copy denied")
      return []
    })
    await expect(moveAllToTrash(PP, "s")).rejects.toThrow(/chapter-snapshots: copy denied/)
    // 失败域的源绝不被删；其余域继续搬入回收站
    expect(mocks.deleteFile).not.toHaveBeenCalledWith(`${BASE}/chapter-backups`)
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${BASE}/lancedb`)
  })
})

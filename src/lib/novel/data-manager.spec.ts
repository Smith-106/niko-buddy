import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileNode } from "@/types/wiki"

const mocks = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  fileExists: vi.fn(),
  getFileSize: vi.fn(),
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
    // lancedb 是目录：getFileSize reject → 递归；子文件 t.lance 返回 2048
    mocks.listDirectory.mockImplementation(async (p: string) =>
      p === `${BASE}/lancedb` ? [file(`${BASE}/lancedb/t.lance`)] : [],
    )
    mocks.getFileSize.mockImplementation(async (p: string) => {
      if (p === `${BASE}/lancedb`) throw new Error("is a dir")
      return 2048
    })
    const s = await statDomain(PP, domain)
    expect(s.presentPaths).toBe(1)
    expect(s.totalBytes).toBe(2048)
  })

  it("moveDomainToTrash copies then deletes existing paths", async () => {
    const domain = DATA_DOMAINS.find((d) => d.id === "vector-index")!
    mocks.fileExists.mockImplementation(async (p: string) => p === `${BASE}/lancedb`)
    mocks.getFileSize.mockRejectedValue(new Error("is a dir")) // 目录
    const moved = await moveDomainToTrash(PP, domain, "2026-01-01_00-00-00")
    expect(moved).toBe(true)
    expect(mocks.copyDirectory).toHaveBeenCalledWith(
      `${BASE}/lancedb`,
      `${BASE}/.trash-bin/2026-01-01_00-00-00/vector-index/lancedb`,
    )
    expect(mocks.deleteFile).toHaveBeenCalledWith(`${BASE}/lancedb`)
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
    mocks.getFileSize.mockResolvedValue(128) // 文件
    const moved = await moveDomainToTrash(PP, domain, "s1")
    expect(moved).toBe(true)
    expect(mocks.copyFile).toHaveBeenCalledWith(
      `${BASE}/character-aura.json`,
      `${BASE}/.trash-bin/s1/character-assets/character-aura.json`,
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
    mocks.getFileSize.mockImplementation(async (p: string) => {
      if (p.includes("ingest-cache")) throw new Error("is a dir")
      return 0
    })
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
  })

  it("moveAllToTrash iterates every domain", async () => {
    mocks.fileExists.mockResolvedValue(false)
    await moveAllToTrash(PP, "stamp")
    // 无内容时不删，但流程跑完
    expect(mocks.deleteFile).not.toHaveBeenCalled()
  })
})

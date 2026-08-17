import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createDirectory: vi.fn(),
  fileExists: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
  createDirectory: fsMocks.createDirectory,
  fileExists: fsMocks.fileExists,
}))

import {
  createDefaultNovelProjectMeta,
  loadNovelProjectMeta,
  saveNovelProjectMeta,
  updateNovelProjectStats,
  type NovelProjectMeta,
} from "./project-meta"

function baseMeta(): NovelProjectMeta {
  return {
    id: "novel-1",
    title: "测试小说",
    genre: "玄幻",
    targetWords: 1000000,
    novelMode: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    currentChapter: 3,
    totalChapters: 5,
    totalWords: 42000,
    volumes: 1,
    description: "描述",
  }
}

describe("project-meta", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("createDefaultNovelProjectMeta builds a fresh meta with now timestamps", () => {
    const meta = createDefaultNovelProjectMeta("新项目")
    expect(meta.title).toBe("新项目")
    expect(meta.novelMode).toBe(true)
    expect(meta.genre).toBe("")
    expect(meta.targetWords).toBe(0)
    expect(meta.id).toMatch(/^novel-\d+$/)
    expect(meta.createdAt).toBe(meta.updatedAt)
  })

  it("saveNovelProjectMeta creates dir and writes JSON with fresh updatedAt", async () => {
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.writeFile.mockResolvedValue(undefined)
    await saveNovelProjectMeta("C:/novel", baseMeta())
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("C:/novel/.novel")
    const [filePath, contents] = fsMocks.writeFile.mock.calls[0]
    expect(filePath).toBe("C:/novel/.novel/project-meta.json")
    const parsed = JSON.parse(contents)
    expect(parsed.title).toBe("测试小说")
    expect(parsed.updatedAt).not.toBe("2026-01-01T00:00:00.000Z")
  })

  it("loadNovelProjectMeta returns null when file missing", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    const meta = await loadNovelProjectMeta("C:/novel")
    expect(meta).toBeNull()
    expect(fsMocks.readFile).not.toHaveBeenCalled()
  })

  it("loadNovelProjectMeta parses existing file", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(JSON.stringify(baseMeta()))
    const meta = await loadNovelProjectMeta("C:/novel")
    expect(meta?.title).toBe("测试小说")
    expect(meta?.totalChapters).toBe(5)
  })

  it("loadNovelProjectMeta returns null on parse error", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue("{broken json")
    const meta = await loadNovelProjectMeta("C:/novel")
    expect(meta).toBeNull()
  })

  it("updateNovelProjectStats is a no-op when meta missing", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    await updateNovelProjectStats("C:/novel", { totalWords: 999 })
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it("updateNovelProjectStats merges stats and re-saves", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockResolvedValue(JSON.stringify(baseMeta()))
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.writeFile.mockResolvedValue(undefined)
    await updateNovelProjectStats("C:/novel", {
      currentChapter: 4,
      totalWords: 50000,
      volumes: 2,
    })
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
    const [filePath, contents] = fsMocks.writeFile.mock.calls[0]
    expect(filePath).toBe("C:/novel/.novel/project-meta.json")
    const parsed = JSON.parse(contents)
    expect(parsed.currentChapter).toBe(4)
    expect(parsed.totalWords).toBe(50000)
    expect(parsed.volumes).toBe(2)
    expect(parsed.title).toBe("测试小说")
  })
})

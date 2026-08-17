import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(async () => {}),
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(async () => {}),
}))
vi.mock("@/commands/fs", () => ({
  createDirectory: (...args: unknown[]) => fsMocks.createDirectory(...args),
  listDirectory: (...args: unknown[]) => fsMocks.listDirectory(...args),
  readFile: (...args: unknown[]) => fsMocks.readFile(...args),
  writeFile: (...args: unknown[]) => fsMocks.writeFile(...args),
}))

const moveFileToTrashMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/lib/trash", () => ({
  moveFileToTrash: (...args: unknown[]) => moveFileToTrashMock(...args),
}))

describe("generation-history", () => {
  beforeEach(() => {
    fsMocks.createDirectory.mockReset()
    fsMocks.listDirectory.mockReset()
    fsMocks.readFile.mockReset()
    fsMocks.writeFile.mockReset()
    moveFileToTrashMock.mockReset()
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.writeFile.mockResolvedValue(undefined)
  })

  it("saveGenerationHistoryEntry creates dirs, writes json, and returns the entry", async () => {
    const { saveGenerationHistoryEntry } = await import("./generation-history")
    const entry = await saveGenerationHistoryEntry("/p", {
      kind: "lint",
      title: "lint 检查",
      chapterNumber: 3,
      sourcePath: "/p/chapters/ch3.md",
      results: [{ file: "ch3.md", ok: true } as never],
    })
    // 目录创建顺序：.qmai → root → kind
    const dirs = fsMocks.createDirectory.mock.calls.map(([d]) => d)
    expect(dirs).toContain("/p/.qmai")
    expect(dirs).toContain("/p/.qmai/generation-history")
    expect(dirs).toContain("/p/.qmai/generation-history/lint")
    // 写盘 JSON 与返回 entry
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
    const [path, raw] = fsMocks.writeFile.mock.calls[0]
    expect(String(path)).toMatch(/\/p\/\.qmai\/generation-history\/lint\/\d{8}-\d{6}-[a-z0-9]{6}\.json$/)
    const parsed = JSON.parse(String(raw))
    expect(parsed.kind).toBe("lint")
    expect(parsed.title).toBe("lint 检查")
    expect(parsed.chapterNumber).toBe(3)
    expect(parsed.sourcePath).toBe("/p/chapters/ch3.md")
    expect(entry.id).toBe(parsed.id)
    expect(entry.filePath).toBe(path)
    expect(entry.createdAt).toBe(parsed.createdAt)
    // id 格式：YYYYMMDD-HHMMSS-随机
    expect(entry.id).toMatch(/^\d{8}-\d{6}-[a-z0-9]{6}$/)
  })

  it("saveGenerationHistoryEntry review kind omits optional fields and normalizes sourcePath", async () => {
    const { saveGenerationHistoryEntry } = await import("./generation-history")
    await saveGenerationHistoryEntry("C:\\p", {
      kind: "review",
      title: "评审",
      sourcePath: "C:\\p\\chapters\\ch2.md",
      results: [],
      dimensionResults: { consistency: { score: 9 } as never },
    })
    const [path, raw] = fsMocks.writeFile.mock.calls[0]
    expect(String(path)).toContain("/review/")
    const parsed = JSON.parse(String(raw))
    expect(parsed.sourcePath).toContain("/p/chapters/ch2.md")
    expect(parsed.dimensionResults.consistency.score).toBe(9)
    expect(parsed.chapterNumber).toBeUndefined()
  })

  it("saveGenerationHistoryEntry leaves sourcePath undefined when omitted", async () => {
    const { saveGenerationHistoryEntry } = await import("./generation-history")
    await saveGenerationHistoryEntry("/p", { kind: "lint", title: "无路径", results: [] })
    const [, raw] = fsMocks.writeFile.mock.calls[0]
    const parsed = JSON.parse(String(raw))
    expect(parsed.sourcePath).toBeUndefined()
    expect(parsed.chapterNumber).toBeUndefined()
  })

  it("listGenerationHistory parses matching entries, skips junk, and sorts desc by createdAt", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      { name: "a.json", path: "/p/.qmai/generation-history/review/a.json", is_dir: false },
      { name: "b.json", path: "/p/.qmai/generation-history/review/b.json", is_dir: false },
      { name: "sub", path: "/p/.qmai/generation-history/review/sub", is_dir: true },
      { name: "notes.txt", path: "/p/.qmai/generation-history/review/notes.txt", is_dir: false },
      { name: "bad.json", path: "/p/.qmai/generation-history/review/bad.json", is_dir: false },
      { name: "wrong-kind.json", path: "/p/.qmai/generation-history/review/wrong-kind.json", is_dir: false },
      { name: "shapeless.json", path: "/p/.qmai/generation-history/review/shapeless.json", is_dir: false },
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const name = String(path).split("/").pop()
      if (name === "bad.json") throw new Error("corrupt")
      if (name === "wrong-kind.json") return JSON.stringify({ id: "x", kind: "lint", title: "t", results: [], createdAt: "2026-08-01T00:00:00.000Z", filePath: "/p/old" })
      if (name === "shapeless.json") return JSON.stringify({ foo: 1 })
      return JSON.stringify({
        id: name === "a.json" ? "a" : "b",
        kind: "review",
        title: `t-${name}`,
        results: [],
        createdAt: name === "a.json" ? "2026-08-02T00:00:00.000Z" : "2026-08-03T00:00:00.000Z",
        filePath: "/p/old/path.json",
      })
    })
    const { listGenerationHistory } = await import("./generation-history")
    const entries = await listGenerationHistory("/p", "review")
    expect(entries.map(e => e.id)).toEqual(["b", "a"])
    // filePath 被 normalize
    expect(entries[0].filePath).toBe("/p/old/path.json")
  })

  it("listGenerationHistory returns [] when listing fails", async () => {
    fsMocks.listDirectory.mockRejectedValue(new Error("enoent"))
    const { listGenerationHistory } = await import("./generation-history")
    expect(await listGenerationHistory("/p", "lint")).toEqual([])
  })

  it("deleteGenerationHistoryEntry moves the file to trash with normalized path", async () => {
    const { deleteGenerationHistoryEntry } = await import("./generation-history")
    await deleteGenerationHistoryEntry("/p", "C:\\p\\.qmai\\generation-history\\lint\\x.json")
    expect(moveFileToTrashMock).toHaveBeenCalledWith("/p", expect.stringContaining("/p/.qmai/generation-history/lint/x.json"), "history")
  })
})

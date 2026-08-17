import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMocks = vi.hoisted(() => {
  const files = new Map<string, string>()
  return {
    files,
    fileExists: vi.fn(async (path: string) => files.has(path)),
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      files.set(path, content)
    }),
  }
})

vi.mock("@/commands/fs", () => ({
  fileExists: fsMocks.fileExists,
  readFile: fsMocks.readFile,
  writeFile: fsMocks.writeFile,
}))

import { addNotDuplicate, loadNotDuplicates, saveNotDuplicates } from "./dedup-storage"

beforeEach(() => {
  vi.clearAllMocks()
  fsMocks.files.clear()
})

const PROJECT = "E:\\Novel"
const FILE = "E:/Novel/.qmai/dedup-not-duplicates.json"

describe("loadNotDuplicates", () => {
  it("returns [] when the file does not exist", async () => {
    await expect(loadNotDuplicates(PROJECT)).resolves.toEqual([])
  })

  it("returns [] when existence checks throw", async () => {
    fsMocks.fileExists.mockRejectedValueOnce(new Error("fs broken"))
    await expect(loadNotDuplicates(PROJECT)).resolves.toEqual([])
  })

  it("returns [] when the file content is not an array", async () => {
    fsMocks.files.set(FILE, JSON.stringify({ not: "an array" }))
    await expect(loadNotDuplicates(PROJECT)).resolves.toEqual([])
  })

  it("returns [] on invalid JSON", async () => {
    fsMocks.files.set(FILE, "{oops")
    await expect(loadNotDuplicates(PROJECT)).resolves.toEqual([])
  })

  it("returns [] when reading throws", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockRejectedValueOnce(new Error("read failed"))
    await expect(loadNotDuplicates(PROJECT)).resolves.toEqual([])
  })

  it("filters out malformed groups and keeps valid string arrays", async () => {
    fsMocks.files.set(
      FILE,
      JSON.stringify([["a", "b"], "not-a-group", ["c"], 42, null, ["d", "e", "f"]]),
    )
    await expect(loadNotDuplicates(PROJECT)).resolves.toEqual([
      ["a", "b"],
      ["c"],
      ["d", "e", "f"],
    ])
  })

  it("loads a well-formed whitelist", async () => {
    fsMocks.files.set(FILE, JSON.stringify([["x", "y"], ["p", "q"]]))
    await expect(loadNotDuplicates(PROJECT)).resolves.toEqual([["x", "y"], ["p", "q"]])
  })
})

describe("saveNotDuplicates", () => {
  it("writes the list as pretty JSON", async () => {
    await saveNotDuplicates(PROJECT, [["a", "b"]])
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      FILE,
      JSON.stringify([["a", "b"]], null, 2),
    )
  })
})

describe("addNotDuplicate", () => {
  it("ignores groups with fewer than two slugs", async () => {
    await addNotDuplicate(PROJECT, ["solo"])
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it("appends a sorted copy of a new group", async () => {
    await addNotDuplicate(PROJECT, ["b", "a"])
    expect(fsMocks.writeFile).toHaveBeenCalledWith(FILE, JSON.stringify([["a", "b"]], null, 2))
  })

  it("is a no-op when an equivalent group already exists (any order/case)", async () => {
    fsMocks.files.set(FILE, JSON.stringify([["Alpha", "Beta"]]))
    await addNotDuplicate(PROJECT, ["beta", "ALPHA"])
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })

  it("appends to an existing whitelist", async () => {
    fsMocks.files.set(FILE, JSON.stringify([["a", "b"]]))
    await addNotDuplicate(PROJECT, ["c", "d"])
    expect(JSON.parse(fsMocks.files.get(FILE) ?? "[]")).toEqual([["a", "b"], ["c", "d"]])
  })
})

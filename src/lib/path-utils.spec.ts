import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  fileExists: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  fileExists: mocks.fileExists,
}))

import {
  getFileName,
  getFileStem,
  getRelativePath,
  getUniqueOutlinePath,
  isAbsolutePath,
  joinPath,
  normalizePath,
  sanitizeFileStem,
} from "./path-utils"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("normalizePath / joinPath / getFileName / getFileStem", () => {
  it("normalizes backslashes and joins segments", () => {
    expect(normalizePath("C:\\a\\b")).toBe("C:/a/b")
    expect(joinPath("a/", "/b/", "c")).toBe("a/b/c")
    expect(joinPath("a", "b")).toBe("a/b")
  })

  it("extracts file names and stems", () => {
    expect(getFileName("C:\\dir\\file.md")).toBe("file.md")
    expect(getFileName("plain")).toBe("plain")
    expect(getFileStem("a/b/c.tar.gz")).toBe("c.tar")
    expect(getFileStem("noext")).toBe("noext")
  })
})

describe("sanitizeFileStem", () => {
  it("strips directory components and traversal", () => {
    expect(sanitizeFileStem("../../etc/passwd")).toBe("passwd")
    expect(sanitizeFileStem("a\\b\\c.txt")).toBe("c.txt")
  })

  it("drops control characters and drive letters", () => {
    expect(sanitizeFileStem("C:\\evil\u0000name")).toBe("evilname")
    expect(sanitizeFileStem("C:/file.pdf")).toBe("file.pdf")
  })

  it("falls back for nullish input", () => {
    expect(sanitizeFileStem(undefined as unknown as string)).toBe("unnamed-source")
    expect(sanitizeFileStem(null as unknown as string)).toBe("unnamed-source")
  })

  it("collapses leading dots/colons and falls back for empty results", () => {
    expect(sanitizeFileStem("..hidden")).toBe("hidden")
    expect(sanitizeFileStem("...")).toBe("unnamed-source")
    expect(sanitizeFileStem("")).toBe("unnamed-source")
    expect(sanitizeFileStem("   ")).toBe("unnamed-source")
  })
})

describe("getRelativePath", () => {
  it("returns the relative portion when under base", () => {
    expect(getRelativePath("/p/a/b.md", "/p/a")).toBe("b.md")
    expect(getRelativePath("C:/p/a/b.md", "C:\\p\\a\\")).toBe("b.md")
  })

  it("returns the full path when not under base", () => {
    expect(getRelativePath("/x/y.md", "/p/a")).toBe("/x/y.md")
  })
})

describe("isAbsolutePath", () => {
  it("detects unix and windows absolute paths", () => {
    expect(isAbsolutePath("/foo/bar")).toBe(true)
    expect(isAbsolutePath("C:\\foo")).toBe(true)
    expect(isAbsolutePath("C:/foo")).toBe(true)
    expect(isAbsolutePath("\\\\server\\share")).toBe(true)
    expect(isAbsolutePath("//server/share")).toBe(true)
  })

  it("rejects relative and empty paths", () => {
    expect(isAbsolutePath("foo/bar")).toBe(false)
    expect(isAbsolutePath("")).toBe(false)
  })
})

describe("getUniqueOutlinePath", () => {
  it("returns the first path when free", async () => {
    mocks.fileExists.mockResolvedValue(false)
    await expect(getUniqueOutlinePath("/p", "ch1.md")).resolves.toBe("/p/ch1.md")
    expect(mocks.fileExists).toHaveBeenCalledWith("/p/ch1.md")
  })

  it("appends -2..-N suffixes until a free name is found", async () => {
    mocks.fileExists
      .mockResolvedValueOnce(true) // ch1.md
      .mockResolvedValueOnce(true) // ch1-2.md
      .mockResolvedValueOnce(false) // ch1-3.md
    await expect(getUniqueOutlinePath("/p", "ch1.md")).resolves.toBe("/p/ch1-3.md")
  })

  it("handles extensionless names", async () => {
    mocks.fileExists
      .mockResolvedValueOnce(true) // outline
      .mockResolvedValueOnce(false) // outline-2
    await expect(getUniqueOutlinePath("/p", "outline")).resolves.toBe("/p/outline-2")
  })

  it("falls back to a Date.now() suffix after exhausting 2..99", async () => {
    mocks.fileExists.mockResolvedValue(true)
    const now = Date.now()
    vi.spyOn(Date, "now").mockReturnValue(now)
    await expect(getUniqueOutlinePath("/p", "ch.md")).resolves.toBe(`/p/ch-${now}.md`)
  })
})

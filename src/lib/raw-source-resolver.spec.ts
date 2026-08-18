import { beforeEach, describe, expect, it, vi } from "vitest"


const listDirectory = vi.fn()

vi.mock("@/commands/fs", () => ({
  listDirectory: (...args: unknown[]) => listDirectory(...args),
}))

import { findRawSourceForImage, imageUrlToAbsolute } from "./raw-source-resolver"

const PROJECT = "E:\\Novel"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("findRawSourceForImage", () => {
  it("returns null when the URL has no media/<slug>/ segment", async () => {
    await expect(findRawSourceForImage("https://example.com/img.png", PROJECT)).resolves.toBeNull()
    await expect(findRawSourceForImage("wiki/entities/foo.md", PROJECT)).resolves.toBeNull()
    expect(listDirectory).not.toHaveBeenCalled()
  })

  it("returns null when listing the raw sources directory fails", async () => {
    listDirectory.mockRejectedValue(new Error("no raw dir"))
    await expect(findRawSourceForImage("/wiki/media/report/img-1.png", PROJECT)).resolves.toBeNull()
  })

  it("matches absolute and wiki-relative URL shapes", async () => {
    listDirectory.mockResolvedValue([
      { name: "report.pdf", path: "E:/Novel/raw/sources/report.pdf", is_dir: false },
    ])
    await expect(findRawSourceForImage("E:/Novel/wiki/media/report/img-1.png", PROJECT)).resolves.toBe(
      "E:/Novel/raw/sources/report.pdf",
    )
    await expect(findRawSourceForImage("media/report/img-1.png", PROJECT)).resolves.toBe(
      "E:/Novel/raw/sources/report.pdf",
    )
  })

  it("normalizes backslashes in image URLs", async () => {
    listDirectory.mockResolvedValue([
      { name: "paper.txt", path: "E:/Novel/raw/sources/paper.txt", is_dir: false },
    ])
    await expect(
      findRawSourceForImage("E:\\Novel\\wiki\\media\\paper\\img-2.png", PROJECT),
    ).resolves.toBe("E:/Novel/raw/sources/paper.txt")
  })

  it("searches nested directories recursively", async () => {
    listDirectory.mockResolvedValue([
      {
        name: "archive",
        path: "E:/Novel/raw/sources/archive",
        is_dir: true,
        children: [
          { name: "deep.pdf", path: "E:/Novel/raw/sources/archive/deep.pdf", is_dir: false },
        ],
      },
    ])
    await expect(findRawSourceForImage("media/deep/img-1.png", PROJECT)).resolves.toBe(
      "E:/Novel/raw/sources/archive/deep.pdf",
    )
  })

  it("recurses into a directory but finds no match inside it", async () => {
    // The directory has children, so `findByStem` recurses; the inner search
    // misses the slug and returns null, exercising the `if (found)` false path
    // before the loop moves on.
    listDirectory.mockResolvedValue([
      {
        name: "archive",
        path: "E:/Novel/raw/sources/archive",
        is_dir: true,
        children: [
          { name: "unrelated.pdf", path: "E:/Novel/raw/sources/archive/unrelated.pdf", is_dir: false },
        ],
      },
    ])
    await expect(findRawSourceForImage("media/missing/img.png", PROJECT)).resolves.toBeNull()
  })

  it("skips directories without children", async () => {
    listDirectory.mockResolvedValue([
      { name: "empty-dir", path: "E:/Novel/raw/sources/empty-dir", is_dir: true },
    ])
    await expect(findRawSourceForImage("media/anything/img.png", PROJECT)).resolves.toBeNull()
  })

  it("returns null when no file stem matches the slug", async () => {
    listDirectory.mockResolvedValue([
      { name: "other.pdf", path: "E:/Novel/raw/sources/other.pdf", is_dir: false },
    ])
    await expect(findRawSourceForImage("media/missing/img.png", PROJECT)).resolves.toBeNull()
  })

  it("matches files with multiple dots in the name", async () => {
    listDirectory.mockResolvedValue([
      { name: "report.v2.final.pdf", path: "E:/Novel/raw/sources/report.v2.final.pdf", is_dir: false },
    ])
    await expect(findRawSourceForImage("media/report.v2.final/img.png", PROJECT)).resolves.toBe(
      "E:/Novel/raw/sources/report.v2.final.pdf",
    )
  })
})

describe("imageUrlToAbsolute", () => {
  it("returns absolute URLs unchanged", () => {
    expect(imageUrlToAbsolute("/wiki/media/a/img.png", PROJECT)).toBe("/wiki/media/a/img.png")
    expect(imageUrlToAbsolute("C:/wiki/media/a/img.png", PROJECT)).toBe("C:/wiki/media/a/img.png")
    expect(imageUrlToAbsolute("\\\\server\\share\\img.png", PROJECT)).toBe("\\\\server\\share\\img.png")
  })

  it("promotes wiki-relative URLs to absolute paths", () => {
    expect(imageUrlToAbsolute("media/a/img.png", PROJECT)).toBe("E:\\Novel/wiki/media/a/img.png")
  })

  it("strips a leading ./ and trailing slashes from the project path", () => {
    expect(imageUrlToAbsolute("./media/a/img.png", "E:/Novel//")).toBe("E:/Novel/wiki/media/a/img.png")
  })
})

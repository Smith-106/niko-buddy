import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SavedImage } from "./extract-source-images"

const invokeMock = vi.hoisted(() => vi.fn())
const isTauriMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
vi.mock("@/lib/platform", () => ({ isTauri: isTauriMock }))

import {
  buildImageMarkdownSection,
  extractAndSaveSourceImages,
} from "./extract-source-images"

function makeImage(overrides: Partial<SavedImage> = {}): SavedImage {
  return {
    index: 1,
    mimeType: "image/png",
    page: 1,
    width: 10,
    height: 10,
    relPath: "media/a/img-1.png",
    absPath: "/P/wiki/media/a/img-1.png",
    sha256: "h1",
    ...overrides,
  }
}

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  invokeMock.mockReset().mockResolvedValue([])
  isTauriMock.mockReset().mockReturnValue(true)
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

describe("extractAndSaveSourceImages", () => {
  it("returns [] for unsupported extensions without invoking Rust", async () => {
    await expect(extractAndSaveSourceImages("/P", "/P/raw/sources/report.txt")).resolves.toEqual([])
    await expect(extractAndSaveSourceImages("/P", "/P/raw/sources/notes.md")).resolves.toEqual([])
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("returns [] for an extensionless filename", async () => {
    await expect(extractAndSaveSourceImages("/P", "/P/raw/sources/noext")).resolves.toEqual([])
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("dispatches PDF extraction with a case-insensitive extension check", async () => {
    invokeMock.mockResolvedValue([])
    await extractAndSaveSourceImages("/P", "/P/raw/sources/report.PDF")
    expect(invokeMock).toHaveBeenCalledWith("extract_and_save_pdf_images_cmd", {
      sourcePath: "/P/raw/sources/report.PDF",
      destDir: "/P/wiki/media/report",
      relTo: "/P/wiki",
    })
  })

  it("dispatches office extraction for pptx/docx/ppt/doc", async () => {
    for (const file of ["deck.pptx", "notes.docx", "old.ppt", "memo.doc"]) {
      invokeMock.mockClear()
      await extractAndSaveSourceImages("/P", `/P/raw/sources/${file}`)
      expect(invokeMock).toHaveBeenCalledWith("extract_and_save_office_images_cmd", {
        sourcePath: `/P/raw/sources/${file}`,
        destDir: `/P/wiki/media/${file.replace(/\.[^.]+$/, "")}`,
        relTo: "/P/wiki",
      })
    }
  })

  it("returns [] when not running inside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    await expect(extractAndSaveSourceImages("/P", "/P/raw/sources/deck.pdf")).resolves.toEqual([])
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("filters out malformed entries from the Rust response", async () => {
    invokeMock.mockResolvedValue([
      makeImage(),
      null,
      "junk",
      { index: "1", relPath: "r", absPath: "a" },
      { index: 1 },
      { index: 1, relPath: 5, absPath: "a" },
      { index: 1, relPath: "r" },
    ])
    const images = await extractAndSaveSourceImages("/P", "/P/raw/sources/deck.pptx")
    expect(images).toEqual([makeImage()])
  })

  it("returns [] and logs a warning when the Rust command throws an Error", async () => {
    invokeMock.mockRejectedValue(new Error("extraction crashed"))
    await expect(extractAndSaveSourceImages("/P", "/P/raw/sources/deck.pdf")).resolves.toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("extraction failed"), "extraction crashed")
  })

  it("returns [] and logs a warning when the Rust command throws a non-Error", async () => {
    invokeMock.mockRejectedValue("boom")
    await expect(extractAndSaveSourceImages("/P", "/P/raw/sources/deck.pdf")).resolves.toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("extraction failed"), "boom")
  })
})

describe("buildImageMarkdownSection", () => {
  it("returns an empty string for no images", () => {
    expect(buildImageMarkdownSection([])).toBe("")
    expect(buildImageMarkdownSection([], new Map())).toBe("")
  })

  it("groups by page, sorts pages numerically with Document last, and embeds sanitised captions", () => {
    // Key insertion order [Page 10, Document, Page 0, Page 1, Page 2] drives
    // V8's small-array sort through every comparator arm: "Document" is
    // compared as the inserted element (`a === "Document"`) and as an
    // existing element (`b === "Document"`), while "Page 0" fills both
    // `parseInt(...) || 0` right-hand sides.
    const images: SavedImage[] = [
      makeImage({ index: 3, page: 10, relPath: "media/a/img-10.png", sha256: "h3" }),
      makeImage({ index: 6, page: null, relPath: "media/a/doc.png", sha256: "h6" }),
      makeImage({ index: 5, page: 0, relPath: "media/a/img-0.png", sha256: "h5" }),
      makeImage({ index: 2, page: 1, relPath: "media/a/img-2.png", sha256: "h2" }),
      makeImage({ index: 4, page: 2, relPath: "media/a/img-2b.png", sha256: "h4" }),
      makeImage({ index: 1, relPath: "media/a/img-1.png", sha256: "h1" }),
    ]
    const captions = new Map<string, string>([
      ["h1", "Figure 1\ncaption ]"],
      ["h3", "Third figure"],
    ])
    const out = buildImageMarkdownSection(images, captions)
    const lines = out.split("\n")
    // header
    expect(lines).toContain("## Embedded Images")
    // page order: Page 0, Page 1, Page 2, Page 10, Document
    const keyPositions = ["### Page 0", "### Page 1", "### Page 2", "### Page 10", "### Document"].map((k) =>
      lines.indexOf(k),
    )
    expect(keyPositions.every((p) => p >= 0)).toBe(true)
    for (let i = 0; i < keyPositions.length - 1; i++) {
      expect(keyPositions[i]).toBeLessThan(keyPositions[i + 1])
    }
    // sanitised caption for h1, plain caption for h3, empty alt elsewhere
    expect(out).toContain("![Figure 1 caption )](media/a/img-1.png)")
    expect(out).toContain("![Third figure](media/a/img-10.png)")
    expect(out).toContain("![](media/a/img-2.png)")
    expect(out).toContain("![](media/a/doc.png)")
  })

  it("works without a captions map and groups repeated pages into one bucket", () => {
    const out = buildImageMarkdownSection([
      makeImage({ index: 1 }),
      makeImage({ index: 2, relPath: "media/a/img-2.png", sha256: "h2" }),
      makeImage({ index: 3, page: 3, relPath: "media/a/img-3.png", sha256: "h3" }),
    ])
    expect(out).toContain("### Page 1")
    expect(out).toContain("![](media/a/img-1.png)")
    expect(out).toContain("![](media/a/img-2.png)")
    expect(out).toContain("### Page 3")
    // exactly one "### Page 1" heading for the shared bucket
    expect(out.match(/### Page 1/g)).toHaveLength(1)
  })
})

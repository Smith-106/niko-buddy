import { describe, expect, it } from "vitest"
import {
  getCodeLanguage,
  getFileCategory,
  isBinary,
  isTextReadable,
  type FileCategory,
} from "./file-types"

describe("getFileCategory", () => {
  it.each([
    ["file.md", "markdown"],
    ["file.mdx", "markdown"],
    ["file.txt", "text"],
    ["file.rtf", "text"],
    ["file.log", "text"],
    ["file.ts", "code"],
    ["file.jsx", "code"],
    ["file.py", "code"],
    ["file.rs", "code"],
    ["file.png", "image"],
    ["file.JPG", "image"],
    ["file.gif", "image"],
    ["file.mp4", "video"],
    ["file.mp3", "audio"],
    ["file.pdf", "pdf"],
    ["file.docx", "document"],
    ["file.json", "data"],
    ["file.csv", "data"],
    ["file.yaml", "data"],
    ["file.yml", "data"],
  ])("maps %s to %s", (path, expected) => {
    expect(getFileCategory(path)).toBe(expected)
  })

  it("returns unknown for unrecognised extensions", () => {
    expect(getFileCategory("file.xyz")).toBe("unknown")
  })

  it("returns unknown when there is no extension", () => {
    expect(getFileCategory("README")).toBe("unknown")
  })

  it("returns unknown for an empty path", () => {
    expect(getFileCategory("")).toBe("unknown")
  })

  it("uses the last dot segment only", () => {
    expect(getFileCategory("a.b.ts")).toBe("code")
  })
})

describe("isTextReadable", () => {
  it("accepts text-like categories", () => {
    const categories: FileCategory[] = ["markdown", "text", "code", "data"]
    for (const c of categories) expect(isTextReadable(c)).toBe(true)
  })

  it("rejects non-text categories", () => {
    const categories: FileCategory[] = [
      "image",
      "video",
      "audio",
      "pdf",
      "document",
      "unknown",
    ]
    for (const c of categories) expect(isTextReadable(c)).toBe(false)
  })
})

describe("isBinary", () => {
  it("accepts binary-ish categories", () => {
    const categories: FileCategory[] = ["image", "video", "audio", "document", "unknown"]
    for (const c of categories) expect(isBinary(c)).toBe(true)
  })

  it("rejects text-like categories", () => {
    const categories: FileCategory[] = ["markdown", "text", "code", "data", "pdf"]
    for (const c of categories) expect(isBinary(c)).toBe(false)
  })
})

describe("getCodeLanguage", () => {
  it("maps known extensions to language names", () => {
    expect(getCodeLanguage("a.js")).toBe("javascript")
    expect(getCodeLanguage("a.jsx")).toBe("javascript")
    expect(getCodeLanguage("a.ts")).toBe("typescript")
    expect(getCodeLanguage("a.tsx")).toBe("typescript")
    expect(getCodeLanguage("a.py")).toBe("python")
    expect(getCodeLanguage("a.rs")).toBe("rust")
    expect(getCodeLanguage("a.go")).toBe("go")
    expect(getCodeLanguage("a.java")).toBe("java")
    expect(getCodeLanguage("a.rb")).toBe("ruby")
    expect(getCodeLanguage("a.php")).toBe("php")
    expect(getCodeLanguage("a.swift")).toBe("swift")
    expect(getCodeLanguage("a.sql")).toBe("sql")
    expect(getCodeLanguage("a.html")).toBe("html")
    expect(getCodeLanguage("a.htm")).toBe("html")
    expect(getCodeLanguage("a.css")).toBe("css")
    expect(getCodeLanguage("a.json")).toBe("json")
    expect(getCodeLanguage("a.yaml")).toBe("yaml")
    expect(getCodeLanguage("a.yml")).toBe("yaml")
    expect(getCodeLanguage("a.xml")).toBe("xml")
    expect(getCodeLanguage("a.sh")).toBe("bash")
    expect(getCodeLanguage("a.bash")).toBe("bash")
    expect(getCodeLanguage("a.toml")).toBe("toml")
  })

  it("falls back to the raw extension for unknown extensions", () => {
    expect(getCodeLanguage("a.xyz")).toBe("xyz")
  })

  it("falls back to the lowercased full name when there is no extension", () => {
    expect(getCodeLanguage("Makefile")).toBe("makefile")
  })

  it("normalises extension case", () => {
    expect(getCodeLanguage("a.PY")).toBe("python")
  })
})

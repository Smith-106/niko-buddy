import { describe, expect, it } from "vitest"
import {
  buildDefaultNovelDir,
  DEFAULT_INSTALL_DIR_NAME,
  DEFAULT_NOVEL_DIR_NAME,
} from "./default-paths"

describe("default-paths constants", () => {
  it("exports the expected directory names", () => {
    expect(DEFAULT_NOVEL_DIR_NAME).toBe("QM-BOOK")
    expect(DEFAULT_INSTALL_DIR_NAME).toBe("QMaiWrite")
  })
})

describe("buildDefaultNovelDir", () => {
  it("extracts the drive letter from a Windows path", () => {
    expect(buildDefaultNovelDir("C:\\Users\\niko\\AppData")).toBe("C:\\QM-BOOK")
  })

  it("uppercases a lowercase drive letter", () => {
    expect(buildDefaultNovelDir("d:\\Program Files\\QMaiWrite")).toBe("D:\\QM-BOOK")
  })

  it("handles forward-slash paths", () => {
    expect(buildDefaultNovelDir("E:/software")).toBe("E:\\QM-BOOK")
  })

  it("trims surrounding whitespace before matching", () => {
    expect(buildDefaultNovelDir("  F:\\app  ")).toBe("F:\\QM-BOOK")
  })

  it("falls back to the D: install drive for non-Windows paths", () => {
    expect(buildDefaultNovelDir("/usr/local")).toBe("D:\\QM-BOOK")
  })

  it("falls back for empty and drive-less inputs", () => {
    expect(buildDefaultNovelDir("")).toBe("D:\\QM-BOOK")
    expect(buildDefaultNovelDir("relative/path")).toBe("D:\\QM-BOOK")
    expect(buildDefaultNovelDir("not a path")).toBe("D:\\QM-BOOK")
  })
})

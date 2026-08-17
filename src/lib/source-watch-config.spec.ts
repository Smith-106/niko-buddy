import { describe, expect, it } from "vitest"
import {
  DEFAULT_SOURCE_WATCH_CONFIG,
  getSourceWatchExtension,
  isPathAllowedBySourceWatch,
  normalizeSourceWatchConfig,
  SOURCE_WATCH_FILE_TYPE_GROUPS,
} from "./source-watch-config"
import type { SourceWatchConfig } from "@/stores/wiki-store"

const fullConfig: SourceWatchConfig = {
  enabled: true,
  autoIngest: true,
  includeExtensions: [],
  excludeExtensions: [],
  excludeDirs: [],
  excludeGlobs: [],
  maxFileSizeMb: 50,
}

describe("constants", () => {
  it("exposes default config and file type groups", () => {
    expect(DEFAULT_SOURCE_WATCH_CONFIG.enabled).toBe(true)
    expect(DEFAULT_SOURCE_WATCH_CONFIG.includeExtensions).toContain("md")
    expect(DEFAULT_SOURCE_WATCH_CONFIG.excludeDirs).toContain(".git")
    expect(DEFAULT_SOURCE_WATCH_CONFIG.maxFileSizeMb).toBe(100)
    expect(SOURCE_WATCH_FILE_TYPE_GROUPS.length).toBe(5)
    expect(SOURCE_WATCH_FILE_TYPE_GROUPS[0].extensions).toContain("pdf")
  })
})

describe("normalizeSourceWatchConfig", () => {
  it("applies defaults for a missing config", () => {
    const cfg = normalizeSourceWatchConfig(undefined)
    expect(cfg.enabled).toBe(DEFAULT_SOURCE_WATCH_CONFIG.enabled)
    expect(cfg.maxFileSizeMb).toBe(DEFAULT_SOURCE_WATCH_CONFIG.maxFileSizeMb)
  })

  it("merges partial config values", () => {
    const cfg = normalizeSourceWatchConfig({ enabled: true, maxFileSizeMb: 100 })
    expect(cfg.enabled).toBe(true)
    expect(cfg.autoIngest).toBe(DEFAULT_SOURCE_WATCH_CONFIG.autoIngest)
    expect(cfg.maxFileSizeMb).toBe(100)
  })

  it("normalizes extensions: trims dots, lowercases, dedupes, drops blanks", () => {
    const cfg = normalizeSourceWatchConfig({
      includeExtensions: ["PDF", ".md", ".md", "  TXT  ", ""],
      excludeExtensions: [".docx", "docx"],
      excludeDirs: [" node_modules ", "node_modules", ""],
      excludeGlobs: ["*.tmp", "*.tmp"],
    })
    expect(cfg.includeExtensions).toEqual(["pdf", "md", "txt"])
    expect(cfg.excludeExtensions).toEqual(["docx"])
    expect(cfg.excludeDirs).toEqual(["node_modules"])
    expect(cfg.excludeGlobs).toEqual(["*.tmp"])
  })

  it("clamps maxFileSizeMb into [1, 4096]", () => {
    expect(normalizeSourceWatchConfig({ maxFileSizeMb: 0 }).maxFileSizeMb).toBe(1)
    expect(normalizeSourceWatchConfig({ maxFileSizeMb: 99999 }).maxFileSizeMb).toBe(4096)
    expect(normalizeSourceWatchConfig({ maxFileSizeMb: 5 }).maxFileSizeMb).toBe(5)
  })

  it("normalizes an explicit null list and preserves non-finite size values", () => {
    const cfg = normalizeSourceWatchConfig({
      includeExtensions: undefined,
      excludeExtensions: undefined,
      excludeDirs: undefined,
      excludeGlobs: undefined,
      maxFileSizeMb: Number.NaN,
    })
    expect(cfg.includeExtensions).toEqual(DEFAULT_SOURCE_WATCH_CONFIG.includeExtensions)
    expect(cfg.maxFileSizeMb).toBeNaN()
  })

  it("handles null config", () => {
    expect(normalizeSourceWatchConfig(null).enabled).toBe(DEFAULT_SOURCE_WATCH_CONFIG.enabled)
  })
})

describe("getSourceWatchExtension", () => {
  it("extracts the lowercased extension", () => {
    expect(getSourceWatchExtension("C:\\docs\\Report.PDF")).toBe("pdf")
    expect(getSourceWatchExtension("/a/b/file.txt")).toBe("txt")
  })

  it("returns empty for extensionless names and empty paths", () => {
    expect(getSourceWatchExtension("README")).toBe("")
    expect(getSourceWatchExtension("")).toBe("")
  })

  it("treats a leading dot as an extension for dotfiles", () => {
    expect(getSourceWatchExtension(".hidden")).toBe("hidden")
  })
})

describe("isPathAllowedBySourceWatch", () => {
  it("allows ordinary files by default", () => {
    expect(isPathAllowedBySourceWatch("/proj/sources/a.pdf", fullConfig)).toBe(true)
  })

  it("rejects paths inside excluded directories (bare and nested)", () => {
    const cfg = { ...fullConfig, excludeDirs: ["node_modules", "build", "assets/img"] }
    expect(isPathAllowedBySourceWatch("/proj/node_modules/x.md", cfg)).toBe(false)
    expect(isPathAllowedBySourceWatch("/proj/a/build/b/x.md", cfg)).toBe(false)
    expect(isPathAllowedBySourceWatch("/proj/src/build/x.md", cfg)).toBe(false)
    expect(isPathAllowedBySourceWatch("/proj/build", cfg)).toBe(false)
    // slash-containing dir matches the exact dir or a path under it
    expect(isPathAllowedBySourceWatch("/proj/assets/img/logo.png", cfg)).toBe(false)
    expect(isPathAllowedBySourceWatch("assets/img", cfg)).toBe(false)
    // a path that merely starts with the dir name but isn't inside it is unaffected
    expect(isPathAllowedBySourceWatch("/proj/assets/img", cfg)).toBe(true)
    // a name that merely contains the dir word is unaffected
    expect(isPathAllowedBySourceWatch("/proj/builder/x.md", cfg)).toBe(true)
  })

  it("rejects the empty path", () => {
    expect(isPathAllowedBySourceWatch("", fullConfig)).toBe(false)
  })

  it("rejects hidden file names", () => {
    expect(isPathAllowedBySourceWatch("/proj/.env", fullConfig)).toBe(false)
    expect(isPathAllowedBySourceWatch("/proj/a/.hidden", fullConfig)).toBe(false)
  })

  it("rejects files inside default hidden directories via excludeDirs", () => {
    const cfg = { ...fullConfig, excludeDirs: [".git", ".obsidian"] }
    expect(isPathAllowedBySourceWatch("/proj/.git/config", cfg)).toBe(false)
    expect(isPathAllowedBySourceWatch("/proj/.obsidian/plugins/x.js", cfg)).toBe(false)
  })

  it("rejects excluded extensions", () => {
    const cfg = { ...fullConfig, excludeExtensions: ["exe"] }
    expect(isPathAllowedBySourceWatch("/proj/a/tool.exe", cfg)).toBe(false)
    expect(isPathAllowedBySourceWatch("/proj/a/tool.EXE", cfg)).toBe(false)
  })

  it("applies include-extension filtering when configured", () => {
    const cfg = { ...fullConfig, includeExtensions: ["md", "txt"] }
    expect(isPathAllowedBySourceWatch("/proj/a/note.md", cfg)).toBe(true)
    expect(isPathAllowedBySourceWatch("/proj/a/note.pdf", cfg)).toBe(false)
    expect(isPathAllowedBySourceWatch("/proj/a/README", cfg)).toBe(false)
  })

  it("matches a literal glob metacharacter in a filename", () => {
    const cfg = { ...fullConfig, excludeGlobs: ["report[1].txt"] }
    expect(isPathAllowedBySourceWatch("/proj/report[1].txt", cfg)).toBe(false)
    expect(isPathAllowedBySourceWatch("/proj/report1.txt", cfg)).toBe(true)
  })

  it("handles a glob pattern that targets only the full path", () => {
    const cfg = { ...fullConfig, excludeGlobs: ["/proj/sources/*.md"] }
    expect(isPathAllowedBySourceWatch("/proj/sources/note.md", cfg)).toBe(false)
  })
})

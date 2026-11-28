import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyDownloadDocSync, applyReadmeSync, syncReleaseDocs } from "./sync-release-docs.mjs"

describe("sync-release-docs", () => {
  const sampleEntry = {
    version: "2.37.0",
    date: "2026-12-01",
    highlights: {
      zh: ["修复便携版整目录 ZIP 打包。", "同步下载页与 README 版本。"],
    },
  }

  it("updates README badge and controlled current block while preserving older sections", () => {
    const rawReadme = [
      `<img src="https://img.shields.io/badge/version-2.32.0-blue?style=flat-square" alt="Version" />`,
      "",
      "## v2.32.0（旧标题）",
      "",
      "旧摘要内容",
      "",
      "**v2.31.0 历史摘要：**",
      "- 保留历史",
    ].join("\n")

    const synced = applyReadmeSync(rawReadme, sampleEntry)
    expect(synced).toContain("badge/version-2.37.0-blue")
    expect(synced).toContain("## v2.37.0（2026-12-01 发布，当前主干版本）")
    expect(synced).toContain("niko-buddy_2.37.0_windows_X64_portable.zip")
    expect(synced).toContain("**v2.31.0 历史摘要：**")
    // idempotent on second pass
    expect(applyReadmeSync(synced, sampleEntry)).toBe(synced)
  })

  it("updates docs-site download page controlled block without clobbering release history", () => {
    const rawDownload = [
      "# 下载安装",
      "",
      "## 最新版本",
      "",
      "**v2.27.2**（旧版）",
      "",
      "> **上一稳定版 v2.27.1**",
      "",
      "## Windows 安装包",
      "",
      "旧链接",
      "",
      "## 便携版",
      "",
      "旧便携版",
      "",
      "## 系统要求",
    ].join("\n")

    const synced = applyDownloadDocSync(rawDownload, sampleEntry)
    expect(synced).toContain("**v2.37.0**（2026-12-01 发布")
    expect(synced).toContain("niko-buddy_2.37.0_windows_X64_portable.zip")
    expect(synced).toContain("releases/download/v2.37.0/niko-buddy_2.37.0_windows_X64_portable.zip")
    expect(synced).not.toContain("v2.27.2**（旧版）")
    expect(synced).toContain("> **上一稳定版 v2.27.1**")
    expect(synced).toContain("## 系统要求")
    expect(applyDownloadDocSync(synced, sampleEntry)).toBe(synced)
  })

  it("detects drift in check mode and synchronizes files in write mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-sync-docs-"))
    try {
      mkdirSync(join(dir, "src/lib"), { recursive: true })
      mkdirSync(join(dir, "docs-site/src/content/docs"), { recursive: true })
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2.37.0" }), "utf8")
      writeFileSync(
        join(dir, "src/lib/changelog.ts"),
        `export const ENTRIES = [{ version: "2.37.0", date: "2026-12-01", highlights: { en: ["x"], zh: ["测试要点"] } }]`,
        "utf8",
      )
      writeFileSync(
        join(dir, "README.md"),
        `<img src="https://img.shields.io/badge/version-2.32.0-blue" />\n\n## v2.32.0\n旧\n\n**v2.31.0**\n`,
        "utf8",
      )
      writeFileSync(
        join(dir, "docs-site/src/content/docs/download.md"),
        `# 下载\n\n## 最新版本\n\n**v2.27.2**\n\n> **上一稳定版 v2.27.1**\n`,
        "utf8",
      )

      const dryCheck = await syncReleaseDocs({ root: dir, write: false })
      expect(dryCheck.ok).toBe(false)
      expect(dryCheck.changed).toEqual(["README.md", "docs-site/src/content/docs/download.md"])

      const written = await syncReleaseDocs({ root: dir, write: true })
      expect(written.ok).toBe(true)
      expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("badge/version-2.37.0-blue")

      const recheck = await syncReleaseDocs({ root: dir, write: false })
      expect(recheck.ok).toBe(true)
      expect(recheck.changed).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

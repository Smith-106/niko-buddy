import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  diagnoseProjectIntegrity,
  purgeStaleDrafts,
  generateStandardArchiveManifest,
} from "./disposal-maintenance"

const mockFiles = new Map<string, string>()
const mockDirs = new Map<string, Array<{ name: string; path: string; is_dir: boolean }>>()
const deletedFiles: string[] = []

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (path: string) => {
    const key = path.replace(/\\/g, "/")
    if (mockFiles.has(key)) return mockFiles.get(key)!
    throw new Error(`File not found: ${path}`)
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    mockFiles.set(path.replace(/\\/g, "/"), content)
  }),
  deleteFile: vi.fn(async (path: string) => {
    const key = path.replace(/\\/g, "/")
    deletedFiles.push(key)
    mockFiles.delete(key)
  }),
  listDirectory: vi.fn(async (path: string) => {
    const key = path.replace(/\\/g, "/")
    if (mockDirs.has(key)) return mockDirs.get(key)!
    return []
  }),
  createDirectory: vi.fn(async () => {}),
  fileExists: vi.fn(async (path: string) => mockFiles.has(path.replace(/\\/g, "/"))),
}))

vi.mock("./novel-session-status", () => ({
  loadNovelSessionStatus: vi.fn(async (projectPath: string) => {
    const key = `${projectPath.replace(/\\/g, "/")}/.novel/status.json`
    if (mockFiles.has(key)) {
      return JSON.parse(mockFiles.get(key)!)
    }
    return null
  }),
}))

describe("disposal-maintenance (ISO 12207 6.4.14 Disposal & ISO 25010 Replaceability)", () => {
  const projectPath = "c:/test-novel"

  beforeEach(() => {
    mockFiles.clear()
    mockDirs.clear()
    deletedFiles.length = 0
  })

  describe("diagnoseProjectIntegrity", () => {
    it("reports healthy project with matched chapters and snapshots", async () => {
      mockFiles.set(
        "c:/test-novel/.novel/status.json",
        JSON.stringify({
          status: "idle",
          ready_status: "idle",
        }),
      )
      mockDirs.set("c:/test-novel/wiki/chapters", [
        { name: "001-ch1.md", path: "c:/test-novel/wiki/chapters/001-ch1.md", is_dir: false },
        { name: "002-ch2.md", path: "c:/test-novel/wiki/chapters/002-ch2.md", is_dir: false },
      ])
      mockDirs.set("c:/test-novel/.novel/snapshots", [
        { name: "001.snapshot.json", path: "c:/test-novel/.novel/snapshots/001.snapshot.json", is_dir: false },
        { name: "002.snapshot.json", path: "c:/test-novel/.novel/snapshots/002.snapshot.json", is_dir: false },
      ])

      const report = await diagnoseProjectIntegrity(projectPath)
      expect(report.healthScore).toBe(100)
      expect(report.isHealthy).toBe(true)
      expect(report.totalFinalChapters).toBe(2)
      expect(report.totalSnapshots).toBe(2)
      expect(report.orphanedSnapshots).toHaveLength(0)
    })

    it("detects orphaned snapshots and lowers health score", async () => {
      mockFiles.set(
        "c:/test-novel/.novel/status.json",
        JSON.stringify({
          status: "idle",
        }),
      )
      mockDirs.set("c:/test-novel/wiki/chapters", [
        { name: "001-ch1.md", path: "c:/test-novel/wiki/chapters/001-ch1.md", is_dir: false },
      ])
      mockDirs.set("c:/test-novel/.novel/snapshots", [
        { name: "001.snapshot.json", path: "c:/test-novel/.novel/snapshots/001.snapshot.json", is_dir: false },
        { name: "099.snapshot.json", path: "c:/test-novel/.novel/snapshots/099.snapshot.json", is_dir: false },
      ])

      const report = await diagnoseProjectIntegrity(projectPath)
      expect(report.healthScore).toBeLessThan(100)
      expect(report.orphanedSnapshots).toContain(99)
      expect(report.issues.some((i) => i.includes("孤立快照"))).toBe(true)
    })
  })

  describe("purgeStaleDrafts", () => {
    it("safely deletes rejected drafts while protecting final chapters", async () => {
      mockFiles.set(
        "c:/test-novel/.novel/status.json",
        JSON.stringify({
          session_id: "s1",
          session_status: "completed",
          draft: {
            draft_status: "rejected",
            file_path: ".novel/drafts/ch2-rejected.draft.md",
          },
        }),
      )
      mockFiles.set("c:/test-novel/.novel/drafts/ch2-rejected.draft.md", "Rejected draft content")
      mockFiles.set("c:/test-novel/wiki/chapters/001.md", "# Chapter 1 Final Content")

      mockDirs.set("c:/test-novel/wiki/chapters", [
        { name: "001.md", path: "c:/test-novel/wiki/chapters/001.md", is_dir: false },
      ])
      mockDirs.set("c:/test-novel/.novel/drafts", [
        { name: "ch2-rejected.draft.md", path: "c:/test-novel/.novel/drafts/ch2-rejected.draft.md", is_dir: false },
      ])

      const result = await purgeStaleDrafts({ projectPath })
      expect(result.success).toBe(true)
      expect(result.purgedDraftCount).toBeGreaterThanOrEqual(1)
      expect(result.preservedFinalChaptersCount).toBe(1)
      expect(deletedFiles).toContain("c:/test-novel/.novel/drafts/ch2-rejected.draft.md")
      expect(mockFiles.has("c:/test-novel/wiki/chapters/001.md")).toBe(true)
    })

    it("respects dryRun flag and does not delete physical files", async () => {
      mockFiles.set(
        "c:/test-novel/.novel/status.json",
        JSON.stringify({
          session_id: "s1",
          session_status: "completed",
          draft: {
            draft_status: "rejected",
            file_path: ".novel/drafts/ch2-rejected.draft.md",
          },
        }),
      )
      mockFiles.set("c:/test-novel/.novel/drafts/ch2-rejected.draft.md", "Rejected draft content")

      const result = await purgeStaleDrafts({ projectPath, dryRun: true })
      expect(result.success).toBe(true)
      expect(deletedFiles).toHaveLength(0)
      expect(result.details.some((d) => d.includes("[DryRun]"))).toBe(true)
      expect(mockFiles.has("c:/test-novel/.novel/drafts/ch2-rejected.draft.md")).toBe(true)
    })

    it("never purges an active review_ready draft", async () => {
      mockFiles.set(
        "c:/test-novel/.novel/status.json",
        JSON.stringify({
          session_id: "s1",
          session_status: "running",
          draft: {
            draft_status: "ready",
            file_path: ".novel/drafts/ch3-active.draft.md",
          },
        }),
      )
      mockFiles.set("c:/test-novel/.novel/drafts/ch3-active.draft.md", "Pending review content")
      mockDirs.set("c:/test-novel/.novel/drafts", [
        { name: "ch3-active.draft.md", path: "c:/test-novel/.novel/drafts/ch3-active.draft.md", is_dir: false },
      ])

      const result = await purgeStaleDrafts({ projectPath })
      expect(result.success).toBe(true)
      expect(deletedFiles).not.toContain("c:/test-novel/.novel/drafts/ch3-active.draft.md")
      expect(result.details.some((d) => d.includes("跳过正在等待人工审阅的激活草稿"))).toBe(true)
    })
  })

  describe("generateStandardArchiveManifest", () => {
    it("generates ISO 25010 compliant standard manifest", async () => {
      mockDirs.set("c:/test-novel/wiki/chapters", [
        { name: "002-ch2.md", path: "c:/test-novel/wiki/chapters/002-ch2.md", is_dir: false },
        { name: "001-ch1.md", path: "c:/test-novel/wiki/chapters/001-ch1.md", is_dir: false },
      ])

      const manifest = await generateStandardArchiveManifest(projectPath)
      expect(manifest.standard).toBe("ISO/IEC 25010:2023 Replaceability Compliant")
      expect(manifest.chaptersCount).toBe(2)
      // Ordered by chapter number
      expect(manifest.chapters[0].chapterNumber).toBe(1)
      expect(manifest.chapters[1].chapterNumber).toBe(2)
      expect(manifest.metadataIncluded.characterStates).toBe(true)
    })
  })
})

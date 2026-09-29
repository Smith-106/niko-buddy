import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  diagnoseProjectIntegrity,
  purgeStaleDrafts,
  generateStandardArchiveManifest,
} from "./disposal-maintenance"
import * as sessionStatusModule from "./novel-session-status"

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
    throw new Error(`Directory not found: ${path}`)
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
    vi.restoreAllMocks()
  })

  describe("diagnoseProjectIntegrity", () => {
    it("reports healthy project with matched chapters and snapshots", async () => {
      mockFiles.set(
        "c:/test-novel/.novel/status.json",
        JSON.stringify({
          session_id: "s1",
          session_status: "running",
          draft: {
            draft_status: "ready",
            file_path: ".novel/drafts/ch1.draft.md",
          },
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
      expect(report.hasActiveReviewReadyDraft).toBe(true)
      expect(report.totalFinalChapters).toBe(2)
      expect(report.totalSnapshots).toBe(2)
      expect(report.orphanedSnapshots).toHaveLength(0)
    })

    it("detects orphaned snapshots and handles capping deduction", async () => {
      mockFiles.set(
        "c:/test-novel/.novel/status.json",
        JSON.stringify({
          session_id: "s1",
          session_status: "idle",
        }),
      )
      mockDirs.set("c:/test-novel/wiki/chapters", [
        { name: "001-ch1.md", path: "c:/test-novel/wiki/chapters/001-ch1.md", is_dir: false },
      ])
      mockDirs.set("c:/test-novel/.novel/snapshots", [
        { name: "001.snapshot.json", path: "c:/test-novel/.novel/snapshots/001.snapshot.json", is_dir: false },
        { name: "010.snapshot.json", path: "c:/test-novel/.novel/snapshots/010.snapshot.json", is_dir: false },
        { name: "011.snapshot.json", path: "c:/test-novel/.novel/snapshots/011.snapshot.json", is_dir: false },
        { name: "012.snapshot.json", path: "c:/test-novel/.novel/snapshots/012.snapshot.json", is_dir: false },
        { name: "013.snapshot.json", path: "c:/test-novel/.novel/snapshots/013.snapshot.json", is_dir: false },
        { name: "014.snapshot.json", path: "c:/test-novel/.novel/snapshots/014.snapshot.json", is_dir: false },
      ])

      const report = await diagnoseProjectIntegrity(projectPath)
      expect(report.healthScore).toBe(80)
      expect(report.orphanedSnapshots.length).toBe(5)
      expect(report.issues.some((i) => i.includes("孤立快照"))).toBe(true)
    })

    it("handles missing chapters directory and Error status failure gracefully", async () => {
      vi.spyOn(sessionStatusModule, "loadNovelSessionStatus").mockRejectedValueOnce(
        new Error("Status file corrupted"),
      )

      const report = await diagnoseProjectIntegrity(projectPath)
      expect(report.healthScore).toBe(50)
      expect(report.isHealthy).toBe(false)
      expect(report.issues.some((i) => i.includes("Status file corrupted"))).toBe(true)
    })

    it("handles non-Error status failure gracefully", async () => {
      vi.spyOn(sessionStatusModule, "loadNovelSessionStatus").mockRejectedValueOnce("Status file raw error")

      const report = await diagnoseProjectIntegrity(projectPath)
      expect(report.healthScore).toBe(50)
      expect(report.issues.some((i) => i.includes("Status file raw error"))).toBe(true)
    })

    it("ignores non-snapshot files, unnumbered snapshots, and non-positive snapshot numbers", async () => {
      mockFiles.set(
        "c:/test-novel/.novel/status.json",
        JSON.stringify({ session_id: "s1", session_status: "idle" }),
      )
      mockDirs.set("c:/test-novel/wiki/chapters", [
        { name: "README.txt", path: "c:/test-novel/wiki/chapters/README.txt", is_dir: false },
        { name: "intro.md", path: "c:/test-novel/wiki/chapters/intro.md", is_dir: false },
      ])
      mockDirs.set("c:/test-novel/.novel/snapshots", [
        { name: "ignore.txt", path: "c:/test-novel/.novel/snapshots/ignore.txt", is_dir: false },
        { name: "unnumbered.snapshot.json", path: "c:/test-novel/.novel/snapshots/unnumbered.snapshot.json", is_dir: false },
        { name: "000.snapshot.json", path: "c:/test-novel/.novel/snapshots/000.snapshot.json", is_dir: false },
      ])

      const report = await diagnoseProjectIntegrity(projectPath)
      expect(report.totalFinalChapters).toBe(1)
      expect(report.totalSnapshots).toBe(2)
      expect(report.orphanedSnapshots).toHaveLength(0)
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
        { name: "temp-stage.tmp", path: "c:/test-novel/.novel/drafts/temp-stage.tmp", is_dir: false },
        { name: "notes.txt", path: "c:/test-novel/.novel/drafts/notes.txt", is_dir: false }, // Ignored
      ])
      mockFiles.set("c:/test-novel/.novel/drafts/temp-stage.tmp", "temp content")

      const result = await purgeStaleDrafts({ projectPath })
      expect(result.success).toBe(true)
      expect(result.purgedDraftCount).toBe(2)
      expect(result.preservedFinalChaptersCount).toBe(1)
      expect(deletedFiles).toContain("c:/test-novel/.novel/drafts/ch2-rejected.draft.md")
      expect(deletedFiles).toContain("c:/test-novel/.novel/drafts/temp-stage.tmp")
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
      mockDirs.set("c:/test-novel/.novel/drafts", [
        { name: "stale-scratch.draft.md", path: "c:/test-novel/.novel/drafts/stale-scratch.draft.md", is_dir: false },
      ])
      mockFiles.set("c:/test-novel/.novel/drafts/stale-scratch.draft.md", "Scratch content")

      const result = await purgeStaleDrafts({ projectPath, dryRun: true })
      expect(result.success).toBe(true)
      expect(deletedFiles).toHaveLength(0)
      expect(result.details.some((d) => d.includes("[DryRun] 探测到待清除已驳回草稿"))).toBe(true)
      expect(result.details.some((d) => d.includes("[DryRun] 探测到过期临时草稿"))).toBe(true)
      expect(mockFiles.has("c:/test-novel/.novel/drafts/ch2-rejected.draft.md")).toBe(true)
    })

    it("handles unreadable files in drafts directory and already deleted rejected drafts", async () => {
      mockFiles.set(
        "c:/test-novel/.novel/status.json",
        JSON.stringify({
          session_id: "s1",
          session_status: "completed",
          draft: {
            draft_status: "rejected",
            file_path: ".novel/drafts/already-gone.draft.md",
          },
        }),
      )
      mockDirs.set("c:/test-novel/.novel/drafts", [
        { name: "corrupted.draft.md", path: "c:/test-novel/.novel/drafts/corrupted.draft.md", is_dir: false },
      ])
      // Note: corrupted.draft.md is not placed into mockFiles, so readFile will throw

      const result = await purgeStaleDrafts({ projectPath })
      expect(result.success).toBe(true)
      expect(result.purgedDraftCount).toBe(0)
      expect(result.preservedFinalChaptersCount).toBe(0)
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

    it("handles top-level Error exceptions gracefully", async () => {
      vi.spyOn(sessionStatusModule, "loadNovelSessionStatus").mockRejectedValueOnce(
        new Error("Disk IO failure"),
      )

      const result = await purgeStaleDrafts({ projectPath })
      expect(result.success).toBe(false)
      expect(result.details[0]).toContain("处置过程异常中断: Disk IO failure")
    })

    it("handles top-level non-Error exceptions gracefully", async () => {
      vi.spyOn(sessionStatusModule, "loadNovelSessionStatus").mockRejectedValueOnce(
        "Raw fatal string failure",
      )

      const result = await purgeStaleDrafts({ projectPath })
      expect(result.success).toBe(false)
      expect(result.details[0]).toContain("处置过程异常中断: Raw fatal string failure")
    })
  })

  describe("generateStandardArchiveManifest", () => {
    it("generates ISO 25010 compliant standard manifest and ignores non-md files", async () => {
      mockDirs.set("c:/test-novel/wiki/chapters", [
        { name: "002-ch2.md", path: "c:/test-novel/wiki/chapters/002-ch2.md", is_dir: false },
        { name: "001-ch1.md", path: "c:/test-novel/wiki/chapters/001-ch1.md", is_dir: false },
        { name: "prologue.md", path: "c:/test-novel/wiki/chapters/prologue.md", is_dir: false },
        { name: "metadata.json", path: "c:/test-novel/wiki/chapters/metadata.json", is_dir: false },
      ])

      const manifest = await generateStandardArchiveManifest(projectPath)
      expect(manifest.standard).toBe("ISO/IEC 25010:2023 Replaceability Compliant")
      expect(manifest.chaptersCount).toBe(3)
      // Ordered by chapter number (0, 1, 2)
      expect(manifest.chapters[0].chapterNumber).toBe(0)
      expect(manifest.chapters[0].title).toBe("prologue")
      expect(manifest.chapters[1].chapterNumber).toBe(1)
      expect(manifest.chapters[2].chapterNumber).toBe(2)
      expect(manifest.metadataIncluded.characterStates).toBe(true)
    })

    it("handles missing chapters directory gracefully", async () => {
      const manifest = await generateStandardArchiveManifest("c:/empty-project")
      expect(manifest.chaptersCount).toBe(0)
      expect(manifest.chapters).toHaveLength(0)
    })
  })
})

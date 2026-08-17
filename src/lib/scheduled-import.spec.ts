import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  isScheduledImportInternalPath,
  resolveImportPath,
  scanAndImport,
  scheduledImportDestinationForFile,
  shouldSkipScheduledImportFile,
  startScheduledImport,
  stopScheduledImport,
} from "./scheduled-import"
import type { FileNode, WikiProject } from "@/types/wiki"
import type { ScheduledImportConfig } from "@/stores/wiki-store"

const mocks = vi.hoisted(() => ({
  copyFile: vi.fn(),
  fileExists: vi.fn(),
  getFileMd5: vi.fn(),
  getFileSize: vi.fn(),
  listDirectory: vi.fn(),
  preprocessFile: vi.fn(),
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  wikiGetState: vi.fn(),
  resolveDefaultModel: vi.fn(),
  loadScheduledImportConfig: vi.fn(),
  saveScheduledImportConfig: vi.fn(),
  enqueueSourceIngest: vi.fn(),
  isIngestableSourcePath: vi.fn(),
  setFileTree: vi.fn(),
  bumpDataVersion: vi.fn(),
  setScheduledImportConfig: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  copyFile: mocks.copyFile,
  fileExists: mocks.fileExists,
  getFileMd5: mocks.getFileMd5,
  getFileSize: mocks.getFileSize,
  listDirectory: mocks.listDirectory,
  preprocessFile: mocks.preprocessFile,
  readFile: mocks.readFile,
  writeFileAtomic: mocks.writeFileAtomic,
}))

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: { getState: mocks.wikiGetState },
}))

vi.mock("@/lib/novel/model-resolver", () => ({
  resolveDefaultModel: mocks.resolveDefaultModel,
}))

vi.mock("@/lib/project-store", () => ({
  loadScheduledImportConfig: mocks.loadScheduledImportConfig,
  saveScheduledImportConfig: mocks.saveScheduledImportConfig,
}))

vi.mock("@/lib/source-lifecycle", () => ({
  enqueueSourceIngest: mocks.enqueueSourceIngest,
  isIngestableSourcePath: mocks.isIngestableSourcePath,
}))

const project: WikiProject = { id: "proj1", name: "P", path: "C:/projects/p" }
const DB_FILE = "C:/projects/p/.qmai/scheduled-import-db.json"

const storeState = {
  projectId: "proj1",
  llmConfig: { provider: "custom" as const, apiKey: "k" },
}

function installWikiStore(): void {
  mocks.wikiGetState.mockImplementation(() => ({
    project: { id: storeState.projectId },
    llmConfig: storeState.llmConfig,
    setFileTree: mocks.setFileTree,
    bumpDataVersion: mocks.bumpDataVersion,
    setScheduledImportConfig: mocks.setScheduledImportConfig,
  }))
}

const fileNode = (path: string, name: string): FileNode => ({
  id: path,
  path,
  name,
  is_dir: false,
  children: undefined,
})

const dirNode = (path: string, name: string, children: FileNode[]): FileNode => ({
  id: path,
  path,
  name,
  is_dir: true,
  children,
})

const config: ScheduledImportConfig = { enabled: true, path: "watched", interval: 5, lastScan: null }

describe("path helpers", () => {
  it("detects internal paths", () => {
    expect(isScheduledImportInternalPath("C:/p/.qmai/x.json")).toBe(true)
    expect(isScheduledImportInternalPath("C:/p/raw/.llm-wiki-imported/y")).toBe(true)
    expect(isScheduledImportInternalPath("C:/p/raw/.llm-wiki/z")).toBe(true)
    expect(isScheduledImportInternalPath("C:/p/wiki/a.md")).toBe(false)
  })

  it("skips internal, wiki, cache and dotfile paths", () => {
    const pp = "C:/p"
    expect(shouldSkipScheduledImportFile(pp, "C:/p/.qmai/db.json")).toBe(true)
    expect(shouldSkipScheduledImportFile(pp, "C:/p/wiki/entities/a.md")).toBe(true)
    expect(shouldSkipScheduledImportFile(pp, "C:/p/raw/sources/.cache/a.txt")).toBe(true)
    expect(shouldSkipScheduledImportFile(pp, "C:/p/raw/sources/.hidden")).toBe(true)
    expect(shouldSkipScheduledImportFile(pp, "C:/p/raw/sources/ok.pdf")).toBe(false)
  })

  it("resolves import paths relative to the project or absolute", () => {
    expect(resolveImportPath("C:/p", "")).toBe("C:/p/raw/sources")
    expect(resolveImportPath("C:/p", "watched")).toBe("C:/p/watched")
    expect(resolveImportPath("C:/p", "C:/abs/dir")).toBe("C:/abs/dir")
  })

  it("computes destinations for files inside and outside the sources root", () => {
    const pp = "C:/p"
    // already inside raw/sources → stays put
    expect(scheduledImportDestinationForFile(pp, "C:/p/watched", fileNode("C:/p/raw/sources/a.md", "a.md"))).toBe("C:/p/raw/sources/a.md")
    // import root file → name only
    expect(scheduledImportDestinationForFile(pp, "C:/p/watched", fileNode("C:/p/watched/a.md", "a.md"))).toBe("C:/p/raw/sources/scheduled-import/a.md")
    // outside the root → name only
    expect(scheduledImportDestinationForFile(pp, "C:/p/watched", fileNode("C:/elsewhere/b.md", "b.md"))).toBe("C:/p/raw/sources/scheduled-import/b.md")
    // subdirectory file → relative subpath preserved
    expect(scheduledImportDestinationForFile(pp, "C:/p/watched", fileNode("C:/p/watched/sub/b.pdf", "b.pdf"))).toBe("C:/p/raw/sources/scheduled-import/sub/b.pdf")
  })

  it("sanitizes unsafe segments and reserved names in destinations", () => {
    const pp = "C:/p"
    const dest = scheduledImportDestinationForFile(pp, "C:/p/watched", fileNode("C:/p/watched/we:ird..name  .txt", "we:ird..name  .txt"))
    expect(dest.split("/").pop()!).not.toContain(":")
    expect(dest.split("/").pop()!).toContain("we_ird")
    const reserved = scheduledImportDestinationForFile(pp, "C:/p/watched", fileNode("C:/p/watched/con.md", "con.md"))
    expect(reserved).toContain("scheduled-import/_con-")
    // dotless reserved name exercises the no-extension suffix branch
    const dotless = scheduledImportDestinationForFile(pp, "C:/p/watched", fileNode("C:/p/watched/con", "con"))
    expect(dotless).toMatch(/scheduled-import\/_con-[0-9a-z]+$/)
    // a path of only ".." segments normalizes to "_"
    expect(scheduledImportDestinationForFile(pp, "C:/p/watched", fileNode("C:/p/watched/..", ".."))).toBe("C:/p/raw/sources/scheduled-import/_")
    // all-dots segments sanitize to "_" (and the last segment gains a stability suffix)
    expect(scheduledImportDestinationForFile(pp, "C:/p/watched", fileNode("C:/p/watched/.../a.md", "a.md"))).toMatch(/scheduled-import\/_\/a-[0-9a-z]+\.md$/)
  })
})

describe("scanAndImport", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.projectId = "proj1"
    installWikiStore()
    mocks.resolveDefaultModel.mockImplementation((c: unknown) => c)
    mocks.isIngestableSourcePath.mockResolvedValue(true)
    mocks.enqueueSourceIngest.mockResolvedValue([])
    mocks.listDirectory.mockResolvedValue([])
    mocks.readFile.mockRejectedValue(new Error("no db"))
    mocks.fileExists.mockResolvedValue(false)
    mocks.getFileSize.mockResolvedValue(1000)
    mocks.getFileMd5.mockResolvedValue("md5-1")
    mocks.copyFile.mockResolvedValue(undefined)
    mocks.preprocessFile.mockResolvedValue("pre")
    mocks.writeFileAtomic.mockResolvedValue(undefined)
    mocks.loadScheduledImportConfig.mockResolvedValue(null)
    mocks.saveScheduledImportConfig.mockResolvedValue(undefined)
    stopScheduledImport()
  })

  it("returns immediately for an empty import path", async () => {
    await scanAndImport(project, "")
    expect(mocks.listDirectory).not.toHaveBeenCalled()
  })

  it("ignores concurrent scans while one is running", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    mocks.listDirectory.mockImplementation(() => gate.then(() => []))
    const first = scanAndImport(project, "watched")
    const second = scanAndImport(project, "watched")
    expect(mocks.listDirectory).toHaveBeenCalledTimes(1)
    release()
    await first
    await second
  })

  it("scans, copies, preprocesses and enqueues new files", async () => {
    mocks.listDirectory.mockResolvedValue([
      dirNode("C:/projects/p/watched/sub", "sub", [fileNode("C:/projects/p/watched/sub/notes.pdf", "notes.pdf")]),
      fileNode("C:/projects/p/raw/sources/existing.md", "existing.md"),
    ])
    mocks.enqueueSourceIngest.mockResolvedValue(["job-1"])
    mocks.loadScheduledImportConfig.mockResolvedValue({ ...config })

    await scanAndImport(project, "watched")

    expect(mocks.listDirectory).toHaveBeenCalledWith("C:/projects/p/watched")
    // notes.pdf is outside raw/sources → copied
    expect(mocks.copyFile).toHaveBeenCalledWith(
      "C:/projects/p/watched/sub/notes.pdf",
      "C:/projects/p/raw/sources/scheduled-import/sub/notes.pdf",
    )
    // existing.md already lives in raw/sources → no copy
    expect(mocks.copyFile).toHaveBeenCalledTimes(1)
    expect(mocks.preprocessFile).toHaveBeenCalledWith("C:/projects/p/raw/sources/scheduled-import/sub/notes.pdf")
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledWith(
      project,
      [
        "C:/projects/p/raw/sources/scheduled-import/sub/notes.pdf",
        "C:/projects/p/raw/sources/existing.md",
      ],
      storeState.llmConfig,
    )
    expect(mocks.setFileTree).toHaveBeenCalled()
    expect(mocks.bumpDataVersion).toHaveBeenCalled()
    expect(mocks.saveScheduledImportConfig).toHaveBeenCalledWith(
      "C:/projects/p",
      expect.objectContaining({ lastScan: expect.any(Number) }),
    )
    expect(mocks.setScheduledImportConfig).toHaveBeenCalled()
    // db persisted with both changed md5s
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      DB_FILE,
      expect.stringContaining("md5-1"),
    )
  })

  it("keeps already-imported files out of the changed set", async () => {
    mocks.listDirectory.mockResolvedValue([fileNode("C:/projects/p/watched/a.md", "a.md")])
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        directories: { "c:/projects/p/watched": { files: { "C:/projects/p/watched/a.md": "md5-1" }, lastScan: 1 } },
      }),
    )
    await scanAndImport(project, "watched")
    expect(mocks.preprocessFile).not.toHaveBeenCalled()
    expect(mocks.enqueueSourceIngest).not.toHaveBeenCalled()
    expect(mocks.writeFileAtomic).toHaveBeenCalled()
  })

  it("skips wiki/internal/dotfile/sensitive/non-ingestable files", async () => {
    mocks.listDirectory.mockResolvedValue([
      fileNode("C:/projects/p/wiki/entities/a.md", "a.md"),
      fileNode("C:/projects/p/watched/.secret", ".secret"),
      fileNode("C:/projects/p/watched/settings.json", "settings.json"),
      fileNode("C:/projects/p/watched/README", "README"),
      fileNode("C:/projects/p/watched/archive.zip", "archive.zip"),
    ])
    mocks.isIngestableSourcePath.mockImplementation((p: string) => p.endsWith(".zip"))
    await scanAndImport(project, "watched")
    // only archive.zip passes every gate; .zip is ingestable → it is copied
    expect(mocks.copyFile).toHaveBeenCalledTimes(1)
    expect(mocks.getFileSize).toHaveBeenCalledWith("C:/projects/p/watched/archive.zip")
  })

  it("skips files over the 100 MB limit", async () => {
    mocks.listDirectory.mockResolvedValue([fileNode("C:/projects/p/watched/big.pdf", "big.pdf")])
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.getFileSize.mockResolvedValue(101 * 1024 * 1024)
    await scanAndImport(project, "watched")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exceeds 100 MB limit"))
    expect(mocks.copyFile).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("warns and continues on per-file errors", async () => {
    mocks.listDirectory.mockResolvedValue([
      fileNode("C:/projects/p/watched/good.md", "good.md"),
      fileNode("C:/projects/p/watched/bad.pdf", "bad.pdf"),
    ])
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.getFileSize.mockImplementation(async (p: string) => {
      if (p.endsWith("bad.pdf")) throw new Error("stat failed")
      return 10
    })
    mocks.enqueueSourceIngest.mockResolvedValue(["job"])
    await scanAndImport(project, "watched")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("skipped C:/projects/p/watched/bad.pdf:"), expect.any(Error))
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it("does not mark files imported when the LLM is not configured", async () => {
    mocks.listDirectory.mockResolvedValue([fileNode("C:/projects/p/watched/a.md", "a.md")])
    mocks.enqueueSourceIngest.mockResolvedValue([])
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await scanAndImport(project, "watched")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("LLM is not configured"))
    // changed file md5 was NOT persisted
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(DB_FILE, expect.stringContaining('"files": {}'))
    warn.mockRestore()
  })

  it("tolerates preprocess failures", async () => {
    mocks.listDirectory.mockResolvedValue([fileNode("C:/projects/p/watched/a.md", "a.md")])
    mocks.preprocessFile.mockRejectedValue(new Error("preprocess boom"))
    mocks.enqueueSourceIngest.mockResolvedValue(["job"])
    await expect(scanAndImport(project, "watched")).resolves.toBeUndefined()
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledTimes(1)
  })

  it("returns early mid-loop when the project switches", async () => {
    mocks.listDirectory.mockImplementation(async () => {
      storeState.projectId = "other"
      return [fileNode("C:/projects/p/watched/a.md", "a.md")]
    })
    await scanAndImport(project, "watched")
    expect(mocks.getFileSize).not.toHaveBeenCalled()
  })

  it("returns early after the loop when the run becomes stale", async () => {
    mocks.listDirectory.mockResolvedValue([fileNode("C:/projects/p/watched/a.md", "a.md")])
    // switch the active project while the scan is in flight → post-loop isCurrentRun fails
    mocks.getFileMd5.mockImplementation(async () => {
      storeState.projectId = "other"
      return "md5"
    })
    await scanAndImport(project, "watched")
    expect(mocks.enqueueSourceIngest).not.toHaveBeenCalled()
  })

  it("skips ingest when the run goes stale between preprocess and ingest", async () => {
    mocks.listDirectory.mockResolvedValue([fileNode("C:/projects/p/watched/a.md", "a.md")])
    mocks.preprocessFile.mockImplementation(async () => {
      storeState.projectId = "other"
      return "pre"
    })
    mocks.enqueueSourceIngest.mockResolvedValue(["job"])
    await scanAndImport(project, "watched")
    expect(mocks.enqueueSourceIngest).not.toHaveBeenCalled()
  })

  it("returns immediately when the project is not current at scan start", async () => {
    storeState.projectId = "other"
    await scanAndImport(project, "watched")
    expect(mocks.listDirectory).not.toHaveBeenCalled()
  })

  it("logs and swallows a failed scan", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.listDirectory.mockRejectedValue(new Error("scan exploded"))
    await expect(scanAndImport(project, "watched")).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith("Scheduled import scan failed:", expect.any(Error))
    error.mockRestore()
  })

  it("collects files recursively and tolerates empty directories", async () => {
    mocks.listDirectory.mockResolvedValue([
      dirNode("C:/projects/p/watched/empty", "empty", []),
      // dir node without a children array is skipped by collectFiles
      { ...dirNode("C:/projects/p/watched/bare", "bare", []), children: undefined },
      dirNode("C:/projects/p/watched/sub", "sub", [fileNode("C:/projects/p/watched/sub/a.md", "a.md")]),
    ])
    mocks.enqueueSourceIngest.mockResolvedValue(["job"])
    await scanAndImport(project, "watched")
    expect(mocks.enqueueSourceIngest).toHaveBeenCalledTimes(1)
    expect(mocks.copyFile).toHaveBeenCalledTimes(1)
  })

  it("handles a corrupted db store as empty", async () => {
    mocks.listDirectory.mockResolvedValue([fileNode("C:/projects/p/watched/a.md", "a.md")])
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue("not json")
    await scanAndImport(project, "watched")
    expect(mocks.copyFile).toHaveBeenCalledTimes(1)
  })

  it("treats a store without a directories object as empty", async () => {
    mocks.listDirectory.mockResolvedValue([fileNode("C:/projects/p/watched/a.md", "a.md")])
    mocks.fileExists.mockResolvedValue(true)
    mocks.readFile.mockResolvedValue(JSON.stringify({ version: 1 }))
    await scanAndImport(project, "watched")
    expect(mocks.copyFile).toHaveBeenCalledTimes(1)
  })

  it("supports unix-style project paths", async () => {
    const unixProject: WikiProject = { id: "u1", name: "U", path: "/home/u/p" }
    storeState.projectId = "u1"
    mocks.listDirectory.mockResolvedValue([fileNode("/home/u/p/watched/a.md", "a.md")])
    mocks.enqueueSourceIngest.mockResolvedValue(["job"])
    await scanAndImport(unixProject, "watched")
    expect(mocks.copyFile).toHaveBeenCalledWith(
      "/home/u/p/watched/a.md",
      "/home/u/p/raw/sources/scheduled-import/a.md",
    )
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith("/home/u/p/.qmai/scheduled-import-db.json", expect.any(String))
  })
})

describe("start/stop scheduled import", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.projectId = "proj1"
    installWikiStore()
    mocks.resolveDefaultModel.mockImplementation((c: unknown) => c)
    mocks.listDirectory.mockResolvedValue([])
    mocks.readFile.mockRejectedValue(new Error("no db"))
    mocks.fileExists.mockResolvedValue(false)
    mocks.getFileSize.mockResolvedValue(1)
    mocks.getFileMd5.mockResolvedValue("m")
    mocks.writeFileAtomic.mockResolvedValue(undefined)
    mocks.loadScheduledImportConfig.mockResolvedValue(null)
    stopScheduledImport()
  })

  it("does not start when disabled, pathless or with a non-positive interval", () => {
    startScheduledImport(project, { ...config, enabled: false })
    startScheduledImport(project, { ...config, path: "" })
    startScheduledImport(project, { ...config, interval: 0 })
    expect(mocks.listDirectory).not.toHaveBeenCalled()
  })

  it("runs an immediate scan, then stops the timer", async () => {
    startScheduledImport(project, config)
    await vi.waitFor(() => expect(mocks.listDirectory).toHaveBeenCalledWith("C:/projects/p/watched"))
    stopScheduledImport()
    // second call to stop is a no-op on the timer
    stopScheduledImport()
    expect(mocks.listDirectory).toHaveBeenCalledTimes(1)
  })

  it("fires the interval scan while the timer runs", async () => {
    vi.useFakeTimers()
    try {
      startScheduledImport(project, config) // interval 5 → 300000 ms
      await vi.advanceTimersByTimeAsync(300000)
      stopScheduledImport()
      // immediate scan + one interval-fired scan
      expect(mocks.listDirectory.mock.calls.length).toBeGreaterThanOrEqual(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops an in-flight scan by invalidating its run id", async () => {
    let release!: () => void
    const gate = new Promise<FileNode[]>((r) => { release = () => r([]) })
    mocks.listDirectory.mockImplementation(() => gate)
    startScheduledImport(project, config)
    // wait until the scan is inside listDirectory
    await vi.waitFor(() => expect(mocks.listDirectory).toHaveBeenCalled())
    stopScheduledImport()
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.getFileSize).not.toHaveBeenCalled()
  })
})

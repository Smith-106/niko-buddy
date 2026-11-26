import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import type { IngestResult } from "./chapter-ingest"
import { normalizeChapterSnapshot } from "./chapter-snapshot-normalize"
import { getNextChapterNumber, invalidateChapterCache } from "./chapter-utils"

const fsMocks = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  fileExists: vi.fn(),
  listDirectory: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  writeFileAtomic: vi.fn(),
}))



vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      createDirectory: fsMocks.createDirectory,
      fileExists: fsMocks.fileExists,
      listDirectory: fsMocks.listDirectory,
      readFile: fsMocks.readFile,
      writeFile: fsMocks.writeFile,
      writeFileAtomic: fsMocks.writeFileAtomic,
    
  }
})

import {
  buildImportFingerprint,
  buildImportedChapterMarkdown,
  extractImportFingerprint,
  collectChapterImportCandidatesFromFolder,
  extractImportedChapterNumber,
  importChapterFiles,
  importChapterFolder,
  importWholeTxtNovel,
  previewWholeTxtChapters,
  runImportedChapterMemoryExtraction,
  sortChapterImportCandidates,
} from "./chapter-import"

const IMPORT_PROJECT = "E:/Novel"
const IMPORT_SYNC = "sync_snapshot_to_memory"

function importedMemoryFixture(chapterNumber: number, path: string) {
  const index = String(chapterNumber).padStart(3, "0")
  const body = `Chapter ${chapterNumber} test body.`
  const historyPath = `${IMPORT_PROJECT}/.novel/snapshots/history/${index}/extraction.snapshot.json`
  const currentPath = `${IMPORT_PROJECT}/.novel/snapshots/${index}.snapshot.json`
  const source = `---
type: chapter
chapter_number: ${chapterNumber}
chapter_status: final
---
${body}`
  const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
  const extraction = { chapterNumber, snapshotId: `chapter-${chapterNumber}-r1`, revision: 1, isHistorical: false }
  const projected = { ...extraction, snapshotId: `chapter-${chapterNumber}-r2`, revision: 2, supersedes: extraction.snapshotId }
  const archive = JSON.stringify({ ...extraction, isHistorical: true }, null, 2)
  const current = JSON.stringify(projected, null, 2)
  const ledgerPath = `${IMPORT_PROJECT}/.novel/projection-status.json`
  const ledger = { schemaVersion: "2", chapters: { [String(chapterNumber)]: { [IMPORT_SYNC]: { projection: IMPORT_SYNC, category: "fold_rebuildable", status: "committed", updated_at: "2026-01-01T00:00:00Z", last_error: "" } } } }
  const files = new Map([[path, source], [historyPath, archive], [currentPath, current], [ledgerPath, JSON.stringify(ledger)]])
  const canonOutcome = { status: "skipped", reason: "no_facts" } as const
  const result: IngestResult = {
    snapshot: normalizeChapterSnapshot(extraction),
    receipt: {
      readPath: path, chapterNumber, contentSha256: hash(source), bodySha256: hash(body),
      snapshotIdAtExtractionCommit: extraction.snapshotId, snapshotRevisionAtExtractionCommit: extraction.revision,
      snapshotJsonSha256AtExtractionCommit: hash(JSON.stringify(extraction, null, 2)), canonOutcome,
    },
    projectionReceipt: { extractionHistoryPath: historyPath, snapshotId: projected.snapshotId, revision: projected.revision, snapshotJsonSha256: hash(current) },
    canonOutcome, ledgerSaveFailed: false, factsStoreFailed: false, failedProjections: [],
    pendingProjections: [], committedProjections: [IMPORT_SYNC],
  }
  return { result, files }
}

describe("chapter import", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.createDirectory.mockResolvedValue(undefined)
  })

  it("extracts Arabic and Chinese chapter numbers from file names", () => {
    expect(extractImportedChapterNumber("第1章 开局.txt")).toBe(1)
    expect(extractImportedChapterNumber("第十章 真相.docx")).toBe(10)
    expect(extractImportedChapterNumber("chapter-002.md")).toBe(2)
    expect(extractImportedChapterNumber("番外.txt")).toBeNull()
  })

  it("matches chapter numbers after book and volume prefixes without treating volume as the chapter", () => {
    expect(extractImportedChapterNumber("万古逍遥游-第一卷-第1章 前言.docx")).toBe(1)
    expect(extractImportedChapterNumber("万古逍遥游-第一卷-第2章 浮生苍穹为寒.docx")).toBe(2)
    expect(extractImportedChapterNumber("万古逍遥游-第一卷-第3章 十又五载.docx")).toBe(3)
  })

  it("sorts imported chapters by detected chapter number before unknown files", () => {
    const sorted = sortChapterImportCandidates([
      { path: "E:/book/第10章.txt", name: "第10章.txt" },
      { path: "E:/book/番外.txt", name: "番外.txt" },
      { path: "E:/book/第2章.txt", name: "第2章.txt" },
      { path: "E:/book/第1章.txt", name: "第1章.txt" },
    ])

    expect(sorted.map((item) => item.name)).toEqual([
      "第1章.txt",
      "第2章.txt",
      "第10章.txt",
      "番外.txt",
    ])
  })

  it("collects and sorts importable chapter files from a selected folder before confirmation", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "notes.tmp", path: "E:/book/notes.tmp", is_dir: false },
      { name: "chapter-002.md", path: "E:/book/chapter-002.md", is_dir: false },
      {
        name: "volume",
        path: "E:/book/volume",
        is_dir: true,
        children: [
          { name: "chapter-001.txt", path: "E:/book/volume/chapter-001.txt", is_dir: false },
        ],
      },
    ])

    const candidates = await collectChapterImportCandidatesFromFolder("E:\\book")

    expect(fsMocks.listDirectory).toHaveBeenCalledWith("E:/book")
    expect(candidates.map((candidate) => candidate.path)).toEqual([
      "E:/book/volume/chapter-001.txt",
      "E:/book/chapter-002.md",
    ])
  })

  it("builds chapter markdown as final only when memory extraction is requested", () => {
    const draft = buildImportedChapterMarkdown({
      title: "第1章 开局",
      chapterNumber: 1,
      body: "# 原标题\n\n正文",
      finalForMemoryExtraction: false,
    })
    const final = buildImportedChapterMarkdown({
      title: "第1章 开局",
      chapterNumber: 1,
      body: "正文",
      finalForMemoryExtraction: true,
    })

    expect(draft).toContain("chapter_status: draft")
    expect(final).toContain("chapter_status: final")
    expect(final).toContain("# 第1章 开局")
  })

  it("imports prefixed book-volume chapter files with clean chapter titles", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async (path: string) => `正文 ${path}`)

    await importChapterFiles("E:/Novel", [
      "E:/book/万古逍遥游-第一卷-第3章 十又五载.docx",
      "E:/book/万古逍遥游-第一卷-第1章 前言.docx",
      "E:/book/万古逍遥游-第一卷-第2章 浮生苍穹为寒.docx",
    ], { finalForMemoryExtraction: false })

    const written = fsMocks.writeFile.mock.calls.map(([path, content]) => ({
      path,
      content: String(content),
    }))
    expect(written.map((item) => item.path)).toEqual([
      "E:/Novel/wiki/chapters/chapter-001-前言.md",
      "E:/Novel/wiki/chapters/chapter-002-浮生苍穹为寒.md",
      "E:/Novel/wiki/chapters/chapter-003-十又五载.md",
    ])
    expect(written[0].content).toContain('title: "第1章 前言"')
    expect(written[0].content).toContain("# 第1章 前言")
    expect(written[1].content).toContain('title: "第2章 浮生苍穹为寒"')
    expect(written[2].content).toContain('title: "第3章 十又五载"')
  })

  it("imports bare 第N章 filename but recovers chapter name from body heading", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async () => [
      "---",
      "title: 第7章",
      "---",
      "",
      "# 第7章",
      "",
      "# 第7章 律师说没漏洞",
      "",
      "正文",
    ].join("\n"))

    const imported = await importChapterFiles("E:/Novel", ["E:/book/第7章.md"], {
      finalForMemoryExtraction: false,
    })

    // 文件名无章节名 → 用正文里首个非裸标题补全（原先会落成裸「第7章」）
    expect(imported[0].title).toBe("第7章 律师说没漏洞")
    const calls = fsMocks.writeFile.mock.calls as unknown[][]
    const written = calls[calls.length - 1]?.[1]
    expect(String(written)).toContain("# 第7章 律师说没漏洞")
  })

  it("extracts imported chapter memories one by one and stops after cancellation", async () => {
    const abortController = new AbortController()
    const firstPath = `${IMPORT_PROJECT}/wiki/chapters/chapter-001.md`
    const { files, result: ingestResult } = importedMemoryFixture(1, firstPath)
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const found = files.get(path)
      if (found === undefined) throw new Error(`ENOENT: ${path}`)
      return found
    })
    const ingestChapter = vi.fn(async () => {
      abortController.abort()
      return ingestResult
    })
    const onProgress = vi.fn()

    const result = await runImportedChapterMemoryExtraction({
      projectPath: "E:/Novel",
      chapterPaths: [firstPath, `${IMPORT_PROJECT}/wiki/chapters/chapter-002.md`],
      signal: abortController.signal,
      ingestChapter,
      onProgress,
    })

    expect(ingestChapter).toHaveBeenCalledTimes(1)
    expect(ingestChapter).toHaveBeenCalledWith(IMPORT_PROJECT, firstPath, undefined, abortController.signal, expect.any(Object))
    expect(result.cancelled).toBe(true)
    expect(result.completed).toBe(1)
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ completed: 0, total: 2 }))
  })
})

describe("chapter import number parsing edge cases", () => {
  it("parses Chinese digits, the 万 unit and zero-result numerals", () => {
    expect(extractImportedChapterNumber("第三章 试炼.txt")).toBe(3)
    expect(extractImportedChapterNumber("第三万章 洪荒.txt")).toBe(30000)
    expect(extractImportedChapterNumber("第万章 洪荒.txt")).toBe(10000)
    // 零 normalizes away -> parseChineseInteger returns 0 -> rejected
    expect(extractImportedChapterNumber("第零章 起.txt")).toBeNull()
    // 第0章 rejected by the <=0 guard
    expect(extractImportedChapterNumber("第0章.txt")).toBeNull()
  })

  it("falls through to the english/leading-number matchers when the chapter patterns miss", () => {
    // chapter pattern rejects number 0, english matcher still catches it
    expect(extractImportedChapterNumber("chapter 0.txt")).toBe(0)
    // leading digits without 第/chapter
    expect(extractImportedChapterNumber("001 开局.txt")).toBe(1)
  })

  it("handles empty/extensionless text", () => {
    expect(extractImportedChapterNumber("")).toBeNull()
    expect(extractImportedChapterNumber("番外.txt")).toBeNull()
  })

  it("normalizes full-width digits before matching (第１２章 → 12)", () => {
    expect(extractImportedChapterNumber("第１２章 开幕.txt")).toBe(12)
    expect(extractImportedChapterNumber("chapter ３.txt")).toBe(3)
    expect(extractImportedChapterNumber("０４ 开局.txt")).toBe(4)
  })

  it("sorts two null-numbered candidates by localeCompare", () => {
    const sorted = sortChapterImportCandidates([
      { path: "E:/book/b.txt", name: "b.txt" },
      { path: "E:/book/a.txt", name: "a.txt" },
    ])
    expect(sorted.map((item) => item.name)).toEqual(["a.txt", "b.txt"])
  })
})

describe("chapter import candidate filtering and title derivation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("skips hidden nodes and dirs without children during folder collection", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: ".hidden.md", path: "E:/book/.hidden.md", is_dir: false },
      { name: "chapter-001.md", path: "E:/book/chapter-001.md", is_dir: false },
      { name: "emptydir", path: "E:/book/emptydir", is_dir: true },
      { name: "sub", path: "E:/book/sub", is_dir: true, children: [{ name: "chapter-002.md", path: "E:/book/sub/chapter-002.md", is_dir: false }] },
    ])
    const candidates = await collectChapterImportCandidatesFromFolder("E:/book")
    expect(candidates.map((c) => c.path)).toEqual(["E:/book/chapter-001.md", "E:/book/sub/chapter-002.md"])
  })

  it("filters hidden files and extensionless files out of direct imports", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async (path: string) => `正文 ${path}`)
    const imported = await importChapterFiles("E:/Novel", ["E:/book/.hidden.md", "E:/book/README", "E:/book/正文.txt"], { finalForMemoryExtraction: false })
    expect(imported).toHaveLength(1)
    expect(imported[0]!.sourcePath).toBe("E:/book/正文.txt")
  })

  it("derives a bare 第N章 title when the file name carries no suffix", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async (path: string) => `正文 ${path}`)
    const imported = await importChapterFiles("E:/Novel", ["E:/book/chapter-002.md"], { finalForMemoryExtraction: true })
    expect(imported[0]!.title).toBe("第2章")
    expect(imported[0]!.path).toBe("E:/Novel/wiki/chapters/chapter-002.md")
    expect(String(fsMocks.writeFile.mock.calls[0]![1])).toContain("# 第2章")
  })

  it("derives the title suffix via stripChapterPrefix when the name has no chapter pattern", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async (path: string) => `正文 ${path}`)
    const imported = await importChapterFiles("E:/Novel", ["E:/book/前言.txt"], { finalForMemoryExtraction: false })
    expect(imported[0]!.title).toBe("第1章 前言")
    expect(imported[0]!.path).toBe("E:/Novel/wiki/chapters/chapter-001-前言.md")
  })

  it("suffixes the target file with -2 when the first path already exists", async () => {
    fsMocks.fileExists.mockImplementation(async (path: string) => path.includes("chapter-001-前言.md"))
    fsMocks.readFile.mockImplementation(async (path: string) => `正文 ${path}`)
    const imported = await importChapterFiles("E:/Novel", ["E:/book/前言.txt"], { finalForMemoryExtraction: false })
    expect(imported[0]!.path).toBe("E:/Novel/wiki/chapters/chapter-001-前言-2.md")
  })

  it("falls back to a Date.now-suffixed path when every numbered variant exists", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockImplementation(async (path: string) => `正文 ${path}`)
    const imported = await importChapterFiles("E:/Novel", ["E:/book/前言.txt"], { finalForMemoryExtraction: false })
    expect(imported[0]!.path).toMatch(/chapter-001-前言-\d+\.md$/)
  })

  it("records failures for unreadable chapter files and continues", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("坏文件")) throw new Error("read denied")
      return `正文 ${path}`
    })
    const imported = await importChapterFiles("E:/Novel", ["E:/book/坏文件.txt", "E:/book/好文件.txt"], { finalForMemoryExtraction: false })
    expect(imported).toHaveLength(1)
    expect(imported[0]!.sourcePath).toBe("E:/book/好文件.txt")
  })

  it("records non-Error failures with String(error) formatting", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("坏文件")) throw "string failure"
      return `正文 ${path}`
    })
    const imported = await importChapterFiles("E:/Novel", ["E:/book/坏文件.txt", "E:/book/好文件.txt"], { finalForMemoryExtraction: false })
    expect(imported).toHaveLength(1)
    expect(imported[0]!.sourcePath).toBe("E:/book/好文件.txt")
  })

  it("imports every importable file found in a selected folder via importChapterFolder", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "chapter-002.md", path: "E:/book/chapter-002.md", is_dir: false },
      { name: "notes.tmp", path: "E:/book/notes.tmp", is_dir: false },
    ])
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async (path: string) => `正文 ${path}`)

    const imported = await importChapterFolder("E:/Novel", "E:\\book", { finalForMemoryExtraction: false })

    expect(fsMocks.listDirectory).toHaveBeenCalledWith("E:/book")
    expect(imported.map((item) => item.path)).toEqual(["E:/Novel/wiki/chapters/chapter-002.md"])
    const written = fsMocks.writeFile.mock.calls.map(([path]) => path)
    expect(written).toEqual(["E:/Novel/wiki/chapters/chapter-002.md"])
  })

  it("continues importing when the chapters directory cannot be created", async () => {
    fsMocks.createDirectory.mockRejectedValueOnce(new Error("mkdir denied"))
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async (path: string) => `正文 ${path}`)

    const imported = await importChapterFiles("E:/Novel", ["E:/book/正文.txt"], { finalForMemoryExtraction: false })

    expect(imported).toHaveLength(1)
    expect(imported[0]!.sourcePath).toBe("E:/book/正文.txt")
  })
})

describe("runImportedChapterMemoryExtraction failure paths", () => {
  it("counts snapshot-less results as failed with failReason message", async () => {
    const result = await runImportedChapterMemoryExtraction({
      projectPath: "E:/Novel",
      chapterPaths: ["E:/Novel/wiki/chapters/chapter-001.md"],
      ingestChapter: vi.fn(async (): Promise<IngestResult> => ({ snapshot: null, failReason: "no_llm" } as IngestResult)),
    })
    expect(result).toMatchObject({ completed: 0, failed: 1, cancelled: false })
    expect(result.errors[0]).toContain("no_llm")
  })

  it("counts snapshot-less results with a generic 提取失败 message", async () => {
    const result = await runImportedChapterMemoryExtraction({
      projectPath: "E:/Novel",
      chapterPaths: ["E:/Novel/wiki/chapters/chapter-001.md"],
      ingestChapter: vi.fn(async () => ({ snapshot: null })),
    })
    expect(result.errors[0]).toContain("提取失败")
  })

  it("pending/partial 未核验 → 计为 pending/partial，不误报失败", async () => {
    const pending = importedMemoryFixture(1, `${IMPORT_PROJECT}/wiki/chapters/a.md`)
    const partial = importedMemoryFixture(2, `${IMPORT_PROJECT}/wiki/chapters/b.md`)
    const allFiles = new Map([...pending.files, ...partial.files])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const found = allFiles.get(path)
      if (found === undefined) throw new Error(`ENOENT: ${path}`)
      return found
    })
    const ingestChapter = vi.fn<() => Promise<IngestResult>>()
      .mockResolvedValueOnce({ ...pending.result, pendingProjections: ["community_summary"] })
      .mockResolvedValueOnce({ ...partial.result, failedProjections: ["graph_entity_pages"] })
    const result = await runImportedChapterMemoryExtraction({
      projectPath: IMPORT_PROJECT,
      chapterPaths: [`${IMPORT_PROJECT}/wiki/chapters/a.md`, `${IMPORT_PROJECT}/wiki/chapters/b.md`],
      ingestChapter,
    })
    expect(result).toMatchObject({ completed: 0, pending: 1, partial: 1, failed: 0, cancelled: false, errors: [] })
  })

  it("ingest 返回 failReason cancelled + 已 abort → 不记失败且不再启动下一章", async () => {
    const abortController = new AbortController()
    const ingestChapter = vi.fn(async (): Promise<IngestResult> => {
      abortController.abort()
      return { snapshot: null, failReason: "cancelled" } as IngestResult
    })
    const result = await runImportedChapterMemoryExtraction({
      projectPath: "E:/Novel",
      chapterPaths: ["E:/Novel/wiki/chapters/a.md", "E:/Novel/wiki/chapters/b.md"],
      signal: abortController.signal,
      ingestChapter,
    })
    expect(ingestChapter).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ completed: 0, pending: 0, partial: 0, failed: 0, cancelled: true, errors: [] })
  })

  it("records thrown Error and non-Error failures", async () => {
    const result = await runImportedChapterMemoryExtraction({
      projectPath: "E:/Novel",
      chapterPaths: ["E:/Novel/wiki/chapters/a.md", "E:/Novel/wiki/chapters/b.md"],
      ingestChapter: vi.fn(async (_pp: string, path: string) => {
        if (path.endsWith("a.md")) throw new Error("boom")
        throw "string failure"
      }),
    })
    expect(result).toMatchObject({ completed: 0, failed: 2 })
    expect(result.errors[0]).toContain("boom")
    expect(result.errors[1]).toContain("string failure")
  })
})

describe("导入即副本幂等（R2）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.createDirectory.mockResolvedValue(undefined)
  })
  it("同内容重入命中指纹→复用路径不复写", async () => {
    const body = "正文内容"
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.readFile.mockImplementation(async (p: string) => (String(p).startsWith("E:/book") ? body : ""))
    const first = await importChapterFiles("E:/Novel", ["E:/book/第1章.txt"], { finalForMemoryExtraction: false })
    expect(first).toHaveLength(1)
    const writes1 = fsMocks.writeFile.mock.calls.length
    expect(writes1).toBe(1)
    const writtenContent = String(fsMocks.writeFile.mock.calls[0][1])
    const fp = extractImportFingerprint(writtenContent)
    expect(fp).toBe(buildImportFingerprint("E:/book/第1章.txt", body))
    // 第二次：首选路径存在且指纹一致 → 跳过写盘
    vi.clearAllMocks()
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.readFile.mockImplementation(async (p: string) => (String(p).startsWith("E:/book") ? body : writtenContent))
    const second = await importChapterFiles("E:/Novel", ["E:/book/第1章.txt"], { finalForMemoryExtraction: false })
    expect(second).toHaveLength(1)
    expect(second[0].path).toBe(first[0].path)
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
  })
  it("内容变化→指纹不一致→正常落盘", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    const oldDoc = ["---", "import_source_fingerprint: fnv1a-old", "---"].join(String.fromCharCode(10))
    fsMocks.readFile.mockImplementation(async (p: string) => (String(p).startsWith("E:/book") ? "新正文" : oldDoc))
    await importChapterFiles("E:/Novel", ["E:/book/第1章.txt"], { finalForMemoryExtraction: false })
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
  })
})

describe("导入即副本幂等：探测/读盘失败时降级（不误判为已存在）", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.createDirectory.mockResolvedValue(undefined)
  })

  it("fileExists 对某个 -N 变体抛错 → 跳过该变体继续探测，最终仍正常落盘", async () => {
    fsMocks.readFile.mockImplementation(async (p: string) =>
      String(p).startsWith("E:/book") ? "正文内容" : "")
    fsMocks.fileExists.mockImplementation(async (p: string) => {
      if (String(p).endsWith("chapter-001-前言-1.md")) throw new Error("EBUSY: stat failed")
      return false
    })

    const imported = await importChapterFiles("E:/Novel", ["E:/book/第1章 前言.txt"], {
      finalForMemoryExtraction: false,
    })

    expect(imported).toHaveLength(1)
    expect(imported[0].path).toBe("E:/Novel/wiki/chapters/chapter-001-前言.md")
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
  })

  it("既有副本读不出来（EACCES）→ 不认定指纹命中，改写到下一个可用 -N 路径", async () => {
    const body = "正文内容"
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (String(p).startsWith("E:/book")) return body
      throw new Error("EACCES: permission denied")
    })
    fsMocks.fileExists.mockImplementation(
      async (p: string) => String(p).endsWith("chapter-001-前言.md"),
    )

    const imported = await importChapterFiles("E:/Novel", ["E:/book/第1章 前言.txt"], {
      finalForMemoryExtraction: false,
    })

    expect(imported).toHaveLength(1)
    // 既有 chapter-001-前言.md 不可读 → 不能复用它（会丢正文），改落 -2 副本
    expect(imported[0].path).toBe("E:/Novel/wiki/chapters/chapter-001-前言-2.md")
    expect(fsMocks.writeFile).toHaveBeenCalledTimes(1)
    expect(String(fsMocks.writeFile.mock.calls[0][1])).toContain("正文内容")
  })
})

describe("P1-03 整本 TXT 拆章预览与导入（previewWholeTxtChapters / importWholeTxtNovel）", () => {
  const sampleBook = [
    "\uFEFF第一章：雾起长街",
    "林深推开门。",
    "",
    "第二章 暗潮",
    "雨声渐急。",
    "",
    "第3章 破晓",
    "东方泛白。",
  ].join("\r\n")

  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.createDirectory.mockResolvedValue(undefined)
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.listDirectory.mockResolvedValue([])
    fsMocks.writeFileAtomic.mockResolvedValue(undefined)
  })

  it("previewWholeTxtChapters 纯读零写盘，统计总字数并提示重复章号告警", async () => {
    const dupBook = "第1章 开局\n正文甲\n\n第1章 重复章\n正文乙"
    const preview = await previewWholeTxtChapters("E:/books/dup.txt", { rawText: dupBook })

    expect(preview.chapters).toHaveLength(2)
    expect(preview.totalWords).toBe("正文甲".length + "正文乙".length)
    expect(preview.warnings.some((w) => w.includes("重复章号") && w.includes("1"))).toBe(true)
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
    expect(fsMocks.createDirectory).not.toHaveBeenCalled()
  })

  it("importWholeTxtNovel 默认 auto-offset 顺延冲突章号，走 writeFileAtomic 且绝不自动入库", async () => {
    // 既有第 1、2 章存在 → 导入书的第 1、2 章顺延为 4、5（第 3 章无冲突保留为 3，或按空闲位分配）
    fsMocks.listDirectory.mockResolvedValue([
      { name: "chapter-001.md", path: "E:/Novel/wiki/chapters/chapter-001.md", is_dir: false },
      { name: "chapter-002.md", path: "E:/Novel/wiki/chapters/chapter-002.md", is_dir: false },
    ])
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("chapter-001.md")) return "---\nchapter_number: 1\nchapter_status: final\n---\n旧一"
      if (p.endsWith("chapter-002.md")) return "---\nchapter_number: 2\nchapter_status: final\n---\n旧二"
      return sampleBook
    })
    const onProgress = vi.fn()

    const result = await importWholeTxtNovel("E:/Novel", "E:/books/whole.txt", {
      finalForMemoryExtraction: false,
      onProgress,
    })

    expect(result.detectedCount).toBe(3)
    expect(result.skippedCount).toBe(0)
    // 既有 1/2 占坑 → 原 1→3、原 2→4，顺延后 3 也被占 → 原 3→5（共 3 章重映射）
    expect(result.remappedCount).toBe(3)
    expect(result.imported.map((c) => c.chapterNumber)).toEqual([3, 4, 5])
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(3)
    expect(fsMocks.writeFile).not.toHaveBeenCalled()
    expect(String(fsMocks.writeFileAtomic.mock.calls[0]![1])).toContain("chapter_status: draft")
    expect(String(fsMocks.writeFileAtomic.mock.calls[0]![1])).toContain("import_source_fingerprint:")
    expect(onProgress).toHaveBeenCalledWith(3, 3)

    // 局部冲突场景：既有 1/2，导入第 1 章与第 5 章 → 仅第 1 章顺延至 3，第 5 章保持原号
    const partial = await importWholeTxtNovel("E:/Novel", "E:/books/partial.txt", {
      rawText: "第1章 冲突\n正文甲\n\n第5章 保留\n正文乙",
    })
    expect(partial.imported.map((c) => c.chapterNumber)).toEqual([3, 5])
    expect(partial.remappedCount).toBe(1)
  })

  it("importWholeTxtNovel 支持 append-after-max / keep-detected / startChapterNumber / finalForMemoryExtraction", async () => {
    fsMocks.listDirectory.mockResolvedValue([
      { name: "chapter-001.md", path: "E:/Novel/wiki/chapters/chapter-001.md", is_dir: false },
      { name: "chapter-002.md", path: "E:/Novel/wiki/chapters/chapter-002.md", is_dir: false },
    ])
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("chapter-001.md")) return "---\nchapter_number: 1\n---\n旧一"
      if (p.endsWith("chapter-002.md")) return "---\nchapter_number: 2\n---\n旧二"
      return ""
    })

    const appended = await importWholeTxtNovel("E:/Novel", "E:/books/whole.txt", {
      rawText: sampleBook,
      conflictStrategy: "append-after-max",
      finalForMemoryExtraction: true,
    })
    expect(appended.imported.map((c) => c.chapterNumber)).toEqual([3, 4, 5])
    expect(appended.remappedCount).toBe(3)
    expect(String(fsMocks.writeFileAtomic.mock.calls[0]![1])).toContain("chapter_status: final")

    fsMocks.writeFileAtomic.mockClear()
    const kept = await importWholeTxtNovel("E:/Novel", "E:/books/whole.txt", {
      rawText: sampleBook,
      conflictStrategy: "keep-detected",
    })
    expect(kept.skippedCount).toBe(2)
    expect(kept.imported.map((c) => c.chapterNumber)).toEqual([3])
    expect(kept.warnings.some((w) => w.includes("跳过冲突章号"))).toBe(true)

    fsMocks.writeFileAtomic.mockClear()
    const started = await importWholeTxtNovel("E:/Novel", "E:/books/whole.txt", {
      rawText: sampleBook,
      startChapterNumber: 10,
    })
    expect(started.imported.map((c) => c.chapterNumber)).toEqual([10, 11, 12])
  })

  it("importWholeTxtNovel 响应 AbortSignal 中途取消", async () => {
    const controller = new AbortController()
    fsMocks.writeFileAtomic.mockImplementationOnce(async () => {
      controller.abort()
    })

    const result = await importWholeTxtNovel("E:/Novel", "E:/books/whole.txt", {
      rawText: sampleBook,
      signal: controller.signal,
    })

    expect(result.imported).toHaveLength(1)
    expect(result.warnings).toContain("整本导入已取消")
  })

  it("R3-3B-MAINT-001: importWholeTxtNovel 成功落盘章节后主动失效 chapter cache，避免程序化调用读到过期章号", async () => {
    invalidateChapterCache("E:/Novel")
    let diskChapters = [
      { name: "chapter-001.md", path: "E:/Novel/wiki/chapters/chapter-001.md", is_dir: false },
    ]
    fsMocks.listDirectory.mockImplementation(async () => diskChapters)
    fsMocks.readFile.mockImplementation(async (p: string) => {
      if (p.endsWith("chapter-001.md")) return "---\nchapter_number: 1\n---\n旧一"
      if (p.endsWith("chapter-002-新章.md")) return "---\nchapter_number: 2\n---\n新正文"
      return ""
    })
    fsMocks.writeFileAtomic.mockImplementation(async (p: string) => {
      const name = p.split("/").pop() ?? "chapter-002.md"
      diskChapters = [...diskChapters, { name, path: p, is_dir: false }]
    })

    // 首次读取写入 chapter cache（当前最大章号 1 → 下一章 2）
    expect(await getNextChapterNumber("E:/Novel")).toBe(2)
    expect(fsMocks.listDirectory).toHaveBeenCalledTimes(1)
    // 命中缓存不再触发 listDirectory
    expect(await getNextChapterNumber("E:/Novel")).toBe(2)
    expect(fsMocks.listDirectory).toHaveBeenCalledTimes(1)

    // 导入新章 → 应自动调用 invalidateChapterCache
    const res = await importWholeTxtNovel("E:/Novel", "E:/books/one.txt", {
      rawText: "第2章 新章\n新正文",
    })
    expect(res.imported).toHaveLength(1)

    // 导入后再次查询章节号：因缓存已失效，重新枚举并返回 3（而非过期缓存值 2）
    expect(await getNextChapterNumber("E:/Novel")).toBe(3)
  })
})

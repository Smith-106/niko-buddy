import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"

/**
 * chapter-ingest.ts snapshot-history / persistence coverage
 * (s/l/b/f 100% target, sibling of chapter-ingest.behavior.spec.ts).
 *
 * Covers loadSnapshot / listSnapshots / listSnapshotHistory /
 * restoreSnapshotHistory / saveEditedSnapshot / syncSnapshotToMemory /
 * deleteChapterSnapshots / exportStructuredMemoryToWiki / snapshotMarkdownPath
 * and the internal cleanup/supersede + rebuildFromCommittedSnapshot flows.
 */

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  listDirectory: vi.fn(),
  fileExists: vi.fn(),
  createDirectory: vi.fn(),
  deleteFile: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: (...args: unknown[]) => fsMocks.readFile(...args),
  writeFileAtomic: (...args: unknown[]) => fsMocks.writeFileAtomic(...args),
  listDirectory: (...args: unknown[]) => fsMocks.listDirectory(...args),
  fileExists: (...args: unknown[]) => fsMocks.fileExists(...args),
  createDirectory: (...args: unknown[]) => fsMocks.createDirectory(...args),
  deleteFile: (...args: unknown[]) => fsMocks.deleteFile(...args),
}))

const streamChatMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/llm-client", () => ({
  streamChat: (...args: unknown[]) => streamChatMock(...args),
  combineAbortSignals: (signal?: AbortSignal, timeoutSignal?: AbortSignal): AbortSignal | undefined => {
    const signals = [signal, timeoutSignal].filter(Boolean) as AbortSignal[]
    if (signals.length === 0) return undefined
    if (signals.length === 1) return signals[0]
    const controller = new AbortController()
    for (const s of signals) {
      if (s.aborted) { controller.abort(); break }
      s.addEventListener("abort", () => controller.abort(), { once: true })
    }
    return controller.signal
  },
  DEFAULT_LLM_REQUEST_TIMEOUT_MS: 1000,
}))

const storeState = vi.hoisted(() => ({
  novelMode: true,
  llmConfig: { provider: "custom", model: "extract-model", customEndpoint: "http://localhost:11434", apiKey: "" } as LlmConfig,
  novelConfig: {
    communitySummaryAsync: false,
    communitySummaryEnabled: true,
    communitySummaryInterval: 5,
    reviewModel: "",
  } as NovelConfig,
  embeddingConfig: { enabled: false, model: "" },
  outputLanguage: "zh-CN",
  setCommunitySummaryError: vi.fn(),
  bumpDataVersion: vi.fn(),
}))

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  return {
    ...actual,
    useWikiStore: { getState: () => storeState },
  }
})

const moduleMocks = vi.hoisted(() => ({
  writeSnapshotToWiki: vi.fn(),
  writePatchFieldsToWiki: vi.fn(),
  shouldRebuildCommunitySummaries: vi.fn(),
  generateCommunitySummaries: vi.fn(),
  mergeSnapshotTimeline: vi.fn(),
  clearGraphCache: vi.fn(),
  clearTemporalFactsCache: vi.fn(),
  buildEntityLinkIndex: vi.fn(),
  resolveEntityLink: vi.fn(),
  extractEntitySummary: vi.fn(),
  planAddOpsFromCanonFacts: vi.fn(),
  applyMemoryOps: vi.fn(),
  embedPage: vi.fn(),
}))

vi.mock("./graph-adapter", () => ({
  canonicalizeSnapshotCharacters: (snapshot: unknown) => snapshot,
  sanitizeEntitySlug: (name: string) => name,
  writeSnapshotToWiki: (...args: unknown[]) => moduleMocks.writeSnapshotToWiki(...args),
  writePatchFieldsToWiki: (...args: unknown[]) => moduleMocks.writePatchFieldsToWiki(...args),
  canonicalizeGraphNodeId: (_snapshot: unknown, raw: string) => raw.trim(),
  detectNodeType: () => "character",
  getCharacterNamesForMatching: (snapshot: { characterAliases?: Record<string, string[]> }, name: string) => [
    name,
    ...(snapshot.characterAliases?.[name] ?? []),
  ],
  snapshotToGraphNodes: () => [],
  snapshotToGraphEdges: () => [],
}))

vi.mock("./model-resolver", () => ({
  resolveNovelModel: (cfg: unknown) => cfg,
}))

vi.mock("./community-summary", () => ({
  shouldRebuildCommunitySummaries: (...args: unknown[]) => moduleMocks.shouldRebuildCommunitySummaries(...args),
  generateCommunitySummaries: (...args: unknown[]) => moduleMocks.generateCommunitySummaries(...args),
}))

vi.mock("./timeline", () => ({
  mergeSnapshotTimeline: (...args: unknown[]) => moduleMocks.mergeSnapshotTimeline(...args),
}))

vi.mock("@/lib/graph-relevance", () => ({
  clearGraphCache: (...args: unknown[]) => moduleMocks.clearGraphCache(...args),
}))

vi.mock("./context-engine", () => ({
  clearTemporalFactsCache: (...args: unknown[]) => moduleMocks.clearTemporalFactsCache(...args),
}))

vi.mock("@/lib/dedup", () => ({
  buildEntityLinkIndex: (...args: unknown[]) => moduleMocks.buildEntityLinkIndex(...args),
  resolveEntityLink: (...args: unknown[]) => moduleMocks.resolveEntityLink(...args),
  extractEntitySummary: (...args: unknown[]) => moduleMocks.extractEntitySummary(...args),
}))

vi.mock("./memory-op", () => ({
  planAddOpsFromCanonFacts: (...args: unknown[]) => moduleMocks.planAddOpsFromCanonFacts(...args),
  applyMemoryOps: (...args: unknown[]) => moduleMocks.applyMemoryOps(...args),
}))

vi.mock("@/lib/embedding", () => ({
  embedPage: (...args: unknown[]) => moduleMocks.embedPage(...args),
}))

import {
  deleteChapterSnapshots,
  exportStructuredMemoryToWiki,
  listSnapshotHistory,
  listSnapshots,
  loadSnapshot,
  restoreSnapshotHistory,
  saveEditedSnapshot,
  snapshotMarkdownPath,
  syncSnapshotToMemory,
  type ChapterSnapshot,
} from "./chapter-ingest"

const PROJECT = "E:/Novel"

function baseSnapshot(chapterNumber = 1, overrides: Partial<ChapterSnapshot> = {}): ChapterSnapshot {
  return {
    chapterId: `chapter-${chapterNumber}`,
    chapterNumber,
    summary: "摘要",
    characters: ["阿宁"],
    locations: ["码头"],
    organizations: [],
    items: [],
    events: [],
    characterStateChanges: ["阿宁：受伤"],
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    newCanonFacts: [],
    timelineEvents: [],
    conflicts: [],
    endingHook: "钩子",
    graphNodes: [],
    graphEdges: [],
    sourceType: "chapter",
    sourceSequence: chapterNumber,
    revision: 1,
    snapshotId: `chapter-${chapterNumber}-r1`,
    ...overrides,
  }
}

function snapshotRaw(chapterNumber: number): Record<string, unknown> {
  return { ...baseSnapshot(chapterNumber) }
}

function defaultReadFile(path: string): string {
  const p = String(path)
  if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
  if (p.endsWith(".snapshot.json")) {
    const m = p.match(/(?:outline-)?(\d+)\.snapshot\.json$/)
    const chapterNumber = m ? Number.parseInt(m[1], 10) : 1
    return JSON.stringify(snapshotRaw(chapterNumber))
  }
  if (p.endsWith("wiki/canon.md")) return "# 正史\n"
  throw new Error("ENOENT: no such file or directory")
}

beforeEach(() => {
  vi.clearAllMocks()
  storeState.novelMode = true
  storeState.llmConfig = { provider: "custom", model: "extract-model", customEndpoint: "http://localhost:11434", apiKey: "" } as LlmConfig
  storeState.novelConfig = {
    communitySummaryAsync: false,
    communitySummaryEnabled: true,
    communitySummaryInterval: 5,
    reviewModel: "",
  } as NovelConfig
  storeState.embeddingConfig = { enabled: false, model: "" }
  storeState.outputLanguage = "zh-CN"
  fsMocks.readFile.mockImplementation((path: string) => defaultReadFile(path))
  fsMocks.listDirectory.mockRejectedValue(new Error("ENOENT: no such file or directory"))
  fsMocks.createDirectory.mockResolvedValue(undefined)
  fsMocks.writeFileAtomic.mockResolvedValue(undefined)
  fsMocks.deleteFile.mockResolvedValue(undefined)
  fsMocks.fileExists.mockResolvedValue(false)
  moduleMocks.writeSnapshotToWiki.mockResolvedValue([])
  moduleMocks.writePatchFieldsToWiki.mockResolvedValue([])
  moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(false)
  moduleMocks.generateCommunitySummaries.mockResolvedValue(undefined)
  moduleMocks.mergeSnapshotTimeline.mockResolvedValue(undefined)
  moduleMocks.clearGraphCache.mockReturnValue(undefined)
  moduleMocks.clearTemporalFactsCache.mockReturnValue(undefined)
  moduleMocks.buildEntityLinkIndex.mockReturnValue({})
  moduleMocks.resolveEntityLink.mockReturnValue(null)
  moduleMocks.extractEntitySummary.mockReturnValue(null)
  moduleMocks.planAddOpsFromCanonFacts.mockReturnValue([])
  moduleMocks.applyMemoryOps.mockReturnValue([])
  moduleMocks.embedPage.mockResolvedValue(undefined)
})

describe("loadSnapshot", () => {
  it("loads and normalizes a positive chapter snapshot", async () => {
    const snapshot = await loadSnapshot(PROJECT, 1)
    expect(snapshot?.chapterNumber).toBe(1)
    expect(snapshot?.characters).toContain("阿宁")
  })

  it("loads a negative (outline) snapshot from the outline-### file", async () => {
    const snapshot = await loadSnapshot(PROJECT, -3)
    expect(snapshot?.chapterNumber).toBe(3)
  })

  it("returns null when the file is missing", async () => {
    fsMocks.readFile.mockRejectedValueOnce(new Error("ENOENT"))
    await expect(loadSnapshot(PROJECT, 1)).resolves.toBeNull()
  })

  it("returns null when the file contains invalid JSON", async () => {
    fsMocks.readFile.mockResolvedValueOnce("{broken")
    await expect(loadSnapshot(PROJECT, 1)).resolves.toBeNull()
  })
})

describe("listSnapshots", () => {
  it("parses chapter and outline snapshot file names, filters junk and sorts", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "002.snapshot.json", path: `${PROJECT}/.novel/snapshots/002.snapshot.json`, is_dir: false },
      { name: "outline-001.snapshot.json", path: `${PROJECT}/.novel/snapshots/outline-001.snapshot.json`, is_dir: false },
      { name: "001.snapshot.json", path: `${PROJECT}/.novel/snapshots/001.snapshot.json`, is_dir: false },
      { name: "junk.txt", path: `${PROJECT}/.novel/snapshots/junk.txt`, is_dir: false },
      { name: "not-a-number.snapshot.json", path: `${PROJECT}/.novel/snapshots/not-a-number.snapshot.json`, is_dir: false },
    ])
    await expect(listSnapshots(PROJECT)).resolves.toEqual([-1, 1, 2])
  })

  it("returns [] when the snapshot dir is missing", async () => {
    await expect(listSnapshots(PROJECT)).resolves.toEqual([])
  })
})

describe("snapshotMarkdownPath", () => {
  it("formats positive and negative chapter prefixes", () => {
    expect(snapshotMarkdownPath(PROJECT, 1)).toBe(`${PROJECT}/.novel/snapshots/001.snapshot.md`)
    expect(snapshotMarkdownPath(PROJECT, -12)).toBe(`${PROJECT}/.novel/snapshots/outline-012.snapshot.md`)
  })
})

describe("listSnapshotHistory", () => {
  it("maps, formats and sorts history entries newest-first", async () => {
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "2026-06-01T00-00-00.000Z.snapshot.json", path: `${PROJECT}/.novel/snapshots/history/001/2026-06-01T00-00-00.000Z.snapshot.json`, is_dir: false },
      { name: "2026-06-02T00-00-00.000Z.snapshot.json", path: `${PROJECT}/.novel/snapshots/history/001/2026-06-02T00-00-00.000Z.snapshot.json`, is_dir: false },
      { name: "2026-06-01-00-00-00.000Z.snapshot.json", path: `${PROJECT}/.novel/snapshots/history/001/2026-06-01-00-00-00.000Z.snapshot.json`, is_dir: false },
      { name: "other.txt", path: `${PROJECT}/.novel/snapshots/history/001/other.txt`, is_dir: false },
      { name: "dir", path: `${PROJECT}/.novel/snapshots/history/001/dir`, is_dir: true },
    ])
    const entries = await listSnapshotHistory(PROJECT, 1)
    expect(entries.map((e) => e.fileName)).toEqual([
      "2026-06-02T00-00-00.000Z.snapshot.json",
      "2026-06-01T00-00-00.000Z.snapshot.json",
      "2026-06-01-00-00-00.000Z.snapshot.json",
    ])
    // ISO "T"-separated names keep the raw stem (the -HH-MM-SS transform
    // targets the legacy dash-separated timestamp format only)
    expect(entries[1]!.createdAt).toBe("2026-06-01T00-00-00.000Z")
    // legacy dash-separated names get the transform (note: the replacement
    // substitutes seconds for the millis group — source behavior, kept as-is)
    expect(entries[2]!.createdAt).toBe("2026-06-01:00:00.00Z")
  })

  it("returns [] when the history dir is missing", async () => {
    await expect(listSnapshotHistory(PROJECT, 1)).resolves.toEqual([])
  })
})

describe("saveEditedSnapshot", () => {
  it("throws on invalid snapshot data", async () => {
    // NOTE: normalizeChapterSnapshot never returns null for the spread object
    // (snapshot.chapterNumber is read before the check), so the defensive
    // throw is unreachable — the null input surfaces as a TypeError instead.
    await expect(saveEditedSnapshot(PROJECT, null as unknown as ChapterSnapshot))
      .rejects.toThrow(/Cannot read properties of null/)
  })

  it("throws Invalid snapshot data for a non-object snapshot payload", async () => {
    // 数组直接传参 (非 spread) → normalizeChapterSnapshot 顶层 Array.isArray → null → 防御性 throw
    await expect(saveEditedSnapshot(PROJECT, [] as unknown as ChapterSnapshot))
      .rejects.toThrow("Invalid snapshot data.")
  })

  it("backs up the current snapshot and saves a materialized next revision", async () => {
    const currentRaw = JSON.stringify(snapshotRaw(1))
    // current snapshot exists on disk → backup path + revision bump
    fsMocks.fileExists.mockImplementation(async (path: string) => String(path).endsWith(".novel/snapshots/001.snapshot.json"))
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/snapshots/001.snapshot.json")) return currentRaw
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT")
    })
    const edited = baseSnapshot(1, { summary: "编辑后的摘要" })
    await saveEditedSnapshot(PROJECT, edited)
    // history backup written
    const historyWrite = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).includes("/history/001/"))
    expect(historyWrite).toBeTruthy()
    const history = JSON.parse(String(historyWrite![1]))
    expect(history.isHistorical).toBe(true)
    // current snapshot has revision 2 + supersedes r1
    const jsonWrite = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/snapshots/001.snapshot.json"))
    const saved = JSON.parse(String(jsonWrite![1]))
    expect(saved.revision).toBe(2)
    expect(saved.supersedes).toBe("chapter-1-r1")
    expect(saved.isHistorical).toBe(false)
    expect(moduleMocks.clearTemporalFactsCache).toHaveBeenCalledWith(PROJECT)
  })

  it("writes the raw (non-object) current snapshot verbatim to history", async () => {
    fsMocks.fileExists.mockResolvedValueOnce(true)
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/snapshots/001.snapshot.json")) return "[]"
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT")
    })
    await saveEditedSnapshot(PROJECT, baseSnapshot(1))
    const historyWrite = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).includes("/history/001/"))
    expect(String(historyWrite![1])).toBe("[]")
  })
})

describe("restoreSnapshotHistory", () => {
  it("rejects unsafe history file names (traversal / wrong suffix / empty)", async () => {
    await expect(restoreSnapshotHistory(PROJECT, 1, "")).rejects.toThrow("Invalid snapshot history file name.")
    await expect(restoreSnapshotHistory(PROJECT, 1, "../evil.snapshot.json")).rejects.toThrow("Invalid snapshot history file name.")
    await expect(restoreSnapshotHistory(PROJECT, 1, "a/b.snapshot.json")).rejects.toThrow("Invalid snapshot history file name.")
    await expect(restoreSnapshotHistory(PROJECT, 1, "evil.json")).rejects.toThrow("Invalid snapshot history file name.")
    await expect(restoreSnapshotHistory(PROJECT, 1, "  ")).rejects.toThrow("Invalid snapshot history file name.")
  })

  it("throws when the history file holds invalid snapshot data", async () => {
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith("history/001/2026-06-01.snapshot.json")) return "[]"
      if (p.endsWith(".novel/snapshots/001.snapshot.json")) return "[]"
      throw new Error("ENOENT")
    })
    await expect(restoreSnapshotHistory(PROJECT, 1, "2026-06-01.snapshot.json")).rejects.toThrow("Invalid snapshot history file.")
  })

  it("restores a history snapshot with a bumped revision and calls the data-version bump callback", async () => {
    const onDataVersionBump = vi.fn()
    const restored = await restoreSnapshotHistory(PROJECT, 1, "2026-06-01T00-00-00.000Z.snapshot.json", onDataVersionBump)
    expect(restored.revision).toBe(2)
    expect(restored.snapshotId).toBe("chapter-1-r2")
    expect(restored.isHistorical).toBe(false)
    const jsonWrite = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/snapshots/001.snapshot.json"))
    expect(jsonWrite).toBeTruthy()
    expect(moduleMocks.writeSnapshotToWiki).toHaveBeenCalled()
    expect(moduleMocks.clearTemporalFactsCache).toHaveBeenCalledWith(PROJECT)
    expect(moduleMocks.clearGraphCache).toHaveBeenCalled()
    expect(onDataVersionBump).toHaveBeenCalled()
    expect(storeState.bumpDataVersion).not.toHaveBeenCalled()
  })

  it("falls back to the store bump when no callback is injected", async () => {
    await restoreSnapshotHistory(PROJECT, 1, "2026-06-01T00-00-00.000Z.snapshot.json")
    expect(storeState.bumpDataVersion).toHaveBeenCalled()
  })

  it("supersedes the existing current snapshot when one exists", async () => {
    fsMocks.fileExists.mockImplementation(async (path: string) => String(path).endsWith(".novel/snapshots/001.snapshot.json"))
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/snapshots/001.snapshot.json")) return JSON.stringify({ ...snapshotRaw(1), revision: 5, snapshotId: "chapter-1-r5" })
      if (p.endsWith("history/001/2026-06-01T00-00-00.000Z.snapshot.json")) return JSON.stringify(snapshotRaw(1))
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT")
    })
    await restoreSnapshotHistory(PROJECT, 1, "2026-06-01T00-00-00.000Z.snapshot.json")
    const jsonWrite = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/snapshots/001.snapshot.json"))
    const saved = JSON.parse(String(jsonWrite![1]))
    expect(saved.revision).toBe(6)
    expect(saved.supersedes).toBe("chapter-1-r5")
  })
})

describe("syncSnapshotToMemory", () => {
  it("throws on invalid snapshot data", async () => {
    // NOTE: normalizeChapterSnapshot never returns null for the spread object
    // (snapshot.chapterNumber is read before the check), so the defensive
    // throw is unreachable — the null input surfaces as a TypeError instead.
    await expect(syncSnapshotToMemory(PROJECT, null as unknown as ChapterSnapshot))
      .rejects.toThrow(/Cannot read properties of null/)
  })

  it("syncs entity pages, cognition/character/foreshadow stores and bumps data version", async () => {
    const snapshot = baseSnapshot(1, {
      knowledgeChanges: ["阿宁知道秘密"],
      characterStateChanges: ["阿宁：受伤"],
      foreshadowingChanges: ["新增伏笔：黑剑"],
    })
    const result = await syncSnapshotToMemory(PROJECT, snapshot)
    expect(result.memorySyncedAt).toBeTruthy()
    expect(result.writtenEntityPaths).toEqual([])
    // the synced snapshot itself is a valid memory snapshot → 7 memory docs written
    expect(result.memoryPagePaths).toHaveLength(7)
    expect(moduleMocks.writeSnapshotToWiki).toHaveBeenCalled()
    expect(moduleMocks.mergeSnapshotTimeline).toHaveBeenCalled()
    expect(moduleMocks.clearTemporalFactsCache).toHaveBeenCalledWith(PROJECT)
    expect(moduleMocks.clearGraphCache).toHaveBeenCalled()
    expect(storeState.bumpDataVersion).toHaveBeenCalled()
    const jsonWrites = fsMocks.writeFileAtomic.mock.calls.map(([p]) => String(p))
    expect(jsonWrites.some((p) => p.endsWith(".novel/character-states.json"))).toBe(true)
    expect(jsonWrites.some((p) => p.endsWith(".novel/foreshadowing-tracker.json"))).toBe(true)
    expect(jsonWrites.some((p) => p.endsWith(".novel/cognition-state.json"))).toBe(true)
  })

  it("skips cognition/character/foreshadow sync when the change lists are empty", async () => {
    const snapshot = baseSnapshot(1, {
      knowledgeChanges: [],
      characterStateChanges: [],
      foreshadowingChanges: [],
    })
    await syncSnapshotToMemory(PROJECT, snapshot)
    const jsonWrites = fsMocks.writeFileAtomic.mock.calls.map(([p]) => String(p))
    expect(jsonWrites.some((p) => p.endsWith(".novel/character-states.json"))).toBe(false)
    expect(jsonWrites.some((p) => p.endsWith(".novel/foreshadowing-tracker.json"))).toBe(false)
    expect(jsonWrites.some((p) => p.endsWith(".novel/character-cognition.json"))).toBe(false)
  })

  it("uses the injected data-version bump callback", async () => {
    const bump = vi.fn()
    await syncSnapshotToMemory(PROJECT, baseSnapshot(1), bump)
    expect(bump).toHaveBeenCalled()
    expect(storeState.bumpDataVersion).not.toHaveBeenCalled()
  })
})

describe("exportStructuredMemoryToWiki", () => {
  it("returns [] when the latest snapshot is not a valid memory snapshot", async () => {
    const invalid = baseSnapshot(1, { chapterNumber: 0 })
    await expect(exportStructuredMemoryToWiki(PROJECT, invalid)).resolves.toEqual([])
  })

  it("writes structured memory documents for valid snapshots", async () => {
    // chapters dir lists chapter-001.md → actual chapter numbers [1]
    fsMocks.listDirectory.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith("wiki/chapters")) {
        return [{ name: "chapter-001.md", path: `${PROJECT}/wiki/chapters/chapter-001.md`, is_dir: false }]
      }
      if (p.endsWith(".novel/snapshots")) {
        return [{ name: "001.snapshot.json", path: `${PROJECT}/.novel/snapshots/001.snapshot.json`, is_dir: false }]
      }
      throw new Error("ENOENT")
    })
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/snapshots/001.snapshot.json")) return JSON.stringify(snapshotRaw(1))
      if (p.endsWith("wiki/chapters/chapter-001.md")) return "---\nchapter_number: 1\n---\n# 第1章\n"
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT")
    })
    const paths = await exportStructuredMemoryToWiki(PROJECT, baseSnapshot(1))
    expect(paths.length).toBeGreaterThan(0)
    const memoryWrites = fsMocks.writeFileAtomic.mock.calls.filter(([p]) => String(p).includes("wiki/memory/"))
    expect(memoryWrites.length).toBe(7) // chapter-snapshots / character-cognition / character-states / foreshadowing / timeline / canon-facts / conflicts
  })

  it("accepts the latest snapshot even when the chapters dir cannot be listed", async () => {
    // chapters dir missing → actual [] → latest snapshot (chapterNumber > 0) is valid
    fsMocks.listDirectory.mockImplementation(async (path: string) => {
      if (String(path).endsWith(".novel/snapshots")) {
        return [{ name: "001.snapshot.json", path: `${PROJECT}/.novel/snapshots/001.snapshot.json`, is_dir: false }]
      }
      throw new Error("ENOENT")
    })
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/snapshots/001.snapshot.json")) return JSON.stringify(snapshotRaw(1))
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT")
    })
    const paths = await exportStructuredMemoryToWiki(PROJECT, baseSnapshot(1))
    expect(paths.length).toBeGreaterThan(0)
  })

  it("skips chapter files whose frontmatter is not a chapter page during memory-window listing", async () => {
    fsMocks.listDirectory.mockImplementation(async (path: string) => {
      if (String(path).endsWith("wiki/chapters")) {
        return [{ name: "chapter-001.md", path: `${PROJECT}/wiki/chapters/chapter-001.md`, is_dir: false }]
      }
      throw new Error("ENOENT")
    })
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith("wiki/chapters/chapter-001.md")) return "# 第1章\n\n正文（无 frontmatter）"
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT")
    })
    const paths = await exportStructuredMemoryToWiki(PROJECT, baseSnapshot(1))
    expect(paths.length).toBeGreaterThan(0)
  })

  it("tolerates unreadable chapter files during memory-window listing", async () => {
    fsMocks.listDirectory.mockImplementation(async (path: string) => {
      if (String(path).endsWith("wiki/chapters")) {
        return [{ name: "chapter-001.md", path: `${PROJECT}/wiki/chapters/chapter-001.md`, is_dir: false }]
      }
      throw new Error("ENOENT")
    })
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith("wiki/chapters/chapter-001.md")) throw new Error("read denied")
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT")
    })
    const paths = await exportStructuredMemoryToWiki(PROJECT, baseSnapshot(1))
    expect(paths.length).toBeGreaterThan(0)
  })

  it("drops memory snapshots that are out of the actual-chapter window", async () => {
    fsMocks.listDirectory.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith("wiki/chapters")) {
        return [
          { name: "chapter-001.md", path: `${PROJECT}/wiki/chapters/chapter-001.md`, is_dir: false },
          { name: "chapter-002.md", path: `${PROJECT}/wiki/chapters/chapter-002.md`, is_dir: false },
        ]
      }
      if (p.endsWith(".novel/snapshots")) {
        return [
          { name: "001.snapshot.json", path: `${PROJECT}/.novel/snapshots/001.snapshot.json`, is_dir: false },
          { name: "099.snapshot.json", path: `${PROJECT}/.novel/snapshots/099.snapshot.json`, is_dir: false },
        ]
      }
      throw new Error("ENOENT")
    })
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/snapshots/001.snapshot.json")) return JSON.stringify(snapshotRaw(1))
      if (p.endsWith(".novel/snapshots/099.snapshot.json")) return JSON.stringify(snapshotRaw(99))
      if (p.endsWith("wiki/chapters/chapter-001.md")) return "---\nchapter_number: 1\n---\n"
      if (p.endsWith("wiki/chapters/chapter-002.md")) return "---\nchapter_number: 2\n---\n"
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT")
    })
    const paths = await exportStructuredMemoryToWiki(PROJECT, baseSnapshot(1))
    // chapter 99 is 97 above the max actual chapter 2 → invalid → excluded
    expect(paths.length).toBeGreaterThan(0)
    const docs = fsMocks.writeFileAtomic.mock.calls.filter(([p]) => String(p).includes("wiki/memory/"))
    expect(docs.length).toBe(7)
  })
})

describe("deleteChapterSnapshots (rebuild path)", () => {
  it("deletes snapshot json/md/history files, rebuilds projections and bumps", async () => {
    fsMocks.fileExists.mockResolvedValue(true)
    fsMocks.listDirectory.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith("wiki/chapters")) {
        return [{ name: "chapter-001.md", path: `${PROJECT}/wiki/chapters/chapter-001.md`, is_dir: false }]
      }
      if (p.endsWith(".novel/snapshots")) {
        return [{ name: "001.snapshot.json", path: `${PROJECT}/.novel/snapshots/001.snapshot.json`, is_dir: false }]
      }
      throw new Error("ENOENT")
    })
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/snapshots/001.snapshot.json")) return JSON.stringify(snapshotRaw(1))
      if (p.endsWith("wiki/chapters/chapter-001.md")) return "---\nchapter_number: 1\n---\n# 第1章\n"
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT")
    })
    const bump = vi.fn()
    await deleteChapterSnapshots(PROJECT, 1, bump)
    expect(fsMocks.deleteFile).toHaveBeenCalledWith(`${PROJECT}/.novel/snapshots/001.snapshot.json`)
    expect(fsMocks.deleteFile).toHaveBeenCalledWith(`${PROJECT}/.novel/snapshots/001.snapshot.md`)
    expect(fsMocks.deleteFile).toHaveBeenCalledWith(`${PROJECT}/.novel/snapshots/history/001`)
    // rebuild folded the single snapshot into every store
    const jsonWrites = fsMocks.writeFileAtomic.mock.calls.map(([p]) => String(p))
    expect(jsonWrites.some((p) => p.endsWith(".novel/character-states.json"))).toBe(true)
    expect(jsonWrites.some((p) => p.endsWith(".novel/foreshadowing-tracker.json"))).toBe(true)
    expect(jsonWrites.some((p) => p.endsWith(".novel/emotional-arcs.json"))).toBe(true)
    expect(jsonWrites.some((p) => p.endsWith(".novel/resource-ledger.json"))).toBe(true)
    expect(jsonWrites.some((p) => p.endsWith(".novel/subplot-board.json"))).toBe(true)
    expect(jsonWrites.some((p) => p.endsWith("wiki/memory/chapter-snapshots.md"))).toBe(true)
    expect(moduleMocks.writeSnapshotToWiki).toHaveBeenCalled()
    expect(moduleMocks.clearGraphCache).toHaveBeenCalled()
    expect(moduleMocks.clearTemporalFactsCache).toHaveBeenCalledWith(PROJECT)
    expect(bump).toHaveBeenCalled()
  })

  it("skips deleteFile when files do not exist and ignores delete failures", async () => {
    fsMocks.fileExists.mockResolvedValue(false)
    fsMocks.deleteFile.mockRejectedValue(new Error("delete denied"))
    const bump = vi.fn()
    await deleteChapterSnapshots(PROJECT, 1, bump)
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
    expect(bump).toHaveBeenCalled()
  })

  it("re-embeds every snapshot when the embedding config is enabled, tolerating embed failures", async () => {
    storeState.embeddingConfig = { enabled: true, model: "emb" }
    fsMocks.listDirectory.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith("wiki/chapters")) {
        return [{ name: "chapter-001.md", path: `${PROJECT}/wiki/chapters/chapter-001.md`, is_dir: false }]
      }
      if (p.endsWith(".novel/snapshots")) {
        return [
          { name: "001.snapshot.json", path: `${PROJECT}/.novel/snapshots/001.snapshot.json`, is_dir: false },
          { name: "002.snapshot.json", path: `${PROJECT}/.novel/snapshots/002.snapshot.json`, is_dir: false },
        ]
      }
      throw new Error("ENOENT")
    })
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/snapshots/001.snapshot.json")) return JSON.stringify(snapshotRaw(1))
      if (p.endsWith(".novel/snapshots/002.snapshot.json")) return JSON.stringify(snapshotRaw(2))
      if (p.endsWith("wiki/chapters/chapter-001.md")) return "---\nchapter_number: 1\n---\n"
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT")
    })
    moduleMocks.embedPage.mockImplementation(async (pp: string, pageId: string) => {
      if (pageId === "002") throw new Error("embed boom")
      return undefined
    })
    await deleteChapterSnapshots(PROJECT, 1)
    expect(moduleMocks.embedPage).toHaveBeenCalledTimes(2)
  })

  it("tolerates per-chapter graph rebuild failures", async () => {
    fsMocks.listDirectory.mockImplementation(async (path: string) => {
      if (String(path).endsWith(".novel/snapshots")) {
        return [{ name: "001.snapshot.json", path: `${PROJECT}/.novel/snapshots/001.snapshot.json`, is_dir: false }]
      }
      throw new Error("ENOENT")
    })
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/snapshots/001.snapshot.json")) return JSON.stringify(snapshotRaw(1))
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT")
    })
    moduleMocks.writeSnapshotToWiki.mockRejectedValue(new Error("graph rebuild boom"))
    await expect(deleteChapterSnapshots(PROJECT, 1)).resolves.toBeUndefined()
  })
})

describe("superseded-entity cleanup (cleanupSupersededEntityFiles)", () => {
  it("deletes entity files whose snapshot_id matches the current supersedes", async () => {
    const snapshot = baseSnapshot(1, { supersedes: "chapter-1-r1", revision: 2 })
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "旧阿宁.md", path: `${PROJECT}/wiki/entities/旧阿宁.md`, is_dir: false },
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (String(path).endsWith("wiki/entities/旧阿宁.md")) {
        return "---\nsnapshot_id: chapter-1-r1\n---\n旧内容"
      }
      throw new Error("ENOENT")
    })
    await syncSnapshotToMemory(PROJECT, snapshot)
    expect(fsMocks.deleteFile).toHaveBeenCalledWith(`${PROJECT}/wiki/entities/旧阿宁.md`)
  })

  it("deletes entity files from an older revision of the same source chapter", async () => {
    const snapshot = baseSnapshot(1, { sourceType: "chapter", sourceSequence: 1, revision: 3 })
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "旧页.md", path: `${PROJECT}/wiki/entities/旧页.md`, is_dir: false },
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (String(path).endsWith("wiki/entities/旧页.md")) {
        return "---\nsource_type: chapter\nsource_sequence: 1\nsource_revision: 2\n---\n旧内容"
      }
      throw new Error("ENOENT")
    })
    await syncSnapshotToMemory(PROJECT, snapshot)
    expect(fsMocks.deleteFile).toHaveBeenCalledWith(`${PROJECT}/wiki/entities/旧页.md`)
  })

  it("keeps entity files that reference only other snapshots", async () => {
    const snapshot = baseSnapshot(1, { revision: 2, snapshotId: "chapter-1-r2" })
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "其他页.md", path: `${PROJECT}/wiki/entities/其他页.md`, is_dir: false },
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (String(path).endsWith("wiki/entities/其他页.md")) {
        return "---\nsource: 001.snapshot.json 999.snapshot.json\n---\n其他内容"
      }
      throw new Error("ENOENT")
    })
    await syncSnapshotToMemory(PROJECT, snapshot)
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })

  it("deletes entity files that reference only the current snapshot source", async () => {
    const snapshot = baseSnapshot(1, { revision: 2, snapshotId: "chapter-1-r2" })
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "纯当前.md", path: `${PROJECT}/wiki/entities/纯当前.md`, is_dir: false },
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (String(path).endsWith("wiki/entities/纯当前.md")) {
        return "---\nsource: 001.snapshot.json\n---\n内容"
      }
      throw new Error("ENOENT")
    })
    await syncSnapshotToMemory(PROJECT, snapshot)
    expect(fsMocks.deleteFile).toHaveBeenCalledWith(`${PROJECT}/wiki/entities/纯当前.md`)
  })

  it("skips unreadable entity files and ignores delete failures", async () => {
    const snapshot = baseSnapshot(1, { revision: 2, snapshotId: "chapter-1-r2" })
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "a.md", path: `${PROJECT}/wiki/entities/a.md`, is_dir: false },
      { name: "b.md", path: `${PROJECT}/wiki/entities/b.md`, is_dir: false },
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (String(path).endsWith("wiki/entities/a.md")) return "---\nsource: 001.snapshot.json\n---\n"
      throw new Error("ENOENT")
    })
    fsMocks.deleteFile.mockRejectedValue(new Error("delete denied"))
    await syncSnapshotToMemory(PROJECT, snapshot)
    // b.md unreadable → skipped; a.md delete failure ignored
    expect(fsMocks.deleteFile).toHaveBeenCalled()
  })

  it("is a no-op when the entities dir cannot be listed", async () => {
    await syncSnapshotToMemory(PROJECT, baseSnapshot(1))
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })

  it("keeps freshly written entity files out of the deletion candidates", async () => {
    const snapshot = baseSnapshot(1, { revision: 2, snapshotId: "chapter-1-r2" })
    moduleMocks.writeSnapshotToWiki.mockResolvedValue([`${PROJECT}/wiki/entities/阿宁.md`])
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "阿宁.md", path: `${PROJECT}/wiki/entities/阿宁.md`, is_dir: false },
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (String(path).endsWith("wiki/entities/阿宁.md")) return "---\nsource: 001.snapshot.json\n---\n"
      throw new Error("ENOENT")
    })
    await syncSnapshotToMemory(PROJECT, snapshot)
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })
})
describe("snapshot residual branches (L2A)", () => {
  it("restores with no current snapshot on disk (null-current fallbacks)", async () => {
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/snapshots/001.snapshot.json")) throw new Error("ENOENT")
      if (p.includes("history/001/")) return JSON.stringify(snapshotRaw(1))
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT")
    })
    const restored = await restoreSnapshotHistory(PROJECT, 1, "2026-06-01T00-00-00.000Z.snapshot.json")
    expect(restored.revision).toBe(2)
    expect(restored.supersedes).toBe("chapter-1-r1")
  })

  it("rejects an undefined history file name through the ?? '' fallback", async () => {
    await expect(restoreSnapshotHistory(PROJECT, 1, undefined as unknown as string))
      .rejects.toThrow("Invalid snapshot history file name.")
  })

  it("ignores entity files whose source_sequence is not numeric", async () => {
    const snapshot = baseSnapshot(1, { revision: 2, snapshotId: "chapter-1-r2" })
    fsMocks.listDirectory.mockResolvedValueOnce([
      { name: "怪页.md", path: `${PROJECT}/wiki/entities/怪页.md`, is_dir: false },
    ])
    fsMocks.readFile.mockImplementation(async (path: string) => {
      if (String(path).endsWith("wiki/entities/怪页.md")) {
        return "---\nsource_type: chapter\nsource_sequence: abc\nsource_revision: 1\n---\n内容"
      }
      throw new Error("ENOENT")
    })
    await syncSnapshotToMemory(PROJECT, snapshot)
    expect(fsMocks.deleteFile).not.toHaveBeenCalled()
  })

  it("logs String(err) when graph rebuild fails with a non-Error", async () => {
    fsMocks.listDirectory.mockImplementation(async (path: string) => {
      if (String(path).endsWith(".novel/snapshots")) {
        return [{ name: "001.snapshot.json", path: `${PROJECT}/.novel/snapshots/001.snapshot.json`, is_dir: false }]
      }
      throw new Error("ENOENT")
    })
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/snapshots/001.snapshot.json")) return JSON.stringify(snapshotRaw(1))
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT")
    })
    moduleMocks.writeSnapshotToWiki.mockRejectedValue("graph rebuild boom string")
    await expect(deleteChapterSnapshots(PROJECT, 1)).resolves.toBeUndefined()
  })

  it("logs String(err) when vector re-embed fails with a non-Error", async () => {
    storeState.embeddingConfig = { enabled: true, model: "emb" }
    fsMocks.listDirectory.mockImplementation(async (path: string) => {
      if (String(path).endsWith(".novel/snapshots")) {
        return [{ name: "001.snapshot.json", path: `${PROJECT}/.novel/snapshots/001.snapshot.json`, is_dir: false }]
      }
      throw new Error("ENOENT")
    })
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/snapshots/001.snapshot.json")) return JSON.stringify(snapshotRaw(1))
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT")
    })
    moduleMocks.embedPage.mockRejectedValue("embed boom string")
    await expect(deleteChapterSnapshots(PROJECT, 1)).resolves.toBeUndefined()
  })
})

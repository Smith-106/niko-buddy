import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StreamCallbacks } from "@/lib/llm-client"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"

/**
 * chapter-ingest.ts behavior coverage (s/l/b/f 100% target).
 *
 * This spec drives ingestChapter / ingestOutline / ingestChapterPipeline /
 * buildSnapshotMemorySyncPreview through the full dependency graph with
 * controlled mocks for the FS / LLM / store / projection modules, leaving
 * the pure helpers (normalize, fold, dedup-free link/validate) on their
 * real implementations. See chapter-ingest.snapshot.spec.ts for the
 * snapshot-history / restore / rebuild flows.
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
  // mirror real combineAbortSignals: 任一 abort 即合并 abort
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
    reviewModel: "review-model",
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
  buildSnapshotMemorySyncPreview,
  ingestChapter,
  ingestChapterPipeline,
  ingestOutline,
  type ChapterSnapshot,
} from "./chapter-ingest"

const PROJECT = "E:/Novel"
const CHAPTER_PATH = `${PROJECT}/wiki/chapters/chapter-001.md`

function chapterContent(overrides: Record<string, string | number> = {}): string {
  const fm = {
    type: "chapter",
    chapter_number: 1,
    chapter_status: "final",
    title: "第1章 开局",
    ...overrides,
  }
  const fmLines = Object.entries(fm).map(([k, v]) => `${k}: ${typeof v === "string" && /[:#]/.test(v) ? `"${v}"` : v}`)
  return `---\n${fmLines.join("\n")}\n---\n\n# 第1章 开局\n\n正文内容……`
}

function llmSnapshotJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chapterId: "chapter-1",
    chapterNumber: 1,
    summary: "主角来到码头",
    characters: ["阿宁"],
    characterAliases: { 阿宁: ["宁"] },
    locations: ["码头"],
    organizations: [],
    items: [],
    events: ["夺剑大战"],
    characterStateChanges: ["阿宁：受伤"],
    relationshipChanges: [],
    knowledgeChanges: ["阿宁知道秘密"],
    foreshadowingChanges: ["新增伏笔：黑剑"],
    newCanonFacts: ["主角佩剑名为黑剑"],
    timelineEvents: ["第一天：抵达码头"],
    conflicts: ["对峙"],
    endingHook: "结尾钩子",
    graphNodes: [],
    graphEdges: [],
    ...overrides,
  }
}

function mockLlmJsonResponse(json: unknown, fence = ""): void {
  streamChatMock.mockImplementation(async (_cfg: unknown, _msgs: unknown, callbacks: StreamCallbacks) => {
    const payload = typeof json === "string" ? json : JSON.stringify(json)
    callbacks.onToken(fence ? `\`\`\`${fence}\n${payload}\n\`\`\`` : payload)
    callbacks.onDone()
  })
}

function mockLlmStreamError(message: string): void {
  streamChatMock.mockImplementation(async (_cfg: unknown, _msgs: unknown, callbacks: StreamCallbacks) => {
    callbacks.onError(new Error(message))
  })
}

function setupDefaultFs(): void {
  fsMocks.readFile.mockImplementation(async (path: string) => {
    const p = String(path)
    if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
    throw new Error("ENOENT: no such file or directory")
  })
  fsMocks.listDirectory.mockRejectedValue(new Error("ENOENT: no such file or directory"))
}

beforeEach(() => {
  vi.clearAllMocks()
  storeState.novelMode = true
  storeState.llmConfig = { provider: "custom", model: "extract-model", customEndpoint: "http://localhost:11434", apiKey: "" } as LlmConfig
  storeState.novelConfig = {
    communitySummaryAsync: false,
    communitySummaryEnabled: true,
    communitySummaryInterval: 5,
    reviewModel: "review-model",
  } as NovelConfig
  storeState.embeddingConfig = { enabled: false, model: "" }
  storeState.outputLanguage = "zh-CN"
  setupDefaultFs()
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

describe("ingestChapter — early guard branches", () => {
  it("returns { snapshot: null } without failReason when novelMode is off", async () => {
    storeState.novelMode = false
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result).toEqual({ snapshot: null })
    expect(streamChatMock).not.toHaveBeenCalled()
  })

  it("returns failReason no_llm when the resolved LLM config is unusable", async () => {
    storeState.llmConfig = { provider: "custom", model: "", customEndpoint: "http://x", apiKey: "" } as LlmConfig
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result).toEqual({ snapshot: null, failReason: "no_llm" })
  })

  it("returns failReason not_chapter when the file has no frontmatter", async () => {
    fsMocks.readFile.mockResolvedValueOnce("plain body without frontmatter")
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result).toEqual({ snapshot: null, failReason: "not_chapter" })
  })

  it("returns failReason not_chapter when frontmatter is not a chapter page", async () => {
    fsMocks.readFile.mockResolvedValueOnce("---\ntype: note\ntitle: 笔记\n---\n\n正文")
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result).toEqual({ snapshot: null, failReason: "not_chapter" })
  })

  it("returns failReason not_final when the chapter status is not final", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent({ chapter_status: "draft" }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result).toEqual({ snapshot: null, failReason: "not_final" })
  })

  it("returns failReason invalid_chapter_number for zero chapter numbers", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent({ chapter_number: 0 }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result).toEqual({ snapshot: null, failReason: "invalid_chapter_number" })
  })

  it("returns failReason cancelled when the signal is already aborted", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    const result = await ingestChapter(PROJECT, CHAPTER_PATH, undefined, AbortSignal.abort())
    expect(result).toEqual({ snapshot: null, failReason: "cancelled" })
  })

  it("propagates readFile failures from the chapter path", async () => {
    fsMocks.readFile.mockRejectedValueOnce(new Error("read denied"))
    await expect(ingestChapter(PROJECT, CHAPTER_PATH)).rejects.toThrow("read denied")
  })
})

describe("ingestChapter — extraction failures degrade to extract_failed", () => {
  it("returns failReason extract_failed when the model returns no JSON object at all", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse("模型只输出了散文，没有 JSON")
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result).toEqual({ snapshot: null, failReason: "extract_failed" })
  })

  it("returns failReason extract_failed for unbalanced braces (never-closed object)", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse('{"summary": "未闭合')
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result).toEqual({ snapshot: null, failReason: "extract_failed" })
  })

  it("returns failReason extract_failed for malformed JSON (SyntaxError)", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse('{"summary": 未闭合的引号}')
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result).toEqual({ snapshot: null, failReason: "extract_failed" })
  })

  it("returns failReason extract_failed for valid JSON that is not an object", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse("[1, 2, 3]")
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result).toEqual({ snapshot: null, failReason: "extract_failed" })
  })

  it("rethrows stream errors instead of degrading (transport/abort path stays distinct)", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmStreamError("connection reset")
    await expect(ingestChapter(PROJECT, CHAPTER_PATH)).rejects.toThrow("connection reset")
  })
})

describe("ingestChapter — JSON object extraction from model text", () => {
  it("extracts from a ```json code fence", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson(), "json")
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot?.chapterNumber).toBe(1)
    expect(result.snapshot?.characters).toContain("阿宁")
  })

  it("extracts from a plain ``` fence", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson(), "")
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot?.summary).toBe("主角来到码头")
  })

  it("extracts the first balanced object from prose with leading/trailing chatter", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(`好的，以下是提取结果：\n${JSON.stringify(llmSnapshotJson())}\n希望有帮助！`)
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot?.chapterNumber).toBe(1)
  })

  it("keeps braces inside strings balanced (escaped quotes and nested objects)", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({ summary: "他说：\"我们走}\"，然后离开" }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot?.summary).toBe("他说：\"我们走}\"，然后离开")
  })

  it("prefers the fenced object when both fence and outer prose contain braces", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    const fenceJson = JSON.stringify(llmSnapshotJson({ summary: "围栏内的摘要" }))
    streamChatMock.mockImplementation(async (_cfg: unknown, _msgs: unknown, callbacks: StreamCallbacks) => {
      callbacks.onToken(`前面有 { 干扰 } 内容\n\`\`\`json\n${fenceJson}\n\`\`\``)
      callbacks.onDone()
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot?.summary).toBe("围栏内的摘要")
  })
})

describe("ingestChapter — full success path with projections", () => {
  it("commits snapshot + ingest output and runs every projection", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())

    const result = await ingestChapter(PROJECT, CHAPTER_PATH)

    expect(result.snapshot).not.toBeNull()
    expect(result.snapshot!.chapterId).toBe("chapter-1")
    // entityIsNew + validation warnings computed from the entity probes
    expect(result.snapshot!.entityIsNew).toEqual({ 阿宁: true, 码头: true })
    expect(result.snapshot!.validationWarnings?.some((w) => w.type === "entity_new")).toBe(true)
    // snapshot json + md writes (saveSnapshot), then 4 ingest-output files
    const writtenPaths = fsMocks.writeFileAtomic.mock.calls.map(([p]) => String(p))
    expect(writtenPaths.some((p) => p.endsWith(".novel/snapshots/001.snapshot.json"))).toBe(true)
    expect(writtenPaths.some((p) => p.endsWith(".novel/snapshots/001.snapshot.md"))).toBe(true)
    expect(writtenPaths.some((p) => p.endsWith(".novel/chapter-ingest-output/001.output.json"))).toBe(true)
    expect(writtenPaths.some((p) => p.endsWith(".novel/chapter-ingest-output/001.wiki-patch.json"))).toBe(true)
    expect(writtenPaths.some((p) => p.endsWith(".novel/chapter-ingest-output/001.search-index.json"))).toBe(true)
    expect(writtenPaths.some((p) => p.endsWith(".novel/chapter-ingest-output/001.vector-index.json"))).toBe(true)
    expect(moduleMocks.mergeSnapshotTimeline).toHaveBeenCalled()
    // projections with data-driven guards
    expect(moduleMocks.writeSnapshotToWiki).toHaveBeenCalled()
    expect(moduleMocks.writePatchFieldsToWiki).toHaveBeenCalled()
    // store saves for cognition / character / foreshadow / emotional / resource / subplot
    const jsonWrites = fsMocks.writeFileAtomic.mock.calls.map(([p]) => String(p))
    expect(jsonWrites.some((p) => p.endsWith(".novel/character-states.json"))).toBe(true)
    expect(jsonWrites.some((p) => p.endsWith(".novel/foreshadowing-tracker.json"))).toBe(true)
    expect(jsonWrites.some((p) => p.endsWith(".novel/emotional-arcs.json"))).toBe(true)
    expect(jsonWrites.some((p) => p.endsWith(".novel/resource-ledger.json"))).toBe(true)
    expect(jsonWrites.some((p) => p.endsWith(".novel/subplot-board.json"))).toBe(true)
    // sync_snapshot_to_memory bump
    expect(storeState.bumpDataVersion).toHaveBeenCalled()
    expect(result.snapshot!.memorySyncedAt).toBeTruthy()
  })

  it("skips data-driven projections whose change lists are empty", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      characterStateChanges: [],
      knowledgeChanges: [],
      foreshadowingChanges: [],
      newCanonFacts: [],
      timelineEvents: [],
      conflicts: [],
    }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const jsonWrites = fsMocks.writeFileAtomic.mock.calls.map(([p]) => String(p))
    expect(jsonWrites.some((p) => p.endsWith(".novel/character-states.json"))).toBe(false)
    expect(jsonWrites.some((p) => p.endsWith(".novel/foreshadowing-tracker.json"))).toBe(false)
  })

  it("executes the console-log branches when graph projections return paths", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    moduleMocks.writeSnapshotToWiki.mockResolvedValue([`${PROJECT}/wiki/entities/阿宁.md`])
    moduleMocks.writePatchFieldsToWiki.mockResolvedValue([`${PROJECT}/wiki/entities/阿宁.md`])
    await ingestChapter(PROJECT, CHAPTER_PATH)
    // the non-empty path list triggers the `if (writtenPaths.length > 0)` log branches
    expect(moduleMocks.writeSnapshotToWiki).toHaveBeenCalled()
    expect(moduleMocks.writePatchFieldsToWiki).toHaveBeenCalled()
  })

  it("embeds the chapter page when the embedding config is enabled", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    storeState.embeddingConfig = { enabled: true, model: "emb-model" }
    await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(moduleMocks.embedPage).toHaveBeenCalledWith(
      PROJECT,
      "chapter-001",
      "第1章 开局",
      expect.any(String),
      { enabled: true, model: "emb-model" },
    )
  })

  it("uses the page id as title when frontmatter has no title", async () => {
    fsMocks.readFile.mockResolvedValueOnce("---\ntype: chapter\nchapter_number: 1\nchapter_status: final\n---\n\n# 第1章\n\n正文")
    mockLlmJsonResponse(llmSnapshotJson())
    storeState.embeddingConfig = { enabled: true, model: "emb-model" }
    await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(moduleMocks.embedPage).toHaveBeenCalledWith(PROJECT, "chapter-001", "chapter-001", expect.any(String), expect.anything())
  })

  it("renders every non-empty snapshot section into the markdown snapshot", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      organizations: ["商会"],
      items: ["黑剑"],
      relationshipChanges: ["阿宁与苏未晞结盟"],
      graphNodes: ["阿宁"],
      graphEdges: ["阿宁->持有->黑剑"],
    }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const mdWrite = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/snapshots/001.snapshot.md"))
    const md = String(mdWrite![1])
    // snapshotToMarkdown 非空数组分支 (organizations/items/relationshipChanges/graphNodes/graphEdges)
    expect(md).toContain("- 商会")
    expect(md).toContain("- 黑剑")
    expect(md).toContain("- 阿宁与苏未晞结盟")
    expect(md).toContain("- 阿宁->持有->黑剑")
  })

  it("builds the entity link index from existing entity pages during linking", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    fsMocks.listDirectory.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith("wiki/entities")) {
        return [
          { name: "阿宁.md", path: `${PROJECT}/wiki/entities/阿宁.md`, is_dir: false },
          { name: "坏页.md", path: `${PROJECT}/wiki/entities/坏页.md`, is_dir: false },
        ]
      }
      throw new Error("ENOENT: no such file or directory")
    })
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith("wiki/entities/阿宁.md")) return "# 阿宁\n\n主角"
      if (p.endsWith("wiki/entities/坏页.md")) throw new Error("read denied")
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT: no such file or directory")
    })
    moduleMocks.extractEntitySummary.mockReturnValue({ path: "wiki/entities/阿宁.md", summary: "主角阿宁", aliases: ["宁"] })
    mockLlmJsonResponse(llmSnapshotJson())
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    expect(moduleMocks.buildEntityLinkIndex).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ path: "wiki/entities/阿宁.md" })]),
    )
  })

  it("runs memory-op rehearsal when canon facts produce ops, and warns when it throws", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    moduleMocks.planAddOpsFromCanonFacts.mockReturnValue([{ op: "add", fact: "黑剑" }])
    moduleMocks.applyMemoryOps.mockReturnValue([{ ok: true }])
    await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(moduleMocks.applyMemoryOps).toHaveBeenCalled()

    moduleMocks.planAddOpsFromCanonFacts.mockImplementation(() => {
      throw new Error("memory-op boom")
    })
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
  })

  it("records a failed projection to the ledger and continues when a projection throws", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    moduleMocks.writeSnapshotToWiki.mockRejectedValue(new Error("graph boom"))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    // projection failure is ledgered, not fatal
    expect(result.snapshot).not.toBeNull()
    const ledgerWrite = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/projection-status.json"))
    expect(ledgerWrite).toBeTruthy()
  })

  it("falls back to a fresh ledger when the ledger load throws", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith("projection-status-ledger.json")) throw new Error("corrupt ledger")
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT: no such file or directory")
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
  })

  it("warns when the ledger save fails but still returns the snapshot", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    // ledgerPath = ${PROJECT}/.novel/projection-status.json (非 projection-status-ledger.json)
    fsMocks.writeFileAtomic.mockImplementation(async (path: string) => {
      if (String(path).endsWith("projection-status.json")) throw new Error("ledger write boom")
      return undefined
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
  })

  it("resets warnings when entity validation throws", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    moduleMocks.resolveEntityLink.mockImplementation(() => {
      throw new Error("link boom")
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot?.validationWarnings).toEqual([])
    expect(result.snapshot?.entityIsNew).toEqual({})
  })
})

describe("ingestChapter — validation warning branches", () => {
  it("emits canon_conflict warnings from events matching the conflict patterns", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      events: ["主角推翻了旧设定", "主角之前对真相有误解", "实际上真相是……"],
    }))
    // canon.md exists and reads fine
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith("wiki/canon.md")) return "# 正史规则\n\nxxx"
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT: no such file or directory")
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    const canonWarnings = result.snapshot!.validationWarnings!.filter((w) => w.type === "canon_conflict")
    expect(canonWarnings.length).toBe(3)
  })

  it("emits no canon warnings when canon.md is missing", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({ events: ["主角推翻了旧设定"] }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot!.validationWarnings!.filter((w) => w.type === "canon_conflict")).toHaveLength(0)
  })

  it("marks entities as new only when their wiki file does not exist, and handles probe errors", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    // 阿宁/宁/码头 exist on disk except 码头; one probe throws
    fsMocks.fileExists.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith("阿宁.md")) throw new Error("probe denied")
      return p.endsWith("码头.md")
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot!.entityIsNew).toEqual({ 阿宁: true, 码头: false })
  })

  it("collapses entity references to canonical names and remaps detail records", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    const linkTargets = new Map<string, string>([
      ["宁", "阿宁"],
      ["码头", "东码头"],
      ["商会", "商行"],
    ])
    moduleMocks.resolveEntityLink.mockImplementation((_index: unknown, name: string, type: string) => {
      const canonical = linkTargets.get(name)
      if (!canonical) return null
      return { canonicalName: canonical, type, path: `${PROJECT}/wiki/entities/${canonical}.md`, label: canonical }
    })
    mockLlmJsonResponse(llmSnapshotJson({
      characters: ["阿宁", "宁"],
      locations: ["码头"],
      organizations: ["商会"],
      characterDetails: { 宁: { identity: "主角", faction: "无", goals: "复仇", arcChange: "成长" } },
      locationDetails: { 码头: { region: "东城", type: "港口", controller: "商会", hiddenInfo: "密道" } },
      organizationDetails: { 商会: { leader: "苏未晞", members: "阿宁", goals: "控制码头", resources: "船队" } },
    }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot!.characters).toEqual(["阿宁"])
    expect(result.snapshot!.locations).toEqual(["东码头"])
    expect(result.snapshot!.characterDetails).toEqual({ 阿宁: { identity: "主角", faction: "无", goals: "复仇", arcChange: "成长" } })
    expect(result.snapshot!.locationDetails).toEqual({ 东码头: { region: "东城", type: "港口", controller: "商会", hiddenInfo: "密道" } })
    // organizationDetails 也按 canonical 重映射 (linkSnapshotEntities 四类 detail 分支)
    expect(result.snapshot!.organizationDetails).toEqual({ 商行: { leader: "苏未晞", members: "阿宁", goals: "控制码头", resources: "船队" } })
    expect(result.snapshot!.validationWarnings!.some((w) => w.type === "canon_conflict")).toBe(true)
  })
})

describe("ingestChapter — community summary rebuild", () => {
  it("waits synchronously when communitySummaryAsync is off", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    expect(moduleMocks.generateCommunitySummaries).toHaveBeenCalledWith(PROJECT, storeState.llmConfig, storeState.novelConfig)
  })

  it("fires and forgets when communitySummaryAsync is on", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    storeState.novelConfig = { ...storeState.novelConfig, communitySummaryAsync: true }
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    await vi.waitFor(() => expect(moduleMocks.generateCommunitySummaries).toHaveBeenCalled())
  })

  it("routes summary failure to the injected callback", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    moduleMocks.generateCommunitySummaries.mockRejectedValue(new Error("summary boom"))
    const onCommunitySummaryError = vi.fn()
    const result = await ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, { onCommunitySummaryError })
    expect(result.snapshot).not.toBeNull()
    expect(onCommunitySummaryError).toHaveBeenCalledWith("summary boom")
  })

  it("falls back to the store notification when no callback is injected", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    moduleMocks.generateCommunitySummaries.mockRejectedValue(new Error("summary boom"))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    expect(storeState.setCommunitySummaryError).toHaveBeenCalledWith("summary boom")
  })
})

describe("ingestChapter — options DI", () => {
  it("prefers injected llmConfig / novelConfig / embeddingConfig / novelMode over the store", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    const options = {
      llmConfig: { provider: "custom", model: "injected", customEndpoint: "http://injected", apiKey: "" } as LlmConfig,
      novelConfig: { ...storeState.novelConfig, communitySummaryAsync: false } as NovelConfig,
      embeddingConfig: { enabled: true, model: "injected-emb", endpoint: "", apiKey: "" },
      novelMode: true,
    }
    storeState.novelMode = false // must be overridden by options.novelMode
    const result = await ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, options)
    expect(result.snapshot).not.toBeNull()
    expect(moduleMocks.embedPage).toHaveBeenCalledWith(PROJECT, "chapter-001", "第1章 开局", expect.any(String), options.embeddingConfig)
  })
})

describe("ingestChapterPipeline", () => {
  it("resolves the review model and forwards to ingestChapter", async () => {
    storeState.novelConfig = { ...storeState.novelConfig, reviewModel: "review-model" }
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    const result = await ingestChapterPipeline(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    // the pipeline resolved reviewModel from the store config — verified by
    // the review-model module being real; assert the ingest still succeeded
    expect(streamChatMock).toHaveBeenCalled()
  })
})

describe("ingestOutline", () => {
  const OUTLINE_PATH = `${PROJECT}/wiki/outlines/总大纲.md`

  function outlineJson(): Record<string, unknown> {
    return {
      chapterId: "outline-init",
      chapterNumber: 0,
      summary: "大纲摘要",
      characters: ["初始人物"],
      locations: ["初始地点"],
      organizations: [],
      items: [],
      events: [],
      characterStateChanges: ["初始人物：登场"],
      relationshipChanges: [],
      knowledgeChanges: [],
      foreshadowingChanges: [],
      newCanonFacts: ["世界初始设定"],
      timelineEvents: [],
      conflicts: [],
      endingHook: "",
      graphNodes: [],
      graphEdges: [],
    }
  }

  it("returns null when the LLM config is unusable", async () => {
    storeState.llmConfig = { provider: "custom", model: "", customEndpoint: "http://x", apiKey: "" } as LlmConfig
    await expect(ingestOutline(PROJECT, OUTLINE_PATH)).resolves.toBeNull()
  })

  it("extracts an outline snapshot, syncs it to memory and returns it with memorySyncedAt", async () => {
    fsMocks.readFile.mockResolvedValueOnce("这是总大纲的正文内容……")
    mockLlmJsonResponse(outlineJson())
    const result = await ingestOutline(PROJECT, OUTLINE_PATH)
    expect(result).not.toBeNull()
    expect(result!.chapterId).toMatch(/^outline-总大纲$/)
    expect(result!.chapterNumber).toBeLessThan(0)
    expect(result!.memorySyncedAt).toBeTruthy()
    expect(storeState.bumpDataVersion).toHaveBeenCalled()
  })

  it("returns null when the model emits no parseable JSON object", async () => {
    fsMocks.readFile.mockResolvedValueOnce("大纲内容")
    mockLlmJsonResponse("没有 JSON")
    await expect(ingestOutline(PROJECT, OUTLINE_PATH)).resolves.toBeNull()
  })

  it("returns null for malformed JSON (SyntaxError)", async () => {
    fsMocks.readFile.mockResolvedValueOnce("大纲内容")
    mockLlmJsonResponse('{"summary": 坏引号}')
    await expect(ingestOutline(PROJECT, OUTLINE_PATH)).resolves.toBeNull()
  })

  it("returns null when normalized payload is not a snapshot object", async () => {
    fsMocks.readFile.mockResolvedValueOnce("大纲内容")
    mockLlmJsonResponse([1, 2, 3])
    await expect(ingestOutline(PROJECT, OUTLINE_PATH)).resolves.toBeNull()
  })

  it("rejects with the friendly interruption message on abort-like stream errors", async () => {
    fsMocks.readFile.mockResolvedValueOnce("大纲内容")
    mockLlmStreamError("request cancelled by user")
    await expect(ingestOutline(PROJECT, OUTLINE_PATH)).rejects.toThrow("大纲摄取已中断，请稍后重试")
  })

  it("maps a SyntaxError from the model to the friendly invalid-JSON message", async () => {
    // 模型直接抛 SyntaxError → normalizeOutlineIngestError 的 SyntaxError 分支
    fsMocks.readFile.mockResolvedValueOnce("大纲内容")
    streamChatMock.mockImplementation(async () => {
      throw new SyntaxError("Unexpected token '}'")
    })
    await expect(ingestOutline(PROJECT, OUTLINE_PATH)).rejects.toThrow("大纲摄取失败：模型返回了无法解析的 JSON，请重试或调整提示")
  })

  it("returns null for a fenced payload whose JSON never closes (no parseable object)", async () => {
    fsMocks.readFile.mockResolvedValueOnce("大纲内容")
    mockLlmJsonResponse("```json\n{broken\n```")
    await expect(ingestOutline(PROJECT, OUTLINE_PATH)).resolves.toBeNull()
  })

  it("propagates non-abort stream errors with their original message", async () => {
    fsMocks.readFile.mockResolvedValueOnce("大纲内容")
    mockLlmStreamError("provider timeout")
    await expect(ingestOutline(PROJECT, OUTLINE_PATH)).rejects.toThrow("provider timeout")
  })
})

describe("buildSnapshotMemorySyncPreview", () => {
  function previewSnapshot(overrides: Partial<ChapterSnapshot> = {}): ChapterSnapshot {
    return {
      chapterId: "chapter-1",
      chapterNumber: 1,
      summary: "摘要",
      characters: ["阿宁", "阿宁", ""],
      locations: ["码头"],
      organizations: [],
      items: [],
      events: [],
      characterStateChanges: ["阿宁：受伤"],
      relationshipChanges: [],
      knowledgeChanges: ["阿宁知道秘密"],
      foreshadowingChanges: [],
      newCanonFacts: [],
      timelineEvents: [],
      conflicts: [],
      endingHook: "",
      graphNodes: [],
      graphEdges: [],
      ...overrides,
    }
  }

  it("lists every section with deduplicated graph items", () => {
    const preview = buildSnapshotMemorySyncPreview(previewSnapshot())
    expect(preview).toContain("人物状态")
    expect(preview).toContain("角色认知")
    expect(preview).toContain("伏笔追踪")
    expect(preview).toContain("实体页 / 图谱")
    expect(preview).toContain("RAG 记忆页面")
    expect(preview).toContain("- 阿宁")
    // dedupe: 阿宁 appears exactly once as a bare graph-item line
    const bareNingLines = preview.split("\n").filter((l) => l === "- 阿宁")
    expect(bareNingLines).toHaveLength(1)
  })

  it("renders 无 placeholders for empty sections", () => {
    const preview = buildSnapshotMemorySyncPreview(previewSnapshot({
      characterStateChanges: [],
      knowledgeChanges: [],
      foreshadowingChanges: [],
    }))
    expect(preview).toContain("人物状态：")
    expect(preview.match(/- 无/g)!.length).toBeGreaterThanOrEqual(3)
  })
})

describe("fold helpers via ingest projections (CORR-001/002 shared colon parsers)", () => {
  it("folds fullwidth and ASCII colon character-state lines and weak includes fallback", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      characterStateChanges: [
        "阿宁：受伤",
        "苏未晞:怀疑",
        "路人甲受伤了",
        "路人甲：无名氏没有记录",
      ],
    }))
    // existing character store holds 阿宁 + 路人甲
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/character-states.json")) {
        return JSON.stringify({
          characters: [
            { characterName: "阿宁", currentLocation: "", status: "旧", equipment: [], abilities: [], relationships: {}, lastUpdatedChapter: 0, lastUpdatedAt: "" },
            { characterName: "路人甲", currentLocation: "", status: "旧", equipment: [], abilities: [], relationships: {}, lastUpdatedChapter: 0, lastUpdatedAt: "" },
          ],
          lastUpdated: "",
        })
      }
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT: no such file or directory")
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const write = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/character-states.json"))
    const store = JSON.parse(String(write![1]))
    const aNing = store.characters.find((c: { characterName: string }) => c.characterName === "阿宁")
    expect(aNing.status).toBe("受伤")
    const suWeiXi = store.characters.find((c: { characterName: string }) => c.characterName === "苏未晞")
    expect(suWeiXi.status).toBe("怀疑")
    // colon-less line hit the weak includes fallback against 路人甲, then the
    // parsed line overwrote it — both branches executed
    const luRen = store.characters.find((c: { characterName: string }) => c.characterName === "路人甲")
    expect(luRen.status).toBe("无名氏没有记录")
  })

  it("folds foreshadow add/advance/resolve with notes and unrecognized lines", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      foreshadowingChanges: [
        "新增伏笔：黑剑-主角的佩剑",
        "推进伏笔：黑剑-剑身出现裂痕",
        "回收伏笔：旧钥匙",
        "完全无法识别的一行",
      ],
    }))
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/foreshadowing-tracker.json")) {
        return JSON.stringify({
          items: [
            { id: "fs-1-1", name: "黑剑", description: "", status: "planted", plantedChapter: 1, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
            { id: "fs-1-2", name: "旧钥匙", description: "", status: "planted", plantedChapter: 1, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
          ],
          lastUpdated: "",
        })
      }
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT: no such file or directory")
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const write = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/foreshadowing-tracker.json"))
    const store = JSON.parse(String(write![1]))
    const heiJian = store.items.find((i: { name: string }) => i.name === "黑剑")
    expect(heiJian.description).toBe("主角的佩剑")
    expect(heiJian.status).toBe("advanced")
    expect(heiJian.advancedChapters).toEqual([1])
    expect(heiJian.notes).toContain("[第1章推进] 剑身出现裂痕")
    const oldKey = store.items.find((i: { name: string }) => i.name === "旧钥匙")
    expect(oldKey.status).toBe("resolved")
    expect(oldKey.resolvedChapter).toBe(1)
    expect(store.items).toHaveLength(2)
  })

  it("folds emotional arcs and resource ledger from details, skipping empty entries", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      characterDetails: {
        阿宁: { identity: "主角", faction: "无", goals: "复仇", arcChange: "从复仇到释然" },
        无变化者: { identity: "配角", faction: "无", goals: "", arcChange: "   " },
      },
      itemDetails: {
        断水剑: { holder: "阿宁", previousHolders: "老掌门", abilities: "", limitations: "", origin: "" },
        无主物: { holder: "", previousHolders: "", abilities: "", limitations: "", origin: "" },
        "": { holder: "某人", previousHolders: "", abilities: "", limitations: "", origin: "" },
      },
    }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const arcWrite = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/emotional-arcs.json"))
    const arcs = JSON.parse(String(arcWrite![1]))
    expect(arcs.beats).toHaveLength(1)
    expect(arcs.beats[0]).toMatchObject({ character: "阿宁", chapterNumber: 1, emotion: "从复仇到释然" })
    const ledgerWrite = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/resource-ledger.json"))
    const ledger = JSON.parse(String(ledgerWrite![1]))
    // 断水剑 with holder + 无主物 with empty holder are both entries; the
    // empty item name is skipped
    expect(ledger.entries).toHaveLength(2)
    expect(ledger.entries[0]).toMatchObject({ item: "断水剑", currentHolder: "阿宁", transferredFrom: "老掌门" })
    expect(ledger.entries[0].transferHistory).toHaveLength(1)
    expect(ledger.entries[1]).toMatchObject({ item: "无主物", currentHolder: "" })
    expect(ledger.entries[1].transferHistory).toEqual([])
  })

  it("updates an existing resource-ledger entry when the holder changes", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      itemDetails: {
        断水剑: { holder: "苏未晞", previousHolders: "", abilities: "", limitations: "", origin: "" },
      },
    }))
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/resource-ledger.json")) {
        return JSON.stringify({
          entries: [
            { item: "断水剑", currentHolder: "阿宁", acquiredChapter: 1, transferredFrom: undefined, transferHistory: [{ fromChapter: 1, fromHolder: "", toHolder: "阿宁" }] },
          ],
          lastUpdated: "",
        })
      }
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT: no such file or directory")
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const ledgerWrite = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/resource-ledger.json"))
    const ledger = JSON.parse(String(ledgerWrite![1]))
    expect(ledger.entries[0].currentHolder).toBe("苏未晞")
    expect(ledger.entries[0].transferHistory).toHaveLength(2)
  })
})
describe("chapter-ingest residual branches (L2A)", () => {
  it("routes an unparseable chapter_number through the ?? 0 fallback to invalid_chapter_number", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent({ chapter_number: "abc" }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result).toEqual({ snapshot: null, failReason: "invalid_chapter_number" })
  })

  it("resets warnings when entity validation throws a non-Error value", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    moduleMocks.resolveEntityLink.mockImplementation(() => {
      throw "link boom string"
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot?.validationWarnings).toEqual([])
    expect(result.snapshot?.entityIsNew).toEqual({})
  })

  it("logs String(err) when the memory-op rehearsal throws a non-Error", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    moduleMocks.planAddOpsFromCanonFacts.mockImplementation(() => {
      throw "memory-op boom"
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
  })

  it("logs String(err) when a projection fails with a non-Error", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    moduleMocks.writeSnapshotToWiki.mockRejectedValue("graph boom string")
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
  })

  it("skips the embed when the chapter path has no page-id stem", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    storeState.embeddingConfig = { enabled: true, model: "emb-model" }
    await ingestChapter(PROJECT, `${CHAPTER_PATH}/`)
    expect(moduleMocks.embedPage).not.toHaveBeenCalled()
  })

  it("logs String(err) when the ledger save fails with a non-Error", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    fsMocks.writeFileAtomic.mockImplementation(async (path: string) => {
      if (String(path).endsWith("projection-status.json")) throw "ledger boom string"
      return undefined
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
  })

  it("routes non-Error community-summary failures through String(err)", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson())
    moduleMocks.shouldRebuildCommunitySummaries.mockReturnValue(true)
    moduleMocks.generateCommunitySummaries.mockRejectedValue("summary boom string")
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    expect(storeState.setCommunitySummaryError).toHaveBeenCalledWith("summary boom string")
  })

  it("rethrows non-Error stream failures with String(err) from extractSnapshotWithLLM", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    streamChatMock.mockImplementation(async () => {
      throw "raw stream failure"
    })
    await expect(ingestChapter(PROJECT, CHAPTER_PATH)).rejects.toThrow("raw stream failure")
  })

  it("renders （无） placeholders for empty characters and locations in the snapshot markdown", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({ characters: [], locations: [] }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const mdWrite = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/snapshots/001.snapshot.md"))
    const md = String(mdWrite![1])
    expect(md).toContain("## 出场人物\n（无）")
    expect(md).toContain("## 出场地点\n（无）")
  })

  it("advances a foreshadow without a dash separator (bare name)", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      foreshadowingChanges: ["推进伏笔：黑剑"],
    }))
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/foreshadowing-tracker.json")) {
        return JSON.stringify({
          items: [
            { id: "fs-1-1", name: "黑剑", description: "", status: "planted", plantedChapter: 1, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
          ],
          lastUpdated: "",
        })
      }
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT: no such file or directory")
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const write = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/foreshadowing-tracker.json"))
    const store = JSON.parse(String(write![1]))
    const heiJian = store.items.find((i: { name: string }) => i.name === "黑剑")
    expect(heiJian.status).toBe("advanced")
    expect(heiJian.notes).toBe("")
  })

  it("ignores colon-less character-state lines that match no existing character", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      characterStateChanges: ["完全陌生的路人受伤了"],
    }))
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/character-states.json")) {
        return JSON.stringify({
          characters: [
            { characterName: "阿宁", currentLocation: "", status: "旧", equipment: [], abilities: [], relationships: {}, lastUpdatedChapter: 0, lastUpdatedAt: "" },
          ],
          lastUpdated: "",
        })
      }
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT: no such file or directory")
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const write = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/character-states.json"))
    const store = JSON.parse(String(write![1]))
    expect(store.characters).toHaveLength(1)
    expect(store.characters[0].characterName).toBe("阿宁")
    expect(store.characters[0].status).toBe("旧")
  })

  it("matches advance lines against partial foreshadow names", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      foreshadowingChanges: ["推进伏笔：黑剑", "推进伏笔：碎片"],
    }))
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/foreshadowing-tracker.json")) {
        return JSON.stringify({
          items: [
            { id: "fs-1-1", name: "黑", description: "", status: "planted", plantedChapter: 1, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
            { id: "fs-1-2", name: "黑剑碎片", description: "", status: "planted", plantedChapter: 1, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
          ],
          lastUpdated: "",
        })
      }
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT: no such file or directory")
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const write = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/foreshadowing-tracker.json"))
    const store = JSON.parse(String(write![1]))
    const hei = store.items.find((i: { name: string }) => i.name === "黑")
    const suiPian = store.items.find((i: { name: string }) => i.name === "黑剑碎片")
    expect(hei.status).toBe("advanced")
    expect(suiPian.status).toBe("advanced")
  })

  it("skips advance/resolve lines with no matching foreshadow", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      foreshadowingChanges: ["推进伏笔：不存在的剑", "回收伏笔：也没有的钥匙"],
    }))
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/foreshadowing-tracker.json")) {
        return JSON.stringify({
          items: [
            { id: "fs-1-1", name: "黑剑", description: "", status: "planted", plantedChapter: 1, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
          ],
          lastUpdated: "",
        })
      }
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT: no such file or directory")
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const write = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/foreshadowing-tracker.json"))
    const store = JSON.parse(String(write![1]))
    expect(store.items).toHaveLength(1)
    expect(store.items[0].status).toBe("planted")
    expect(store.items[0].advancedChapters).toEqual([])
  })

  it("does not duplicate the advancedChapter on a same-chapter re-advance and appends notes", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      foreshadowingChanges: ["推进伏笔：黑剑-第一次", "推进伏笔：黑剑-第二次"],
    }))
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/foreshadowing-tracker.json")) {
        return JSON.stringify({
          items: [
            { id: "fs-1-1", name: "黑剑", description: "", status: "planted", plantedChapter: 1, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
          ],
          lastUpdated: "",
        })
      }
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT: no such file or directory")
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const write = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/foreshadowing-tracker.json"))
    const store = JSON.parse(String(write![1]))
    const heiJian = store.items.find((i: { name: string }) => i.name === "黑剑")
    expect(heiJian.advancedChapters).toEqual([1])
    expect(heiJian.notes).toBe("[第1章推进] 第一次\n[第1章推进] 第二次")
  })

  it("appends resolution notes when the resolved foreshadow already has notes", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      foreshadowingChanges: ["回收伏笔：黑剑-钥匙沉入井底"],
    }))
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/foreshadowing-tracker.json")) {
        return JSON.stringify({
          items: [
            { id: "fs-1-1", name: "黑剑", description: "", status: "planted", plantedChapter: 1, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "旧笔记" },
          ],
          lastUpdated: "",
        })
      }
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT: no such file or directory")
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const write = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/foreshadowing-tracker.json"))
    const store = JSON.parse(String(write![1]))
    const heiJian = store.items.find((i: { name: string }) => i.name === "黑剑")
    expect(heiJian.status).toBe("resolved")
    expect(heiJian.notes).toBe("旧笔记\n[第1章回收] 钥匙沉入井底")
  })

  it("skips character-detail entries without an arcChange", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      characterDetails: {
        无弧光者: { identity: "配角", faction: "", goals: "", arcChange: undefined as unknown as string },
        阿宁: { identity: "主角", faction: "无", goals: "复仇", arcChange: "成长" },
      },
    }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const arcWrite = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/emotional-arcs.json"))
    const arcs = JSON.parse(String(arcWrite![1]))
    expect(arcs.beats).toHaveLength(1)
    expect(arcs.beats[0]).toMatchObject({ character: "阿宁", emotion: "成长" })
  })

  it("handles item details missing holder or previousHolders", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      itemDetails: {
        无主之物: { previousHolders: "老掌门", abilities: "", limitations: "", origin: "" },
        无源之物: { holder: "阿宁", abilities: "", limitations: "", origin: "" },
      },
    }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const ledgerWrite = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/resource-ledger.json"))
    const ledger = JSON.parse(String(ledgerWrite![1]))
    expect(ledger.entries).toHaveLength(2)
    const wuZhu = ledger.entries.find((e: { item: string }) => e.item === "无主之物")
    expect(wuZhu.currentHolder).toBe("")
    expect(wuZhu.transferredFrom).toBe("老掌门")
    expect(wuZhu.transferHistory).toEqual([])
    const wuYuan = ledger.entries.find((e: { item: string }) => e.item === "无源之物")
    expect(wuYuan.currentHolder).toBe("阿宁")
    expect(wuYuan.transferredFrom).toBeUndefined()
    expect(wuYuan.transferHistory).toHaveLength(1)
  })

  it("keeps an existing ledger entry unchanged when the holder did not change", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      itemDetails: {
        断水剑: { holder: "阿宁", previousHolders: "", abilities: "", limitations: "", origin: "" },
      },
    }))
    fsMocks.readFile.mockImplementation(async (path: string) => {
      const p = String(path)
      if (p.endsWith(".novel/resource-ledger.json")) {
        return JSON.stringify({
          entries: [
            { item: "断水剑", currentHolder: "阿宁", acquiredChapter: 1, transferredFrom: undefined, transferHistory: [{ fromChapter: 1, fromHolder: "", toHolder: "阿宁" }] },
          ],
          lastUpdated: "",
        })
      }
      if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
      throw new Error("ENOENT: no such file or directory")
    })
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const ledgerWrite = fsMocks.writeFileAtomic.mock.calls.find(([p]) => String(p).endsWith(".novel/resource-ledger.json"))
    const ledger = JSON.parse(String(ledgerWrite![1]))
    expect(ledger.entries[0].currentHolder).toBe("阿宁")
    expect(ledger.entries[0].transferHistory).toHaveLength(1)
  })

  it("drops characterAliases when the LLM emits none and no alias links resolve", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({ characterAliases: undefined }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    expect(result.snapshot!.characterAliases).toBeUndefined()
  })

  it("seeds an alias list for a canonical name that had no aliases yet", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    const linkTargets = new Map<string, string>([
      ["宁", "阿宁"],
      ["小猫", "猫妖"],
    ])
    moduleMocks.resolveEntityLink.mockImplementation((_index: unknown, name: string, type: string) => {
      const canonical = linkTargets.get(name)
      if (!canonical) return null
      return { canonicalName: canonical, type, path: `${PROJECT}/wiki/entities/${canonical}.md`, label: canonical }
    })
    mockLlmJsonResponse(llmSnapshotJson({ characters: ["阿宁", "宁", "小猫"] }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot!.characterAliases).toEqual({ 阿宁: ["宁"], 猫妖: ["小猫"] })
  })

  it("keeps unlinked location/organization detail keys under their raw names", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      locationDetails: { 神秘地点: { region: "东城", type: "秘境", controller: "", hiddenInfo: "" } },
      organizationDetails: { 无名组织: { leader: "", members: "", goals: "", resources: "" } },
    }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot!.locationDetails).toEqual({ 神秘地点: expect.objectContaining({ region: "东城" }) })
    expect(result.snapshot!.organizationDetails).toEqual({ 无名组织: expect.objectContaining({ leader: "" }) })
  })

  it("normalizes a non-Error throw from the outline LLM call", async () => {
    fsMocks.readFile.mockResolvedValueOnce("大纲内容")
    streamChatMock.mockImplementation(async () => {
      throw "boom-string"
    })
    await expect(ingestOutline(PROJECT, `${PROJECT}/wiki/outlines/总大纲.md`)).rejects.toThrow("boom-string")
  })
})

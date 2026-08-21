import { beforeEach, describe, expect, it, vi, type Mock } from "vitest"
import type { StreamCallbacks } from "@/lib/llm-client"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"

/**
 * chapter-ingest.ts — T16 (F-14) canon 影子双写钩子覆盖。
 *
 * 验证：
 *  1. `isCanonDualWriteEligible` 仅 final/accepted 放行；pending/draft/... 拦截。
 *  2. `buildCanonDualWriteOps` 从 `newCanonFacts` 派生 episode 双写操作（digest = SHA-256 幂等键）。
 *  3. `runCanonDualWriteHook` 单点调用：deps 未注入 / reject(pending/draft) / 无新事实 → 不写 canon；
 *     final+事实 → 调 shadowWriteCanon；双写异常 → 非致命告警不阻断。
 *  4. 集成：ingestChapter 在 final 章路径触发双写；draft 章 early-return 不触达双写（reject 先于双写）。
 *
 * 复用 behavior spec 的依赖 mock 骨架，使 ingestChapter 完整跑通到钩子点；
 * 双写本身用真实 `shadowWriteCanon` + 注入 mock deps（writeCanon 断言）。
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
  buildCanonDualWriteOps,
  ingestChapter,
  isCanonDualWriteEligible,
  runCanonDualWriteHook,
  type ChapterSnapshot,
} from "./chapter-ingest"
import { computeCheckpointDigestOf } from "./checkpoint-digest"
import type { CanonDualWriteDeps } from "./canon-dual-write"

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

function setupDefaultFs(): void {
  fsMocks.readFile.mockImplementation(async (path: string) => {
    const p = String(path)
    if (p.endsWith(".wiki-patch.json")) return JSON.stringify({ sharedWiki: true, entries: [] })
    throw new Error("ENOENT: no such file or directory")
  })
  fsMocks.listDirectory.mockRejectedValue(new Error("ENOENT: no such file or directory"))
}

/** 构造最小章节快照（仅双写派生所需字段）。 */
function snapshotWithFacts(facts: string[] | undefined): ChapterSnapshot {
  return {
    chapterId: "chapter-1",
    chapterNumber: 1,
    summary: "摘要",
    characters: [],
    locations: [],
    organizations: [],
    items: [],
    events: [],
    characterStateChanges: [],
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    newCanonFacts: facts as string[],
    timelineEvents: [],
    conflicts: [],
    endingHook: "",
    graphNodes: [],
    graphEdges: [],
  } as unknown as ChapterSnapshot
}

/** 注入双写 deps 的工厂；writeCanon/writeLegacy 为可断言 spy。 */
type T16TestDeps = CanonDualWriteDeps & { writeCanon: Mock; writeLegacy: Mock }

function makeDeps(extra: Partial<T16TestDeps> = {}): T16TestDeps {
  const writeCanon = vi.fn(async () => ({ ok: true, revision: 1 }))
  const writeLegacy = vi.fn(async () => ({ ok: true }))
  return {
    writeCanon,
    writeLegacy,
    queueRead: async () => "",
    queueWrite: async () => {},
    ...extra,
  }
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

describe("isCanonDualWriteEligible（reject 先于双写守卫）", () => {
  it("final → 放行", () => {
    expect(isCanonDualWriteEligible({ chapter_status: "final" })).toBe(true)
  })

  it("accepted → 放行（已 accept 章路径）", () => {
    expect(isCanonDualWriteEligible({ chapter_status: "accepted" })).toBe(true)
  })

  it("draft → 拦截（不写 canon）", () => {
    expect(isCanonDualWriteEligible({ chapter_status: "draft" })).toBe(false)
  })

  it("outline/revised/archived → 拦截", () => {
    expect(isCanonDualWriteEligible({ chapter_status: "outline" })).toBe(false)
    expect(isCanonDualWriteEligible({ chapter_status: "revised" })).toBe(false)
    expect(isCanonDualWriteEligible({ chapter_status: "archived" })).toBe(false)
  })

  it("chapter_status 缺失 / 非字符串 → 拦截", () => {
    expect(isCanonDualWriteEligible({})).toBe(false)
    expect(isCanonDualWriteEligible({ chapter_status: 5 })).toBe(false)
    expect(isCanonDualWriteEligible({ chapter_status: "FINAL" })).toBe(false)
  })
})

describe("buildCanonDualWriteOps（从 newCanonFacts 派生 episode 双写操作）", () => {
  it("无 newCanonFacts（undefined）→ 空操作集", async () => {
    const ops = await buildCanonDualWriteOps(snapshotWithFacts(undefined))
    expect(ops).toEqual([])
  })

  it("newCanonFacts 为空数组 → 空操作集", async () => {
    const ops = await buildCanonDualWriteOps(snapshotWithFacts([]))
    expect(ops).toEqual([])
  })

  it("每条新正史事实派生一个 episode 双写操作，digest 为 SHA-256 幂等键", async () => {
    const facts = ["主角佩剑名为黑剑", "码头设防"]
    const ops = await buildCanonDualWriteOps(snapshotWithFacts(facts))
    expect(ops).toHaveLength(2)

    const digest0 = await computeCheckpointDigestOf({ chapter: 1, fact: facts[0] })
    const digest1 = await computeCheckpointDigestOf({ chapter: 1, fact: facts[1] })

    expect(ops[0]!.digest).toBe(digest0)
    expect(ops[1]!.digest).toBe(digest1)

    expect(ops[0]!.canonPayload).toEqual({
      kind: "episode",
      episode: {
        id: "ch1-fact0",
        chapter_number: 1,
        entity_id: "chapter-1",
        summary: facts[0],
        digest: digest0,
      },
    })
    expect(ops[1]!.canonPayload).toEqual({
      kind: "episode",
      episode: {
        id: "ch1-fact1",
        chapter_number: 1,
        entity_id: "chapter-1",
        summary: facts[1],
        digest: digest1,
      },
    })
    // 旧 view 占位负载
    expect(ops[0]!.legacyPayload).toEqual({ kind: "snapshot_fact", chapterNumber: 1, fact: facts[0] })
    expect(ops[0]!.content).toEqual({ chapter: 1, fact: facts[0] })
  })
})

describe("runCanonDualWriteHook（单点双写钩子）", () => {
  it("deps 未注入 → 空操作（向后兼容，不触达 shadowWriteCanon）", async () => {
    const snap = snapshotWithFacts(["主角佩剑名为黑剑"])
    await expect(runCanonDualWriteHook(undefined, PROJECT, { chapter_status: "final" }, snap, 1234)).resolves.toBeUndefined()
  })

  it("章未 accept/final（draft=reject）→ 不写 canon", async () => {
    const deps = makeDeps()
    const snap = snapshotWithFacts(["主角佩剑名为黑剑"])
    await runCanonDualWriteHook(deps, PROJECT, { chapter_status: "draft" }, snap, 1234)
    expect(deps.writeCanon).not.toHaveBeenCalled()
    expect(deps.writeLegacy).not.toHaveBeenCalled()
  })

  it("final 但无新正史事实 → 无操作可双写，不写 canon", async () => {
    const deps = makeDeps()
    const snap = snapshotWithFacts([])
    await runCanonDualWriteHook(deps, PROJECT, { chapter_status: "final" }, snap, 1234)
    expect(deps.writeCanon).not.toHaveBeenCalled()
  })

  it("final + 新事实 → 调 shadowWriteCanon，两侧各一次（now 由入参提供）", async () => {
    const deps = makeDeps()
    const facts = ["主角佩剑名为黑剑", "码头设防"]
    const snap = snapshotWithFacts(facts)
    await runCanonDualWriteHook(deps, PROJECT, { chapter_status: "final" }, snap, 1234)
    expect(deps.writeCanon).toHaveBeenCalledTimes(2)
    expect(deps.writeLegacy).toHaveBeenCalledTimes(2)
    const digest0 = await computeCheckpointDigestOf({ chapter: 1, fact: facts[0] })
    expect((deps.writeCanon.mock.calls[0]![1] as { episode: unknown }).episode).toEqual({
      id: "ch1-fact0",
      chapter_number: 1,
      entity_id: "chapter-1",
      summary: facts[0],
      digest: digest0,
    })
  })

  it("shadowWriteCanon 抛 Error → 非致命告警，不阻断（双写失败落队异常路径）", async () => {
    const deps = makeDeps({
      writeCanon: vi.fn(async () => ({ ok: false, error: "canon boom" })),
      queueWrite: vi.fn(async () => {
        throw new Error("queue boom")
      }),
    })
    const snap = snapshotWithFacts(["主角佩剑名为黑剑"])
    await expect(runCanonDualWriteHook(deps, PROJECT, { chapter_status: "final" }, snap, 1234)).resolves.toBeUndefined()
    expect(deps.writeCanon).toHaveBeenCalled()
  })

  it("shadowWriteCanon 抛非 Error → String(err) 兜底，仍非致命不阻断", async () => {
    const deps = makeDeps({
      writeCanon: vi.fn(async () => ({ ok: false, error: "canon boom" })),
      queueWrite: vi.fn(async () => {
        throw "queue boom string"
      }),
    })
    const snap = snapshotWithFacts(["主角佩剑名为黑剑"])
    await expect(runCanonDualWriteHook(deps, PROJECT, { chapter_status: "final" }, snap, 1234)).resolves.toBeUndefined()
    expect(deps.writeCanon).toHaveBeenCalled()
  })
})

describe("ingestChapter — T16 双写钩子接入（reject 先于双写）", () => {
  it("final 章 + 新正史事实 → 触发 canon 双写（每条事实一个 episode）", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({ newCanonFacts: ["主角佩剑名为黑剑", "码头设防"] }))

    const deps = makeDeps()
    const result = await ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, { canonDualWriteDeps: deps })

    expect(result.snapshot).not.toBeNull()
    expect(result.snapshot!.chapterNumber).toBe(1)
    // 双写被触发：两个新事实 → 两次 canon 写
    expect(deps.writeCanon).toHaveBeenCalledTimes(2)
    const firstEpisode = (deps.writeCanon.mock.calls[0]![1] as { episode: { summary: string } }).episode
    expect(firstEpisode.summary).toBe("主角佩剑名为黑剑")
  })

  it("未注入 canonDualWriteDeps → 旧行为，不触发双写（零回归）", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({ newCanonFacts: ["主角佩剑名为黑剑"] }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
  })

  it("draft 章 → early-return not_final，根本不触达双写（reject 先于双写断言）", async () => {
    fsMocks.readFile.mockResolvedValueOnce(chapterContent({ chapter_status: "draft" }))
    const deps = makeDeps()
    const result = await ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, { canonDualWriteDeps: deps })
    expect(result).toEqual({ snapshot: null, failReason: "not_final" })
    expect(deps.writeCanon).not.toHaveBeenCalled()
  })
})

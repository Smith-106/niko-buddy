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
  writeFilesAtomic: vi.fn(),
  listDirectory: vi.fn(),
  fileExists: vi.fn(),
  createDirectory: vi.fn(),
  deleteFile: vi.fn(),
}))

const sourceFs = vi.hoisted(() => ({
  chapterPath: "E:/Novel/wiki/chapters/chapter-001.md",
  chapterSource: null as string | null,
  chapterSequence: [] as Array<string | Error>,
}))

/**
 * MF-01: 显式 chapterPath 保持稳定正文（初始 read 与提交前同路径复查同源），
 * unrelated paths 仍走各用例原本的 per-test 行为（ENOENT/错误/wiki-patch）。
 */
function mockChapterSource(content: string, path: string = sourceFs.chapterPath): void {
  sourceFs.chapterPath = path
  sourceFs.chapterSource = content
  sourceFs.chapterSequence = []
}

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
      readFile: (path: unknown) => {
        const p = String(path)
        if (p === sourceFs.chapterPath) {
          const queued = sourceFs.chapterSequence.shift()
          if (queued instanceof Error) return Promise.reject(queued)
          if (typeof queued === "string") return Promise.resolve(queued)
          if (sourceFs.chapterSource !== null) return Promise.resolve(sourceFs.chapterSource)
        }
        return fsMocks.readFile(path)
      },
      writeFileAtomic: (...args: unknown[]) => fsMocks.writeFileAtomic(...args),
      writeFilesAtomic: (...args: unknown[]) => fsMocks.writeFilesAtomic(...args),
      listDirectory: (...args: unknown[]) => fsMocks.listDirectory(...args),
      fileExists: (...args: unknown[]) => fsMocks.fileExists(...args),
      createDirectory: (...args: unknown[]) => fsMocks.createDirectory(...args),
      deleteFile: (...args: unknown[]) => fsMocks.deleteFile(...args),
    
  }
})

const streamChatMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
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
    
  }
})

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

vi.mock("@/lib/graph-relevance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/graph-relevance")>()
  return {
    ...actual,
      clearGraphCache: (...args: unknown[]) => moduleMocks.clearGraphCache(...args),
    
  }
})

vi.mock("./context-engine", () => ({
  clearTemporalFactsCache: (...args: unknown[]) => moduleMocks.clearTemporalFactsCache(...args),
}))

vi.mock("@/lib/dedup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dedup")>()
  return {
    ...actual,
      buildEntityLinkIndex: (...args: unknown[]) => moduleMocks.buildEntityLinkIndex(...args),
      resolveEntityLink: (...args: unknown[]) => moduleMocks.resolveEntityLink(...args),
      extractEntitySummary: (...args: unknown[]) => moduleMocks.extractEntitySummary(...args),
    
  }
})

vi.mock("./memory-op", () => ({
  planAddOpsFromCanonFacts: (...args: unknown[]) => moduleMocks.planAddOpsFromCanonFacts(...args),
  applyMemoryOps: (...args: unknown[]) => moduleMocks.applyMemoryOps(...args),
}))

vi.mock("@/lib/embedding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embedding")>()
  return {
    ...actual,
      embedPage: (...args: unknown[]) => moduleMocks.embedPage(...args),
    
  }
})

import {
  buildCanonDualWriteOps,
  ingestChapter,
  isCanonDualWriteEligible,
  parseFactsSubject,
  runCanonDualWriteHook,
  runCanonDualWriteHookOutcome,
  type ChapterSnapshot,
} from "./chapter-ingest"
import { buildChapterIngestOutput } from "./chapter-ingest-output"
import { parseFrontmatter } from "@/lib/frontmatter"
import { computeCheckpointDigest, computeCheckpointDigestOf } from "./checkpoint-digest"
import type { CanonDualWriteDeps } from "./canon-dual-write"

const PROJECT = "E:/Novel"
const CHAPTER_PATH = sourceFs.chapterPath

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
  sourceFs.chapterPath = "E:/Novel/wiki/chapters/chapter-001.md"
  sourceFs.chapterSource = null
  sourceFs.chapterSequence = []
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
  fsMocks.writeFilesAtomic.mockResolvedValue(undefined)
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

  it("T3：beliefFacts/hypothesisFacts 派生 supersede 边 ops（modality 承载，digest 键含 modality）", async () => {
    const ops = await buildCanonDualWriteOps({
      ...snapshotWithFacts(["正史事实"]),
      beliefFacts: [{ subject: "林晚", predicate: "认为", object: "沈舟是凶手" }],
      hypothesisFacts: [{ subject: "沈舟", predicate: "猜测", object: "地宫有密道" }],
    })
    // 1 episode + 2 modality ops
    expect(ops).toHaveLength(3)

    const belief = ops[1]!
    expect(belief.canonPayload.kind).toBe("supersede")
    const request = (belief.canonPayload as {
      kind: "supersede"
      request: {
        old_edge_ids: unknown[]
        cap_chapter: number
        caused_by: string
        new_edges: Array<Record<string, unknown>>
      }
    }).request
    expect(request.old_edge_ids).toEqual([])
    expect(request.cap_chapter).toBe(1)
    expect(request.caused_by).toBe("snapshot-modality-facts")
    expect(request.new_edges).toHaveLength(1)
    const edge = request.new_edges[0]!
    expect(edge.source_id).toBe("林晚")
    expect(edge.target_id).toBe("沈舟是凶手")
    expect(edge.predicate).toBe("认为")
    expect(edge.edge_kind).toBe("world_fact")
    expect(edge.valid_at).toBe(1)
    expect(edge.modality).toBe("belief")
    expect(edge.digest).toBe(await computeCheckpointDigestOf({ chapter: 1, modality: "belief", fact: "林晚认为沈舟是凶手" }))

    const hypothesis = ops[2]!
    const hEdge = (hypothesis.canonPayload as { kind: "supersede"; request: { new_edges: Array<Record<string, unknown>> } }).request.new_edges[0]!
    expect(hEdge.modality).toBe("hypothesis")
    expect(hypothesis.legacyPayload).toEqual({
      kind: "snapshot_modality_fact",
      chapterNumber: 1,
      modality: "hypothesis",
      subject: "沈舟",
      predicate: "猜测",
      object: "地宫有密道",
    })
  })

  it("T3：仅模态事实（无 newCanonFacts）也派生 ops；两者皆空仍返回空", async () => {
    const onlyModal = await buildCanonDualWriteOps({
      ...snapshotWithFacts([]),
      beliefFacts: [{ subject: "甲", predicate: "相信", object: "乙已离开" }],
    })
    expect(onlyModal).toHaveLength(1)
    expect(onlyModal[0]!.canonPayload.kind).toBe("supersede")

    const none = await buildCanonDualWriteOps(snapshotWithFacts(undefined))
    expect(none).toEqual([])
  })
})

describe("runCanonDualWriteHook（单点双写钩子）", () => {
  it("deps 未注入 → skipped/no_deps（向后兼容，不触达 shadowWriteCanon）", async () => {
    const snap = snapshotWithFacts(["主角佩剑名为黑剑"])
    await expect(runCanonDualWriteHookOutcome(undefined, PROJECT, { chapter_status: "final" }, snap, 1234)).resolves.toEqual({
      status: "skipped",
      reason: "no_deps",
    })
  })

  it("章未 accept/final（draft=reject）→ skipped/not_eligible，不写 canon", async () => {
    const deps = makeDeps()
    const snap = snapshotWithFacts(["主角佩剑名为黑剑"])
    await expect(
      runCanonDualWriteHookOutcome(deps, PROJECT, { chapter_status: "draft" }, snap, 1234),
    ).resolves.toEqual({ status: "skipped", reason: "not_eligible" })
    expect(deps.writeCanon).not.toHaveBeenCalled()
    expect(deps.writeLegacy).not.toHaveBeenCalled()
  })

  it("final 但无新正史事实 → skipped/no_facts，不写 canon", async () => {
    const deps = makeDeps()
    const snap = snapshotWithFacts([])
    await expect(
      runCanonDualWriteHookOutcome(deps, PROJECT, { chapter_status: "final" }, snap, 1234),
    ).resolves.toEqual({ status: "skipped", reason: "no_facts" })
    expect(deps.writeCanon).not.toHaveBeenCalled()
  })

  it("final + 新事实 → completed + 原 ShadowWriteReport（两侧各一次，now 由入参提供）", async () => {
    const deps = makeDeps()
    const facts = ["主角佩剑名为黑剑", "码头设防"]
    const snap = snapshotWithFacts(facts)
    const outcome = await runCanonDualWriteHookOutcome(deps, PROJECT, { chapter_status: "final" }, snap, 1234)
    expect(outcome.status).toBe("completed")
    if (outcome.status !== "completed") throw new Error("expected completed outcome")
    expect(outcome.report.written).toBe(2)
    expect(outcome.report.queued).toBe(0)
    expect(outcome.report.reconcile.consistent).toBe(true)
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
    await expect(runCanonDualWriteHookOutcome(deps, PROJECT, { chapter_status: "final" }, snap, 1234)).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("queue boom"),
    })
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
    await expect(runCanonDualWriteHookOutcome(deps, PROJECT, { chapter_status: "final" }, snap, 1234)).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("queue boom string"),
    })
    expect(deps.writeCanon).toHaveBeenCalled()
  })

  it("legacy runCanonDualWriteHook 仍保持 Promise<void> 契约（副作用同一实现，回返值不变）", async () => {
    const deps = makeDeps()
    const snap = snapshotWithFacts(["主角佩剑名为黑剑"])
    await expect(
      runCanonDualWriteHook(deps, PROJECT, { chapter_status: "final" }, snap, 1234),
    ).resolves.toBeUndefined()
    expect(deps.writeCanon).toHaveBeenCalledTimes(1)
    expect(deps.writeLegacy).toHaveBeenCalledTimes(1)
  })
})

describe("ingestChapter — T16 双写钩子接入（reject 先于双写）", () => {
  it("final 章 + 新正史事实 → 触发 canon 双写（每条事实一个 episode）", async () => {
    mockChapterSource(chapterContent())
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

  it("54 ③: facts-store 接线——final 章 newCanonFacts 写入 facts.json (ADR-26 唯一真源)", async () => {
    mockChapterSource(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({ newCanonFacts: ["主角：佩剑名为黑剑", "码头设防"] }))
    // facts.json 不存在 → 空表重建
    fsMocks.readFile.mockRejectedValueOnce(new Error("ENOENT"))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    // facts.json 被写入且含两条事实 + episode 溯源
    const writeCall = fsMocks.writeFileAtomic.mock.calls.find((c) => String(c[0]).endsWith("facts.json"))
    expect(writeCall).toBeDefined()
    const written = JSON.parse(String(writeCall![1]))
    expect(written.schema_version).toBe("facts/1.0")
    expect(written.facts).toHaveLength(2)
    expect(written.facts[0]!.subject).toBe("主角")
    expect(written.facts[0]!.object).toBe("主角：佩剑名为黑剑")
    expect(written.facts[0]!.valid_at).toBe(1)
    expect(written.episodes).toHaveLength(1)
    expect(written.episodes[0]!.chapter).toBe(1)
  })

  it("54 ③: subject 解析排除误切——「名为/称为/因为/作为」不切分, 冒号仍优先", async () => {
    mockChapterSource(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({ newCanonFacts: ["主角：佩剑名为黑剑"] }))
    // facts.json 不存在 → 空表重建
    fsMocks.readFile.mockRejectedValueOnce(new Error("ENOENT"))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
    const writeCall = fsMocks.writeFileAtomic.mock.calls.find((c) => String(c[0]).endsWith("facts.json"))
    expect(writeCall).toBeDefined()
    const written = JSON.parse(String(writeCall![1]))
    // 冒号优先切分 → subject=主角 (即便后续有「名为」也不误切)
    expect(written.facts[0]!.subject).toBe("主角")
    // lookbehind: 无冒号时「李四被称为王」→ 不在「为」处切分, subject 回退 rawFact 前 20 字
    let subject = parseFactsSubject("李四被称为王")
    expect(subject).toContain("李四被称为王")
    subject = parseFactsSubject("主角因为愤怒离开")
    expect(subject).toContain("主角因为愤怒离开")
    subject = parseFactsSubject("赵六作为队长")
    expect(subject).toContain("赵六作为队长")
    subject = parseFactsSubject("李四成为队长")
    // 「成为」非排除词: 在「为」处切 → subject=李四成
    expect(subject.startsWith("李四成")).toBe(true)
    subject = parseFactsSubject("张三属于甲队")
    expect(subject).toBe("张三")
  })

  it("未注入 canonDualWriteDeps → 旧行为，不触发双写（零回归）", async () => {
    mockChapterSource(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({ newCanonFacts: ["主角佩剑名为黑剑"] }))
    const result = await ingestChapter(PROJECT, CHAPTER_PATH)
    expect(result.snapshot).not.toBeNull()
  })

  it("draft 章 → early-return not_final，根本不触达双写（reject 先于双写断言）", async () => {
    mockChapterSource(chapterContent({ chapter_status: "draft" }))
    const deps = makeDeps()
    const result = await ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, { canonDualWriteDeps: deps })
    expect(result).toEqual({ snapshot: null, failReason: "not_final" })
    expect(deps.writeCanon).not.toHaveBeenCalled()
  })
})

describe("ingestChapter — 提交点实源绑定与归一化消费者连接", () => {
  const FIXED_NOW = "2026-11-20T00:00:00.000Z"
  const CHAPTER_62_PATH = `${PROJECT}/wiki/chapters/chapter-062.md`

  function chapter62Content(): string {
    return chapterContent({ chapter_number: 62, title: "第62章 雪夜" })
  }

  it("fixture：normalized-consumer 前后 output JSON 字节与 Canon op digest 不变（真实 buildChapterIngestOutput/buildCanonDualWriteOps + 真实 saver 写盘 JSON）", async () => {
    mockChapterSource(chapter62Content(), CHAPTER_62_PATH)
    mockLlmJsonResponse(llmSnapshotJson({
      chapterNumber: 62,
      newCanonFacts: ["主角佩剑名为黑剑", "码头设防"],
      beliefFacts: [{ subject: "阿宁", predicate: "认为", object: "沈舟是凶手" }],
      hypothesisFacts: [],
    }))
    const deps = makeDeps()

    const result = await ingestChapter(PROJECT, CHAPTER_62_PATH, undefined, undefined, { canonDualWriteDeps: deps })
    expect(result.snapshot).not.toBeNull()

    // 真实 saver 写盘 JSON：第一份 062.snapshot.json 属提交点（后续 sync 会再物化）。
    const snapshotBatch = fsMocks.writeFilesAtomic.mock.calls
      .map(([files]) => files as Array<[string, string]>)
      .flat()
      .find(([p]) => String(p).endsWith(".novel/snapshots/062.snapshot.json"))
    expect(snapshotBatch).toBeDefined()
    const savedSnapshotJson = String(snapshotBatch![1])
    const savedSnapshot = JSON.parse(savedSnapshotJson) as ChapterSnapshot

    // 旧消费者（pre-commit snapshot）vs 新消费者（saver 实际返回值）：逐字节相同。
    const outputBefore = JSON.stringify(
      buildChapterIngestOutput(result.snapshot!, { title: "第62章 雪夜", now: FIXED_NOW }),
      null,
      2,
    )
    const outputAfter = JSON.stringify(
      buildChapterIngestOutput(savedSnapshot, { title: "第62章 雪夜", now: FIXED_NOW }),
      null,
      2,
    )
    expect(outputAfter).toBe(outputBefore)
    expect(await computeCheckpointDigest(outputAfter)).toBe(await computeCheckpointDigest(outputBefore))

    // Canon 操作集：同一事实集 → 相同 digest / payload（不因 normalized 身份变化）。
    const opsBefore = await buildCanonDualWriteOps(result.snapshot!)
    const opsAfter = await buildCanonDualWriteOps(savedSnapshot)
    expect(opsBefore).toHaveLength(3)
    expect(opsAfter.map((op) => op.digest)).toEqual(opsBefore.map((op) => op.digest))
    // 捕获本次真实 fixture 字节/digest 值（探测输出契约不变）。
    expect({
      outputCodeUnits: outputBefore.length,
      outputSha256: await computeCheckpointDigest(outputBefore),
      canonDigests: opsBefore.map((op) => op.digest),
      canonPayloadDigest: await computeCheckpointDigestOf(opsBefore.map((op) => op.canonPayload)),
    }).toEqual({
      outputCodeUnits: 8660,
      outputSha256: "a848f17936730b054a336282ccd8fe734a84f0b418c1088e8a009ec1b15213cc",
      canonDigests: [
        "967a4f8e09ae870ad3168b7999f7bb9f1536b583aeaaed075234239d977974a7",
        "18370a812865156b414f1f66ec75cea0ee5ad8596cbfcf9b13052458c59cbb2e",
        "93adf5bbc3c90c03b01ff8afac38d1a571e1cb1961df653c973df8cf14ba707f",
      ],
      canonPayloadDigest: "acbc1240566d0547fbfdb770b340625aa96152a81245e7ce9e99e2e1b2f4f676",
    })
    expect(await computeCheckpointDigestOf(opsAfter.map((op) => op.canonPayload)))
      .toBe(await computeCheckpointDigestOf(opsBefore.map((op) => op.canonPayload)))

    // receipt.snapshotJsonSha256 绑定 saver 实际写入字节（真实 normalized JSON 身份）。
    expect(result.receipt?.snapshotJsonSha256AtExtractionCommit).toBe(await computeCheckpointDigest(savedSnapshotJson))
    expect(savedSnapshot.revision).toBe(1)
    expect(savedSnapshot.snapshotId).toBe("chapter-62-r1")
    // ingest 返回体/后续投影输入保持 pre-commit snapshot 语义（无新身份字段）。
    expect(result.snapshot?.revision).toBeUndefined()
    expect(result.snapshot?.snapshotId).toBeUndefined()

    // 同一 read 的完整源摘要（parsed.body / content 原始字符串），readPath 为精确实参。
    const content = chapter62Content()
    const parsed = parseFrontmatter(content)
    expect(result.sourceBinding).toEqual({
      readPath: CHAPTER_62_PATH,
      chapterNumber: 62,
      bodySha256: await computeCheckpointDigest(parsed.body),
      contentSha256: await computeCheckpointDigest(content),
    })
    // 对外源引用/receipt 只有无正文摘要，不携带原文或持久新字段。
    expect(Object.keys(result.sourceBinding!).sort()).toEqual(
      ["bodySha256", "chapterNumber", "contentSha256", "readPath"].sort(),
    )
    expect(Object.keys(result.receipt!).sort()).toEqual(
      [
        "bodySha256",
        "canonOutcome",
        "chapterNumber",
        "contentSha256",
        "readPath",
        "snapshotIdAtExtractionCommit",
        "snapshotJsonSha256AtExtractionCommit",
        "snapshotRevisionAtExtractionCommit",
      ].sort(),
    )
    const published = JSON.stringify({ sourceBinding: result.sourceBinding, receipt: result.receipt })
    expect(published).not.toContain("正文内容")
    expect(published).not.toContain("originalContent")
    expect(published).not.toMatch(/bodyRevision|formalBodyRevision/)
  })

  it("snapshot revision 7、Canon 写响应 max_revision 23、正文 revision unknown 分域可见", async () => {
    mockChapterSource(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({
      revision: 7,
      newCanonFacts: ["主角佩剑名为黑剑"],
    }))
    const writeCanon = vi.fn(async () => ({ ok: true, revision: 23 }))
    const deps = makeDeps({ writeCanon })

    const result = await ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, { canonDualWriteDeps: deps })
    expect(result.receipt?.snapshotRevisionAtExtractionCommit).toBe(7)
    expect(result.canonOutcome?.status).toBe("completed")
    const outcome = result.canonOutcome
    if (outcome?.status !== "completed") throw new Error("expected completed canon outcome")
    expect(outcome.report.results.map((r) => r.canon.revision)).toEqual([23])
    // 正文 revision 无真源 → sourceBinding 无该字段；snapshot revision / Canon max_revision 不交叉复制。
    expect(JSON.stringify(result.sourceBinding)).not.toContain("revision")
    expect(result.receipt?.snapshotRevisionAtExtractionCommit).not.toBe(outcome.report.results[0]!.canon.revision)
  })

  it("Canon 部分失败入队 → canonOutcome 原样携带 per-op outcome/queued，不装饰成全部成功", async () => {
    mockChapterSource(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({ newCanonFacts: ["主角佩剑名为黑剑", "码头设防"] }))
    let calls = 0
    const deps = makeDeps({
      writeCanon: vi.fn(async () => {
        calls += 1
        return calls === 1 ? { ok: true, revision: 5 } : { ok: false, error: "canon boom" }
      }),
    })

    const result = await ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, { canonDualWriteDeps: deps })
    expect(result.snapshot).not.toBeNull()
    const outcome = result.canonOutcome
    if (outcome?.status !== "completed") throw new Error("expected completed canon outcome")
    expect(outcome.report.written).toBe(1)
    expect(outcome.report.queued).toBe(1)
    expect(outcome.report.results.map((r) => r.canon.ok)).toEqual([true, false])
    expect(outcome.report.results[1]!.canon.error).toBe("canon boom")
    expect(outcome.report.reconcile.consistent).toBe(false)
    // ingest 四态不变：snapshot 成功仍 ok（Canon 状态另列，不篡改 ingest 语义）。
    expect(result.receipt?.canonOutcome).toEqual(outcome)
  })

  it("无新正史事实且 canon deps 存在 → canonOutcome 为 skipped/no_facts，snapshot 仍成功", async () => {
    mockChapterSource(chapterContent())
    mockLlmJsonResponse(llmSnapshotJson({ newCanonFacts: [], beliefFacts: [], hypothesisFacts: [] }))
    const deps = makeDeps()

    const result = await ingestChapter(PROJECT, CHAPTER_PATH, undefined, undefined, { canonDualWriteDeps: deps })
    expect(result.snapshot).not.toBeNull()
    expect(result.canonOutcome).toEqual({ status: "skipped", reason: "no_facts" })
    expect(deps.writeCanon).not.toHaveBeenCalled()
  })
})

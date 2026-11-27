// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_NOVEL_CONFIG, type LlmConfig } from "@/stores/wiki-store"
import { computeCheckpointDigest } from "./checkpoint-digest"
import type { ChapterSnapshot, IngestResult } from "./chapter-ingest"
import {
  buildInteractiveIngestPrompt,
  commitInteractiveChapterSnapshot,
  detectAntigravityMemoryMode,
  prepareInteractiveChapterSnapshot,
  type PreparedInteractiveChapterSnapshot,
} from "./antigravity-hybrid-ingest"

const mocks = vi.hoisted(() => ({
  resolveIngestTarget: vi.fn(),
  assertUniqueFinalChapterSource: vi.fn(),
  linkSnapshotEntities: vi.fn(),
  validateEntityReferences: vi.fn(),
  validateCanonConflicts: vi.fn(),
  runTruthAuthorityCheck: vi.fn(),
  commitPreparedChapterIngest: vi.fn(),
  readBackMemoryIngest: vi.fn(),
}))

vi.mock("./chapter-ingest-ingest-guards", () => ({
  resolveIngestTarget: mocks.resolveIngestTarget,
}))

vi.mock("./snapshot-scanner", () => ({
  assertUniqueFinalChapterSource: mocks.assertUniqueFinalChapterSource,
}))

vi.mock("./chapter-ingest-entity-validation", () => ({
  linkSnapshotEntities: mocks.linkSnapshotEntities,
  validateEntityReferences: mocks.validateEntityReferences,
  validateCanonConflicts: mocks.validateCanonConflicts,
}))

vi.mock("./truth-authority-adapter", () => ({
  runTruthAuthorityCheck: mocks.runTruthAuthorityCheck,
}))

vi.mock("./chapter-ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chapter-ingest")>()
  return {
    ...actual,
    commitPreparedChapterIngest: mocks.commitPreparedChapterIngest,
  }
})

vi.mock("./accept-draft-with-ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accept-draft-with-ingest")>()
  return {
    ...actual,
    readBackMemoryIngest: mocks.readBackMemoryIngest,
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.assertUniqueFinalChapterSource.mockResolvedValue(undefined)
  mocks.linkSnapshotEntities.mockResolvedValue([])
  mocks.validateEntityReferences.mockResolvedValue([])
  mocks.validateCanonConflicts.mockResolvedValue([])
  mocks.runTruthAuthorityCheck.mockReturnValue([])
})

describe("detectAntigravityMemoryMode (Watchlist #7 null-safe)", () => {
  it("所有参数为 undefined 或 null 时安全返回 pure_subscription，不抛 TypeError", () => {
    const undefRes = detectAntigravityMemoryMode()
    expect(undefRes).toEqual({
      mode: "pure_subscription",
      canAutoExtract: false,
      autoIngestOnSave: true,
      autoIngestReady: false,
      embeddingEnabled: false,
      extractModelLabel: null,
      reasonCode: "no_extract_model_configured",
    })

    const nullRes = detectAntigravityMemoryMode(null, null, null, null)
    expect(nullRes).toEqual(undefRes)

    const partialStore = detectAntigravityMemoryMode(
      { provider: "openai", apiKey: "", model: "", ollamaUrl: "", customEndpoint: "", maxContextSize: 128000 },
      { extractModel: "google/gemini-2.5-flash", autoIngestOnSave: false },
      { enabled: true },
      { providerConfigs: undefined },
    )
    expect(partialStore.mode).toBe("pure_subscription")
    expect(partialStore.autoIngestOnSave).toBe(false)
    expect(partialStore.autoIngestReady).toBe(false)
    expect(partialStore.embeddingEnabled).toBe(true)
  })

  it("退休的 antigravity-cli 永不视为可用 LLM（ToS 合规）", () => {
    const retiredLlm: LlmConfig = {
      provider: "antigravity-cli",
      apiKey: "fake",
      model: "gemini-2.5-pro",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    }
    const info = detectAntigravityMemoryMode(retiredLlm, DEFAULT_NOVEL_CONFIG)
    expect(info.mode).toBe("pure_subscription")
    expect(info.canAutoExtract).toBe(false)
    expect(info.extractModelLabel).toBeNull()
  })

  it("仅配置专用廉价/本地 extractModel（主模型无 Key）时识别为 golden_hybrid", () => {
    const emptyMain: LlmConfig = {
      provider: "openai",
      apiKey: "",
      model: "",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    }
    const info = detectAntigravityMemoryMode(
      emptyMain,
      { ...DEFAULT_NOVEL_CONFIG, extractModel: "google/gemini-2.5-flash", autoIngestOnSave: true },
      { enabled: false },
      {
        providerConfigs: {
          google: {
            apiKey: "AIza-extract-key",
            savedModels: [{ id: "m1", name: "Gemini 2.5 Flash", model: "gemini-2.5-flash", createdAt: 1 }],
          },
        },
      },
    )
    expect(info).toEqual({
      mode: "golden_hybrid",
      canAutoExtract: true,
      autoIngestOnSave: true,
      autoIngestReady: true,
      embeddingEnabled: false,
      extractModelLabel: "google/gemini-2.5-flash",
      reasonCode: "dedicated_extract_model_configured",
    })
  })

  it("主模型可用且未另设 extractModel 时识别为 full_api；autoIngestOnSave=false 时 autoIngestReady=false", () => {
    const mainLlm: LlmConfig = {
      provider: "openai",
      apiKey: "sk-main",
      model: "gpt-4.1",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    }
    const full = detectAntigravityMemoryMode(
      mainLlm,
      { ...DEFAULT_NOVEL_CONFIG, extractModel: "", autoIngestOnSave: true },
      { enabled: true },
      { providerConfigs: {} },
    )
    expect(full).toEqual({
      mode: "full_api",
      canAutoExtract: true,
      autoIngestOnSave: true,
      autoIngestReady: true,
      embeddingEnabled: true,
      extractModelLabel: "openai/gpt-4.1",
      reasonCode: "full_api_configured",
    })

    const manualSave = detectAntigravityMemoryMode(
      mainLlm,
      { ...DEFAULT_NOVEL_CONFIG, extractModel: "", autoIngestOnSave: false },
      { enabled: false },
      { providerConfigs: {} },
    )
    expect(manualSave.mode).toBe("full_api")
    expect(manualSave.autoIngestOnSave).toBe(false)
    expect(manualSave.autoIngestReady).toBe(false)
  })
})

describe("buildInteractiveIngestPrompt", () => {
  it("生成中/英双语提示词，严格要求只用 chapter.read、禁止写工具并输出单一 JSON 代码块", () => {
    const zh = buildInteractiveIngestPrompt({
      chapterNumber: 12,
      chapterPath: "/proj/wiki/chapters/chapter-012.md",
      chapterTitle: "雾港听雨",
    })
    expect(zh).toContain("chapter.read")
    expect(zh).toContain("严禁调用任何写入工具")
    expect(zh).toContain('"chapterId": "chapter-12"')
    expect(zh).toContain('"chapterNumber": 12')
    expect(zh).toContain("beliefFacts")
    expect(zh).toContain("hypothesisFacts")
    expect(zh).toContain("arcChange")
    expect(zh).toContain('"holder"')
    expect(zh).toContain('"previousHolders"')
    expect(zh).toContain("新增伏笔：伏笔名称-伏笔描述")
    expect(zh).toContain("推进伏笔：伏笔名称-推进进展")
    expect(zh).toContain("回收伏笔：伏笔名称-回收结果")
    expect(zh).toContain("characterDetails.<name>.arcChange")
    expect(zh).toContain("itemDetails.<item>.holder")

    const en = buildInteractiveIngestPrompt({
      chapterNumber: 3,
      chapterPath: "/proj/wiki/chapters/chapter-003.md",
      lang: "en-US",
    })
    expect(en).toContain("chapter.read")
    expect(en).toContain("Do NOT call any write tools")
    expect(en).toContain('"chapterNumber": 3')
    expect(en).toContain("characterDetails.<name>.arcChange")
    expect(en).toContain("itemDetails.<item>.holder")
    expect(en).toContain("itemDetails.<item>.previousHolders")
    expect(en).toContain("新增伏笔：伏笔名称-伏笔描述")
    expect(en).toContain("推进伏笔：伏笔名称-推进进展")
    expect(en).toContain("回收伏笔：伏笔名称-回收结果")
  })

  it("非法章号或空路径抛错", () => {
    expect(() =>
      buildInteractiveIngestPrompt({ chapterNumber: 0, chapterPath: "/proj/wiki/chapters/ch1.md" }),
    ).toThrow(/chapterNumber/)
    expect(() =>
      buildInteractiveIngestPrompt({ chapterNumber: 1, chapterPath: "   " }),
    ).toThrow(/chapterPath/)
  })
})

describe("prepareInteractiveChapterSnapshot (Watchlist #9 只读两段式)", () => {
  const sampleBody = "雨夜中，陈砚推开铁门，在旧账本里发现了失踪十年的线索。"
  const sampleContent = `---\ntype: chapter\nchapter_number: 5\nchapter_status: final\ntitle: "第5章 铁门"\n---\n\n${sampleBody}`

  function mockReadyTarget() {
    mocks.resolveIngestTarget.mockResolvedValue({
      ok: true,
      pp: "/proj",
      runtimeLlmConfig: { provider: "openai", apiKey: "", model: "", maxContextSize: 128000 },
      llmConfig: { provider: "openai", apiKey: "", model: "", maxContextSize: 128000 },
      novelConfig: DEFAULT_NOVEL_CONFIG,
      chapterNumber: 5,
      body: sampleBody,
      content: sampleContent,
      fm: { type: "chapter", chapter_number: 5, chapter_status: "final", title: "第5章 铁门" },
    })
  }

  it("零 LLM Key 下成功解析 fenced JSON、计算精确 SHA-256 源绑定并在克隆体上运行只读校验", async () => {
    mockReadyTarget()
    mocks.validateEntityReferences.mockImplementation(async (_pp: string, snap: ChapterSnapshot) => {
      snap.entityIsNew = { 陈砚: true }
      return [{ type: "entity_new", message: "新人物: 陈砚" }]
    })
    mocks.validateCanonConflicts.mockResolvedValue([
      { type: "canon_conflict", message: "潜在冲突" },
    ])

    const rawText = [
      "以下是提取结果：",
      "```json",
      JSON.stringify({
        chapterId: "chapter-5",
        chapterNumber: 5,
        summary: "陈砚在雨夜发现旧账本线索。",
        characters: ["小砚"],
        characterAliases: { 陈砚: ["小砚"] },
        locations: ["雾港铁门"],
        events: ["发现旧账本"],
        newCanonFacts: ["旧账本记载了十年前的交易"],
        revision: 99,
        snapshotId: "forged-id",
      }),
      "```",
    ].join("\n")

    const res = await prepareInteractiveChapterSnapshot(
      "/proj",
      "/proj/wiki/chapters/chapter-005.md",
      5,
      rawText,
      { novelMode: true },
    )

    expect(mocks.resolveIngestTarget).toHaveBeenCalledWith(
      "/proj",
      "/proj/wiki/chapters/chapter-005.md",
      { novelMode: true, requireUniqueFinalChapter: true },
      { requireExtractionModel: false },
    )
    expect(mocks.assertUniqueFinalChapterSource).toHaveBeenCalledWith(
      "/proj",
      "/proj/wiki/chapters/chapter-005.md",
      5,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error("expected ok")

    expect(res.prepared.chapterNumber).toBe(5)
    expect(res.prepared.chapterPath).toBe("/proj/wiki/chapters/chapter-005.md")
    expect(res.prepared.prepared.source.bodySha256).toBe(await computeCheckpointDigest(sampleBody))
    expect(res.prepared.prepared.source.contentSha256).toBe(await computeCheckpointDigest(sampleContent))
    // 外部不可信身份字段已被剥离
    expect(res.prepared.prepared.snapshot.revision).toBeUndefined()
    expect(res.prepared.prepared.snapshot.snapshotId).toBeUndefined()
    // 人物别名归一生效
    expect(res.prepared.prepared.snapshot.characters).toContain("陈砚")
    // 预览与校验警告来自克隆体，不污染 prepared.snapshot.entityIsNew
    expect(res.prepared.validationWarnings).toHaveLength(2)
    expect(res.prepared.snapshot.entityIsNew).toEqual({ 陈砚: true })
    expect(res.prepared.prepared.snapshot.entityIsNew).toEqual({})
    expect(res.prepared.preview).toContain("陈砚")
    expect(mocks.commitPreparedChapterIngest).not.toHaveBeenCalled()
  })

  it("拒绝章号不匹配、空快照、非 JSON、非 final 或重复正式章", async () => {
    mockReadyTarget()

    const wrongChapter = await prepareInteractiveChapterSnapshot(
      "/proj",
      "/proj/wiki/chapters/chapter-005.md",
      5,
      JSON.stringify({ chapterNumber: 6, summary: "错误章号" }),
    )
    expect(wrongChapter.ok).toBe(false)
    if (!wrongChapter.ok) expect(wrongChapter.errorCode).toBe("snapshot_chapter_mismatch")

    const emptySnap = await prepareInteractiveChapterSnapshot(
      "/proj",
      "/proj/wiki/chapters/chapter-005.md",
      5,
      JSON.stringify({ chapterNumber: 5, summary: "   ", characters: [] }),
    )
    expect(emptySnap.ok).toBe(false)
    if (!emptySnap.ok) expect(emptySnap.errorCode).toBe("empty_snapshot")

    const noJson = await prepareInteractiveChapterSnapshot(
      "/proj",
      "/proj/wiki/chapters/chapter-005.md",
      5,
      "这里没有任何大括号",
    )
    expect(noJson.ok).toBe(false)
    if (!noJson.ok) expect(noJson.errorCode).toBe("no_json_found")

    mocks.resolveIngestTarget.mockResolvedValueOnce({
      ok: false,
      result: { snapshot: null, failReason: "not_final" },
    })
    const notFinal = await prepareInteractiveChapterSnapshot(
      "/proj",
      "/proj/wiki/chapters/chapter-005.md",
      5,
      JSON.stringify({ chapterNumber: 5, summary: "ok" }),
    )
    expect(notFinal.ok).toBe(false)
    if (!notFinal.ok) expect(notFinal.errorCode).toBe("not_final")

    mockReadyTarget()
    mocks.assertUniqueFinalChapterSource.mockRejectedValueOnce(
      new Error("第 5 章存在多个正式章文件，请先处理冲突"),
    )
    const dup = await prepareInteractiveChapterSnapshot(
      "/proj",
      "/proj/wiki/chapters/chapter-005.md",
      5,
      JSON.stringify({ chapterNumber: 5, summary: "ok" }),
    )
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.errorCode).toBe("duplicate_chapter_number")
  })
})

describe("commitInteractiveChapterSnapshot", () => {
  const validPrepared: PreparedInteractiveChapterSnapshot = {
    chapterPath: "/proj/wiki/chapters/chapter-005.md",
    chapterNumber: 5,
    preview: "预览",
    validationWarnings: [],
    warnings: [],
    snapshot: {
      chapterId: "chapter-5",
      chapterNumber: 5,
      summary: "摘要",
      characters: ["陈砚"],
      locations: [],
      organizations: [],
      items: [],
      events: [],
      characterStateChanges: [],
      relationshipChanges: [],
      knowledgeChanges: [],
      foreshadowingChanges: [],
      newCanonFacts: [],
      timelineEvents: [],
      conflicts: [],
      endingHook: "",
      graphNodes: [],
      graphEdges: [],
    },
    prepared: {
      snapshot: {
        chapterId: "chapter-5",
        chapterNumber: 5,
        summary: "摘要",
        characters: ["陈砚"],
        locations: [],
        organizations: [],
        items: [],
        events: [],
        characterStateChanges: [],
        relationshipChanges: [],
        knowledgeChanges: [],
        foreshadowingChanges: [],
        newCanonFacts: [],
        timelineEvents: [],
        conflicts: [],
        endingHook: "",
        graphNodes: [],
        graphEdges: [],
      },
      source: {
        readPath: "/proj/wiki/chapters/chapter-005.md",
        chapterNumber: 5,
        bodySha256: "a".repeat(64),
        contentSha256: "b".repeat(64),
      },
    },
  }

  it("confirmed=false 或 64 位 SHA-256 非法时直接拒绝，绝不委托提交", async () => {
    await expect(
      commitInteractiveChapterSnapshot("/proj", validPrepared, { confirmed: false }),
    ).rejects.toThrow(/确认/)

    const badSha: PreparedInteractiveChapterSnapshot = {
      ...validPrepared,
      prepared: {
        ...validPrepared.prepared,
        source: { ...validPrepared.prepared.source, bodySha256: "not-a-sha" },
      },
    }
    await expect(commitInteractiveChapterSnapshot("/proj", badSha)).rejects.toThrow(/bodySha256/)
    expect(mocks.commitPreparedChapterIngest).not.toHaveBeenCalled()
  })

  it("确认后委托 commitPreparedChapterIngest，分类记忆结果并触发 onDataVersionBump", async () => {
    const ingestResult: IngestResult = {
      snapshot: validPrepared.snapshot,
      ledgerSaveFailed: false,
      factsStoreFailed: false,
      failedProjections: [],
      committedProjections: ["sync_snapshot_to_memory"],
      pendingProjections: [],
      canonOutcome: { status: "skipped", reason: "no_facts" },
      receipt: {
        readPath: validPrepared.chapterPath,
        chapterNumber: 5,
        bodySha256: "a".repeat(64),
        contentSha256: "b".repeat(64),
        snapshotIdAtExtractionCommit: "chapter-5-r1",
        snapshotRevisionAtExtractionCommit: 1,
        snapshotJsonSha256AtExtractionCommit: "c".repeat(64),
        canonOutcome: { status: "skipped", reason: "no_facts" },
      },
      projectionReceipt: {
        extractionHistoryPath: "/proj/.novel/snapshots/history/ch5.json",
        snapshotId: "chapter-5-r2",
        revision: 2,
        snapshotJsonSha256: "d".repeat(64),
      },
    }
    mocks.commitPreparedChapterIngest.mockResolvedValue(ingestResult)
    const beforeFormalEffects = vi.fn(async () => {})
    const onDataVersionBump = vi.fn()

    const out = await commitInteractiveChapterSnapshot("/proj", validPrepared, {
      confirmed: true,
      beforeFormalEffects,
      onDataVersionBump,
    })

    expect(mocks.commitPreparedChapterIngest).toHaveBeenCalledWith(
      "/proj",
      validPrepared.prepared,
      beforeFormalEffects,
    )
    expect(out.ingestResult).toBe(ingestResult)
    expect(out.memoryStatus.ingest).toBe("ok")
    expect(onDataVersionBump).toHaveBeenCalledTimes(1)

    // verifyReadback=true 时走独立回读验证通道
    mocks.readBackMemoryIngest.mockResolvedValue({ ingest: "partial", failReason: "memory_incomplete" })
    const readbackOut = await commitInteractiveChapterSnapshot("/proj", validPrepared, {
      confirmed: true,
      verifyReadback: true,
    })
    expect(mocks.readBackMemoryIngest).toHaveBeenCalledWith(
      "/proj",
      validPrepared.chapterPath,
      ingestResult,
    )
    expect(readbackOut.memoryStatus.ingest).toBe("partial")
  })
})

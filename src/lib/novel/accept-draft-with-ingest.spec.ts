// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * accept-draft-with-ingest.spec — 采纳+记忆回填组合四分支 + accept 失败用例。
 *
 * 不触发真实 fs / LLM：ingestChapter 整体 mock。
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWikiStore } from "@/stores/wiki-store"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"

const ingestChapter = vi.fn()
const {
  verifyRebuildOutcome,
  readFileMock,
  markExternalDraftAcceptedInStatus,
  finalizeAcceptedChapter,
} = vi.hoisted(() => ({
  verifyRebuildOutcome: vi.fn(),
  readFileMock: vi.fn(async () => "---\ntype: chapter\nchapter_number: 3\nchapter_status: final\n---\n正文内容。"),
  markExternalDraftAcceptedInStatus: vi.fn(async () => null),
  finalizeAcceptedChapter: vi.fn(async () => undefined),
}))

vi.mock("@/commands/fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/commands/fs")>()),
  readFile: readFileMock,
}))
vi.mock("./chapter-ingest", () => ({
  ingestChapter: (...args: unknown[]) => ingestChapter(...args),
}))
vi.mock("./novel-session-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./novel-session-status")>()),
  markExternalDraftAcceptedInStatus,
}))
vi.mock("./formal-writeback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./formal-writeback")>()),
  finalizeAcceptedChapter,
}))
vi.mock("./rebuild", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rebuild")>()),
  verifyRebuildOutcome,
}))

const { acceptDraftAndIngest, buildIngestActivity } = await import("./accept-draft-with-ingest")
const completedMemory = {
  ledgerSaveFailed: false,
  factsStoreFailed: false,
  failedProjections: [],
  pendingProjections: [],
  committedProjections: ["sync_snapshot_to_memory"],
  canonOutcome: { status: "skipped", reason: "no_facts" },
  receipt: {
    readPath: "/proj/wiki/chapters/chapter-3.md",
    chapterNumber: 3,
    bodySha256: "body-sha",
    contentSha256: "content-sha",
    snapshotIdAtExtractionCommit: "chapter-3-r7",
    snapshotRevisionAtExtractionCommit: 7,
    snapshotJsonSha256AtExtractionCommit: "json-sha",
  },
  projectionReceipt: { revision: 8 },
} as const

const llmConfig = { provider: "openai", apiKey: "k", model: "m", baseUrl: "" } as unknown as LlmConfig

function novelConfig(overrides: Partial<NovelConfig> = {}): NovelConfig {
  return { ...useWikiStore.getState().novelConfig, autoIngestOnSave: true, ...overrides }
}

beforeEach(() => {
  ingestChapter.mockReset()
  verifyRebuildOutcome.mockReset().mockResolvedValue(undefined)
  readFileMock.mockReset().mockResolvedValue("---\ntype: chapter\nchapter_number: 3\nchapter_status: final\n---\n正文内容。")
  markExternalDraftAcceptedInStatus.mockReset().mockResolvedValue(null)
  finalizeAcceptedChapter.mockReset().mockResolvedValue(undefined)
  // resolveNovelModel 的 store 兜底置空 → 回落到传入 llmConfig
  useWikiStore.setState({ providerConfigs: {}, defaultLlmModel: "", aiChatModel: "" })
})

describe("acceptDraftAndIngest", () => {
  it("ok：先 accept（收到 formalChapterPath）再摄取，返回 ingest=ok", async () => {
    ingestChapter.mockResolvedValue({ ...completedMemory, snapshot: { id: "s1", chapterNumber: 3 }, selfHeal: { attempted: false, healed: [] } })
    const accept = vi.fn(async () => {})

    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      accept,
      novelConfig: novelConfig(),
      llmConfig,
    })

    expect(accept).toHaveBeenCalledTimes(1)
    expect(accept).toHaveBeenCalledWith("/proj/wiki/chapters/第3章.md")
    expect(ingestChapter).toHaveBeenCalledTimes(1)
    expect(out.ingest).toBe("ok")
    expect(out.selfHeal).toEqual({ attempted: false, healed: [] })
  })

  it("失败/跳过不伪造 bound source：failed 与两个 skip 均不携带 sourceBinding/canonOutcome/receipt", async () => {
    ingestChapter.mockResolvedValue({ snapshot: null, failReason: "source_changed" })
    const failed = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      accept: vi.fn(async () => {}),
      novelConfig: novelConfig(),
      llmConfig,
    })
    expect(failed.ingest).toBe("failed")
    expect(failed.failReason).toBe("source_changed")
    expect(failed).not.toHaveProperty("sourceBinding")
    expect(failed).not.toHaveProperty("canonOutcome")
    expect(failed).not.toHaveProperty("receipt")

    ingestChapter.mockClear()
    const skippedConfig = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      accept: vi.fn(async () => {}),
      novelConfig: novelConfig({ autoIngestOnSave: false }),
      llmConfig,
    })
    expect(skippedConfig).not.toHaveProperty("sourceBinding")
    expect(ingestChapter).not.toHaveBeenCalled()

    const skippedNoModel = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      accept: vi.fn(async () => {}),
      novelConfig: novelConfig(),
      llmConfig: { ...llmConfig, apiKey: "" } as LlmConfig,
    })
    expect(skippedNoModel).not.toHaveProperty("sourceBinding")
  })

  it("ok：additive 透传 ingest 的 sourceBinding/canonOutcome/receipt（无则不上报）", async () => {
    const sourceBinding = {
      readPath: "/proj/wiki/chapters/第3章.md",
      chapterNumber: 3,
      bodySha256: "body-sha",
      contentSha256: "content-sha",
    }
    const canonOutcome = {
      status: "completed" as const,
      report: {
        written: 1,
        queued: 0,
        results: [{ digest: "d", legacy: { ok: true }, canon: { ok: true, revision: 23 }, consistent: true }],
        reconcile: { consistent: true, divergences: [] },
      },
    }
    const receipt = {
      ...sourceBinding,
      snapshotIdAtExtractionCommit: "chapter-3-r7",
      snapshotRevisionAtExtractionCommit: 7,
      snapshotJsonSha256AtExtractionCommit: "json-sha",
      canonOutcome,
    }
    ingestChapter.mockResolvedValue({
      ...completedMemory,
      snapshot: { chapterId: "chapter-3", chapterNumber: 3 },
      selfHeal: { attempted: false, healed: [] },
      sourceBinding,
      canonOutcome,
      receipt,
      projectionReceipt: { revision: 8 },
    })

    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      accept: vi.fn(async () => {}),
      novelConfig: novelConfig(),
      llmConfig,
    })

    expect(out.ingest).toBe("ok")
    expect(out.sourceBinding).toEqual(sourceBinding)
    expect(out.canonOutcome).toEqual(canonOutcome)
    expect(out.receipt).toEqual(receipt)
  })

  it("a bare snapshot does not prove memory completion or a bound receipt", async () => {
    ingestChapter.mockResolvedValue({ snapshot: { chapterId: "chapter-3" } })

    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      accept: vi.fn(async () => {}),
      novelConfig: novelConfig(),
      llmConfig,
    })

    expect(out).toMatchObject({ ingest: "failed", failReason: "memory_incomplete" })
    expect(out).not.toHaveProperty("sourceBinding")
    expect(out).not.toHaveProperty("canonOutcome")
    expect(out).not.toHaveProperty("receipt")
  })

  it("clean flags but missing projectionReceipt is not success and attaches no bound evidence", async () => {
    const { projectionReceipt: _omit, ...memoryWithoutProjectionReceipt } = completedMemory
    ingestChapter.mockResolvedValue({
      ...memoryWithoutProjectionReceipt,
      snapshot: { chapterId: "chapter-3", chapterNumber: 3 },
      sourceBinding: {
        readPath: "/proj/wiki/chapters/chapter-3.md",
        chapterNumber: 3,
        bodySha256: "body-sha",
        contentSha256: "content-sha",
      },
    })

    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/chapter-3.md",
      accept: vi.fn(async () => {}),
      novelConfig: novelConfig(),
      llmConfig,
    })

    expect(out.ingest).toBe("failed")
    // 诊断不丢：真实回传的 binding/receipt 随失败透出；缺的不伪造。
    expect(out.sourceBinding).toMatchObject({ chapterNumber: 3 })
    expect(out.receipt).toMatchObject({ chapterNumber: 3 })
    expect(out).not.toHaveProperty("projectionReceipt")
  })

  it.each([
    { ledgerSaveFailed: true },
    { factsStoreFailed: true },
    { failedProjections: ["graph_entity_pages"] },
    { canonOutcome: { status: "failed", reason: "unavailable" } },
    { canonOutcome: { status: "completed", report: { queued: 1, reconcile: { consistent: true } } } },
    { canonOutcome: { status: "completed", report: { queued: 0, reconcile: { consistent: false } } } },
    { canonOutcome: { status: "skipped", reason: "no_deps" } },
    { canonOutcome: { status: "skipped", reason: "not_eligible" } },
  ])("reports incomplete memory even after formal adoption: %j", async (details) => {
    ingestChapter.mockResolvedValue({ ...completedMemory, ...details, snapshot: { chapterId: "chapter-3", chapterNumber: 3 } })
    const accept = vi.fn(async () => {})
    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/chapter-3.md",
      accept,
      novelConfig: novelConfig(),
      llmConfig,
    })
    expect(accept).toHaveBeenCalledOnce()
    // 真实双回执 + 已有 committed 投影：不完全但有据 ⇒ partial（裸快照/缺回执才是 failed）。
    expect(out).toMatchObject({ ingest: "partial", failReason: "memory_incomplete", ...details })
    expect(buildIngestActivity(out).kind).toBe("analysis")
  })

  it.each(["source_fence", "projection_runner"])("fails closed on %s even if other projection evidence appears complete", async (stage) => {
    ingestChapter.mockResolvedValue({
      ...completedMemory,
      snapshot: { chapterId: "chapter-3", chapterNumber: 3 },
      projectionError: { stage, message: "wrapper failure" },
    })
    const formalChapterPath = "/proj/wiki/chapters/chapter-3.md"

    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath,
      accept: vi.fn(async () => {}),
      novelConfig: novelConfig(),
      llmConfig,
    })
    expect(out).toMatchObject({ formalChapterPath, ingest: "failed", failReason: "memory_incomplete" })
    expect(out.receipt).toBe(completedMemory.receipt)
    expect(buildIngestActivity(out).kind).toBe("error")
  })

  it("reports background projections as pending, not successful or an activity error", async () => {
    ingestChapter.mockResolvedValue({
      ...completedMemory,
      snapshot: { chapterId: "chapter-3", chapterNumber: 3 },
      pendingProjections: ["community_summary"],
      sourceBinding: {
        readPath: "/proj/wiki/chapters/chapter-3.md",
        chapterNumber: 3,
        bodySha256: "body-sha",
        contentSha256: "content-sha",
      },
    })
    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/chapter-3.md",
      accept: vi.fn(async () => {}),
      novelConfig: novelConfig(),
      llmConfig,
    })
    expect(out).toMatchObject({
      ingest: "pending",
      failReason: "memory_pending",
      pendingProjections: ["community_summary"],
    })
    // 提取诊断透传：pending 同样保留真实 binding + 双回执。
    expect(out.sourceBinding).toBeDefined()
    expect(out.receipt).toBeDefined()
    expect(out.projectionReceipt).toBeDefined()
    expect(out.ingest).not.toBe("failed")
    expect(out.ingest).not.toBe("ok")
    expect(buildIngestActivity(out)).toMatchObject({ kind: "analysis", content: expect.stringContaining("community_summary") })
  })

  it("returns the formal path if ingest throws after adoption", async () => {
    ingestChapter.mockRejectedValue(new Error("disk unavailable"))
    const formalChapterPath = "/proj/wiki/chapters/chapter-3.md"
    const accept = vi.fn(async () => {})
    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath,
      accept,
      novelConfig: novelConfig(),
      llmConfig,
    })
    expect(accept).toHaveBeenCalledOnce()
    expect(out).toEqual({ formalChapterPath, ingest: "failed", failReason: "ingest_error" })
  })

  it("skipped-config：autoIngestOnSave 关闭时不摄取", async () => {
    const accept = vi.fn(async () => {})
    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      accept,
      novelConfig: novelConfig({ autoIngestOnSave: false }),
      llmConfig,
    })
    expect(out.ingest).toBe("skipped-config")
    expect(ingestChapter).not.toHaveBeenCalled()
  })

  it("skipped-no-model：提取模型不可用时不摄取", async () => {
    const accept = vi.fn(async () => {})
    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      accept,
      novelConfig: novelConfig(),
      llmConfig: { ...llmConfig, apiKey: "" } as LlmConfig,
    })
    expect(out.ingest).toBe("skipped-no-model")
    expect(ingestChapter).not.toHaveBeenCalled()
  })

  it("failed：摄取无 snapshot 时带 failReason", async () => {
    ingestChapter.mockResolvedValue({ snapshot: null, failReason: "not_final" })
    const accept = vi.fn(async () => {})
    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      accept,
      novelConfig: novelConfig(),
      llmConfig,
    })
    expect(out.ingest).toBe("skipped-not-final")
    expect(out.failReason).toBe("not_final")
  })

  it("accept 抛错：错误上抛且绝不摄取（采纳失败不得降级成摄取失败）", async () => {
    const accept = vi.fn(async () => {
      throw new Error("写盘失败")
    })
    await expect(
      acceptDraftAndIngest({
        projectPath: "/proj",
        formalChapterPath: "/proj/wiki/chapters/第3章.md",
        accept,
        novelConfig: novelConfig(),
        llmConfig,
      }),
    ).rejects.toThrow("写盘失败")
    expect(ingestChapter).not.toHaveBeenCalled()
    expect(markExternalDraftAcceptedInStatus).not.toHaveBeenCalled()
    expect(finalizeAcceptedChapter).not.toHaveBeenCalled()
  })

  it("外部草稿（带 draftId）严格按 accept → markExternalDraftAcceptedInStatus → ingestChapter → finalizeAcceptedChapter 顺序执行", async () => {
    const order: string[] = []
    const accept = vi.fn(async () => {
      order.push("accept")
    })
    markExternalDraftAcceptedInStatus.mockImplementationOnce(async () => {
      order.push("markStatus")
      return null
    })
    ingestChapter.mockImplementationOnce(async () => {
      order.push("ingest")
      return { ...completedMemory, snapshot: { id: "s1", chapterNumber: 3 } }
    })
    finalizeAcceptedChapter.mockImplementationOnce(async () => {
      order.push("finalize")
    })

    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      draftId: "draft_ext_3",
      chapterNumber: 3,
      chapterName: "第3章",
      accept,
      novelConfig: novelConfig({ autoIngestOnSave: true }),
      llmConfig,
    })

    expect(out.ingest).toBe("ok")
    expect(order).toEqual(["accept", "markStatus", "ingest", "finalize"])
    expect(markExternalDraftAcceptedInStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/proj",
        draftId: "draft_ext_3",
        chapterNumber: 3,
        targetKey: "chapter:3",
      }),
    )
    expect(finalizeAcceptedChapter).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/proj",
        chapterNumber: 3,
        formalChapterPath: "/proj/wiki/chapters/第3章.md",
      }),
    )
  })

  it("外部草稿在 skipped-config / skipped-no-model / ingest 抛错分支下均仍执行状态同步与 finalizeAcceptedChapter", async () => {
    // 1. skipped-config
    const r1 = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      draftId: "draft_skip_cfg",
      chapterNumber: 3,
      accept: vi.fn(async () => {}),
      novelConfig: novelConfig({ autoIngestOnSave: false }),
      llmConfig,
    })
    expect(r1.ingest).toBe("skipped-config")
    expect(markExternalDraftAcceptedInStatus).toHaveBeenCalledTimes(1)
    expect(finalizeAcceptedChapter).toHaveBeenCalledTimes(1)

    // 2. skipped-no-model
    markExternalDraftAcceptedInStatus.mockClear()
    finalizeAcceptedChapter.mockClear()
    const r2 = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      draftId: "draft_skip_llm",
      chapterNumber: 3,
      accept: vi.fn(async () => {}),
      novelConfig: novelConfig({ autoIngestOnSave: true }),
      llmConfig: { ...llmConfig, apiKey: "" } as LlmConfig,
    })
    expect(r2.ingest).toBe("skipped-no-model")
    expect(markExternalDraftAcceptedInStatus).toHaveBeenCalledTimes(1)
    expect(finalizeAcceptedChapter).toHaveBeenCalledTimes(1)

    // 3. ingest throws
    markExternalDraftAcceptedInStatus.mockClear()
    finalizeAcceptedChapter.mockClear()
    ingestChapter.mockRejectedValueOnce(new Error("boom"))
    const r3 = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      draftId: "draft_ingest_err",
      chapterNumber: 3,
      accept: vi.fn(async () => {}),
      novelConfig: novelConfig({ autoIngestOnSave: true }),
      llmConfig,
    })
    expect(r3).toEqual({
      formalChapterPath: "/proj/wiki/chapters/第3章.md",
      ingest: "failed",
      failReason: "ingest_error",
    })
    expect(markExternalDraftAcceptedInStatus).toHaveBeenCalledTimes(1)
    expect(finalizeAcceptedChapter).toHaveBeenCalledTimes(1)
  })
})

describe("buildIngestActivity（RV-002 ② 记忆回填进 activities 通道）", () => {
  it("ok → extract_result，标题与状态文案走 i18n（不硬编码中文）", () => {
    const event = buildIngestActivity(
      { formalChapterPath: "/proj/wiki/chapters/第3章.md", ingest: "ok" },
      1000,
    )
    expect(event.id).toBe("memory_ingest:1000")
    expect(event.stageId).toBe("memory_ingest")
    expect(event.kind).toBe("extract_result")
    expect(event.timestamp).toBe(1000)
    expect(event.title.length).toBeGreaterThan(0)
    expect(event.content).toContain("/proj/wiki/chapters/第3章.md")
  })

  it("failed → error 类别，携带失败原因", () => {
    const event = buildIngestActivity(
      { formalChapterPath: "/p/ch.md", ingest: "failed", failReason: "extract_failed" },
      2000,
    )
    expect(event.kind).toBe("error")
    expect(event.content).toContain("extract_failed")
  })

  it("两种 skip 是说明而非错误", () => {
    expect(buildIngestActivity({ formalChapterPath: "/p/ch.md", ingest: "skipped-config" }).kind).toBe("analysis")
    expect(buildIngestActivity({ formalChapterPath: "/p/ch.md", ingest: "skipped-no-model" }).kind).toBe("analysis")
  })
})

describe("readBackMemoryIngest reconciliation", () => {
  it("clean ingest → verifyRebuildOutcome 精确参数 + ingest=ok", async () => {
    const result = { ...completedMemory, snapshot: { id: "s1", chapterNumber: 3 }, selfHeal: { attempted: false, healed: [] } }
    ingestChapter.mockResolvedValue(result)
    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/chapter-3.md",
      accept: async () => {},
      novelConfig: novelConfig(),
      llmConfig,
    })
    expect(verifyRebuildOutcome).toHaveBeenCalledWith(
      "/proj",
      { path: "/proj/wiki/chapters/chapter-3.md", chapterNumber: 3 },
      result,
    )
    expect(out.ingest).toBe("ok")
  })

  it("verifyRebuildOutcome 拒绝 → ingest=partial + 回执保留 + accept 仍完成", async () => {
    verifyRebuildOutcome.mockRejectedValueOnce(new Error("chapter source changed"))
    const accept = vi.fn(async () => {})
    ingestChapter.mockResolvedValue({ ...completedMemory, snapshot: { id: "s1", chapterNumber: 3 }, selfHeal: { attempted: false, healed: [] } })
    const out = await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/chapter-3.md",
      accept,
      novelConfig: novelConfig(),
      llmConfig,
    })
    expect(out.ingest).toBe("partial")
    expect(out.receipt).toBeTruthy()
    expect(accept).toHaveBeenCalledTimes(1)
  })

  it("pending/failed ingest → verifyRebuildOutcome 不被调用", async () => {
    ingestChapter.mockResolvedValue({ snapshot: null, failReason: "extract_failed" })
    await acceptDraftAndIngest({
      projectPath: "/proj",
      formalChapterPath: "/proj/wiki/chapters/chapter-3.md",
      accept: async () => {},
      novelConfig: novelConfig(),
      llmConfig,
    })
    expect(verifyRebuildOutcome).not.toHaveBeenCalled()
  })
})

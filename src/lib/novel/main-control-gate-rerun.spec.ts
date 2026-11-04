// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * main-control-gate-rerun.spec — F3 ③：主控「重跑门控」确实调用
 * `evaluateChapterGates`（且备料真实：任务书带契约段、复用同一 contextPack），
 * 未评估门落 skipped 不落 pass。
 *
 * 不 mock 备料函数（buildFallbackTaskBrief / resolveChapterLengthSpec 走真实实现），
 * 只 mock 编排入口 evaluateChapterGates 与 IO 依赖（草稿列表 / contextPack / 证据落账）。
 *
 * F1b 收口：重跑结论必须落账（`intent:main-control-rerun`），且落账失败非致命。
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ContextPack } from "./context-engine"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { buildDecisionGates, emptyDecisionGates } from "./deep-chapter-decision-gates"
import type { ChapterGateEvidenceInput, ChapterGateEvidenceResult } from "./deep-chapter-gate-evidence"
import type { ChapterDraft } from "./lifecycle-types"

const mocks = vi.hoisted(() => ({ evaluateChapterGates: vi.fn() }))
const evaluateChapterGates = mocks.evaluateChapterGates

vi.mock("./chapter-gate-evaluation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chapter-gate-evaluation")>()
  return { ...actual, evaluateChapterGates: mocks.evaluateChapterGates }
})

const { rerunMainControlGates, buildMainControlGateRows } = await import("./main-control-gate-rerun")

const llmConfig = { provider: "openai", apiKey: "k", model: "m", baseUrl: "" } as unknown as LlmConfig

function novelConfig(overrides: Partial<NovelConfig> = {}): NovelConfig {
  return { ...useWikiStore.getState().novelConfig, autoIngestOnSave: false, ...overrides }
}

function draft(overrides: Partial<ChapterDraft> = {}): ChapterDraft {
  return {
    id: "draft_1_abc",
    chapterName: "第3章 旧梦",
    content: "第三段正文，角色推门而入。",
    createdAt: 1,
    status: "draft",
    ...overrides,
  }
}

const fakePack = { marker: "pack" } as unknown as ContextPack

const listDrafts = vi.fn(async () => [draft()])
const buildPack = vi.fn(async () => fakePack)
const recordEvidence = vi.fn(
  async (_input: ChapterGateEvidenceInput): Promise<ChapterGateEvidenceResult> => ({
    recorded: ["consistency", "anti_ai", "quality"],
  }),
)

beforeEach(() => {
  evaluateChapterGates.mockReset()
  listDrafts.mockReset()
  buildPack.mockReset()
  recordEvidence.mockReset()
  recordEvidence.mockResolvedValue({ recorded: ["consistency", "anti_ai", "quality"] })
  listDrafts.mockResolvedValue([draft()])
  buildPack.mockResolvedValue(fakePack)
  evaluateChapterGates.mockResolvedValue({
    reviewResults: [],
    decisionGates: buildDecisionGates([], 0),
    llmMediated: true,
    contractEvaluated: true,
    unassessedGates: [],
    unassessedDimensions: [],
  })
})

describe("rerunMainControlGates", () => {
  it("确实调用 evaluateChapterGates，且任务书带契约段 / retryCount=0 / 复用同一 contextPack", async () => {
    await rerunMainControlGates(
      {
        projectPath: "/proj",
        draftId: "draft_1_abc",
        goal: "把第3章收束到旧梦醒来",
        novelConfig: novelConfig(),
        llmConfig,
      },
      { listDrafts, buildPack, recordEvidence },
    )

    expect(evaluateChapterGates).toHaveBeenCalledTimes(1)
    const input = evaluateChapterGates.mock.calls[0][0] as Record<string, unknown>
    expect(input.projectPath).toBe("/proj")
    expect(input.chapterContent).toBe("第三段正文，角色推门而入。")
    expect(input.chapterNumber).toBe(3)
    // 任务书必须带章节契约段，否则契约维度整段短路（假通过）。
    expect(String(input.taskBrief)).toContain("【章节契约】")
    expect(input.retryCount).toBe(0)
    // D4=C：本动作已构建的 contextPack 必须被复用，不二次排队。
    expect(input.contextPack).toBe(fakePack)
    expect(buildPack).toHaveBeenCalledTimes(1)
  })

  it("找不到草稿时抛错，不返回伪造结论", async () => {
    listDrafts.mockResolvedValue([])
    await expect(
      rerunMainControlGates(
        { projectPath: "/proj", draftId: "draft_missing", novelConfig: novelConfig(), llmConfig },
        { listDrafts, buildPack, recordEvidence },
      ),
    ).rejects.toThrow("找不到草稿")
    expect(evaluateChapterGates).not.toHaveBeenCalled()
    expect(recordEvidence).not.toHaveBeenCalled()
  })

  it("草稿无正文时抛错，不调用门控", async () => {
    listDrafts.mockResolvedValue([draft({ content: "   " })])
    await expect(
      rerunMainControlGates(
        { projectPath: "/proj", draftId: "draft_1_abc", novelConfig: novelConfig(), llmConfig },
        { listDrafts, buildPack, recordEvidence },
      ),
    ).rejects.toThrow("草稿没有正文")
    expect(evaluateChapterGates).not.toHaveBeenCalled()
    expect(recordEvidence).not.toHaveBeenCalled()
  })

  it("未评估门落 skipped 不落 pass（AI 审稿关闭时三门全 skipped）", async () => {
    evaluateChapterGates.mockResolvedValue({
      reviewResults: [],
      decisionGates: emptyDecisionGates(),
      llmMediated: false,
      contractEvaluated: true,
      unassessedGates: ["consistency", "anti_ai", "quality"],
      unassessedDimensions: ["ai_review"],
    })

    const out = await rerunMainControlGates(
      { projectPath: "/proj", draftId: "draft_1_abc", novelConfig: novelConfig(), llmConfig },
      { listDrafts, buildPack, recordEvidence },
    )

    expect(out.rows.map((row) => row.status)).toEqual(["skipped", "skipped", "skipped"])
    expect(out.rows.some((row) => row.status === "pass")).toBe(false)
    expect(out.overall).toBe("pending")
    expect(out.llmMediated).toBe(false)
  })

  it("结论落账：带 intent=main-control-rerun，落账即三门 decisionGates（不是渲染行）", async () => {
    const gates = buildDecisionGates([], 3)
    evaluateChapterGates.mockResolvedValue({
      reviewResults: [],
      decisionGates: gates,
      llmMediated: true,
      contractEvaluated: true,
      unassessedGates: [],
      unassessedDimensions: [],
    })

    const out = await rerunMainControlGates(
      { projectPath: "/proj", draftId: "draft_1_abc", novelConfig: novelConfig(), llmConfig },
      { listDrafts, buildPack, recordEvidence },
    )

    expect(recordEvidence).toHaveBeenCalledTimes(1)
    const evidenceInput = recordEvidence.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(evidenceInput.projectPath).toBe("/proj")
    expect(evidenceInput.intent).toBe("main-control-rerun")
    expect(evidenceInput.chapterNumber).toBe(3)
    expect(evidenceInput.llmMediated).toBe(true)
    // 落账内容 = 真实 decisionGates（不是渲染行），供 gate-run payload 同源映射
    expect(evidenceInput.decisionGates).toBe(gates)
    expect(out.evidenceRecorded).toEqual(["consistency", "anti_ai", "quality"])
    expect(out.evidenceError).toBeUndefined()
  })

  it("落账返回带 evidenceTs（供 UI 对账「本次 vs 历史」）", async () => {
    recordEvidence.mockResolvedValue({
      recorded: ["consistency", "anti_ai", "quality"],
      ts: "2026-10-18T01:02:03.000Z",
    })
    const out = await rerunMainControlGates(
      { projectPath: "/proj", draftId: "draft_1_abc", novelConfig: novelConfig(), llmConfig },
      { listDrafts, buildPack, recordEvidence },
    )
    expect(out.evidenceTs).toBe("2026-10-18T01:02:03.000Z")
    expect(out.evidenceError).toBeUndefined()
  })

  it("落账失败非致命：结论照常返回，只回 evidenceError", async () => {
    recordEvidence.mockResolvedValue({ recorded: ["consistency", "anti_ai", "quality"], error: "disk-full" })

    const out = await rerunMainControlGates(
      { projectPath: "/proj", draftId: "draft_1_abc", novelConfig: novelConfig(), llmConfig },
      { listDrafts, buildPack, recordEvidence },
    )

    expect(out.evidenceError).toBe("disk-full")
    // 落账失败 → 没有可对账的批次 ts（历史面诚实缺失，不伪造时间戳）
    expect(out.evidenceTs).toBeUndefined()
    expect(out.rows.map((row) => row.key)).toEqual(["consistency", "anti_ai", "quality"])
  })
})

describe("buildMainControlGateRows", () => {
  it("passed→pass、failed→fail、pending→skipped（与 gate-run 证据同一映射）", () => {
    const gates = buildDecisionGates(
      [
        { severity: "error", type: "timeline_consistency", message: "设定冲突", evidence: "", relatedMemory: "", suggestion: "" },
      ],
      2,
    )
    const rows = buildMainControlGateRows({ decisionGates: { ...gates, quality: emptyDecisionGates().quality } })
    expect(rows.map((row) => [row.key, row.status])).toEqual([
      ["consistency", "fail"],
      ["anti_ai", "pass"],
      ["quality", "skipped"],
    ])
  })
})

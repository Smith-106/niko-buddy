// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * chapter-gate-evaluation.spec — 重跑门控薄编排（R-05 单一真源 guard）。
 *
 * 主断言：同一 reviewResults fixture 双跑，evaluateChapterGates 的 decisionGates
 * 与手工 buildDecisionGates(...) 逐字段相等——任何在编排层复制门判定的写法都会失败。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ContextPack } from "./context-engine"
import type { NovelReviewResult } from "./review-adapter"
import { buildDecisionGates } from "./deep-chapter-decision-gates"
import { resolveDeAiGenre } from "./genre-codes"

const mocks = vi.hoisted(() => ({
  runFullReviewWithSixDim: vi.fn(),
  buildContextPack: vi.fn(),
}))

const runFullReviewWithSixDim = mocks.runFullReviewWithSixDim
const buildContextPack = mocks.buildContextPack

vi.mock("./deep-chapter-review", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./deep-chapter-review")>()
  return { ...actual, runFullReviewWithSixDim: mocks.runFullReviewWithSixDim }
})

// 只替换 buildContextPack：本 spec 不需要真实 context-engine（其装配会读 fs / store）。
vi.mock("./context-engine", () => ({
  buildContextPack: mocks.buildContextPack,
  contextPackToPrompt: vi.fn(() => ""),
}))

const { evaluateChapterGates } = await import("./chapter-gate-evaluation")

function finding(overrides: Partial<NovelReviewResult> = {}): NovelReviewResult {
  return {
    severity: "warning",
    type: "pacing_flat",
    message: "节奏偏平",
    evidence: "第三段",
    relatedMemory: "",
    suggestion: "加一个转折",
    ...overrides,
  }
}

const FIXTURE: NovelReviewResult[] = [
  finding({ severity: "warning", type: "pacing_flat" }),
  finding({ severity: "info", type: "style_note" }),
]

const fakePack = { marker: "pack" } as unknown as ContextPack

beforeEach(() => {
  runFullReviewWithSixDim.mockReset()
  buildContextPack.mockReset()
  runFullReviewWithSixDim.mockResolvedValue({ reviewResults: FIXTURE, dimensionResults: {} })
  // updated_at 用真实时钟 → 固定系统时间，保证两次构建逐字段可比
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-11-04T00:00:00.000Z"))
})

afterEach(() => {
  vi.useRealTimers()
})

describe("evaluateChapterGates", () => {
  it("同一 fixture 双跑：decisionGates 与手工 buildDecisionGates 逐字段相等（R-05）", async () => {
    const evaluation = await evaluateChapterGates({
      projectPath: "/proj",
      chapterContent: "正文",
      chapterNumber: 3,
      genre: "xuanhuan",
      contextPack: fakePack,
    })

    expect(evaluation.decisionGates).toEqual(
      buildDecisionGates(FIXTURE, 0, undefined, resolveDeAiGenre("xuanhuan")),
    )
    expect(evaluation.reviewResults).toEqual(FIXTURE)
    expect(evaluation.llmMediated).toBe(true)
  })

  it("传 contextPack 时不再调 buildContextPack（D4=C 复用优先）", async () => {
    await evaluateChapterGates({
      projectPath: "/proj",
      chapterContent: "正文",
      chapterNumber: 3,
      contextPack: fakePack,
    })
    expect(buildContextPack).not.toHaveBeenCalled()
    // deps 用 deep-chapter-generation 的同一份默认依赖（第二参）
    expect(runFullReviewWithSixDim.mock.calls[0][3]).toBeDefined()
  })

  it("缺 contextPack 时现场构建（并承担串行队列耗时）", async () => {
    buildContextPack.mockResolvedValue(fakePack)
    await evaluateChapterGates({ projectPath: "/proj", chapterContent: "正文片段".repeat(40), chapterNumber: 5 })
    expect(buildContextPack).toHaveBeenCalledTimes(1)
    const args = buildContextPack.mock.calls[0] as unknown[]
    expect(args[0]).toBe("/proj")
    // 任务摘要截断 80 字
    expect((args[1] as string).length).toBeLessThanOrEqual(80)
    expect(args[2]).toBe(5)
  })

  it("deepChapterReview === false 时 llmMediated 为 false", async () => {
    const evaluation = await evaluateChapterGates({
      projectPath: "/proj",
      chapterContent: "正文",
      contextPack: fakePack,
      novelConfig: { deepChapterReview: false } as never,
    })
    expect(evaluation.llmMediated).toBe(false)
  })

  it("空 findings 时三门 passed、overall pass（pending 只属未评估路径）", async () => {
    runFullReviewWithSixDim.mockResolvedValue({ reviewResults: [], dimensionResults: {} })
    const evaluation = await evaluateChapterGates({
      projectPath: "/proj",
      chapterContent: "正文",
      contextPack: fakePack,
    })
    expect(evaluation.decisionGates.consistency.status).toBe("passed")
    expect(evaluation.decisionGates.anti_ai.status).toBe("passed")
    expect(evaluation.decisionGates.quality.status).toBe("passed")
    expect(evaluation.decisionGates.overall).toBe("pass")
  })
})

/**
 * F1c：taskBrief / retryCount 必须可由调用方覆盖——空串会短路章节契约校验、
 * retryCount 硬编码 0 会把「没核对」和「核对过」渲染成同一结论（假通过）。
 */
describe("evaluateChapterGates 契约维度与轮次可覆盖（F1c）", () => {
  const taskBriefWithContract = [
    "本章必须完成：让角色在雨夜推门而入。",
    "【章节契约】",
    "必须节拍：角色在雨夜推门而入",
    "禁区：不得提前揭露真凶身份",
    "连贯核对：时间线紧接上一章结尾",
  ].join("\n")

  it("传带契约段的 taskBrief：契约维度参与判定（contractEvaluated=true，契约 findings 并入）", async () => {
    runFullReviewWithSixDim.mockResolvedValue({ reviewResults: [], dimensionResults: {} })
    const evaluation = await evaluateChapterGates({
      projectPath: "/proj",
      chapterContent: "晴天里角色坐在窗前喝茶。",
      contextPack: fakePack,
      taskBrief: taskBriefWithContract,
    })

    expect(evaluation.contractEvaluated).toBe(true)
    expect(evaluation.unassessedDimensions).toEqual([])
    // 契约核对真的跑了：缺失节拍/连贯核对变成 contract findings（并入 consistency 门）。
    const contractFindings = evaluation.reviewResults.filter((item) => item.type === "contract")
    expect(contractFindings.length).toBeGreaterThan(0)
    expect(evaluation.decisionGates.consistency.findings.some((item) => item.type === "contract")).toBe(true)
  })

  it("不传 taskBrief：契约维度如实标为未评估（不渲染成已核对）", async () => {
    const evaluation = await evaluateChapterGates({
      projectPath: "/proj",
      chapterContent: "正文",
      contextPack: fakePack,
    })

    expect(evaluation.contractEvaluated).toBe(false)
    expect(evaluation.unassessedDimensions).toContain("chapter_contract")
    // 空任务书 ⇒ 无契约 findings（原样返回 reviewResults），不得伪造契约结论。
    expect(evaluation.reviewResults.some((item) => item.type === "contract")).toBe(false)
  })

  it("retryCount 可覆盖：透传到三门（不再硬编码 0）", async () => {
    const evaluation = await evaluateChapterGates({
      projectPath: "/proj",
      chapterContent: "正文",
      chapterNumber: 3,
      genre: "xuanhuan",
      contextPack: fakePack,
      retryCount: 2,
    })

    expect(evaluation.decisionGates).toEqual(buildDecisionGates(FIXTURE, 2, undefined, resolveDeAiGenre("xuanhuan")))
    expect(evaluation.decisionGates.quality.retry_count).toBe(2)
  })

  it("AI 审稿关闭：三门落未评估（pending→skipped），不落 pass", async () => {
    const evaluation = await evaluateChapterGates({
      projectPath: "/proj",
      chapterContent: "正文",
      contextPack: fakePack,
      novelConfig: { deepChapterReview: false } as never,
    })

    expect(evaluation.llmMediated).toBe(false)
    expect(evaluation.unassessedGates).toEqual(["consistency", "anti_ai", "quality"])
    expect(evaluation.unassessedDimensions).toContain("ai_review")
    expect(evaluation.decisionGates.consistency.status).toBe("pending")
    expect(evaluation.decisionGates.overall).toBe("pending")
    // 关闭审稿时不再调审稿（与管线 deep-chapter-review-repair.ts:196 同形）。
    expect(runFullReviewWithSixDim).not.toHaveBeenCalled()
  })

  it("审稿输出不可解析：三门落未评估 + reviewParseFailed，不落 pass", async () => {
    runFullReviewWithSixDim.mockResolvedValue({
      reviewResults: FIXTURE,
      dimensionResults: {},
      reviewParseFailed: true,
    })
    const evaluation = await evaluateChapterGates({
      projectPath: "/proj",
      chapterContent: "正文",
      contextPack: fakePack,
    })

    expect(evaluation.reviewParseFailed).toBe(true)
    expect(evaluation.unassessedGates).toEqual(["consistency", "anti_ai", "quality"])
    expect(evaluation.decisionGates.overall).toBe("pending")
  })
})

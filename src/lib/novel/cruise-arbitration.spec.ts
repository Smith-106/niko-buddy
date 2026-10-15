// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * cruise-arbitration.spec — G3 仲裁回路类型层测试。
 * 覆盖：各状态映射（blocked/partial/failed 投影 + ready 拒绝）/
 * retry 替换 / skip 原样。
 */
import { describe, expect, it } from "vitest"
import type { CampaignChapterResult } from "./campaign-runner"
import {
  applyArbitrationDirective,
  buildArbitrationRequest,
  type ArbitrationRequest,
} from "./cruise-arbitration"

function makeChapter(overrides: Partial<CampaignChapterResult> = {}): CampaignChapterResult {
  return {
    chapterNumber: 7,
    content: "正文",
    taskBrief: "brief-7",
    draftContent: "draft-7",
    reviewResults: [],
    revised: false,
    wordCount: 2,
    status: "blocked",
    ...overrides,
  }
}

describe("buildArbitrationRequest（状态映射）", () => {
  it("blocked：投影 taskBrief/draftContent/error", () => {
    const req = buildArbitrationRequest(
      makeChapter({ status: "blocked", error: "门控阻断" }),
    )
    expect(req).toMatchObject({
      chapterNumber: 7,
      status: "blocked",
      taskBrief: "brief-7",
      draftContent: "draft-7",
      error: "门控阻断",
    })
  })

  it("partial：透传 decisionGates", () => {
    const gates = { overall: "warning" }
    const req = buildArbitrationRequest(
      makeChapter({
        status: "partial",
        decisionGates: gates as never,
        draftContent: "",
        error: undefined,
      }),
    )
    expect(req.status).toBe("partial")
    expect(req.decisionGates).toBe(gates)
    // 空 draft/error 不落键
    expect("draftContent" in req).toBe(false)
    expect("error" in req).toBe(false)
  })

  it("failed：透传 error（无 decisionGates 时不落键）", () => {
    const req = buildArbitrationRequest(
      makeChapter({ status: "failed", error: "boom", decisionGates: undefined }),
    )
    expect(req.status).toBe("failed")
    expect(req.error).toBe("boom")
    expect("decisionGates" in req).toBe(false)
  })

  it("ready：拒绝构造（无需仲裁）", () => {
    expect(() => buildArbitrationRequest(makeChapter({ status: "ready" }))).toThrow(
      /无需仲裁/,
    )
  })
})

describe("applyArbitrationDirective（落子）", () => {
  const request: ArbitrationRequest = {
    chapterNumber: 7,
    status: "blocked",
    taskBrief: "brief-7",
  }

  it("retry-rebrief：用 revisedBrief 替换 taskBrief", () => {
    const next = applyArbitrationDirective(request, {
      action: "retry-rebrief",
      revisedBrief: "brief-7-revised",
      reason: "放宽 pacing 门限重发",
    })
    expect(next).toEqual({ taskBrief: "brief-7-revised", chapterNumber: 7 })
  })

  it("retry-rebrief 缺 revisedBrief：拒绝", () => {
    expect(() =>
      applyArbitrationDirective(request, { action: "retry-rebrief", reason: "no brief" }),
    ).toThrow(/revisedBrief/)
    expect(() =>
      applyArbitrationDirective(request, {
        action: "retry-rebrief",
        revisedBrief: "   ",
        reason: "blank",
      }),
    ).toThrow(/revisedBrief/)
  })

  it("skip-chapter：原样返回", () => {
    const next = applyArbitrationDirective(request, {
      action: "skip-chapter",
      reason: "本章跳过",
    })
    expect(next).toEqual({ taskBrief: "brief-7", chapterNumber: 7 })
  })

  it("abort-campaign：原样返回", () => {
    const next = applyArbitrationDirective(request, {
      action: "abort-campaign",
      reason: "整场终止",
    })
    expect(next).toEqual({ taskBrief: "brief-7", chapterNumber: 7 })
  })
})

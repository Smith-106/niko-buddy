// SPDX-License-Identifier: MIT
// deep-chapter-runtime-support：章节契约写后核对与 checkpoint 谓词回归测试。
import { describe, expect, it, vi } from "vitest"
import { CHAPTER_CONTRACT_HEADER } from "./deep-chapter-task-brief"
import {
  applyChapterContractCheck,
  hasCheckpointReview,
  hasCheckpointRevision,
  safeBuildChapterContextPack,
} from "./deep-chapter-runtime-support"
import { hasContextPackLoadFailure, type ContextPack } from "./context-engine"
import type { DeepChapterGenerationDeps, DeepChapterGenerationResumeCheckpoint } from "./deep-chapter-generation"

describe("applyChapterContractCheck", () => {
  it("任务书无契约段 → 原样返回（不伪造 findings）", () => {
    const input = [{ severity: "error" as const, type: "consistency", message: "x", evidence: "", relatedMemory: "", suggestion: "" }]
    expect(applyChapterContractCheck("没有任何契约段的任务书", "正文", input)).toBe(input)
  })

  it("契约段为空（无任何约束条目）→ 零 finding 与零取舍，原样返回", () => {
    const input: never[] = []
    const out = applyChapterContractCheck(`${CHAPTER_CONTRACT_HEADER}\n`, "本章正文。", input)
    expect(out).toEqual([])
  })
})

describe("W1-01 checkpoint 谓词：hasCheckpointReview / hasCheckpointRevision", () => {
  function makeCheckpoint(
    overrides: Partial<DeepChapterGenerationResumeCheckpoint> = {},
  ): DeepChapterGenerationResumeCheckpoint {
    return {
      version: 1,
      originalRequest: "写第3章",
      chapterNumber: 3,
      stage: "after_revision",
      taskBrief: "任务书",
      draftContent: "初稿正文",
      reviewResults: [],
      currentContent: "返修后正文",
      ...overrides,
    }
  }

  it("after_revision 且 revisionReviewPending=true：hasCheckpointReview=false、hasCheckpointRevision=true（防绕过复审且不丢返修进度）", () => {
    const cp = makeCheckpoint({ stage: "after_revision", revisionReviewPending: true })
    expect(hasCheckpointReview(cp)).toBe(false)
    expect(hasCheckpointRevision(cp)).toBe(true)
  })

  it("after_revision 且 revisionReviewPending=false 或缺省：两谓词均为 true", () => {
    const reviewed = makeCheckpoint({ stage: "after_revision", revisionReviewPending: false })
    expect(hasCheckpointReview(reviewed)).toBe(true)
    expect(hasCheckpointRevision(reviewed)).toBe(true)

    const legacy = makeCheckpoint({ stage: "after_revision", revisionReviewPending: undefined })
    expect(hasCheckpointReview(legacy)).toBe(true)
    expect(hasCheckpointRevision(legacy)).toBe(true)
  })

  it("after_review 检查点：仅当 currentContent 非空且异于 draftContent 时 hasCheckpointRevision=true", () => {
    const noRevision = makeCheckpoint({ stage: "after_review", currentContent: undefined })
    expect(hasCheckpointReview(noRevision)).toBe(true)
    expect(hasCheckpointRevision(noRevision)).toBe(false)

    const sameAsDraft = makeCheckpoint({ stage: "after_review", currentContent: "初稿正文" })
    expect(hasCheckpointReview(sameAsDraft)).toBe(true)
    expect(hasCheckpointRevision(sameAsDraft)).toBe(false)

    const blankRevision = makeCheckpoint({ stage: "after_review", currentContent: "   " })
    expect(hasCheckpointReview(blankRevision)).toBe(true)
    expect(hasCheckpointRevision(blankRevision)).toBe(false)

    const mutated = makeCheckpoint({ stage: "after_review", currentContent: "已修订正文" })
    expect(hasCheckpointReview(mutated)).toBe(true)
    expect(hasCheckpointRevision(mutated)).toBe(true)
  })

  it("after_draft 检查点未达审稿阶段：hasCheckpointReview=false", () => {
    const draftOnly = makeCheckpoint({ stage: "after_draft", currentContent: undefined })
    expect(hasCheckpointReview(draftOnly)).toBe(false)
    expect(hasCheckpointRevision(draftOnly)).toBe(false)
  })
})

describe("R2-W09: safeBuildChapterContextPack DI 透传与 IC-02 失败降级", () => {
  it("成功路径透传 novelMode=true 与自定义 buildOptions（novelConfig / llmConfig）", async () => {
    const fakePack = { task: "写第5章", gaps: [] } as unknown as ContextPack
    const buildContextPack = vi.fn(async () => fakePack)
    const deps = { buildContextPack } as unknown as DeepChapterGenerationDeps
    const novelConfig = { searchTopK: 10 } as never
    const llmConfig = { model: "test-m" } as never

    const out = await safeBuildChapterContextPack(deps, "/proj", "写第5章", 5, {
      buildOptions: { novelConfig, llmConfig },
    })
    expect(out).toBe(fakePack)
    expect(buildContextPack).toHaveBeenCalledWith("/proj", "写第5章", 5, {
      novelMode: true,
      novelConfig,
      llmConfig,
    })
  })

  it("buildContextPack 抛错时返回带 context_pack_build 缺口的空包并触发 onThinking 告警", async () => {
    const buildContextPack = vi.fn(async () => {
      throw new Error("disk unreadable")
    })
    const deps = { buildContextPack } as unknown as DeepChapterGenerationDeps
    const onThinking = vi.fn()

    const out = await safeBuildChapterContextPack(deps, "/proj", "写第5章", 5, { onThinking })
    expect(out.task).toBe("写第5章")
    expect(hasContextPackLoadFailure(out)).toBe(true)
    expect(out.gaps).toEqual([
      {
        type: "load_failed",
        ref: "context_pack_build",
        originalLength: 0,
        retainedLength: 0,
        reason: "datasource_error",
      },
    ])
    expect(onThinking).toHaveBeenCalledWith(expect.stringContaining("上下文包构建失败"))
  })
})

import { describe, it, expect, vi } from "vitest"
import { generateReviewRewriteEdits } from "./review-rewrite-plan"
import type { ReviewRewriteIssue } from "./review-rewrite-plan"
import type { LlmConfig } from "@/stores/wiki-store"

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(),
}))

import { streamChat } from "@/lib/llm-client"

const fakeLlmConfig = {} as LlmConfig

describe("generateReviewRewriteEdits", () => {
  it("返回 ReviewRewriteEdit[] 且 prompt 语义独立于 de-ai-adapter (A2 intent)", async () => {
    const plan = JSON.stringify([
      { original_text: "原文片段", replacement_text: "改写片段", note: "test" },
    ])

    let capturedMessages: unknown
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      capturedMessages = messages
      callbacks.onToken(plan)
      callbacks.onDone()
    })

    const issue: ReviewRewriteIssue = {
      message: "这段逻辑不通",
      suggestion: "请修正",
      evidence: "原文片段",
      secondaryEvidence: "补充证据",
      chapterContent: "这是原文片段示例。",
    }

    const edits = await generateReviewRewriteEdits(issue, issue.chapterContent, fakeLlmConfig)

    expect(edits).toHaveLength(1)
    expect(edits[0].originalText).toBe("原文片段")
    expect(edits[0].replacementText).toBe("改写片段")

    const promptText = JSON.stringify(capturedMessages)
    // prompt 含审稿问题/修改建议/证据（finding-aware 语义）
    expect(promptText).toContain("审稿问题")
    expect(promptText).toContain("修改建议")
    expect(promptText).toContain("证据")
    // 不含 de-ai-adapter 关键词（A2 intent：独立 prompt 非去 AI 味）
    expect(promptText).not.toContain("去AI味")
    expect(promptText).not.toContain("QM-QUAI")
    expect(promptText).not.toContain("de-ai-writing")
  })

  it("targetOriginalText 优先作为 evidence 定位改写片段", async () => {
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken(JSON.stringify([{ original_text: "旧证据", replacement_text: "Y" }]))
      callbacks.onDone()
    })

    const issue: ReviewRewriteIssue = {
      message: "问题",
      evidence: "旧证据",
      chapterContent: "旧证据在这里。",
    }

    const edits = await generateReviewRewriteEdits(issue, issue.chapterContent, fakeLlmConfig, {
      targetOriginalText: "旧证据",
    })

    expect(edits[0].originalText).toBe("旧证据")
    expect(edits[0].replacementText).toBe("Y")
  })
})

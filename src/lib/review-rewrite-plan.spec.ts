import { describe, expect, it, vi } from "vitest"
import { streamChat } from "@/lib/llm-client"
import {
  applyReviewRewriteEditsToMarkdown,
  buildReviewRewritePlanMessages,
  findReviewRewriteAnchors,
  generateReviewRewriteEdits,
  parseReviewRewritePlan,
} from "./review-rewrite-plan"
import type { ReviewRewriteIssue } from "./review-rewrite-plan"
import type { LlmConfig } from "@/stores/wiki-store"

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(),
}))

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

describe("buildReviewRewritePlanMessages", () => {
  it("omits optional sections when absent", () => {
    const messages = buildReviewRewritePlanMessages({
      message: "m",
      chapterContent: "c",
    })
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe("system")
    expect(messages[1].role).toBe("user")
    expect(messages[1].content).toContain("审稿问题：m")
    expect(messages[1].content).toContain("请直接修正这个问题")
    expect(messages[1].content).not.toContain("审稿证据")
    expect(messages[1].content).not.toContain("补充证据")
    expect(messages[1].content).not.toContain("已定位到的候选原文片段")
  })

  it("includes evidence, secondary evidence, and direct anchors", () => {
    const messages = buildReviewRewritePlanMessages({
      message: "m",
      suggestion: "s",
      evidence: "e1",
      secondaryEvidence: "e2",
      chapterContent: "c",
      directAnchors: [
        { evidence: "e1", selection: { start: 0, end: 2, text: "ab", bodySnapshot: "abc" } },
        { evidence: "e2", selection: { start: 3, end: 5, text: "de", bodySnapshot: "abcde" } },
      ],
    })
    const content = messages[1].content
    expect(content).toContain("审稿证据：e1")
    expect(content).toContain("补充证据：e2")
    expect(content).toContain("片段1：ab")
    expect(content).toContain("片段2：de")
  })
})

describe("parseReviewRewritePlan", () => {
  it("returns empty for blank input", () => {
    expect(parseReviewRewritePlan("   ")).toEqual([])
    expect(parseReviewRewritePlan("")).toEqual([])
  })

  it("parses fenced JSON arrays with snake_case fields", () => {
    const raw = "```json\n[{\"original_text\":\"a\",\"replacement_text\":\"b\",\"note\":\"n\",\"id\":\"e9\"}]\n```"
    expect(parseReviewRewritePlan(raw)).toEqual([
      { id: "e9", originalText: "a", replacementText: "b", note: "n" },
    ])
  })

  it("falls back to camelCase and legacy search/replace keys", () => {
    const raw = JSON.stringify([
      { originalText: "x", replacementText: "y", reason: "r" },
      { search: "s", replace: "t" },
    ])
    const edits = parseReviewRewritePlan(raw)
    expect(edits[0]).toEqual({ id: "edit-1", originalText: "x", replacementText: "y", note: "r" })
    expect(edits[1].originalText).toBe("s")
    expect(edits[1].replacementText).toBe("t")
    expect(edits[1].note).toBeUndefined()
  })

  it("skips invalid entries and non-object items", () => {
    const raw = JSON.stringify([
      { original_text: "", replacement_text: "y" },
      { original_text: "x", replacement_text: "" },
      {},
      { original_text: "x" }, // missing replacement → all ?? fallbacks resolve to ""
      "junk",
      null,
      { original_text: "ok", replacement_text: "ok2" },
    ])
    const edits = parseReviewRewritePlan(raw)
    expect(edits).toHaveLength(1)
    expect(edits[0].originalText).toBe("ok")
  })

  it("returns empty when the payload is not an array or is malformed JSON", () => {
    expect(parseReviewRewritePlan('{"a":1}')).toEqual([])
    expect(parseReviewRewritePlan("not json at all")).toEqual([])
    expect(parseReviewRewritePlan("[]")).toEqual([])
    expect(parseReviewRewritePlan("[1,]")).toEqual([]) // bracket-wrapped but invalid JSON
  })
})

describe("findReviewRewriteAnchors", () => {
  const markdown = "# 第一章\n\n甲乙丙丁登场。\n\n甲乙丙丁再次出现。"

  it("splits bracketed evidence into candidates and dedupes spans", () => {
    const anchors = findReviewRewriteAnchors(markdown, ["「甲乙丙丁登场。」", "甲乙丙丁登场。"])
    expect(anchors).toHaveLength(1)
    expect(anchors[0].selection.text).toBe("甲乙丙丁登场。")
  })

  it("returns empty when no evidence matches", () => {
    expect(findReviewRewriteAnchors(markdown, ["不存在的内容xyz"])).toEqual([])
    expect(findReviewRewriteAnchors(markdown, [null, undefined, ""])).toEqual([])
  })

  it("finds multiple distinct anchors across evidences", () => {
    const anchors = findReviewRewriteAnchors(markdown, ["甲乙丙丁登场。", "甲乙丙丁再次出现。"])
    expect(anchors).toHaveLength(2)
  })
})

describe("applyReviewRewriteEditsToMarkdown", () => {
  const markdown = "---\ntitle: 章\n---\n# 第一章\n\n句子甲原文。\n\n句子乙原文。"

  it("applies all edits and reports ok with backups", () => {
    const result = applyReviewRewriteEditsToMarkdown(markdown, [
      { id: "e1", originalText: "句子甲原文。", replacementText: "句子甲改后。" },
      { id: "e2", originalText: "句子乙原文。", replacementText: "句子乙改后。" },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.markdown).toContain("句子甲改后。")
    expect(result.markdown).toContain("句子乙改后。")
    expect(result.markdown).not.toContain("句子甲原文。")
    expect(result.applied).toHaveLength(2)
    expect(result.applied[0].backup.itemId).toBe("e1")
    expect(result.applied[0].backup.originalText).toBe("句子甲原文。")
    expect(result.applied[0].backup.replacementText).toBe("句子甲改后。")
    expect(result.applied[0].backup.updatedAt).toBeTruthy()
  })

  it("collects failed edits and reports ok=false", () => {
    const result = applyReviewRewriteEditsToMarkdown(markdown, [
      { id: "good", originalText: "句子甲原文。", replacementText: "改后" },
      { id: "bad", originalText: "不存在的句子。", replacementText: "x" },
    ])
    expect(result.ok).toBe(false)
    expect(result.applied).toHaveLength(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].id).toBe("bad")
  })

  it("fails edits whose text occurs more than once", () => {
    const dup = "# 第一章\n\n重复句。\n\n重复句。"
    const result = applyReviewRewriteEditsToMarkdown(dup, [
      { id: "d", originalText: "重复句。", replacementText: "新句。" },
    ])
    expect(result.ok).toBe(false)
    expect(result.failed[0].id).toBe("d")
    expect(result.markdown).toBe(dup)
  })

  it("matches whitespace-insensitively when no exact match exists", () => {
    const spaced = "# 第一章\n\n句子甲\n原文。"
    const result = applyReviewRewriteEditsToMarkdown(spaced, [
      { id: "ws", originalText: "句子甲 原文。", replacementText: "改后。" },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.markdown).toContain("改后。")
    expect(result.applied[0].backup.evidence).toBe("句子甲\n原文。")
  })

  it("fails whitespace-insensitive edits whose text occurs more than once", () => {
    const dup = "# 第一章\n\n句子甲\n原文。\n\n句子甲 原文。"
    const result = applyReviewRewriteEditsToMarkdown(dup, [
      { id: "ws2", originalText: "句子甲原文。", replacementText: "改后。" },
    ])
    expect(result.ok).toBe(false)
    expect(result.failed[0].id).toBe("ws2")
  })

  it("fails edits with a blank original text", () => {
    const result = applyReviewRewriteEditsToMarkdown(markdown, [
      { id: "blank", originalText: "   ", replacementText: "x" },
    ])
    expect(result.ok).toBe(false)
    expect(result.failed[0].id).toBe("blank")
  })

  it("handles a document without frontmatter or heading", () => {
    const plain = "纯正文没有元数据。"
    const result = applyReviewRewriteEditsToMarkdown(plain, [
      { id: "p", originalText: "纯正文没有元数据。", replacementText: "替换后。" },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.markdown).toBe("替换后。")
  })
})

describe("generateReviewRewriteEdits — fallback paths", () => {
  it("falls back to treating the raw response as replacement text", async () => {
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken("```markdown\n修正后的整段内容\n```")
      callbacks.onDone()
    })
    const issue: ReviewRewriteIssue = {
      message: "m",
      evidence: "原文片段",
      chapterContent: "这是原文片段所在的一章。",
    }
    const edits = await generateReviewRewriteEdits(issue, issue.chapterContent, fakeLlmConfig)
    expect(edits).toHaveLength(1)
    expect(edits[0].id).toBe("edit-1")
    expect(edits[0].originalText).toBe("原文片段")
    expect(edits[0].replacementText).toBe("修正后的整段内容")
  })

  it("returns empty when the fallback response is blank", async () => {
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken("   ")
      callbacks.onDone()
    })
    const issue: ReviewRewriteIssue = {
      message: "m",
      evidence: "原文片段",
      chapterContent: "这是原文片段所在的一章。",
    }
    const edits = await generateReviewRewriteEdits(issue, issue.chapterContent, fakeLlmConfig)
    expect(edits).toEqual([])
  })

  it("returns empty when nothing can be located and the response is not JSON", async () => {
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken("no match no json")
      callbacks.onDone()
    })
    const issue: ReviewRewriteIssue = {
      message: "m",
      chapterContent: "完全无关的一章内容。",
    }
    const edits = await generateReviewRewriteEdits(issue, issue.chapterContent, fakeLlmConfig)
    expect(edits).toEqual([])
  })

  it("propagates stream errors", async () => {
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onError(new Error("stream exploded"))
    })
    const issue: ReviewRewriteIssue = {
      message: "m",
      evidence: "原文片段",
      chapterContent: "这是原文片段所在的一章。",
    }
    await expect(generateReviewRewriteEdits(issue, issue.chapterContent, fakeLlmConfig)).rejects.toThrow(
      "stream exploded",
    )
  })
})

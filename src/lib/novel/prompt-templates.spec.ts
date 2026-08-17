import { describe, expect, it, vi } from "vitest"

vi.mock("./chapter-window", () => ({
  sliceChapterForReview: vi.fn((c: string) => `SLICED:${c}`),
}))
vi.mock("@/lib/output-language", () => ({
  buildLanguageDirective: vi.fn((text: string) => `[LANG:${text}]`),
}))

import { PROMPTS } from "./prompt-templates"

describe("prompt-templates PROMPTS", () => {
  it("chapterGeneration composes context, goal and constraints", () => {
    const p = PROMPTS.chapterGeneration("CTX", "GOAL")
    expect(p).toContain("CTX")
    expect(p).toContain("GOAL")
    expect(p).toContain("3000-5000")
    expect(p).toContain("不要泄露角色尚不知道的信息")
  })

  it("chapterContinuation includes last paragraph", () => {
    const p = PROMPTS.chapterContinuation("CTX", "LAST")
    expect(p).toContain("CTX")
    expect(p).toContain("LAST")
  })

  it("chapterRevision slices original content to 6000 chars", () => {
    const long = "x".repeat(9000)
    const p = PROMPTS.chapterRevision("CTX", long, "NOTES")
    expect(p).not.toContain("x".repeat(6001))
    expect(p).toContain("NOTES")
  })

  it("chapterRevision includes full short content", () => {
    const p = PROMPTS.chapterRevision("CTX", "short", "rev")
    expect(p).toContain("short")
  })

  it("outlineGeneration uses fallback context when context empty", () => {
    const p = PROMPTS.outlineGeneration("玄幻", "长篇", "设定")
    expect(p).toContain("暂无可用的剧情记忆")
    expect(p).toContain("[LANG:设定]")
  })

  it("outlineGeneration uses provided context when given", () => {
    const p = PROMPTS.outlineGeneration("都市", "中篇", "设定", "已有记忆")
    expect(p).toContain("已有记忆")
    expect(p).not.toContain("暂无可用的剧情记忆")
  })

  it("outlineRefinementGeneration defaults empty userRequest", () => {
    const p = PROMPTS.outlineRefinementGeneration("OUTLINE", "HINTS", "")
    expect(p).toContain("未额外指定")
    expect(p).toContain("[LANG:OUTLINE]")
    expect(p).toContain("chapterOutlines")
  })

  it("outlineRefinementGeneration treats whitespace userRequest as empty", () => {
    const p = PROMPTS.outlineRefinementGeneration("OUTLINE", "HINTS", "   ")
    expect(p).toContain("未额外指定")
    expect(p).toContain("[LANG:")
  })

  it("outlineRefinementGeneration uses user request when provided", () => {
    const p = PROMPTS.outlineRefinementGeneration("OUTLINE", "HINTS", "加强伏笔")
    expect(p).toContain("加强伏笔")
    expect(p).toContain("[LANG:加强伏笔]")
    expect(p).toContain("HINTS")
  })

  it("consistencyCheck slices chapter content", () => {
    const p = PROMPTS.consistencyCheck("CTX", "CHAPTER")
    expect(p).toContain("CTX")
    expect(p).toContain("SLICED:CHAPTER")
    expect(p).toContain("人设一致性")
  })
})

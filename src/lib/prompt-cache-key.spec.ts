import { describe, expect, it } from "vitest"
import { buildPromptCacheKey, hashStableCacheInput } from "./prompt-cache-key"

describe("prompt-cache-key", () => {
  it("同项目同章多次生成稳定且相同的 key（Windows 反斜杠与尾部斜杠归一化）", () => {
    const a = buildPromptCacheKey({
      projectPath: "C:\\Novels\\BookA\\",
      scope: "deep_chapter",
      chapterNumber: 12,
    })
    const b = buildPromptCacheKey({
      projectPath: "c:/novels/booka",
      scope: "deep_chapter",
      chapterNumber: 12,
    })
    expect(a).toBe(b)
    expect(a.startsWith("niko:deep_chapter:ch12:")).toBe(true)
    expect(a.length).toBeLessThanOrEqual(64)
  })

  it("不同项目、不同章号或不同会话生成不同 key", () => {
    const ch1 = buildPromptCacheKey({ projectPath: "/p1", scope: "deep_chapter", chapterNumber: 1 })
    const ch2 = buildPromptCacheKey({ projectPath: "/p1", scope: "deep_chapter", chapterNumber: 2 })
    const p2 = buildPromptCacheKey({ projectPath: "/p2", scope: "deep_chapter", chapterNumber: 1 })
    const c1 = buildPromptCacheKey({ projectId: "id1", scope: "chat", conversationId: "conv-a" })
    const c2 = buildPromptCacheKey({ projectId: "id1", scope: "chat", conversationId: "conv-b" })
    expect(new Set([ch1, ch2, p2, c1, c2]).size).toBe(5)
  })

  it("超长 scope 也能保证不超过 64 字符且保持确定性", () => {
    const key = buildPromptCacheKey({
      projectPath: "/very/long/project",
      scope: "very_long_scope_name_exceeding_sixty_four_characters_total_budget",
      chapterNumber: 999,
    })
    expect(key.length).toBeLessThanOrEqual(64)
    expect(hashStableCacheInput("abc")).toHaveLength(16)
  })
})

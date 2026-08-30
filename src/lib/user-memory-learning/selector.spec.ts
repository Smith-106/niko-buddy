import { describe, expect, it } from "vitest"
import type { UserMemoryRule } from "./types"
import { inferUserMemorySurface, selectUserMemoryRules } from "./selector"

function rule(partial: Partial<UserMemoryRule>): UserMemoryRule {
  return {
    id: partial.id ?? "r1",
    rule: partial.rule ?? "回答时先给结论。",
    category: partial.category ?? "interaction_preference",
    source: partial.source ?? "automatic",
    surfaces: partial.surfaces ?? ["all"],
    confidence: partial.confidence ?? 0.8,
    evidenceSummary: "",
    sourceHash: null,
    fingerprint: partial.fingerprint ?? "fp",
    enabled: partial.enabled ?? true,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  }
}

describe("user memory selector", () => {
  it("根据任务识别审稿、大纲和章节写作场景", () => {
    expect(inferUserMemorySurface("请审查这一章的问题")).toBe("review")
    expect(inferUserMemorySurface("生成完整故事大纲")).toBe("ai-outline")
    expect(inferUserMemorySurface("续写第十章正文")).toBe("chapter-writing")
  })

  it("审查任务不注入创作文风偏好", () => {
    const selected = selectUserMemoryRules([
      rule({ id: "style", category: "writing_preference", rule: "写作保持幽默。", surfaces: ["all"] }),
      rule({ id: "review", category: "constraint", rule: "审查时列出证据。", surfaces: ["review"] }),
    ], { task: "请审查这一章", surface: "review" })

    expect(selected.map((item) => item.id)).toEqual(["review"])
  })

  it("当前请求明确否定旧规则时不注入旧规则", () => {
    const selected = selectUserMemoryRules([
      rule({ rule: "大纲输出使用分层标题。", category: "format_preference", surfaces: ["ai-outline"] }),
    ], { task: "本次大纲不要使用分层标题，直接连续输出。", surface: "ai-outline" })

    expect(selected).toEqual([])
  })

  it("只选择 active 规则并按会话、作品、全局层级覆盖", () => {
    const selected = selectUserMemoryRules([
      rule({ id: "global", rule: "回答时先给结论。", fingerprint: "same", scope: "global", status: "active" }),
      rule({ id: "project", rule: "本作品先给结论。", fingerprint: "same", scope: "project", projectKey: "p1", status: "active" }),
      rule({ id: "session", rule: "本会话先给结论。", fingerprint: "same", scope: "session", projectKey: "p1", sessionKey: "s1", status: "active" }),
      rule({ id: "candidate", rule: "候选规则。", status: "candidate" }),
      rule({ id: "conflicted", rule: "冲突规则。", status: "conflicted" }),
    ], {
      task: "请回答问题",
      surface: "ai-chat",
      projectKey: "p1",
      sessionKey: "s1",
    })

    expect(selected.map((item) => item.id)).toContain("session")
    expect(selected.map((item) => item.id)).not.toContain("project")
    expect(selected.map((item) => item.id)).not.toContain("global")
    expect(selected.map((item) => item.id)).not.toContain("candidate")
    expect(selected.map((item) => item.id)).not.toContain("conflicted")
  })

  it("没有作品或会话标识时只使用全局规则", () => {
    const selected = selectUserMemoryRules([
      rule({ id: "global", scope: "global", status: "active" }),
      rule({ id: "project", scope: "project", projectKey: "p1", status: "active" }),
      rule({ id: "session", scope: "session", sessionKey: "s1", status: "active" }),
    ], { task: "请回答问题", surface: "ai-chat" })

    expect(selected.map((item) => item.id)).toEqual(["global"])
  })
})

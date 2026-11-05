import { describe, expect, it } from "vitest"
import type { UserMemoryRule } from "./types"
import { inferUserMemorySurface, evaluateUserMemoryRule, selectUserMemoryRules } from "./selector"

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

describe("user memory selector 分支覆盖", () => {
  it("识别拆书场景与默认闲聊场景", () => {
    expect(inferUserMemorySurface("请做一次拆书，提炼人物小传")).toBe("book-analysis")
    expect(inferUserMemorySurface("文风提取：总结作者的语言习惯")).toBe("book-analysis")
    expect(inferUserMemorySurface("今天随便聊聊")).toBe("ai-chat")
  })

  it("未指定 surface 时按任务自动推断场景", () => {
    const selected = selectUserMemoryRules([
      rule({ id: "chat", rule: "回答时先给结论。", surfaces: ["ai-chat"] }),
      rule({ id: "review", rule: "审查时列出证据。", surfaces: ["review"] }),
    ], { task: "今天随便聊聊" })

    expect(selected.map((item) => item.id)).toEqual(["chat"])
  })

  it("章节任务未指定 surface 时推断章节写作场景", () => {
    const selected = selectUserMemoryRules([
      rule({ id: "chapter", rule: "续写时保持剧情承接。", surfaces: ["chapter-writing"] }),
    ], { task: "续写第十章正文" })

    expect(selected.map((item) => item.id)).toEqual(["chapter"])
  })

  it("拆书与分析场景只允许交互、格式、约束与手动记忆", () => {
    expect(evaluateUserMemoryRule(
      rule({ category: "interaction_preference", surfaces: ["all"] }),
      { task: "请拆书", surface: "book-analysis" },
    )).toBeNull()
    expect(evaluateUserMemoryRule(
      rule({ category: "writing_preference", surfaces: ["all"] }),
      { task: "请拆书", surface: "book-analysis" },
    )).toBe("category_blocked")
    expect(evaluateUserMemoryRule(
      rule({ category: "manual", surfaces: ["all"] }),
      { task: "做一次作品分析", surface: "analysis" },
    )).toBeNull()
  })

  it("空否定短语不会误伤旧规则", () => {
    const selected = selectUserMemoryRules([
      rule({ id: "r", rule: "回答时先给结论。", surfaces: ["all"] }),
    ], { task: "本次不要这个，先给结论。", surface: "ai-chat" })

    expect(selected.map((item) => item.id)).toEqual(["r"])
  })

  it("否定内容与规则无关时不误伤规则", () => {
    const selected = selectUserMemoryRules([
      rule({ id: "r", rule: "大纲输出使用分层标题。", category: "format_preference", surfaces: ["ai-outline"] }),
    ], { task: "今晚不要熬夜，先写大纲。", surface: "ai-outline" })

    expect(selected.map((item) => item.id)).toEqual(["r"])
  })

  it("以后缀关键词冲突的旧规则会被过滤", () => {
    const selected = selectUserMemoryRules([
      rule({ id: "r", rule: "写作时请连续输出。", surfaces: ["all"] }),
    ], { task: "本次不要连续输出内容，请调整。", surface: "ai-chat" })

    expect(selected).toEqual([])
  })

  it("同层级时手动来源优先于自动来源", () => {
    const selected = selectUserMemoryRules([
      rule({ id: "auto", source: "automatic", confidence: 0.9, fingerprint: "a", scope: "global" }),
      rule({ id: "manual", source: "manual", confidence: 0.1, fingerprint: "m", scope: "global" }),
    ], { task: "请回答问题", surface: "ai-chat" })

    expect(selected.map((item) => item.id)).toEqual(["manual", "auto"])
  })

  it("同来源时置信度高的排在前面", () => {
    const selected = selectUserMemoryRules([
      rule({ id: "low", confidence: 0.5, fingerprint: "l" }),
      rule({ id: "high", confidence: 0.9, fingerprint: "h" }),
    ], { task: "请回答问题", surface: "ai-chat" })

    expect(selected.map((item) => item.id)).toEqual(["high", "low"])
  })

  it("来源与置信度相同时更新时间晚的排在前面", () => {
    const selected = selectUserMemoryRules([
      rule({ id: "old", confidence: 0.5, updatedAt: 1, fingerprint: "o" }),
      rule({ id: "new", confidence: 0.5, updatedAt: 5, fingerprint: "n" }),
    ], { task: "请回答问题", surface: "ai-chat" })

    expect(selected.map((item) => item.id)).toEqual(["new", "old"])
  })

  it("达到 limit 后停止选择", () => {
    const selected = selectUserMemoryRules([
      rule({ id: "a", fingerprint: "a" }),
      rule({ id: "b", fingerprint: "b" }),
      rule({ id: "c", fingerprint: "c" }),
    ], { task: "请回答问题", surface: "ai-chat", limit: 2 })

    expect(selected.map((item) => item.id)).toEqual(["a", "b"])
  })

  it("evaluateUserMemoryRule 返回各类过滤原因", () => {
    const base = { task: "请回答问题", surface: "ai-chat" as const }
    expect(evaluateUserMemoryRule(rule({ enabled: false }), base)).toBe("disabled")
    expect(evaluateUserMemoryRule(rule({ source: "automatic" }), { ...base, onlyManual: true })).toBe("disabled")
    expect(evaluateUserMemoryRule(rule({ source: "manual" }), { ...base, onlyManual: true })).toBeNull()
    expect(evaluateUserMemoryRule(rule({ status: "expired" }), base)).toBe("expired")
    expect(evaluateUserMemoryRule(rule({ surfaces: ["review"] }), base)).toBe("surface_mismatch")
  })
})

import { describe, expect, it } from "vitest"

import {
  buildCapabilityIndex,
  docFromAiCapability,
  docFromUserSkill,
  retrieveCapabilities,
  ruleFilterReason,
} from "./capability-retrieval"
import type { UserSkill } from "../novel/skill-library"
import type { AiCapability } from "./capabilities/types"

function skill(partial: Partial<UserSkill>): UserSkill {
  return {
    id: partial.id ?? "s1",
    name: partial.name ?? "技能",
    description: partial.description ?? "",
    kind: partial.kind ?? ["style"],
    stages: partial.stages ?? ["output"],
    modes: partial.modes ?? ["fast", "standard", "strict"],
    content: partial.content ?? "",
    source: partial.source ?? "project",
    priority: partial.priority ?? 50,
    tags: partial.tags ?? [],
    categoryId: partial.categoryId ?? "",
  }
}

function cap(partial: Partial<AiCapability>): AiCapability {
  return {
    id: partial.id ?? "c1",
    name: partial.name ?? "cap",
    kind: partial.kind ?? "built_in_tool",
    permission: partial.permission ?? "auto",
    modes: partial.modes ?? ["standard", "strict"],
    intents: partial.intents ?? [],
    toolName: partial.toolName,
    skillId: partial.skillId,
    source: partial.source ?? "built-in",
  }
}

const RULE_STD = { mode: "standard" as const }

describe("capability-retrieval", () => {
  describe("docFromUserSkill / docFromAiCapability", () => {
    it("UserSkill → doc: name/label=kind+stages/tags=tags+modes/permission=auto", () => {
      const d = docFromUserSkill(skill({
        id: "s1", name: "人物动机", kind: ["planning"], stages: ["planning"],
        modes: ["standard"], tags: ["角色"], categoryId: "char",
      }))
      expect(d.id).toBe("s1")
      expect(d.name).toBe("人物动机")
      expect(d.label).toContain("planning")
      expect(d.tags).toContain("角色")
      expect(d.permission).toBe("auto")
    })

    it("AiCapability → doc: permission 透传 confirm", () => {
      const d = docFromAiCapability(cap({ id: "c1", name: "联网搜索", permission: "confirm", kind: "web_search" }))
      expect(d.permission).toBe("confirm")
      expect(d.label).toContain("web_search")
    })
  })

  describe("ruleFilterReason", () => {
    it("mode 不匹配 → 裁掉", () => {
      const d = docFromUserSkill(skill({ id: "s1", modes: ["strict"] }))
      expect(ruleFilterReason(d, { mode: "fast" })).toMatch(/mode/)
      expect(ruleFilterReason(d, { mode: "strict" })).toBeNull()
    })

    it("intent 不匹配 → 裁掉；intents 为空则放行", () => {
      const scoped = docFromAiCapability(cap({ id: "c1", intents: ["write_chapter"] }))
      expect(ruleFilterReason(scoped, { mode: "standard", intent: "review_chapter" })).toMatch(/intent/)
      expect(ruleFilterReason(scoped, { mode: "standard", intent: "write_chapter" })).toBeNull()
      const open = docFromAiCapability(cap({ id: "c2", intents: [] }))
      expect(ruleFilterReason(open, { mode: "standard", intent: "any" })).toBeNull()
    })

    it("allowedSources 白名单 + autoOnly", () => {
      const d = docFromUserSkill(skill({ id: "s1", source: "project" }))
      expect(ruleFilterReason(d, { mode: "standard", allowedSources: new Set(["built-in"]) })).toMatch(/source/)
      const confirmCap = docFromAiCapability(cap({ id: "c1", permission: "confirm" }))
      expect(ruleFilterReason(confirmCap, { mode: "standard", autoOnly: true })).toMatch(/确认/)
    })
  })

  describe("retrieveCapabilities", () => {
    const pool = [
      skill({ id: "s-char", name: "人物动机", description: "角色行为动机分析", kind: ["planning"], stages: ["planning"], modes: ["standard", "strict"], tags: ["角色"] }),
      skill({ id: "s-hook", name: "结尾钩子", description: "章节末尾悬念钩子", kind: ["output"], stages: ["output"], modes: ["standard", "strict"], tags: ["悬念"] }),
      skill({ id: "s-style", name: "文风润色", description: "按指定风格改写正文", kind: ["style"], stages: ["rewrite"], modes: ["standard"], tags: ["风格", "改写"] }),
      skill({ id: "s-deai", name: "去AI味", description: "降低AI腔", kind: ["style"], stages: ["output"], modes: ["fast", "standard"], tags: ["去AI"] }),
      cap({ id: "c-web", name: "联网搜索 web search", kind: "web_search", permission: "confirm", modes: ["standard"], intents: ["external_search"] }),
    ]

    it("query 命中技能名 → 排第一（name 权重最高）", () => {
      const r = retrieveCapabilities("结尾 悬念 钩子", pool, RULE_STD, { limit: 5 })
      expect(r.candidates[0]?.doc.id).toBe("s-hook")
    })

    it("空 query / 空池 → 空候选", () => {
      expect(retrieveCapabilities("", pool, RULE_STD).candidates).toHaveLength(0)
      expect(retrieveCapabilities("x", [], RULE_STD).candidates).toHaveLength(0)
    })

    it("mode 裁剪：strict 模式下 standard-only 技能被剔除并记录", () => {
      const r = retrieveCapabilities("风格 改写 润色", pool, { mode: "strict" }, { limit: 5 })
      expect(r.candidates.some((c) => c.doc.id === "s-style")).toBe(false)
      expect(r.filteredOut.some((f) => f.id === "s-style")).toBe(true)
    })

    it("intent 裁剪：写作意图下 external_search 能力被剔除", () => {
      const r = retrieveCapabilities("搜索 章节", pool, { mode: "standard", intent: "write_chapter" }, { limit: 10 })
      expect(r.filteredOut.some((f) => f.id === "c-web" && /intent/.test(f.reason))).toBe(true)
    })

    it("limit 截断生效", () => {
      const r = retrieveCapabilities("风格 章节 输出", pool, RULE_STD, { limit: 2 })
      expect(r.candidates.length).toBeLessThanOrEqual(2)
    })
  })

  describe("buildCapabilityIndex", () => {
    it("每个能力产出一个 Bm25Doc，id 稳定", () => {
      const idx = buildCapabilityIndex([skill({ id: "s1" }), cap({ id: "c1" })])
      expect(idx).toHaveLength(2)
      expect(idx.map((d) => d.id).sort()).toEqual(["c1", "s1"])
      expect(idx.every((d) => d.text.length > 0)).toBe(true)
    })
  })
})

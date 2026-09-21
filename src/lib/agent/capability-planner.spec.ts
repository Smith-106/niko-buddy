import { describe, expect, it } from "vitest"

import {
  MAX_CAPABILITY_NODES,
  buildCapabilityPlannerPrompt,
  parseCapabilityPlan,
  validateCapabilityPlan,
  type CapabilityPlan,
} from "./capability-planner"
import { docFromUserSkill, type RetrievedCapability } from "./capability-retrieval"
import type { UserSkill } from "../novel/skill-library"

function skill(id: string, name: string): UserSkill {
  return {
    id, name, description: "", kind: ["style"], stages: ["output"],
    modes: ["standard"], content: "", source: "project", priority: 50, tags: [], categoryId: "",
  }
}

function cand(id: string, name: string, score = 1): RetrievedCapability {
  return { doc: docFromUserSkill(skill(id, name)), score }
}

function node(partial: Partial<CapabilityPlan>): CapabilityPlan {
  return {
    id: partial.id ?? "n1",
    name: partial.name ?? "节点",
    capabilityId: partial.capabilityId ?? "cap-a",
    dependsOn: partial.dependsOn ?? [],
    permission: partial.permission ?? "auto",
    reason: partial.reason ?? "",
    finalReview: partial.finalReview ?? false,
  }
}

describe("capability-planner", () => {
  describe("buildCapabilityPlannerPrompt", () => {
    it("注入用户任务 + 候选能力清单 + capabilityId", () => {
      const p = buildCapabilityPlannerPrompt({
        userMessage: "帮我润色本章并加强悬念",
        candidates: [cand("s-hook", "结尾钩子"), cand("s-style", "文风润色")],
        intent: "polish_chapter",
      })
      expect(p).toContain("帮我润色本章并加强悬念")
      expect(p).toContain("capabilityId: s-hook")
      expect(p).toContain("capabilityId: s-style")
      expect(p).toContain("polish_chapter")
      expect(p).toContain("nodes")
    })

    it("simpleTask=true → 最多 1 节点", () => {
      const p = buildCapabilityPlannerPrompt({
        userMessage: "改一句", candidates: [cand("s1", "x")], simpleTask: true,
      })
      expect(p).toContain("最多 1 个能力节点")
    })

    it("无候选 → 清单显示 无候选能力", () => {
      const p = buildCapabilityPlannerPrompt({ userMessage: "x", candidates: [] })
      expect(p).toContain("无候选能力")
    })
  })

  describe("parseCapabilityPlan", () => {
    const allowed = new Set(["cap-a", "cap-b", "cap-c"])

    it("解析标准 nodes 数组", () => {
      const text = JSON.stringify({ nodes: [
        { id: "n1", name: "检查", capabilityId: "cap-a", dependsOn: [], permission: "auto", reason: "先查", finalReview: false },
        { id: "n2", name: "改写", capabilityId: "cap-b", dependsOn: ["n1"], permission: "confirm", reason: "基于检查改写", finalReview: true },
      ] })
      const r = parseCapabilityPlan(text, allowed)
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.plan).toHaveLength(2)
        expect(r.plan[1].capabilityId).toBe("cap-b")
        expect(r.plan[1].dependsOn).toEqual(["n1"])
        expect(r.plan[1].permission).toBe("confirm")
        expect(r.plan[1].finalReview).toBe(true)
      }
    })

    it("容错：```json 代码块包裹 + capability_id snake_case", () => {
      const text = "```json\n" + JSON.stringify({ nodes: [
        { id: "n1", capability_id: "cap-a" },
      ] }) + "\n```"
      const r = parseCapabilityPlan(text, allowed)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.plan[0].capabilityId).toBe("cap-a")
    })

    it("兼容 tasks 键（沿用大纲 planner 习惯）", () => {
      const r = parseCapabilityPlan(JSON.stringify({ tasks: [{ id: "n1", capabilityId: "cap-a" }] }), allowed)
      expect(r.ok).toBe(true)
    })

    it("引用候选集外能力 → 拒绝（防幻觉）", () => {
      const r = parseCapabilityPlan(JSON.stringify({ nodes: [{ id: "n1", capabilityId: "cap-zzz" }] }), allowed)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain("cap-zzz")
    })

    it("非 JSON → error", () => {
      const r = parseCapabilityPlan("没有任何 JSON", allowed)
      expect(r.ok).toBe(false)
    })

    it("缺 capabilityId → error", () => {
      const r = parseCapabilityPlan(JSON.stringify({ nodes: [{ id: "n1", name: "x" }] }), allowed)
      expect(r.ok).toBe(false)
    })
  })

  describe("validateCapabilityPlan", () => {
    it("合法 DAG 通过", () => {
      const plan = [
        node({ id: "a", capabilityId: "cap-a" }),
        node({ id: "b", capabilityId: "cap-b", dependsOn: ["a"] }),
        node({ id: "c", capabilityId: "cap-c", dependsOn: ["a", "b"] }),
      ]
      expect(validateCapabilityPlan(plan).ok).toBe(true)
    })

    it("空计划 / 超上限 → error", () => {
      expect(validateCapabilityPlan([]).ok).toBe(false)
      const tooMany = Array.from({ length: MAX_CAPABILITY_NODES + 1 }, (_, i) => node({ id: `n${i}`, capabilityId: "cap-a" }))
      const v = validateCapabilityPlan(tooMany)
      expect(v.ok).toBe(false)
      expect(v.errors.join()).toContain("不能超过")
    })

    it("重复 id / 依赖自身 / 依赖不存在 → error", () => {
      expect(validateCapabilityPlan([node({ id: "a" }), node({ id: "a" })]).ok).toBe(false)
      expect(validateCapabilityPlan([node({ id: "a", dependsOn: ["a"] })]).ok).toBe(false)
      expect(validateCapabilityPlan([node({ id: "a", dependsOn: ["ghost"] })]).ok).toBe(false)
    })

    it("环依赖 → error", () => {
      const plan = [
        node({ id: "a", capabilityId: "cap-a", dependsOn: ["c"] }),
        node({ id: "b", capabilityId: "cap-b", dependsOn: ["a"] }),
        node({ id: "c", capabilityId: "cap-c", dependsOn: ["b"] }),
      ]
      const v = validateCapabilityPlan(plan)
      expect(v.ok).toBe(false)
      expect(v.errors.join()).toContain("循环")
    })
  })
})

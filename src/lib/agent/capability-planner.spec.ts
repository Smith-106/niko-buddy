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

function sparseSkill(): UserSkill {
  return {
    id: "s-sparse", name: "稀疏技能", description: "一句说明",
    kind: [], stages: [], modes: [], content: "", source: "project",
    priority: 50, tags: [], categoryId: "",
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

    it("空用户消息 + 上下文摘要 + 稀疏候选（空 modes/空 label/有说明）", () => {
      const sparse = sparseSkill()
      const p = buildCapabilityPlannerPrompt({
        userMessage: "",
        candidates: [{ doc: docFromUserSkill(sparse), score: 1 }],
        contextSummary: "已写到第三章，主角进城",
      })
      // userMessage 为空 → 回退占位（capability-planner.ts:84 || 右侧）
      expect(p).toContain("（未提供）")
      expect(p).toContain("已写到第三章，主角进城")
      // modes 为空 → "不限"；label 为空不渲染标签行；description 渲染说明行
      expect(p).toContain("不限")
      expect(p).toContain("一句说明")
      expect(p).not.toContain("标签：")
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

    it("顶层数组 JSON 直接作为节点数组（无 nodes/tasks 键）", () => {
      const text = JSON.stringify([{ id: "n1", name: "检查", capabilityId: "cap-a" }])
      const r = parseCapabilityPlan(text, allowed)
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.plan).toHaveLength(1)
        expect(r.plan[0].capabilityId).toBe("cap-a")
      }
    })

    it("对象无 nodes/tasks 键 → 缺 nodes 数组 error", () => {
      const r = parseCapabilityPlan(JSON.stringify({ hello: 1 }), allowed)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain("nodes")
    })

    it("节点不是对象 → error（定位到序号）", () => {
      const r = parseCapabilityPlan(JSON.stringify({ nodes: [7] }), allowed)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain("第 1 个节点不是对象")
    })

    it("省略候选集时不做幻觉校验（allowedCapabilityIds 缺省）", () => {
      const text = JSON.stringify({ nodes: [{ id: "n1", capabilityId: "cap-new" }] })
      const r = parseCapabilityPlan(text)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.plan[0].capabilityId).toBe("cap-new")
    })

    it("重复 id 经校验拒绝（validation.ok=false 路径）", () => {
      const text = JSON.stringify({ nodes: [
        { id: "n1", capabilityId: "cap-a" },
        { id: "n1", capabilityId: "cap-b" },
      ] })
      const r = parseCapabilityPlan(text, allowed)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain("重复")
    })

    it("字符串内反斜杠转义不破坏 JSON 边界识别", () => {
      const text = JSON.stringify({ nodes: [
        { id: "n1", capabilityId: "cap-a", reason: "处理 a\\b 转义与 \"引用\"" },
      ] })
      const r = parseCapabilityPlan(text, allowed)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.plan[0].reason).toContain("a\\b")
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

    it("空白 id 与缺省 dependsOn 触发校验错误（不抛错）", () => {
      const plan = [{
        ...node({ id: "   ", capabilityId: "cap-a" }),
        dependsOn: undefined as unknown as string[],
      }]
      const v = validateCapabilityPlan(plan)
      expect(v.ok).toBe(false)
      expect(v.errors.join()).toContain("不能为空")
    })
  })

  it("花括号闭合但 JSON 语法错误时报解析失败并带上错误原文", () => {
    // extractJsonObject 能切出 {"a": }，但 JSON.parse 抛错 → 走 catch 分支
    const r = parseCapabilityPlan('前缀 {"a": } 后缀')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain("规划 JSON 解析失败")
  })

  it("花括号始终不闭合时 extractJsonObject 返回 null，报未返回 JSON 对象", () => {
    const r = parseCapabilityPlan('{"a": 1')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toBe("规划器未返回 JSON 对象")
  })
})

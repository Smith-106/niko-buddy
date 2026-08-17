import { describe, expect, it } from "vitest"
import { createDefaultStructureThrilPacingPlan } from "./chapter-structure-plan"
import { evaluateResidualRewritePolicy } from "./residual-rewrite-policy"
import {
  appendStructurePlanToTaskBrief,
  buildStructureFirstRewriteConstraint,
  taskBriefHasStructurePlan,
} from "./structure-first-rewrite"

describe("structure-first-rewrite", () => {
  it("appendStructurePlanToTaskBrief injects beat labels when plan present", () => {
    const plan = createDefaultStructureThrilPacingPlan(1)
    const out = appendStructurePlanToTaskBrief("必须完成：推进主线", plan)
    expect(out).toMatch(/必须完成：推进主线/)
    expect(out).toMatch(/ChapterStructurePlan/)
    expect(out).toMatch(/开篇压迫|章末钩/)
    expect(taskBriefHasStructurePlan(out)).toBe(true)
  })

  it("appendStructurePlanToTaskBrief leaves brief unchanged without plan", () => {
    const brief = "必须完成：推进主线"
    expect(appendStructurePlanToTaskBrief(brief, null)).toBe(brief)
    expect(taskBriefHasStructurePlan(brief)).toBe(false)
  })

  it("constraint names structure_thril_pacing when densify rejected", () => {
    const plan = createDefaultStructureThrilPacingPlan(5)
    const decision = evaluateResidualRewritePolicy({
      residualOverallMedian: 8.8,
      mode: "densify_only",
    })
    expect(decision.accept).toBe(false)
    const c = buildStructureFirstRewriteConstraint(plan, decision)
    expect(c).toMatch(/structure_thril_pacing/)
    expect(c).toMatch(/densify/)
    expect(c).toMatch(/productHardGate=false/)
    expect(c).toMatch(/ChapterStructurePlan/)
  })

  it("appendStructurePlanToTaskBrief tolerates null brief and invalid plans", () => {
    expect(appendStructurePlanToTaskBrief(undefined, null)).toBe("")
    const invalid = {
      schemaVersion: "chapter-structure-plan/9.9",
      fix1NonSpoiler: false,
      beats: [],
    } as never
    const brief = "必须完成：推进主线"
    expect(appendStructurePlanToTaskBrief(brief, invalid)).toBe(brief)
    const plan = createDefaultStructureThrilPacingPlan(1)
    const block = appendStructurePlanToTaskBrief("", plan)
    expect(block).toMatch(/ChapterStructurePlan/)
    expect(appendStructurePlanToTaskBrief(undefined, plan)).toBe(block)
  })

  it("constraint falls back without decision and without a valid plan", () => {
    const plan = createDefaultStructureThrilPacingPlan(5)
    const noDecision = buildStructureFirstRewriteConstraint(plan, null)
    expect(noDecision).toContain("【Structure-first 改写约束】")
    expect(noDecision).not.toContain("策略判定")
    const lowDecision = evaluateResidualRewritePolicy({ residualOverallMedian: 8.5, mode: "densify_only" })
    expect(lowDecision.requiredMode).toBeNull()
    const noRequiredMode = buildStructureFirstRewriteConstraint(plan, lowDecision)
    expect(noRequiredMode).toContain("策略判定")
    expect(noRequiredMode).not.toContain("要求模式")
    const noPlan = buildStructureFirstRewriteConstraint(null, lowDecision)
    expect(noPlan).toContain("无有效 ChapterStructurePlan")
  })

  it("taskBriefHasStructurePlan tolerates undefined briefs", () => {
    expect(taskBriefHasStructurePlan(undefined as unknown as string)).toBe(false)
  })

  it("invalid plan + nullish brief → taskBrief ?? \"\" fallback (line 30)", () => {
    const invalid = {
      schemaVersion: "chapter-structure-plan/9.9",
      fix1NonSpoiler: false,
      beats: [],
    } as never
    expect(appendStructurePlanToTaskBrief(undefined, invalid)).toBe("")
  })
})

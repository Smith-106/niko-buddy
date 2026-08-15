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
})

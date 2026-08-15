/**
 * Medium-deepen E1–E3 wiring contracts:
 * - optional residual fields fail-open
 * - residual_high plan inject markers
 * - residual densify ban + structure constraint text
 * - pure modules still compose with deep-chapter helpers
 */
import { describe, expect, it } from "vitest"
import { createDefaultStructureThrilPacingPlan } from "./chapter-structure-plan"
import {
  evaluateResidualRewritePolicy,
  RESIDUAL_OVERALL_MEDIAN_THRESHOLD,
} from "./residual-rewrite-policy"
import {
  appendStructurePlanToTaskBrief,
  buildStructureFirstRewriteConstraint,
  taskBriefHasStructurePlan,
} from "./structure-first-rewrite"
import {
  evaluateResidualPolicyForInput,
  hasResidualOptIn,
  resolveStructurePlanForResidual,
  type DeepChapterGenerationInput,
} from "./deep-chapter-generation"

function baseInput(
  overrides: Partial<DeepChapterGenerationInput> = {},
): DeepChapterGenerationInput {
  return {
    projectPath: "/tmp/novel",
    userRequest: "wire residual",
    chapterNumber: 5,
    llmConfig: {} as DeepChapterGenerationInput["llmConfig"],
    novelConfig: {} as DeepChapterGenerationInput["novelConfig"],
    ...overrides,
  }
}

describe("deep-chapter structure-first wiring (E1–E3)", () => {
  it("E1 fail-open: omitting residual fields is not residual opt-in", () => {
    const input = baseInput()
    expect(hasResidualOptIn(input)).toBe(false)
    expect(resolveStructurePlanForResidual(input)).toBeUndefined()
    expect(evaluateResidualPolicyForInput(input)).toBeNull()
  })

  it("E1 residual opt-in when any residual field set", () => {
    expect(hasResidualOptIn(baseInput({ residualOverallMedian: 8.8 }))).toBe(true)
    expect(hasResidualOptIn(baseInput({ residualRewriteMode: "densify_only" }))).toBe(true)
    expect(
      hasResidualOptIn(
        baseInput({ chapterStructurePlan: createDefaultStructureThrilPacingPlan(5) }),
      ),
    ).toBe(true)
    expect(hasResidualOptIn(baseInput({ residualLengthPreserving: true }))).toBe(true)
  })

  it("E2 residual_high without plan uses default structure thril-pacing plan", () => {
    const plan = resolveStructurePlanForResidual(
      baseInput({ residualOverallMedian: 8.8, chapterNumber: 5 }),
    )
    expect(plan).toBeDefined()
    expect(plan!.beats.length).toBeGreaterThan(0)
  })

  it("E2 explicit plan wins over default", () => {
    const explicit = createDefaultStructureThrilPacingPlan(2)
    const plan = resolveStructurePlanForResidual(
      baseInput({
        residualOverallMedian: 8.8,
        chapterNumber: 5,
        chapterStructurePlan: explicit,
      }),
    )
    expect(plan).toBe(explicit)
  })

  it("E2 inject path: residual_high appends ChapterStructurePlan marker", () => {
    const plan = createDefaultStructureThrilPacingPlan(5)
    const brief = "必须完成：压迫开场\n结尾钩子：未决危机"
    const injected = appendStructurePlanToTaskBrief(brief, plan)
    expect(taskBriefHasStructurePlan(injected)).toBe(true)
    expect(injected).toContain("【ChapterStructurePlan")
    // idempotent marker check
    expect(taskBriefHasStructurePlan(appendStructurePlanToTaskBrief(injected, plan))).toBe(true)
  })

  it("E2 fail-open: no residual → no plan inject needed (helper leaves brief alone)", () => {
    const brief = "必须完成：正常草稿路径"
    expect(resolveStructurePlanForResidual(baseInput())).toBeUndefined()
    expect(taskBriefHasStructurePlan(brief)).toBe(false)
  })

  it("E3 residual_high densify_only is rejected with required structure_thril_pacing", () => {
    const decision = evaluateResidualPolicyForInput(
      baseInput({
        residualOverallMedian: 8.8,
        residualRewriteMode: "densify_only",
      }),
    )
    expect(decision).not.toBeNull()
    expect(decision!.accept).toBe(false)
    expect(decision!.requiredMode).toBe("structure_thril_pacing")
    expect(decision!.productHardGate).toBe(false)
    expect(decision!.reason).toMatch(/densify/i)
  })

  it("E3 residual_high structure_thril_pacing length-preserving accepts", () => {
    const decision = evaluateResidualPolicyForInput(
      baseInput({
        residualOverallMedian: 8.8,
        residualRewriteMode: "structure_thril_pacing",
        residualLengthPreserving: true,
      }),
    )
    expect(decision!.accept).toBe(true)
    expect(decision!.productHardGate).toBe(false)
  })

  it("E3 constraint text bans densify and includes requiredMode", () => {
    const decision = evaluateResidualRewritePolicy({
      residualOverallMedian: 8.8,
      mode: "densify_only",
    })
    const plan = createDefaultStructureThrilPacingPlan(5)
    const text = buildStructureFirstRewriteConstraint(plan, decision)
    expect(text).toContain("Structure-first")
    expect(text).toMatch(/densify/i)
    expect(text).toContain("structure_thril_pacing")
    expect(text).toContain("productHardGate=false")
    expect(text).toContain("【ChapterStructurePlan")
  })

  it("E3 below residual threshold does not auto-ban densify via policy", () => {
    const decision = evaluateResidualPolicyForInput(
      baseInput({
        residualOverallMedian: 8.0,
        residualRewriteMode: "densify_only",
      }),
    )
    expect(decision!.accept).toBe(true)
    expect(decision!.residualBand).toBe("below_residual")
  })

  it("threshold constant remains 8.6", () => {
    expect(RESIDUAL_OVERALL_MEDIAN_THRESHOLD).toBe(8.6)
  })
})

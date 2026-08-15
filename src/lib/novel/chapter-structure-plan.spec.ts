import { describe, expect, it } from "vitest"
import {
  buildStructurePlanPromptBlock,
  createDefaultStructureThrilPacingPlan,
  createDimAwareStructureThrilPacingPlan,
  createEmptyChapterStructurePlan,
  validateChapterStructurePlan,
} from "./chapter-structure-plan"

describe("chapter-structure-plan", () => {
  it("validate rejects empty beats", () => {
    const plan = createEmptyChapterStructurePlan()
    const v = validateChapterStructurePlan(plan)
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => e.includes("non-empty"))).toBe(true)
  })

  it("validate rejects missing end_hook purpose", () => {
    const plan = createEmptyChapterStructurePlan({
      beats: [
        {
          id: "b1",
          label: "开场",
          purpose: "opening_pressure",
        },
      ],
    })
    const v = validateChapterStructurePlan(plan)
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => e.includes("end_hook"))).toBe(true)
  })

  it("default structure thril-pacing plan validates", () => {
    const plan = createDefaultStructureThrilPacingPlan(6)
    const v = validateChapterStructurePlan(plan)
    expect(v.ok).toBe(true)
    expect(plan.fix1NonSpoiler).toBe(true)
    expect(plan.beats.some((b) => b.purpose === "end_hook")).toBe(true)
  })

  it("buildStructurePlanPromptBlock includes FIX-1 and beats", () => {
    const plan = createDefaultStructureThrilPacingPlan(4)
    const block = buildStructurePlanPromptBlock(plan)
    expect(block.length).toBeGreaterThan(40)
    expect(block).toMatch(/FIX-1/)
    expect(block).toMatch(/章末钩|end_hook/)
    expect(block).toMatch(/structure-first|thril-pacing/i)
  })

  it("invalid plan yields error block", () => {
    const block = buildStructurePlanPromptBlock(createEmptyChapterStructurePlan())
    expect(block).toMatch(/无效/)
  })

  it("M1 dim-aware: thrill emphasis when thrill is weakest", () => {
    const plan = createDimAwareStructureThrilPacingPlan({
      chapterNumber: 2,
      dimMedians: { thrill: 8.1, pacing: 8.3, character: 8.5 },
    })
    expect(plan.notes?.[0]).toMatch(/emphasis=thril/)
    expect(validateChapterStructurePlan(plan).ok).toBe(true)
    expect(plan.beats.some((b) => b.label === "主动下注")).toBe(true)
  })

  it("M1 dim-aware: pacing-safe when pacing is weakest", () => {
    const plan = createDimAwareStructureThrilPacingPlan({
      chapterNumber: 5,
      dimMedians: { thrill: 8.4, pacing: 8.0 },
    })
    expect(plan.notes?.[0]).toMatch(/emphasis=pacing_safe/)
    expect(plan.beats.some((b) => b.label === "单一压抑链")).toBe(true)
    expect(plan.beats.some((b) => b.hook?.includes("不新开大窗口悬念"))).toBe(true)
  })

  it("M1 dim-aware: chapter fallback without dim medians", () => {
    expect(createDimAwareStructureThrilPacingPlan({ chapterNumber: 2 }).notes?.[0]).toMatch(/emphasis=thril/)
    expect(createDimAwareStructureThrilPacingPlan({ chapterNumber: 5 }).notes?.[0]).toMatch(/emphasis=pacing_safe/)
    expect(createDimAwareStructureThrilPacingPlan({ chapterNumber: 7 }).notes?.[0]).toMatch(/emphasis=balanced/)
  })
})

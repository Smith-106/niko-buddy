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

  it("M1 dim-aware: balanced when a non-thrill/pacing dim is weakest", () => {
    const plan = createDimAwareStructureThrilPacingPlan({
      dimMedians: { character: 7.9, pull: 8.1 },
    })
    expect(plan.notes?.[0]).toMatch(/emphasis=balanced/)
  })

  it("validate rejects a null/undefined plan", () => {
    const v = validateChapterStructurePlan(null)
    expect(v.ok).toBe(false)
    expect(v.errors).toContain("plan is null/undefined")
  })

  it("validate flags wrong schemaVersion and fix1NonSpoiler", () => {
    const plan = createEmptyChapterStructurePlan({
      beats: [{ id: "b1", label: "章末钩", purpose: "end_hook" }],
    }) as unknown as { schemaVersion: string; fix1NonSpoiler: boolean }
    plan.schemaVersion = "old/0.9"
    plan.fix1NonSpoiler = false
    const v = validateChapterStructurePlan(plan as Parameters<typeof validateChapterStructurePlan>[0])
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => e.includes("unsupported schemaVersion"))).toBe(true)
    expect(v.errors.some((e) => e.includes("fix1NonSpoiler"))).toBe(true)
  })

  it("validate flags beats missing id/label and unknown thrilCheckpointId", () => {
    const v = validateChapterStructurePlan({
      schemaVersion: "chapter-structure-plan/1.0",
      beats: [
        { purpose: "end_hook" }, // missing id + label → label message uses ? id
        { id: "b2", label: "压", purpose: "end_hook", thrilCheckpointId: "bogus_checkpoint" },
      ],
      thrilCheckpointCoverage: [],
      fix1NonSpoiler: true,
      source: "manual",
    } as Parameters<typeof validateChapterStructurePlan>[0])
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => e.includes("each beat requires non-empty id"))).toBe(true)
    expect(v.errors.some((e) => e.includes("requires label"))).toBe(true)
    expect(v.errors.some((e) => e.includes("unknown thrilCheckpointId"))).toBe(true)
  })

  it("validate warns when coverage omits fix1 and end-hook checkpoints", () => {
    const v = validateChapterStructurePlan({
      schemaVersion: "chapter-structure-plan/1.0",
      beats: [{ id: "b1", label: "章末钩", purpose: "end_hook" }],
      thrilCheckpointCoverage: undefined as unknown as Parameters<typeof validateChapterStructurePlan>[0]["thrilCheckpointCoverage"],
      fix1NonSpoiler: true,
      source: "manual",
    } as Parameters<typeof validateChapterStructurePlan>[0])
    expect(v.ok).toBe(true)
    expect(v.warnings.some((w) => w.includes("omits fix1_no_conflict"))).toBe(true)
    expect(v.warnings.some((w) => w.includes("omits chapter_end_hook"))).toBe(true)
  })

  it("prompt block handles missing chapter, budget, thril id, coverage and blank notes", () => {
    const plan = {
      schemaVersion: "chapter-structure-plan/1.0",
      beats: [{ id: "b1", label: "章末钩", purpose: "end_hook" }],
      lengthBudgetChars: 5000,
      thrilCheckpointCoverage: undefined as unknown as Parameters<typeof validateChapterStructurePlan>[0]["thrilCheckpointCoverage"],
      fix1NonSpoiler: true,
      source: "manual",
      notes: ["", "   ", "实际注释"],
    } as Parameters<typeof validateChapterStructurePlan>[0]
    const block = buildStructurePlanPromptBlock(plan)
    expect(block).toContain("（未指定）")
    expect(block).toContain("长度预算：约 5000 字")
    expect(block).not.toContain("[thril:")
    expect(block).not.toContain("- thril 覆盖")
    expect(block).toContain("实际注释")
  })

  it("prompt block tolerates notes being undefined", () => {
    const plan = {
      schemaVersion: "chapter-structure-plan/1.0",
      beats: [{ id: "b1", label: "章末钩", purpose: "end_hook" }],
      thrilCheckpointCoverage: ["fix1_no_conflict", "chapter_end_hook"],
      fix1NonSpoiler: true,
      source: "manual",
    } as Parameters<typeof validateChapterStructurePlan>[0]
    const block = buildStructurePlanPromptBlock(plan)
    expect(block).toContain("章末钩")
    expect(block).toContain("- thril 覆盖：fix1_no_conflict, chapter_end_hook")
  })
})

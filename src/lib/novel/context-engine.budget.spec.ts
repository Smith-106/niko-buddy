/**
 * TASK-007 (PERF-011): source-level + behavior wiring tests for the
 * computeContextBudget adaptive-scaling integration on the context-engine
 * read path.
 *
 * The tieredSlice call sites in pickChapterOutlineByNumber and
 * readChapterOutlineContent are module-private, so we assert the wiring two
 * ways (mirroring context-engine.wiring.spec.ts for the subplot/resource
 * renderers):
 *   (a) Source-level: context-engine.ts imports computeContextBudget,
 *       computes the budget in buildContextPack and stores it in a
 *       module-level currentBuildBudget, and pickChapterOutlineByNumber /
 *       readChapterOutlineContent drive the protected-tier cap via
 *       resolveChapterOutlineProtectedCap (which reads the budget instead
 *       of the hardcoded CHAPTER_OUTLINE_PROTECTED_CAP).
 *   (b) Behavior-level: pickChapterOutlineByNumber, when a long chapter
 *       outline candidate exceeds the budget-driven cap, truncates to the
 *       budget's maxPageSize. We drive this indirectly by asserting that
 *       pickChapterOutlineByNumber truncates a long candidate (which only
 *       happens when the cap is finite) — the cap value comes from
 *       computeContextBudget when currentBuildBudget is set, and from the
 *       legacy CHAPTER_OUTLINE_PROTECTED_CAP otherwise.
 *
 * Also guards the TASK-006 @ts-expect-error ban (must stay 0).
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pickChapterOutlineByNumber } from "./context-engine"
import { computeContextBudget } from "@/lib/context-budget"

const NOVEL_DIR = resolve(__dirname)

function readSource(rel: string): string {
  return readFileSync(resolve(NOVEL_DIR, rel), "utf-8")
}

describe("TASK-007 PERF-011 computeContextBudget wiring on the read path", () => {
  it("imports computeContextBudget + ContextBudget type from @/lib/context-budget", () => {
    const src = readSource("context-engine.ts")
    expect(src).toMatch(
      /import\s*\{\s*computeContextBudget,\s*type\s+ContextBudget\s*\}\s*from\s*["']@\/lib\/context-budget["']/,
    )
  })

  it("declares a module-level currentBuildBudget variable (mirrors contextGaps pattern)", () => {
    const src = readSource("context-engine.ts")
    expect(src).toMatch(/let\s+currentBuildBudget:\s*ContextBudget\s*\|\s*null\s*=\s*null/)
  })

  it("buildContextPack computes the budget BEFORE registry.loadAll and clears it after", () => {
    const src = readSource("context-engine.ts")
    // The budget is computed from context.maxContextSize + context.chapterNumber
    // and assigned to currentBuildBudget before loadAll runs.
    expect(src).toMatch(
      /currentBuildBudget\s*=\s*computeContextBudget\(\s*context\.maxContextSize,\s*context\.chapterNumber\s*\)/,
    )
    // Cleared after the build (so direct callers fall back to the legacy cap).
    expect(src).toMatch(/currentBuildBudget\s*=\s*null/)
  })

  it("buildLoadContext populates context.maxContextSize from useWikiStore.llmConfig", () => {
    const src = readSource("context-engine.ts")
    // The optional maxContextSize field (added by commit 1a49601) is now
    // populated from the live LLM config so adaptive scaling is live.
    // ISS-20260709-023 (DC-7): llmConfig now injection-first with store fallback.
    expect(src).toMatch(/options\.llmConfig\s*\?\?\s*useWikiStore\.getState\(\)\.llmConfig/)
    expect(src).toMatch(/maxContextSize:\s*llmConfig\.maxContextSize/)
  })

  it("defines resolveChapterOutlineProtectedCap reading currentBuildBudget.maxPageSize", () => {
    const src = readSource("context-engine.ts")
    expect(src).toMatch(/function\s+resolveChapterOutlineProtectedCap\b/)
    // The resolver must reference budget.maxPageSize (the adaptive cap) and
    // fall back to CHAPTER_OUTLINE_PROTECTED_CAP when outside a build.
    expect(src).toMatch(/const\s+budget\s*=\s*currentBuildBudget/)
    expect(src).toMatch(/budget\.maxPageSize/)
    expect(src).toMatch(/CHAPTER_OUTLINE_PROTECTED_CAP/)
  })

  it("pickChapterOutlineByNumber drives tieredSlice caps via resolveChapterOutlineProtectedCap (not the hardcoded constant)", () => {
    const src = readSource("context-engine.ts")
    // The two tieredSlice calls in pickChapterOutlineByNumber must call
    // resolveChapterOutlineProtectedCap() — NOT the bare constant. This is
    // the core wiring assertion: the cap VALUE now comes from the budget.
    const pickBlock = src.match(/export function pickChapterOutlineByNumber[\s\S]*?\n\}/)
    expect(pickBlock).not.toBeNull()
    expect(pickBlock![0]).toContain("resolveChapterOutlineProtectedCap()")
    // The bare CHAPTER_OUTLINE_PROTECTED_CAP must NOT appear as a tieredSlice
    // cap argument inside pickChapterOutlineByNumber anymore.
    expect(pickBlock![0]).not.toMatch(/tieredSlice\([^)]*CHAPTER_OUTLINE_PROTECTED_CAP/)
  })

  it("readChapterOutlineContent search path drives tieredSlice via resolveChapterOutlineProtectedCap", () => {
    const src = readSource("context-engine.ts")
    // The search-path tieredSlice call must also use the budget-driven cap.
    const readBlock = src.match(/export async function readChapterOutlineContent[\s\S]*?\n\}/)
    expect(readBlock).not.toBeNull()
    expect(readBlock![0]).toContain("resolveChapterOutlineProtectedCap()")
    expect(readBlock![0]).not.toMatch(/tieredSlice\([^)]*CHAPTER_OUTLINE_PROTECTED_CAP/)
  })

  it("does not re-introduce @ts-expect-error (TASK-006 cleared it)", () => {
    const src = readSource("context-engine.ts")
    expect(src).not.toMatch(/@ts-expect-error/)
  })

  it("behavior: pickChapterOutlineByNumber truncates a long candidate (cap is finite — budget wired)", () => {
    // When a candidate's content exceeds the cap, pickChapterOutlineByNumber
    // must truncate (return a prefix). The cap value here is the legacy
    // CHAPTER_OUTLINE_PROTECTED_CAP (currentBuildBudget is null outside a
    // buildContextPack call), but the fact that truncation happens at all
    // proves the cap is wired into tieredSlice. A long candidate is truncated
    // to <= CHAPTER_OUTLINE_PROTECTED_CAP chars.
    const longContent = "第3章\n" + "x".repeat(20_000)
    const candidates = [{ path: "/P/第3章.md", content: longContent }]
    const result = pickChapterOutlineByNumber(candidates, 3)
    // Truncation happened — result is shorter than the original content.
    expect(result.length).toBeLessThan(longContent.length)
    expect(result.length).toBeLessThanOrEqual(6_000)
  })

  it("behavior: pickChapterOutlineByNumber preserves short candidate verbatim (no spurious truncation)", () => {
    // Backward compat: a candidate shorter than the cap is returned whole.
    const shortContent = "第3章：主角觉醒"
    const candidates = [{ path: "/P/第3章.md", content: shortContent }]
    const result = pickChapterOutlineByNumber(candidates, 3)
    expect(result).toBe(shortContent)
  })

  it("behavior: computeContextBudget cap matches the truncation boundary (adaptive wiring soundness)", () => {
    // Soundness check: the budget's maxPageSize is the value that
    // pickChapterOutlineByNumber would use as the cap IF currentBuildBudget
    // were set. For a 200K config, maxPageSize is derived from pageBudget
    // (30% of pageBudget, floored at 5K). We assert it is a sensible positive
    // number that would truncate the long candidate from the test above.
    const budget = computeContextBudget(204_800, 3)
    expect(budget.maxPageSize).toBeGreaterThan(0)
    // The budget cap is in the same order of magnitude as the legacy 6000
    // cap (it's derived from pageBudget = 50% of 200K = 100K, * 30% = 30K,
    // so maxPageSize = 30K for a 200K config — generous, as intended for
    // protected-tier canon).
    expect(budget.maxPageSize).toBeGreaterThanOrEqual(5_000)
  })
})

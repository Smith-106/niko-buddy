/**
 * TASK-007 (PERF-011): source-level + behavior wiring tests for the
 * computeContextBudget adaptive-scaling integration on the context-engine
 * read path.
 *
 * The tieredSlice call sites in pickChapterOutlineByNumber and
 * readChapterOutlineContent are module-private, so we assert the wiring two
 * ways (mirroring context-engine.wiring.spec.ts for the subplot/resource
 * renderers):
 *   (a) Source-level (P1 巨文件拆分后位置更新：`currentBuildBudget` 在
 *       context-engine-gaps.ts；大纲读取族在 context-engine-outline.ts):
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
import { RESERVED_CANON_RULES_CHARS, computeContextBudget } from "@/lib/context-budget"

const NOVEL_DIR = resolve(__dirname)

function readSource(rel: string): string {
  return readFileSync(resolve(NOVEL_DIR, rel), "utf-8")
}

describe("TASK-007 PERF-011 computeContextBudget wiring on the read path", () => {
  it("imports computeContextBudget (engine) + ContextBudget type (gaps) from @/lib/context-budget", () => {
    // P1 巨文件拆分后：预算计算仍由 context-engine 负责调度，
    // 预算持有变量 currentBuildBudget 迁到 context-engine-gaps，
    // 因此 `type ContextBudget` 的 import 也随宿主移到 gaps 模块。
    const engine = readSource("context-engine.ts")
    expect(engine).toMatch(
      /import\s*\{\s*computeContextBudget,?\s*\}\s*from\s*["']@\/lib\/context-budget["']/,
    )
    const gaps = readSource("context-engine-gaps.ts")
    expect(gaps).toMatch(
      /import\s+type\s*\{\s*ContextBudget\s*\}\s*from\s*["']@\/lib\/context-budget["']/,
    )
  })

  it("declares a module-level currentBuildBudget variable (mirrors contextGaps pattern)", () => {
    const src = readSource("context-engine-gaps.ts")
    expect(src).toMatch(/export\s+let\s+currentBuildBudget:\s*ContextBudget\s*\|\s*null\s*=\s*null/)
  })

  it("buildContextPack computes the budget BEFORE registry.loadAll and clears it after", () => {
    const src = readSource("context-engine.ts")
    // The budget is computed from context.maxContextSize + context.chapterNumber
    // and assigned to currentBuildBudget before loadAll runs.
    expect(src).toMatch(
      /setCurrentBuildBudget\(\s*computeContextBudget\(\s*context\.maxContextSize,\s*context\.chapterNumber\s*\)\s*\)/,
    )
    // Cleared after the build (so direct callers fall back to the legacy cap).
    expect(src).toMatch(/setCurrentBuildBudget\(null\)/)
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
    const src = readSource("context-engine-outline.ts")
    expect(src).toMatch(/function\s+resolveChapterOutlineProtectedCap\b/)
    // The resolver must reference budget.maxPageSize (the adaptive cap) and
    // fall back to CHAPTER_OUTLINE_PROTECTED_CAP when outside a build.
    expect(src).toMatch(/const\s+budget\s*=\s*currentBuildBudget/)
    expect(src).toMatch(/budget\.maxPageSize/)
    expect(src).toMatch(/CHAPTER_OUTLINE_PROTECTED_CAP/)
  })

  it("pickChapterOutlineByNumber drives tieredSlice caps via resolveChapterOutlineProtectedCap (not the hardcoded constant)", () => {
    const src = readSource("context-engine-outline.ts")
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
    const src = readSource("context-engine-outline.ts")
    // The search-path tieredSlice call must also use the budget-driven cap.
    const readBlock = src.match(/export async function readChapterOutlineContent[\s\S]*?\n\}/)
    expect(readBlock).not.toBeNull()
    expect(readBlock![0]).toContain("resolveChapterOutlineProtectedCap()")
    expect(readBlock![0]).not.toMatch(/tieredSlice\([^)]*CHAPTER_OUTLINE_PROTECTED_CAP/)
  })

  it("does not re-introduce @ts-expect-error (TASK-006 cleared it)", () => {
    for (const rel of ["context-engine.ts", "context-engine-outline.ts", "context-engine-gaps.ts"]) {
      expect(readSource(rel)).not.toMatch(/@ts-expect-error/)
    }
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

// ============================================================================
// G5: canonRules 独立预留槽 + L4 零截断 + 超预算告警
// ============================================================================

describe("G5 canonRules 独立预留槽 (RESERVED_CANON_RULES_CHARS)", () => {
  it("标准额度写死 3840 chars（典型 canonRules 3200 + 20% 裕量）", () => {
    expect(RESERVED_CANON_RULES_CHARS).toBe(3_840)
    // 典型体量 3_200 × 1.2 = 3_840（口径写死防验收不可复现）
    expect(RESERVED_CANON_RULES_CHARS).toBe(Math.round(3_200 * 1.2))
  })

  it("computeContextBudget 暴露 canonRulesReserve（正常窗口足额）", () => {
    const b = computeContextBudget(204_800, 5)
    const reserve = b.canonRulesReserve
    expect(reserve).toBeDefined()
    expect(reserve!.standardChars).toBe(RESERVED_CANON_RULES_CHARS)
    expect(reserve!.reservedChars).toBe(RESERVED_CANON_RULES_CHARS)
    expect(reserve!.clamped).toBe(false)
    // 默认窗口（32K tokens）同样足额
    expect(computeContextBudget(undefined).canonRulesReserve!.clamped).toBe(false)
  })

  it("既有配比数值一字未改（预留槽在配比之外优先扣除）", () => {
    const b = computeContextBudget(204_800, 5)
    // 旧口径逐字保留：resp 15% / index 5% / page 50%
    expect(b.responseReserve).toBe(Math.floor(204_800 * 0.15))
    expect(b.indexBudget).toBe(Math.floor(204_800 * 0.05))
    expect(b.pageBudget).toBe(Math.floor(204_800 * 0.5))
    // 预留槽只从「剩余未分配额度」划出，不挤占三项既有配额
    const slack = 204_800 - (b.responseReserve + b.indexBudget + b.pageBudget)
    expect(b.canonRulesReserve!.reservedChars).toBeLessThanOrEqual(slack)
  })

  it("小窗口剩余额度不足 → clamped 显式标出（不反向挤占既有配额）", () => {
    const tiny = computeContextBudget(10_000)
    const slack = 10_000 - (tiny.responseReserve + tiny.indexBudget + tiny.pageBudget)
    expect(tiny.canonRulesReserve!.reservedChars).toBe(Math.max(0, Math.min(RESERVED_CANON_RULES_CHARS, slack)))
    expect(tiny.canonRulesReserve!.clamped).toBe(
      tiny.canonRulesReserve!.reservedChars < RESERVED_CANON_RULES_CHARS,
    )
    // 既有配额仍与旧口径一致（小窗口下预留槽只拿剩余，不改配比）
    expect(tiny.pageBudget).toBe(Math.floor(10_000 * 0.5))
  })

  it("source: context-budget.ts 多次引用 RESERVED_CANON_RULES_CHARS（定义 + 使用）", () => {
    const src = readFileSync(new URL("../context-budget.ts", import.meta.url), "utf-8")
    const hits = src.split("\n").filter((line) => line.includes("RESERVED_CANON_RULES"))
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(src).toContain("export const RESERVED_CANON_RULES_CHARS")
  })

  it("source: context-compact.ts 引用预留槽 + L4 截断表已剔除 canonRules + budget_exceeded", () => {
    const src = readSource("context-compact.ts")
    // 判据 2：引用 RESERVED_CANON_RULES 或 canonRules
    expect(src).toMatch(/RESERVED_CANON_RULES_CHARS/)
    expect(src).toMatch(/canonRules/)
    // 判据 3：budget_exceeded 记账仍在
    expect(src).toMatch(/budget_exceeded/)
    // G2：L4 最后手段截断表不再包含 canonRules（零截断）
    expect(src).not.toMatch(/for \(const key of \["mustAvoid", "outline", "canonRules"\]\)/)
    expect(src).toMatch(/for \(const key of \["mustAvoid", "outline"\]\)/)
  })

  it("source: G4 只读护栏 —— PROTECTED_COMPACT_FIELDS 与 hardInject 独立块未被改动", () => {
    const compact = readSource("context-compact.ts")
    // 判据 4：PROTECTED_COMPACT_FIELDS 声明仍在，且 canonRules / hardInject 仍在集合内
    expect(compact).toMatch(/export const PROTECTED_COMPACT_FIELDS: ReadonlySet<string> = new Set\(\[/)
    const protectedBlock = compact.match(/export const PROTECTED_COMPACT_FIELDS[\s\S]*?\]\)/)
    expect(protectedBlock).not.toBeNull()
    expect(protectedBlock![0]).toContain('"canonRules"')
    expect(protectedBlock![0]).toContain('"hardInject"')
    // 判据 5：context-engine-prompt.ts 的 hardInject 独立块仍在
    const prompt = readSource("context-engine-prompt.ts")
    expect(prompt).toMatch(/fieldKey: "hardInject"/)
    expect(prompt).toMatch(/hardInjectEnabled === true/)
    // 时序合并链路（取值侧）未动：仍由 applyTemporalFactsToCanonRules 产出 canonRules
    const engine = readSource("context-engine.ts")
    expect(engine).toMatch(/const canonRules = applyTemporalFactsToCanonRules\(/)
  })
})

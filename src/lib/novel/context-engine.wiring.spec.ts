/**
 * TASK-008 (MAINT-002 second half): context-engine wiring of subplot-board
 * and resource-ledger renderers into the characterStates join.
 *
 * buildContextPackFromRawData is module-private, so we assert wiring two
 * ways (mirroring the codebase's existing pattern — emotional-arcs.spec.ts
 * uses readSource to grep the .ts, context-engine.perf.spec.ts (c) uses
 * contextPackToPrompt to surface the injected text):
 * (a) Source-level: context-engine.ts imports loadSubplotBoard /
 *     subplotBoardToContextText / loadResourceLedger /
 *     resourceLedgerToContextText, defines readSubplotBoardText /
 *     readResourceLedgerText, and calls them inside the characterStates
 *     joinNonEmpty — same shape as readEmotionalArcsText.
 * (b) Behavior-level: when characterStates carries the rendered projection
 *     text, contextPackToPrompt surfaces it (the wiring feeds the same
 *     characterStates field that readEmotionalArcsText feeds).
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { contextPackToPrompt, type ContextPack } from "./context-engine"

const NOVEL_DIR = resolve(__dirname)

function readSource(rel: string): string {
  return readFileSync(resolve(NOVEL_DIR, rel), "utf-8")
}

describe("TASK-008 subplot/resource renderer wiring in context-engine", () => {
  it("imports loadSubplotBoard + subplotBoardToContextText from ./subplot-board", () => {
    // ISS-20260712-ARCH-1 (Wave 1): 派生 store 读取群拆到 context-derived-stores.ts,
    // import 随移。本断言读拆分后文件。
    const src = readSource("context-derived-stores.ts")
    expect(src).toMatch(/import\s*\{[^}]*loadSubplotBoard[^}]*subplotBoardToContextText[^}]*\}\s*from\s*["']\.\/subplot-board["']/)
  })

  it("imports loadResourceLedger + resourceLedgerToContextText from ./resource-ledger", () => {
    const src = readSource("context-derived-stores.ts")
    expect(src).toMatch(/import\s*\{[^}]*loadResourceLedger[^}]*resourceLedgerToContextText[^}]*\}\s*from\s*["']\.\/resource-ledger["']/)
  })

  it("defines readSubplotBoardText and readResourceLedgerText helpers (same pattern as readEmotionalArcsText)", () => {
    const src = readSource("context-derived-stores.ts")
    expect(src).toMatch(/async function readSubplotBoardText\b/)
    expect(src).toMatch(/async function readResourceLedgerText\b/)
    // Both call load* + *ToContextText (not dead).
    expect(src).toMatch(/readSubplotBoardText[\s\S]*?loadSubplotBoard[\s\S]*?subplotBoardToContextText/)
    expect(src).toMatch(/readResourceLedgerText[\s\S]*?loadResourceLedger[\s\S]*?resourceLedgerToContextText/)
  })

  it("wires both helpers into the characterStates joinNonEmpty (protected-tier)", () => {
    // The characterStates join must include readSubplotBoardText(...) and
    // readResourceLedgerText(...). This guards against accidental deletion of
    // the wiring in future cleanup passes.
    // PERF-NEW-04: the three store reads are now pre-fetched in parallel via
    // Promise.all just before the joinNonEmpty, then the resolved strings are
    // passed into joinNonEmpty. The wiring intent (all 3 helpers feed
    // characterStates) is preserved — assert the helpers are called in the
    // pre-fetch and their results feed the join.
    const src = readSource("context-engine.ts")
    const joinBlock = src.match(/const characterStates = joinNonEmpty\([\s\S]*?\], "\\n\\n"\)/)
    expect(joinBlock).not.toBeNull()
    expect(joinBlock![0]).toContain("emotionalText")
    expect(joinBlock![0]).toContain("subplotText")
    expect(joinBlock![0]).toContain("resourceText")
    // The pre-fetch block must call all three helpers (parallelized).
    const preFetch = src.match(/Promise\.all\([\s\S]*?readEmotionalArcsText[\s\S]*?readSubplotBoardText[\s\S]*?readResourceLedgerText[\s\S]*?\)/)
    expect(preFetch).not.toBeNull()
  })

  it("does not re-introduce @ts-expect-error (TASK-006 cleared it)", () => {
    const src = readSource("context-engine.ts")
    expect(src).not.toMatch(/@ts-expect-error/)
  })

  it("contextPackToPrompt surfaces subplot/resource text when carried in characterStates", () => {
    // Indirect behavioral assertion: buildContextPackFromRawData feeds the
    // two renderers into characterStates; contextPackToPrompt then renders
    // characterStates into the prompt. We verify the prompt-level surfacing
    // (mirrors context-engine.perf.spec.ts (c) smoke for emotional-arcs).
    const subplotText = "- [进行中] 商会暗线（关联：甲）：调查走私"
    const resourceText = "- 轩辕剑：持有者 昊天（第8章转手）"
    const pack: ContextPack = {
      task: "生成第3章",
      chapterGoal: "",
      outline: "",
      recentChapterContents: [],
      recentSummaries: [],
      previousChapterEnding: "",
      characterStates: `【支线】${subplotText}\n\n【物品】${resourceText}`,
      soulDoc: "",
      characterAuras: "",
      cognitionStates: "",
      foreshadowingStates: "",
      timeline: "",
      relatedSettings: "",
      canonRules: "",
      writingStyle: "",
      searchResults: "",
      graphSearchResults: "",
      mustDo: "",
      mustAvoid: "",
      nextChapterAdvice: "",
      revisionDirectives: "",
      gaps: [],
    } as unknown as ContextPack
    const prompt = contextPackToPrompt(pack)
    expect(prompt).toContain(subplotText)
    expect(prompt).toContain(resourceText)
  })

  it("absent projection stores → no injection (backward compatible — empty stores render '')", () => {
    // When characterStates carries NO subplot/resource text (the empty-store
    // case), contextPackToPrompt must not fabricate any. This guards the
    // backward-compat contract: empty stores inject nothing.
    const pack: ContextPack = {
      task: "生成第3章",
      chapterGoal: "",
      outline: "",
      recentChapterContents: [],
      recentSummaries: [],
      previousChapterEnding: "",
      characterStates: "",
      soulDoc: "",
      characterAuras: "",
      cognitionStates: "",
      foreshadowingStates: "",
      timeline: "",
      relatedSettings: "",
      canonRules: "",
      writingStyle: "",
      searchResults: "",
      graphSearchResults: "",
      mustDo: "",
      mustAvoid: "",
      nextChapterAdvice: "",
      revisionDirectives: "",
      gaps: [],
    } as unknown as ContextPack
    const prompt = contextPackToPrompt(pack)
    expect(prompt).not.toContain("商会暗线")
    expect(prompt).not.toContain("轩辕剑")
    // Empty characterStates → no fabricated subplot/resource markers.
    expect(prompt).not.toMatch(/【支线】|【物品】/)
  })
})

describe("S2a (TASK-101/TASK-102) related-chapters 生产接线", () => {
  it("TASK-101: 主装配调用 buildRelatedChaptersContext（生产 call site，非定义行 2135）并注入 pack.relatedChapters", () => {
    const src = readSource("context-engine.ts")
    // buildRelatedChaptersContext 出现 ≥2 次: 文件尾定义 + 主装配函数体内调用（Promise.all 段）
    const callSites = src.match(/buildRelatedChaptersContext\(/g) ?? []
    expect(callSites.length).toBeGreaterThanOrEqual(2)
    // additive 独立字段注入（与 styleExemplars/activeEntities 同款 merge 注入模式）
    expect(src).toMatch(/pack\.relatedChapters\s*=\s*relatedChaptersText/)
  })

  it("TASK-102: findOverdueForeshadowing 调用点命中（buildRelatedChaptersContext 组合进 finding 文本）", () => {
    const src = readSource("context-engine.ts")
    expect(src).toMatch(/findOverdueForeshadowing\(/)
  })

  it("TASK-101 开关: relatedChaptersEnabled 控制注入（关闭 → 空文本不阻断 pack）", () => {
    const src = readSource("context-engine.ts")
    expect(src).toMatch(/novelConfig\.relatedChaptersEnabled\s*\?/)
  })
})

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
    const src = readSource("context-engine.ts")
    expect(src).toMatch(/import\s*\{[^}]*loadSubplotBoard[^}]*subplotBoardToContextText[^}]*\}\s*from\s*["']\.\/subplot-board["']/)
  })

  it("imports loadResourceLedger + resourceLedgerToContextText from ./resource-ledger", () => {
    const src = readSource("context-engine.ts")
    expect(src).toMatch(/import\s*\{[^}]*loadResourceLedger[^}]*resourceLedgerToContextText[^}]*\}\s*from\s*["']\.\/resource-ledger["']/)
  })

  it("defines readSubplotBoardText and readResourceLedgerText helpers (same pattern as readEmotionalArcsText)", () => {
    const src = readSource("context-engine.ts")
    expect(src).toMatch(/async function readSubplotBoardText\b/)
    expect(src).toMatch(/async function readResourceLedgerText\b/)
    // Both call load* + *ToContextText (not dead).
    expect(src).toMatch(/readSubplotBoardText[\s\S]*?loadSubplotBoard[\s\S]*?subplotBoardToContextText/)
    expect(src).toMatch(/readResourceLedgerText[\s\S]*?loadResourceLedger[\s\S]*?resourceLedgerToContextText/)
  })

  it("wires both helpers into the characterStates joinNonEmpty (protected-tier)", () => {
    // The characterStates join must include await readSubplotBoardText(...) and
    // await readResourceLedgerText(...). This guards against accidental
    // deletion of the wiring in future cleanup passes.
    // Source literal: `], "\n\n")` — the \n are JS string escapes (literal
    // backslash-n in the file), so the regex matches backslash-n, not newline.
    const src = readSource("context-engine.ts")
    const joinBlock = src.match(/const characterStates = joinNonEmpty\([\s\S]*?\], "\\n\\n"\)/)
    expect(joinBlock).not.toBeNull()
    expect(joinBlock![0]).toContain("await readEmotionalArcsText(context.projectPath)")
    expect(joinBlock![0]).toContain("await readSubplotBoardText(context.projectPath)")
    expect(joinBlock![0]).toContain("await readResourceLedgerText(context.projectPath)")
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

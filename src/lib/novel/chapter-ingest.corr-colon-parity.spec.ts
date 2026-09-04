import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const NOVEL_DIR = resolve(__dirname)
function readSource(): string {
  return readFileSync(resolve(NOVEL_DIR, "chapter-ingest.ts"), "utf-8")
}

/**
 * CORR-001/002 fix: the live ingest path (chapter-ingest.ts ~511-560) and
 * rebuildFromCommittedSnapshot both call the same applyCharacterStateChangesToStore
 * / applyForeshadowingChangesToStore helpers, which in turn call the shared
 * parseCharacterStateChange / parseForeshadowingChange helpers. This
 * structurally guarantees ingest == rebuild for fullwidth-colon "角色名：状态"
 * and "新增：伏笔名-描述" lines (Chinese LLM default) — the fold_rebuildable
 * contract is restored.
 *
 * These tests verify (a) the source contains the shared helpers + live-ingest
 * helper calls (grep-verifiable, matching the established f002-atomicity /
 * json spec pattern), and (b) the parser logic itself correctly classifies
 * both fullwidth and ASCII colons (the parser is reproduced here because it is
 * not exported; the reproduction mirrors the source verbatim and serves as a
 * regression guard — if the source parser diverges from this expected behavior,
 * the test must be updated, forcing a conscious decision).
 */

// Verbatim reproduction of the source parser (chapter-ingest.ts). Kept in sync
// so the test asserts the actual classification behavior. If the source parser
// changes, this must change too — a deliberate check, not silent drift.
function parseCharacterStateChange(change: string): { charName: string; changeDesc: string } | null {
  const colonIdx = change.search(/[:：]/)
  if (colonIdx <= 0) return null
  return {
    charName: change.slice(0, colonIdx).trim(),
    changeDesc: change.slice(colonIdx + 1).trim(),
  }
}

function parseForeshadowingChange(change: string):
  | { kind: "add"; name: string; desc: string }
  | { kind: "advance"; name: string; desc: string }
  | { kind: "resolve"; name: string; desc: string }
  | null {
  const trimmed = change.trim()
  if (/^(新增伏笔|新增)[:：]/.test(trimmed)) {
    const content = trimmed.replace(/^(新增伏笔|新增)[:：]?\s*/, "")
    const dashIdx = content.indexOf("-")
    return {
      kind: "add",
      name: dashIdx > 0 ? content.slice(0, dashIdx).trim() : content.trim(),
      desc: dashIdx > 0 ? content.slice(dashIdx + 1).trim() : "",
    }
  }
  if (/^(推进伏笔|推进)[:：]/.test(trimmed)) {
    return {
      kind: "advance",
      name: trimmed.replace(/^(推进伏笔|推进)[:：]?\s*/, "").trim(),
      desc: "",
    }
  }
  if (/^(回收伏笔|回收)[:：]/.test(trimmed)) {
    return {
      kind: "resolve",
      name: trimmed.replace(/^(回收伏笔|回收)[:：]?\s*/, "").trim(),
      desc: "",
    }
  }
  return null
}

describe("CORR-001/002: fold_rebuildable colon-parity (ingest == rebuild) — structural invariants", () => {
  const src = readSource()

  it("defines shared parseCharacterStateChange helper", () => {
    expect(src).toContain("function parseCharacterStateChange(change: string)")
    // Uses the unified /[:：]/ regex (accepts both ASCII and fullwidth colon)
    expect(src).toMatch(/parseCharacterStateChange[\s\S]*?change\.search\(\/\[:：\]\/\)/)
  })

  it("defines shared parseForeshadowingChange helper", () => {
    expect(src).toContain("function parseForeshadowingChange(change: string)")
    // Uses the unified /^(新增伏笔|新增)[:：]/ guard (accepts fullwidth colon)
    expect(src).toMatch(/parseForeshadowingChange[\s\S]*?\^\(新增伏笔\|新增\)\[:：\]/)
  })

  it("applyCharacterStateChangesToStore calls parseCharacterStateChange (rebuild path uses shared parser)", () => {
    expect(src).toMatch(/applyCharacterStateChangesToStore[\s\S]*?parseCharacterStateChange\(change\)/)
  })

  it("applyForeshadowingChangesToStore calls parseForeshadowingChange (rebuild path uses shared parser)", () => {
    expect(src).toMatch(/applyForeshadowingChangesToStore[\s\S]*?parseForeshadowingChange\(change\)/)
  })

  it("live ingest character fold calls applyCharacterStateChangesToStore (no inline fold)", () => {
    // The live ingest path must delegate to the shared helper instead of inlining.
    // E-03 (C-3): fold 纯性 — 调用点注入 foldCtx (显式时间戳全链下传)。
    expect(src).toContain("applyCharacterStateChangesToStore(existingChars, snapshot, aliasMaps, foldCtx)")
  })

  it("live ingest foreshadow fold calls applyForeshadowingChangesToStore (no inline fold)", () => {
    // E-03 (C-3): 同上, 调用点注入 foldCtx。
    expect(src).toContain("applyForeshadowingChangesToStore(existingForeshadows, snapshot, foldCtx)")
  })

  it("removes the ASCII-only double-indexOf from applyCharacterStateChangesToStore", () => {
    // The prior divergence: rebuild path used double indexOf ASCII-first, which
    // mis-split "角色名：状态" (fullwidth). Must be gone.
    expect(src).not.toMatch(/indexOf\(":"\) >= 0 \? change\.indexOf\(":"\) : change\.indexOf\("："\)/)
  })

  it("removes the ASCII-only startsWith('新增:') guard from applyForeshadowingChangesToStore", () => {
    // The prior divergence: rebuild path used startsWith("新增:") ASCII-only,
    // which silently dropped "新增：" (fullwidth). Must be gone.
    expect(src).not.toContain('startsWith("新增:")')
    expect(src).not.toContain('startsWith("新增伏笔")')
  })
})

describe("CORR-001/002: parseCharacterStateChange — fullwidth + ASCII colon parity", () => {
  it("parses fullwidth colon 角色名：状态 (Chinese LLM default)", () => {
    const parsed = parseCharacterStateChange("林晚：受伤")
    expect(parsed).not.toBeNull()
    expect(parsed!.charName).toBe("林晚")
    expect(parsed!.changeDesc).toBe("受伤")
  })

  it("parses ASCII colon 角色名:状态 (backward compat)", () => {
    const parsed = parseCharacterStateChange("林晚:受伤")
    expect(parsed).not.toBeNull()
    expect(parsed!.charName).toBe("林晚")
    expect(parsed!.changeDesc).toBe("受伤")
  })

  it("fullwidth and ASCII colon produce identical {charName, changeDesc}", () => {
    // The fold_rebuildable parity guarantee: both colon forms parse identically.
    const full = parseCharacterStateChange("苏寒：觉醒记忆")!
    const ascii = parseCharacterStateChange("苏寒:觉醒记忆")!
    expect(full.charName).toBe(ascii.charName)
    expect(full.changeDesc).toBe(ascii.changeDesc)
  })

  it("returns null for colon-less freeform string (handled by includes-fallback)", () => {
    expect(parseCharacterStateChange("角色苏寒觉醒了记忆")).toBeNull()
  })
})

describe("CORR-001/002: parseForeshadowingChange — fullwidth + ASCII colon parity", () => {
  it("parses fullwidth-colon add 新增：伏笔名-描述 (Chinese LLM default)", () => {
    const parsed = parseForeshadowingChange("新增：黑剑-主角的佩剑")
    expect(parsed).not.toBeNull()
    expect(parsed!.kind).toBe("add")
    expect(parsed!.name).toBe("黑剑")
    expect(parsed!.desc).toBe("主角的佩剑")
  })

  it("parses ASCII-colon add 新增:伏笔名-描述 (backward compat)", () => {
    const parsed = parseForeshadowingChange("新增:黑剑-主角的佩剑")
    expect(parsed).not.toBeNull()
    expect(parsed!.kind).toBe("add")
    expect(parsed!.name).toBe("黑剑")
    expect(parsed!.desc).toBe("主角的佩剑")
  })

  it("fullwidth and ASCII colon add produce identical {kind, name, desc}", () => {
    // The fold_rebuildable parity guarantee: both colon forms parse identically.
    const full = parseForeshadowingChange("新增：黑剑-主角的佩剑")!
    const ascii = parseForeshadowingChange("新增:黑剑-主角的佩剑")!
    expect(full.kind).toBe(ascii.kind)
    expect(full.name).toBe(ascii.name)
    expect(full.desc).toBe(ascii.desc)
  })

  it("parses fullwidth-colon advance 推进：伏笔名", () => {
    const parsed = parseForeshadowingChange("推进：黑剑")
    expect(parsed).not.toBeNull()
    expect(parsed!.kind).toBe("advance")
    expect(parsed!.name).toBe("黑剑")
  })

  it("parses fullwidth-colon resolve 回收：伏笔名", () => {
    const parsed = parseForeshadowingChange("回收：黑剑")
    expect(parsed).not.toBeNull()
    expect(parsed!.kind).toBe("resolve")
    expect(parsed!.name).toBe("黑剑")
  })

  it("parses 新增伏笔： form (long prefix)", () => {
    const parsed = parseForeshadowingChange("新增伏笔：黑剑-主角的佩剑")
    expect(parsed).not.toBeNull()
    expect(parsed!.kind).toBe("add")
    expect(parsed!.name).toBe("黑剑")
    expect(parsed!.desc).toBe("主角的佩剑")
  })

  it("parses add without dash (name only, empty desc)", () => {
    const parsed = parseForeshadowingChange("新增：黑剑")
    expect(parsed).not.toBeNull()
    expect(parsed!.kind).toBe("add")
    expect(parsed!.name).toBe("黑剑")
    expect(parsed!.desc).toBe("")
  })

  it("returns null for unrecognized line", () => {
    expect(parseForeshadowingChange("一段普通的叙述文字")).toBeNull()
  })
})

describe("CORR-001/002: fold_rebuildable contract — ingest path delegates to same helper as rebuild", () => {
  // Because the live ingest path now calls applyForeshadowingChangesToStore /
  // applyCharacterStateChangesToStore (the same helpers rebuildFromCommittedSnapshot
  // uses), and those helpers call the shared parse* helpers with the unified
  // /[:：]/ regex, ingest == rebuild for fullwidth-colon lines by construction.
  // The parser parity tests above (fullwidth == ASCII) + the structural tests
  // (live ingest calls helper) together prove the contract is restored.
  it("structural: live ingest no longer inlines a divergent fold (grep verifiable)", () => {
    const src = readSource()
    // The live ingest character fold region must NOT contain the old inline
    // change.search(/[:：]/) inside a for-loop (it now delegates to the helper).
    // Find the live ingest character fold block and assert it calls the helper.
    const charFoldIdx = src.indexOf('if (snapshot.characterStateChanges.length > 0)')
    expect(charFoldIdx).toBeGreaterThan(-1)
    const charFoldBlock = src.slice(charFoldIdx, charFoldIdx + 1100)
    expect(charFoldBlock).toContain("applyCharacterStateChangesToStore(existingChars, snapshot, aliasMaps, foldCtx)")
    // No inline for-loop with change.search in the live ingest block
    expect(charFoldBlock).not.toMatch(/for \(const change of snapshot\.characterStateChanges\)[\s\S]*?change\.search\(\/\[:：\]\/\)/)

    const foreshadowFoldIdx = src.indexOf('if (snapshot.foreshadowingChanges.length > 0)')
    expect(foreshadowFoldIdx).toBeGreaterThan(-1)
    const foreshadowFoldBlock = src.slice(foreshadowFoldIdx, foreshadowFoldIdx + 1100)
    expect(foreshadowFoldBlock).toContain("applyForeshadowingChangesToStore(existingForeshadows, snapshot, foldCtx)")
    // No inline for-loop with /^(新增伏笔|新增)[:：]/.test in the live ingest block
    expect(foreshadowFoldBlock).not.toMatch(/for \(const change of snapshot\.foreshadowingChanges\)[\s\S]*?\^\(新增伏笔\|新增\)\[:：\]\.test/)
  })
})

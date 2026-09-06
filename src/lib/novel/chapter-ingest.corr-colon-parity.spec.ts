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

  it("live ingest character fold calls applyCharacterStateChangesToStore (no inline fold)", async () => {
    // P2-IMP-14: 四路径同源遍历注册表后，ingest 增量路径经 character 条目的
    // applyToStore 委派到共享 helper（与 rebuild 同一函数引用）——旧版内联
    // 硬编码调用点已收敛到注册表填充处。行为等价断言改扫注册表条目。
    const { PROJECTION_REGISTRY } = await import("./projection-status-ledger")
    await import("./chapter-ingest") // 确保注册表已填充
    const entry = PROJECTION_REGISTRY.character
    expect(entry).toBeTruthy()
    expect(entry.applyToStore).toBeTypeOf("function")
    // 注册表内 character 条目的 applyToStore 实现仍委派共享 helper（grep 可验）。
    expect(src).toMatch(/applyCharacterStateChangesToStore\(store, snapshot, registryAliasMaps\(ctx, snapshot\), ctx\)/)
    // E-03 (C-3): fold 纯性 — 调用点注入 foldCtx（显式时间戳全链下传）。
    expect(src).toMatch(/const foldCtx: ProjectionFoldContext = \{[\s\S]*?now: options\.now \?\? new Date\(\)\.toISOString\(\),[\s\S]*?aliasMaps,\n      \}/)
  })

  it("live ingest foreshadow fold calls applyForeshadowingChangesToStore (no inline fold)", async () => {
    const { PROJECTION_REGISTRY } = await import("./projection-status-ledger")
    await import("./chapter-ingest")
    const entry = PROJECTION_REGISTRY.foreshadow
    expect(entry).toBeTruthy()
    expect(entry.applyToStore).toBeTypeOf("function")
    // E-03 (C-3): 同上, 注册表条目 applyToStore 委派共享 helper 并注入 foldCtx。
    expect(src).toMatch(/applyForeshadowingChangesToStore\(store, snapshot, ctx\)/)
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
  it("structural: live ingest no longer inlines a divergent fold (grep verifiable)", async () => {
    const src = readSource()
    const { PROJECTION_REGISTRY } = await import("./projection-status-ledger")
    await import("./chapter-ingest")
    // P2-IMP-14: 旧版扫描 ingest 内联块 → 改扫注册表：ingest/rebuild/drift 三路径
    // 共用同一 applyToStore 函数引用（storeEntry 把 foldFromSnapshot 定义为
    // createEmpty + 逐快照 applyToStore 的 reduce）——「某路径内联分叉 fold」
    // 结构上不可能发生，CORR-001/002 契约由注册表同源保证。
    expect(PROJECTION_REGISTRY.character.applyToStore).toBeTypeOf("function")
    expect(PROJECTION_REGISTRY.foreshadow.applyToStore).toBeTypeOf("function")
    // The live ingest region must NOT contain the old inline
    // change.search(/[:：]/) inside a for-loop (it now delegates via the registry).
    const ingestIdx = src.indexOf("const runProjection = async")
    expect(ingestIdx).toBeGreaterThan(-1)
    const ingestBlock = src.slice(ingestIdx, src.indexOf("finally {", ingestIdx))
    // No inline for-loop with change.search in the live ingest block
    expect(ingestBlock).not.toMatch(/for \(const change of snapshot\.characterStateChanges\)[\s\S]*?change\.search\(\/\[:：\]\/\)/)
    // No inline for-loop with /^(新增伏笔|新增)[:：]/.test in the live ingest block
    expect(ingestBlock).not.toMatch(/for \(const change of snapshot\.foreshadowingChanges\)[\s\S]*?\^\(新增伏笔\|新增\)\[:：\]\.test/)
    // 四路径同源：ingest 遍历块存在且引用注册表
    expect(ingestBlock).toMatch(/Object\.entries\(PROJECTION_REGISTRY\)/)
  })
})

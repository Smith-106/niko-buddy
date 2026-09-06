import { describe, expect, it } from "vitest"
import type { ChapterSnapshot } from "./chapter-ingest"
import {
  appendParticleEntry,
  createEmptyParticleLedgerStore,
  foldParticleEntries,
  particleLedgerToContextText,
} from "./particle-ledger"

function snap(lines: string[], chapter = 1): ChapterSnapshot {
  return {
    chapterId: `chapter-${chapter}`,
    chapterNumber: chapter,
    summary: "",
    characters: [],
    locations: [],
    organizations: [],
    items: [],
    events: [],
    characterStateChanges: lines,
    relationshipChanges: [],
    knowledgeChanges: [],
    foreshadowingChanges: [],
    newCanonFacts: [],
    timelineEvents: [],
    conflicts: [],
    endingHook: "",
    graphNodes: [],
    graphEdges: [],
  }
}

describe("P2-IMP-04 粒子分类修正（technique 前置 + money 收紧）", () => {
  it("「境界：金丹期」归 technique（不误归 money 的金）", () => {
    const entries = foldParticleEntries(snap(["境界：金丹期"]))
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(entries[0].kind).toBe("technique")
  })

  it("「获得灵石百枚」仍归 money（灵石 未被境界上下文吞）", () => {
    const entries = foldParticleEntries(snap(["林墨：获得灵石百枚"]))
    const money = entries.find((e) => e.kind === "money")
    expect(money).toBeTruthy()
  })

  it("「金币千两」归 money（金币 命中收紧后的 金[币]）", () => {
    const entries = foldParticleEntries(snap(["林墨：金币千两"]))
    expect(entries.some((e) => e.kind === "money")).toBe(true)
  })

  it("「境界突破，获灵石百」负向护栏 → 境界上下文跳过 money（归 technique 或不提取）", () => {
    const entries = foldParticleEntries(snap(["境界：突破后获灵石百"]))
    // 境界上下文 → money 被护栏跳过；technique 命中 境界
    const money = entries.find((e) => e.kind === "money")
    expect(money).toBeUndefined()
    const technique = entries.find((e) => e.kind === "technique")
    expect(technique).toBeTruthy()
  })
})

describe("P2-IMP-04 渲染 delta=0 不输出增量列", () => {
  it("heuristic 解析（delta=0）渲染行不含 +0", () => {
    const entries = foldParticleEntries(snap(["林墨：获得灵石百枚"]))
    const store = entries.reduce(
      (s, e) => appendParticleEntry(s, e),
      createEmptyParticleLedgerStore(),
    )
    const text = particleLedgerToContextText(store)
    // delta=0 行不应出现 "+0" 增量列
    expect(text).not.toContain("+0")
    expect(text).not.toMatch(/\s0 →/)
    // 应包含角色与状态
    expect(text).toContain("林墨")
  })
})

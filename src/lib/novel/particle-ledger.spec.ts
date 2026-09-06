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

describe("P2-IMP-09 同键 upsert 末条胜（TencentDB skill-versioning）", () => {
  // rest 前 12 字为 name（rest.slice(0,12)），同 name 而尾段不同 → 同键不同内容。
  const lineV1 = "林墨：受伤-左臂已服丹药，次日好转，痛缓"
  const lineV2 = "林墨：受伤-左臂已服丹药，次日好转，痊愈"

  it("同键同内容 → 显式 no-op（不追加、不覆盖、不记修订、不动 lastUpdated）", () => {
    const e = foldParticleEntries(snap([lineV1]))[0]
    const first = appendParticleEntry(createEmptyParticleLedgerStore(), e, { now: "2026-09-01T00:00:00.000Z" })
    const second = appendParticleEntry(first, e, { now: "2026-09-02T00:00:00.000Z" })
    expect(second.entries).toHaveLength(1)
    expect(second.entries[0].state).toBe("受伤-左臂已服丹药，次日好转，痛缓")
    expect(second.entries[0].revisedAt).toBeUndefined()
    expect(second.lastUpdated).toBe("2026-09-01T00:00:00.000Z")
  })

  it("同键内容不等 → 末条胜覆盖内容字段并记修订（revisedAt = ctx.now）", () => {
    const v1 = foldParticleEntries(snap([lineV1]))[0]
    const v2 = foldParticleEntries(snap([lineV2]))[0]
    expect(v1.name).toBe(v2.name) // 同键：name 相同、state 不同
    const first = appendParticleEntry(createEmptyParticleLedgerStore(), v1, { now: "2026-09-01T00:00:00.000Z" })
    const second = appendParticleEntry(first, v2, { now: "2026-09-02T00:00:00.000Z" })
    expect(second.entries).toHaveLength(1)
    expect(second.entries[0].state).toBe("受伤-左臂已服丹药，次日好转，痊愈")
    expect(second.entries[0].revisedAt).toBe("2026-09-02T00:00:00.000Z")
  })

  it("无 ctx 时覆盖仍生效但不记修订（fold 纯性：无隐式墙钟）", () => {
    const v1 = foldParticleEntries(snap([lineV1]))[0]
    const v2 = foldParticleEntries(snap([lineV2]))[0]
    const first = appendParticleEntry(createEmptyParticleLedgerStore(), v1)
    const second = appendParticleEntry(first, v2)
    expect(second.entries).toHaveLength(1)
    expect(second.entries[0].state).toContain("痊愈")
    expect(second.entries[0].revisedAt).toBeUndefined()
  })

  it("跨章同（kind/character/name）→ 仍追加（键含 chapter）", () => {
    const e1 = foldParticleEntries(snap([lineV1], 1))[0]
    const e2 = foldParticleEntries(snap([lineV1], 2))[0]
    const s = [e1, e2].reduce((acc, e) => appendParticleEntry(acc, e), createEmptyParticleLedgerStore())
    expect(s.entries).toHaveLength(2)
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

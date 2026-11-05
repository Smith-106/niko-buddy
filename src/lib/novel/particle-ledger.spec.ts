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

// ── 行解析边界（宁缺勿错：判不出归属/状态的行走「不提取」而不是造脏账目）──
describe("parseParticleLine 边界（经 foldParticleEntries 公开入口）", () => {
  it("无冒号的行不提取（没有「归属角色:状态」结构）", () => {
    expect(foldParticleEntries(snap(["林墨左臂受伤已愈"]))).toEqual([])
  })

  it("冒号前为空的行不提取（无归属角色 → 强不变量拒绝）", () => {
    expect(foldParticleEntries(snap(["：获得灵石百枚"]))).toEqual([])
  })

  it("冒号后为空的行不提取（无状态内容 → 不造空账目）", () => {
    expect(foldParticleEntries(snap(["林墨："]))).toEqual([])
  })

  it("境界上下文里只有「化神」时 money 被负向护栏跳过（化神 不在 technique 正则内）", () => {
    // TECHNIQUE_CONTEXT 含「化神」，technique 词表不含 → money 分支被跳过，
    // injury 也未命中 → 整行不提取（而不是误归 money 的「灵石」）。
    expect(foldParticleEntries(snap(["林墨：化神期获灵石十枚"]))).toEqual([])
  })

  it("旧快照缺 characterStateChanges 字段 → 视为无状态变化（不抛）", () => {
    const legacy = JSON.parse(JSON.stringify(snap([])))
    delete legacy.characterStateChanges
    expect(foldParticleEntries(legacy)).toEqual([])
  })
})

// ── aliasMaps 归一（E-03：角色名归一为 canonical，脏映射不得造空归属）──
describe("aliasMaps 角色名归一", () => {
  const aliasMap = { canonical: "林砚", aliases: ["林墨"] }

  it("别名归一为 canonical", () => {
    const entries = foldParticleEntries(snap(["林墨：获得灵石百枚"]), [aliasMap])
    expect(entries.map((e) => e.character)).toEqual(["林砚"])
  })

  it("已有 canonical 本身命中 → 保持 canonical", () => {
    const entries = foldParticleEntries(snap(["林砚：获得灵石百枚"]), [aliasMap])
    expect(entries.map((e) => e.character)).toEqual(["林砚"])
  })

  it("无匹配映射 → 原样保留名字（不猜身份）", () => {
    const entries = foldParticleEntries(snap(["赵九：获得灵石百枚"]), [aliasMap])
    expect(entries.map((e) => e.character)).toEqual(["赵九"])
  })

  it("空 aliasMaps 数组 → 原样保留名字", () => {
    const entries = foldParticleEntries(snap(["赵九：获得灵石百枚"]), [])
    expect(entries.map((e) => e.character)).toEqual(["赵九"])
  })

  it("脏映射（canonical 为空）→ 丢弃该条，不造空归属账目", () => {
    expect(
      foldParticleEntries(snap(["林墨：获得灵石百枚"]), [{ canonical: "", aliases: ["林墨"] }]),
    ).toEqual([])
  })
})

describe("appendParticleEntry 同键覆盖只替换命中条目", () => {
  it("多条目时覆盖左侧条目，其它条目逐字段保留", () => {
    const money = foldParticleEntries(snap(["林墨：获得灵石百枚"], 1))[0]
    const injury = foldParticleEntries(snap(["赵九：左臂受创"], 2))[0]
    let store = appendParticleEntry(createEmptyParticleLedgerStore(), money)
    store = appendParticleEntry(store, injury)
    expect(store.entries).toHaveLength(2)

    const revised = appendParticleEntry(store, { ...money, state: "获得灵石两百枚" })
    expect(revised.entries).toHaveLength(2)
    expect(revised.entries.map((e) => e.state)).toEqual(["获得灵石两百枚", injury.state])
    expect(revised.entries[1]).toEqual(injury)
  })
})

describe("particleLedgerToContextText 增量列符号", () => {
  const entry = (delta: number, chapter: number) => ({
    kind: "money" as const,
    character: "林墨",
    name: "灵石",
    chapter,
    delta,
    state: delta > 0 ? "余额五十" : "余额三十",
    note: "text-heuristic",
  })

  it("正增量带 + 号、负增量带 - 号（零增量则不出现增量列）", () => {
    const text = particleLedgerToContextText({
      entries: [entry(50, 3), entry(-20, 4)],
      lastUpdated: "",
    })
    expect(text).toContain("第3章 林墨 灵石 +50 → 余额五十（text-heuristic）")
    expect(text).toContain("第4章 林墨 灵石 -20 → 余额三十（text-heuristic）")
    expect(text.split("\n")).toHaveLength(3) // 1 个分类标题 + 2 条账目
  })
})

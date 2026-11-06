import { describe, expect, it } from "vitest"
import { appendMeetingEdge, createEmptyEncounterMatrixStore, foldMeetingEdges, metBefore } from "./encounter-matrix"
import type { ChapterSnapshot } from "./chapter-ingest"
import type { NameAliasMap } from "./book-analysis/types"

function edge(a: string, b: string, chapter: number) {
  return appendMeetingEdge(createEmptyEncounterMatrixStore(), {
    a,
    b,
    chapter,
    context: "",
    witnessedBy: [],
  })
}

describe("P2-IMP-09 同键 upsert 末条胜（TencentDB skill-versioning）", () => {
  it("同键同内容 → 显式 no-op（不追加、不覆盖、不记修订、不动 lastUpdated）", () => {
    const first = appendMeetingEdge(
      createEmptyEncounterMatrixStore(),
      { a: "甲", b: "乙", chapter: 1, context: "客栈", witnessedBy: [] },
      { now: "2026-09-01T00:00:00.000Z" },
    )
    const second = appendMeetingEdge(
      first,
      { a: "甲", b: "乙", chapter: 1, context: "客栈", witnessedBy: [] },
      { now: "2026-09-02T00:00:00.000Z" },
    )
    expect(second.edges).toHaveLength(1)
    expect(second.edges[0].context).toBe("客栈")
    expect(second.edges[0].revisedAt).toBeUndefined()
    expect(second.lastUpdated).toBe("2026-09-01T00:00:00.000Z")
  })

  it("同键内容不等 → 末条胜覆盖内容字段并记修订（revisedAt = ctx.now）", () => {
    const first = appendMeetingEdge(
      createEmptyEncounterMatrixStore(),
      { a: "甲", b: "乙", chapter: 1, context: "客栈", witnessedBy: [] },
      { now: "2026-09-01T00:00:00.000Z" },
    )
    const second = appendMeetingEdge(
      first,
      { a: "甲", b: "乙", chapter: 1, context: "码头交手", witnessedBy: ["丙"] },
      { now: "2026-09-02T00:00:00.000Z" },
    )
    expect(second.edges).toHaveLength(1)
    expect(second.edges[0].context).toBe("码头交手")
    expect(second.edges[0].witnessedBy).toEqual(["丙"])
    expect(second.edges[0].revisedAt).toBe("2026-09-02T00:00:00.000Z")
  })

  it("a/b 无序同键（甲乙 vs 乙甲）同样命中 upsert", () => {
    const first = appendMeetingEdge(
      createEmptyEncounterMatrixStore(),
      { a: "甲", b: "乙", chapter: 1, context: "客栈", witnessedBy: [] },
    )
    const second = appendMeetingEdge(
      first,
      { a: "乙", b: "甲", chapter: 1, context: "新场景", witnessedBy: [] },
    )
    expect(second.edges).toHaveLength(1)
    expect(second.edges[0].context).toBe("新场景")
  })

  it("无 ctx 时覆盖仍生效但不记修订（fold 纯性：无隐式墙钟）", () => {
    const first = appendMeetingEdge(
      createEmptyEncounterMatrixStore(),
      { a: "甲", b: "乙", chapter: 1, context: "客栈", witnessedBy: [] },
    )
    const second = appendMeetingEdge(
      first,
      { a: "甲", b: "乙", chapter: 1, context: "码头", witnessedBy: [] },
    )
    expect(second.edges).toHaveLength(1)
    expect(second.edges[0].context).toBe("码头")
    expect(second.edges[0].revisedAt).toBeUndefined()
    expect(second.lastUpdated).toBe("")
  })

  it("跨章同对角色 → 仍追加（键含 chapter，不误伤跨章再见面）", () => {
    let s = edge("甲", "乙", 1)
    s = appendMeetingEdge(s, { a: "甲", b: "乙", chapter: 2, context: "", witnessedBy: [] })
    expect(s.edges).toHaveLength(2)
  })
})

describe("P2-IMP-05 metBefore 时间窗参数化", () => {
  it("inclusive（默认）：含本章共现边", () => {
    let s = edge("甲", "乙", 1)
    s = appendMeetingEdge(s, { a: "甲", b: "丙", chapter: 3, context: "", witnessedBy: [] })
    // 查第 3 章 inclusive → 含本章（丙）
    expect(new Set(metBefore(s, "甲", 3))).toEqual(new Set(["乙", "丙"]))
  })

  it("past：排除本章共现边（本章见面 ≠ 已见面）", () => {
    let s = edge("甲", "乙", 1)
    s = appendMeetingEdge(s, { a: "甲", b: "丙", chapter: 3, context: "", witnessedBy: [] })
    // 查第 3 章 past → 仅 乙（丙 本章才见）
    expect(new Set(metBefore(s, "甲", 3, "past"))).toEqual(new Set(["乙"]))
  })

  it("past 在无本章边时与 inclusive 等价", () => {
    let s = edge("甲", "乙", 1)
    s = appendMeetingEdge(s, { a: "甲", b: "丙", chapter: 2, context: "", witnessedBy: [] })
    expect(new Set(metBefore(s, "甲", 3, "past"))).toEqual(new Set(["乙", "丙"]))
    expect(new Set(metBefore(s, "甲", 3, "inclusive"))).toEqual(new Set(["乙", "丙"]))
  })
})

describe("foldMeetingEdges：别名归一与退化名跳过（可达性收尾）", () => {
  function snapshotWith(characters: string[]): ChapterSnapshot {
    return {
      chapterId: "ch-7",
      chapterNumber: 7,
      summary: "",
      characters,
      locations: [],
      organizations: [],
      items: [],
      events: [],
      characterStateChanges: [],
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

  it("两个不同写法归一到同一 canonical → 不产出自我见面边（a === b 跳过）", () => {
    const aliasMaps: readonly NameAliasMap[] = [{ canonical: "甲", aliases: ["阿甲"] }]
    const edges = foldMeetingEdges(snapshotWith(["甲", "阿甲"]), aliasMaps)

    // 唯一一对 (甲, 阿甲) 归一后同为「甲」：跳过，绝不产出 a===b 的自环
    expect(edges).toEqual([])
  })

  it("归一结果为空（degenerate canonical）→ 跳过该对", () => {
    const aliasMaps: readonly NameAliasMap[] = [{ canonical: "", aliases: [] }]
    expect(foldMeetingEdges(snapshotWith(["甲", "乙"]), aliasMaps)).toEqual([])
  })

  it("别名表不含该角色 → 保留原名并照常成边（fall-through 返回 name）", () => {
    const aliasMaps: readonly NameAliasMap[] = [{ canonical: "丙", aliases: ["阿丙"] }]
    const edges = foldMeetingEdges(snapshotWith(["甲", "乙"]), aliasMaps)

    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ a: "甲", b: "乙", chapter: 7 })
  })

  it("别名命中但阈值未被空表短路：非空表内无匹配即原样输出（不被空表早退吞掉）", () => {
    // 空表早退（aliasMaps.length === 0）与「非空但不匹配」是两条不同路径，此处取后者
    const edges = foldMeetingEdges(snapshotWith(["甲", "乙"]), [{ canonical: "甲", aliases: [] }])
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ a: "甲", b: "乙" })
    // 见证者列表同样经过归一：both 不在 witnesses 内时为空
    expect(edges[0].witnessedBy).toEqual([])
  })
})

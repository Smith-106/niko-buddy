import { describe, expect, it } from "vitest"
import { appendMeetingEdge, createEmptyEncounterMatrixStore, metBefore } from "./encounter-matrix"

function edge(a: string, b: string, chapter: number) {
  return appendMeetingEdge(createEmptyEncounterMatrixStore(), {
    a,
    b,
    chapter,
    context: "",
    witnessedBy: [],
  })
}

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

import { describe, expect, it } from "vitest"
import {
  advanceVolumeArc,
  allocateVolumeArc,
  arcSegmentForChapter,
  createVolumeArcState,
} from "./volume"
import { directorVolumeArcSummary } from "./director-pipeline"

describe("volume-arc (64 号实施：director volumeArc 卷弧滚动)", () => {
  it("allocateVolumeArc：10 章 2:3:3:2 → 四段 2/3/3/2 章", () => {
    const alloc = allocateVolumeArc(1, 1, 10)
    expect(alloc).toEqual([
      { segment: "起", startChapter: 1, endChapter: 2 },
      { segment: "承", startChapter: 3, endChapter: 5 },
      { segment: "转", startChapter: 6, endChapter: 8 },
      { segment: "合", startChapter: 9, endChapter: 10 },
    ])
  })

  it("allocateVolumeArc：章节全覆盖（首尾衔接无空洞）", () => {
    const alloc = allocateVolumeArc(2, 11, 24)
    expect(alloc[0].startChapter).toBe(11)
    expect(alloc[alloc.length - 1].endChapter).toBe(24)
  })

  it("allocateVolumeArc：区间过小（3 章）压缩不溢出", () => {
    const alloc = allocateVolumeArc(1, 1, 3)
    expect(alloc[0].startChapter).toBe(1)
    expect(alloc[alloc.length - 1].endChapter).toBe(3)
  })

  it("allocateVolumeArc：空区间 → []", () => {
    expect(allocateVolumeArc(1, 5, 4)).toEqual([])
  })

  it("arcSegmentForChapter：卷内章节映射弧段；卷外 → null", () => {
    const alloc = allocateVolumeArc(1, 1, 10)
    expect(arcSegmentForChapter(alloc, 1)).toBe("起")
    expect(arcSegmentForChapter(alloc, 6)).toBe("转")
    expect(arcSegmentForChapter(alloc, 9)).toBe("合")
    expect(arcSegmentForChapter(alloc, 99)).toBeNull()
  })

  it("advanceVolumeArc：初始无段 → 进入起段", () => {
    const alloc = allocateVolumeArc(1, 1, 10)
    const res = advanceVolumeArc(createVolumeArcState(1), alloc, { now: "T" })
    expect(res.rolled).toBe(true)
    expect(res.state.segment).toBe("起")
    expect(res.state.completedInVolume).toBe(1)
  })

  it("advanceVolumeArc：起段 2 章推进后滚入承段", () => {
    const alloc = allocateVolumeArc(1, 1, 10)
    let s = createVolumeArcState(1)
    s = advanceVolumeArc(s, alloc, { now: "T" }).state // 起 1
    s = advanceVolumeArc(s, alloc, { now: "T" }).state // 起 2 → 承
    expect(s.segment).toBe("承")
    expect(s.completedInVolume).toBe(2)
  })

  it("advanceVolumeArc：合段结束 → volumeComplete + nextVolume", () => {
    const alloc = allocateVolumeArc(1, 1, 4) // 每段 1 章
    let s = createVolumeArcState(1)
    let res = advanceVolumeArc(s, alloc, { now: "T" })
    s = res.state
    res = advanceVolumeArc(s, alloc, { now: "T" })
    s = res.state
    res = advanceVolumeArc(s, alloc, { now: "T" })
    s = res.state
    res = advanceVolumeArc(s, alloc, { now: "T" })
    expect(res.volumeComplete).toBe(true)
    expect(res.nextVolume).toBe(2)
    expect(res.state.segment).toBe("合")
  })

  it("advanceVolumeArc：确定性同输入同输出", () => {
    const alloc = allocateVolumeArc(1, 1, 10)
    const a = advanceVolumeArc(createVolumeArcState(1), alloc, { now: "T" })
    const b = advanceVolumeArc(createVolumeArcState(1), alloc, { now: "T" })
    expect(a.state.completedInVolume).toBe(b.state.completedInVolume)
    expect(a.rolled).toBe(b.rolled)
    expect(a.volumeComplete).toBe(b.volumeComplete)
  })

  it("director 接线：directorVolumeArcSummary 渲染卷弧行", () => {
    const alloc = allocateVolumeArc(1, 1, 10)
    const s = advanceVolumeArc(createVolumeArcState(1), alloc, { now: "T" }).state
    const summary = directorVolumeArcSummary(s, 10)
    expect(summary).toContain("第1卷")
    expect(summary).toContain("[起]")
    expect(summary).toContain("1/10")
  })
})

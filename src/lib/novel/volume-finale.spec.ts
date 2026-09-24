import { describe, expect, it } from "vitest"
import { advanceVolumeArc, allocateVolumeArc, checkFinaleAutoComplete, createVolumeArcState } from "./volume"

describe("checkFinaleAutoComplete 收官卷自动完结（§GAP-89-01）", () => {
  it("非卷末 → 不完结", () => {
    expect(
      checkFinaleAutoComplete({ volumeComplete: false, finalVolumeDeclared: true, currentVolumeNumber: 6, finalVolumeNumber: 6 }),
    ).toEqual({ completed: false, reason: "" })
  })

  it("收官卷终点卷末 → 自动完结", () => {
    const r = checkFinaleAutoComplete({ volumeComplete: true, finalVolumeDeclared: true, currentVolumeNumber: 6, finalVolumeNumber: 6 })
    expect(r.completed).toBe(true)
    expect(r.reason).toContain("自动完结")
  })

  it("普通卷末（未宣告收官）→ 滚动下一卷", () => {
    const r = checkFinaleAutoComplete({ volumeComplete: true, finalVolumeDeclared: false, currentVolumeNumber: 3 })
    expect(r.completed).toBe(false)
    expect(r.reason).toContain("滚动进入下一卷")
  })

  it("收官已宣告但当前卷末非收官终点 → 继续推进", () => {
    const r = checkFinaleAutoComplete({ volumeComplete: true, finalVolumeDeclared: true, currentVolumeNumber: 5, finalVolumeNumber: 6 })
    expect(r.completed).toBe(false)
    expect(r.reason).toContain("继续推进")
  })

  it("与 advanceVolumeArc 串联：合段结束 + 收官宣告 → 完结", () => {
    const alloc = allocateVolumeArc(6, 51, 54)
    let s = createVolumeArcState(6)
    let res = advanceVolumeArc(s, alloc, { now: "T" })
    s = res.state
    res = advanceVolumeArc(s, alloc, { now: "T" })
    s = res.state
    res = advanceVolumeArc(s, alloc, { now: "T" })
    s = res.state
    res = advanceVolumeArc(s, alloc, { now: "T" })
    expect(res.volumeComplete).toBe(true)
    const finale = checkFinaleAutoComplete({
      volumeComplete: res.volumeComplete,
      finalVolumeDeclared: true,
      currentVolumeNumber: 6,
      finalVolumeNumber: res.nextVolume !== undefined ? res.nextVolume - 1 : 6,
    })
    expect(finale.completed).toBe(true)
  })
})

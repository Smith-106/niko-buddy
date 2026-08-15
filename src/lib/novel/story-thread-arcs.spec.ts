import { describe, expect, it } from "vitest"
import {
  deriveThreadArcState,
  deriveAllThreadArcStates,
  detectArcTransitionViolations,
  threadArcStatesToContextText,
  countOpenThreadArcs,
  THREAD_ARC_STATES,
  THREAD_ARC_TRANSITIONS,
  THREAD_ARC_KINDS,
  ThreadArcDerived,
} from "./story-thread-arcs"
import type { Subplot } from "./subplot-board"

function makeSubplot(overrides: Partial<Subplot> = {}): Subplot {
  return {
    id: "sp-1",
    title: "复仇线",
    status: "active",
    startChapter: 1,
    relatedCharacters: [],
    summary: "主角复仇",
    progress: [],
    notes: "",
    ...overrides,
  }
}

describe("S2c Story Threads 6 状态机 (Quillica)", () => {
  it("6 状态枚举完整 (Setup/Rising/Climax/Falling/Resolved/Unresolved)", () => {
    expect(THREAD_ARC_STATES).toEqual([
      "Setup", "Rising", "Climax", "Falling", "Resolved", "Unresolved",
    ])
  })

  it("状态转移合法性 (Setup→Rising→Climax→Falling→Resolved/Unresolved)", () => {
    expect(THREAD_ARC_TRANSITIONS.Setup).toContain("Rising")
    expect(THREAD_ARC_TRANSITIONS.Rising).toContain("Climax")
    expect(THREAD_ARC_TRANSITIONS.Climax).toContain("Resolved")
    expect(THREAD_ARC_TRANSITIONS.Falling).toContain("Unresolved")
    expect(THREAD_ARC_TRANSITIONS.Resolved).toEqual([]) // 终态
    expect(THREAD_ARC_TRANSITIONS.Unresolved).toEqual([]) // 终态
  })

  it("13 种线索类型 (Quillica)", () => {
    expect(THREAD_ARC_KINDS).toHaveLength(13)
    expect(THREAD_ARC_KINDS).toContain("Foreshadowing")
    expect(THREAD_ARC_KINDS).toContain("Clue")
  })

  it("派生: proposed → Setup", () => {
    const d = deriveThreadArcState(makeSubplot({ status: "proposed" }), 10)
    expect(d.arcState).toBe("Setup")
  })

  it("派生: active + 1 条 progress → Rising", () => {
    const d = deriveThreadArcState(makeSubplot({ progress: ["引入"] }), 10)
    expect(d.arcState).toBe("Rising")
  })

  it("派生: active + ≥5 条 progress → Climax", () => {
    const d = deriveThreadArcState(
      makeSubplot({ progress: ["1", "2", "3", "4", "5"] }),
      10,
    )
    expect(d.arcState).toBe("Climax")
  })

  it("派生: 长期未推进 (gap≥10) → Falling", () => {
    const d = deriveThreadArcState(
      makeSubplot({ progress: ["1", "2", "3"], lastSeenChapter: 2 }),
      15,
    )
    expect(d.arcState).toBe("Falling")
    expect(d.basis).toContain("13 章未推进")
  })

  it("派生: resolved → Resolved; abandoned → Unresolved (Sequel)", () => {
    expect(deriveThreadArcState(makeSubplot({ status: "resolved" }), 10).arcState).toBe("Resolved")
    expect(deriveThreadArcState(makeSubplot({ abandoned: true }), 10).arcState).toBe("Unresolved")
  })

  it("detectArcTransitionViolations: Resolved 后仍有非闭环 progress → 违反", () => {
    const resolved = makeSubplot({ status: "resolved", progress: ["新增推进"] })
    const derived = detectArcTransitionViolations(resolved, {
      subplotId: resolved.id,
      title: resolved.title,
      arcState: "Resolved",
      basis: "已解决",
    })
    expect(derived.transitionViolation).toBeTruthy()
  })

  it("detectArcTransitionViolations: Resolved 后闭环 progress 不报", () => {
    const resolved = makeSubplot({ status: "resolved", progress: ["伏笔回收闭环"] })
    const derived = detectArcTransitionViolations(resolved, {
      subplotId: resolved.id,
      title: resolved.title,
      arcState: "Resolved",
      basis: "已解决",
    })
    expect(derived.transitionViolation).toBeUndefined()
  })

  it("deriveAllThreadArcStates + countOpenThreadArcs", () => {
    const subplots = [
      makeSubplot({ id: "a", status: "resolved" }),
      makeSubplot({ id: "b", progress: ["x"] }),
      makeSubplot({ id: "c", status: "proposed" }),
    ]
    const derived = deriveAllThreadArcStates(subplots, 10)
    expect(countOpenThreadArcs(derived)).toBe(2) // Rising + Setup
  })

  it("threadArcStatesToContextText 渲染", () => {
    const derived: ThreadArcDerived[] = [
      { subplotId: "a", title: "复仇线", arcState: "Climax", basis: "进度 5 条" },
    ]
    const text = threadArcStatesToContextText(derived)
    expect(text).toContain("Story Threads 弧位")
    expect(text).toContain("[Climax] 复仇线")
  })
})

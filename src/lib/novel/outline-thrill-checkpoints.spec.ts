import { describe, expect, it } from "vitest"
import {
  evaluateOutlineThrillCheckpoints,
  formatThrillSoftGateThinking,
  runOutlineThrillSoftGate,
  summarizeThrillSoftGate,
  thrillResultsToReviewResults,
} from "./outline-thrill-checkpoints"

const STRONG_OUTLINE = `
第3章纲要：开篇危机逼近，主角被追杀陷入绝境。
中段压抑到极点后反击破局，主动设局推动局面。
章末钩：门外传来倒计时滴答，下一阶段仍未揭开。
`.repeat(2)

const SPOILER_OUTLINE = `
开篇说明设定。最终存活者是阿宁，Offer 是契约。
真相是全员被选中。
`.repeat(3)

describe("evaluateOutlineThrillCheckpoints", () => {
  it("empty outline → structural unknown, fix1 pass", () => {
    const r = evaluateOutlineThrillCheckpoints("")
    expect(r.find((x) => x.id === "crisis_info_early")!.status).toBe("unknown")
    expect(r.find((x) => x.id === "fix1_no_conflict")!.status).toBe("pass")
  })

  it("strong outline passes structural cues", () => {
    const r = evaluateOutlineThrillCheckpoints(STRONG_OUTLINE)
    expect(r.find((x) => x.id === "crisis_info_early")!.status).toBe("pass")
    expect(r.find((x) => x.id === "pressure_release")!.status).toBe("pass")
    expect(r.find((x) => x.id === "protagonist_agency")!.status).toBe("pass")
    expect(r.find((x) => x.id === "chapter_end_hook")!.status).toBe("pass")
    expect(r.find((x) => x.id === "fix1_no_conflict")!.status).toBe("pass")
  })

  it("FIX-1 spoiler phrasing fails hard constraint", () => {
    const r = evaluateOutlineThrillCheckpoints(SPOILER_OUTLINE)
    const fix1 = r.find((x) => x.id === "fix1_no_conflict")!
    expect(fix1.status).toBe("fail")
    expect(fix1.hardLiteraryConstraint).toBe(true)
  })
})

describe("summarize + review mapping", () => {
  it("soft-gate review results are warnings only", () => {
    const r = evaluateOutlineThrillCheckpoints(SPOILER_OUTLINE)
    const reviews = thrillResultsToReviewResults(r, 3)
    expect(reviews.every((x) => x.severity === "warning")).toBe(true)
    expect(reviews.some((x) => x.type === "outline_thrill_fix1")).toBe(true)
  })

  it("thinking is non-silent and mentions acknowledge", () => {
    const r = evaluateOutlineThrillCheckpoints("短")
    const text = formatThrillSoftGateThinking(r)
    expect(text).toContain("软门")
    expect(text).toContain("acknowledge")
  })

  it("runOutlineThrillSoftGate bundles", () => {
    const out = runOutlineThrillSoftGate(STRONG_OUTLINE, 2)
    expect(out.summary.failCount).toBe(0)
    expect(out.thinking.length).toBeGreaterThan(20)
  })

  it("summarize detects fix1Blocked", () => {
    const r = evaluateOutlineThrillCheckpoints(SPOILER_OUTLINE)
    expect(summarizeThrillSoftGate(r).fix1Blocked).toBe(true)
  })
})

describe("thril soft-gate acknowledge helpers", () => {
  it("set/get/clear acknowledge by chapter", async () => {
    const {
      isThrillSoftGateAcknowledged,
      setThrillSoftGateAcknowledged,
      thrilAckChapterKey,
      formatThrillSoftGateThinkingWithAck,
    } = await import("./outline-thrill-checkpoints")
    expect(thrilAckChapterKey(3)).toBe("3")
    let map = setThrillSoftGateAcknowledged({}, 3, true)
    expect(isThrillSoftGateAcknowledged(map, 3)).toBe(true)
    expect(isThrillSoftGateAcknowledged(map, 2)).toBe(false)
    map = setThrillSoftGateAcknowledged(map, 3, false)
    expect(isThrillSoftGateAcknowledged(map, 3)).toBe(false)
    const r = evaluateOutlineThrillCheckpoints(STRONG_OUTLINE)
    expect(formatThrillSoftGateThinkingWithAck(r, true)).toContain("已确认")
    expect(formatThrillSoftGateThinkingWithAck(r, false)).toContain("待确认")
  })
})

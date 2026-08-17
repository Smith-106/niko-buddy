import { describe, expect, it } from "vitest"
import {
  evaluateOutlineThrillCheckpoints,
  formatThrillSoftGateThinking,
  getOutlineThrillSoftGateRuntimeStatus,
  runOutlineThrillSoftGate,
  setThrillSoftGateAcknowledged,
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

  it("short text with allowUnknown=false hard-fails structural checks", () => {
    const r = evaluateOutlineThrillCheckpoints("短", { allowUnknown: false })
    expect(r.find((x) => x.id === "crisis_info_early")!.status).toBe("fail")
    expect(r.find((x) => x.id === "pressure_release")!.status).toBe("fail")
    expect(r.find((x) => x.id === "protagonist_agency")!.status).toBe("fail")
    expect(r.find((x) => x.id === "chapter_end_hook")!.status).toBe("fail")
    expect(r.find((x) => x.id === "fix1_no_conflict")!.status).toBe("pass")
  })

  it("null outline text is treated as empty", () => {
    const r = evaluateOutlineThrillCheckpoints(null as unknown as string)
    expect(r.find((x) => x.id === "crisis_info_early")!.status).toBe("unknown")
    expect(r.find((x) => x.id === "fix1_no_conflict")!.status).toBe("pass")
  })

  it("detects an end hook that only appears within the final 200 chars", () => {
    // hook words placed outside lateSlice (55% mark) but inside the last 200
    const text = "危机 压抑 决定 ".repeat(20) + "下章悬念" + "平".repeat(96)
    const r = evaluateOutlineThrillCheckpoints(text)
    expect(r.find((x) => x.id === "chapter_end_hook")!.status).toBe("pass")
    expect(r.find((x) => x.id === "crisis_info_early")!.status).toBe("pass")
  })

  it("takes the final-200-char hook branch when the late slice has no hook cue", () => {
    // 200 filler chars, hook at index 200..203, then 196 filler chars:
    // lateSlice starts at 55% (index 220) so it misses the hook, but the last
    // 200 chars still contain it → the `||` second operand must be evaluated
    const text = "字".repeat(200) + "下章悬念" + "字".repeat(196)
    const r = evaluateOutlineThrillCheckpoints(text)
    expect(r.find((x) => x.id === "chapter_end_hook")!.status).toBe("pass")
    expect(r.find((x) => x.id === "pressure_release")!.status).toBe("fail") // longEnough
  })

  it("renders a result without evidence with an empty evidence suffix", () => {
    const r: ReturnType<typeof evaluateOutlineThrillCheckpoints> = [
      { id: "crisis_info_early", status: "pass", label: "无证据检查点" },
    ]
    const text = formatThrillSoftGateThinking(r)
    expect(text).toContain("[✓] 无证据检查点")
    expect(text).not.toContain("— ")
  })

  it("maps missing evidence to the raw status string in review results", () => {
    const r: ReturnType<typeof evaluateOutlineThrillCheckpoints> = [
      { id: "crisis_info_early", status: "unknown", label: "无证据检查点" },
    ]
    const reviews = thrillResultsToReviewResults(r)
    expect(reviews[0]!.evidence).toBe("unknown")
  })

  it("runtime status tolerates a missing outlineText via empty-string fallback", () => {
    const st = getOutlineThrillSoftGateRuntimeStatus({ chapter: 2, ackMap: {} })
    expect(st.enabled).toBe(true)
    expect(st.chapterKey).toBe("2")
    expect(st.failCount).toBe(0)
    expect(st.results.find((x) => x.id === "fix1_no_conflict")!.status).toBe("pass")
  })
})

describe("getOutlineThrillSoftGateRuntimeStatus", () => {
  it("exposes ack + FIX-1 without product hard gate", () => {
    const ack = setThrillSoftGateAcknowledged({}, 4, true)
    const st = getOutlineThrillSoftGateRuntimeStatus({
      outlineText: STRONG_OUTLINE,
      chapter: 4,
      ackMap: ack,
    })
    expect(st.enabled).toBe(true)
    expect(st.acknowledged).toBe(true)
    expect(st.productHardGate).toBe(false)
    expect(st.mayContinueGeneration).toBe(true)
    expect(st.fix1Blocked).toBe(false)
  })

  it("FIX-1 blocked still may continue but flags constraint", () => {
    const st = getOutlineThrillSoftGateRuntimeStatus({
      outlineText: SPOILER_OUTLINE,
      chapter: 3,
      ackMap: { "3": true },
    })
    expect(st.fix1Blocked).toBe(true)
    expect(st.acknowledged).toBe(true)
    expect(st.thinking).toMatch(/FIX-1/)
  })

  it("disabled runtime status short-circuits with empty results", () => {
    const st = getOutlineThrillSoftGateRuntimeStatus({
      outlineText: SPOILER_OUTLINE,
      chapter: 3,
      enabled: false,
      ackMap: { "3": true },
    })
    expect(st.enabled).toBe(false)
    expect(st.results).toEqual([])
    expect(st.passCount).toBe(0)
    expect(st.fix1Blocked).toBe(false)
    expect(st.allStructuralOk).toBe(true)
    expect(st.mayContinueGeneration).toBe(true)
    expect(st.thinking).toContain("已关闭")
  })

  it("empty outline via runtime status yields structural unknowns and ack false", () => {
    const st = getOutlineThrillSoftGateRuntimeStatus({
      outlineText: "",
      chapter: null,
    })
    expect(st.enabled).toBe(true)
    expect(st.chapterKey).toBe("0")
    expect(st.acknowledged).toBe(false)
    expect(st.failCount).toBe(0)
    expect(st.results.find((r) => r.id === "fix1_no_conflict")!.status).toBe("pass")
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

  it("thrilAckChapterKey handles null, NaN, Infinity and fractional chapters", async () => {
    const { thrilAckChapterKey } = await import("./outline-thrill-checkpoints")
    expect(thrilAckChapterKey(null)).toBe("0")
    expect(thrilAckChapterKey(undefined)).toBe("0")
    expect(thrilAckChapterKey(NaN)).toBe("0")
    expect(thrilAckChapterKey(Infinity)).toBe("0")
    expect(thrilAckChapterKey(3.7)).toBe("3")
    expect(thrilAckChapterKey(-2)).toBe("-2")
  })

  it("setThrillSoftGateAcknowledged tolerates null ackMap and setThrillSoftGateAcknowledged delete path", async () => {
    const { isThrillSoftGateAcknowledged, setThrillSoftGateAcknowledged } = await import("./outline-thrill-checkpoints")
    expect(isThrillSoftGateAcknowledged(null, 2)).toBe(false)
    const fresh = setThrillSoftGateAcknowledged(null, 2, true)
    expect(fresh).toEqual({ "2": true })
  })

  it("thrillResultsToReviewResults maps unknown status with default chapter 0", async () => {
    const { evaluateOutlineThrillCheckpoints, thrillResultsToReviewResults } = await import("./outline-thrill-checkpoints")
    const r = evaluateOutlineThrillCheckpoints("短")
    const reviews = thrillResultsToReviewResults(r)
    expect(reviews.length).toBe(4) // four structural unknowns (fix1 passes)
    expect(reviews.every((x) => x.continuityMeta!.chapter === 0)).toBe(true)
    expect(reviews[0]!.evidence).toBe("no crisis/pressure cue in first ~40%")
  })
})

import { describe, expect, it } from "vitest"
import {
  computeReviewAgreement,
  normalizeForAgreement,
  REVIEW_AGREEMENT_MIN_QUOTE_LEN,
} from "./review-adapter"

// S-goal-storymoss-absorb/S1: 判官一致率 (StoryMoss editor_agreement 对位, 只报不改)
describe("normalizeForAgreement", () => {
  it("strips whitespace and lowercases", () => {
    expect(normalizeForAgreement("  张三 冷笑 道  ")).toBe("张三冷笑道")
    expect(REVIEW_AGREEMENT_MIN_QUOTE_LEN).toBe(6)
  })
})

describe("computeReviewAgreement", () => {
  it("counts a verbatim surviving quote as survived", () => {
    const r = computeReviewAgreement(
      [{ quote: "张三冷笑一声说道" }],
      "前文。张三冷笑一声说道：走。后文。",
    )
    expect(r).toEqual({ total: 1, survived: 1, rate: 1, details: [true] })
  })

  it("counts a rewritten/deleted quote as adopted (not survived)", () => {
    const r = computeReviewAgreement(
      [{ quote: "张三冷笑一声说道" }],
      "前文。张三转身离去，一言未发。后文。",
    )
    expect(r).toEqual({ total: 1, survived: 0, rate: 0, details: [false] })
  })

  it("ignores quotes shorter than 6 normalized chars", () => {
    const r = computeReviewAgreement([{ quote: "冷笑" }, { quote: "张三冷笑一声说道" }], "张三冷笑一声说道")
    expect(r.total).toBe(1)
    expect(r.details).toEqual([false, true])
  })

  it("returns rate 0 when no quotable findings", () => {
    expect(computeReviewAgreement([], "正文")).toEqual({ total: 0, survived: 0, rate: 0, details: [] })
    expect(computeReviewAgreement([{ quote: "短" }], "短").rate).toBe(0)
  })
})

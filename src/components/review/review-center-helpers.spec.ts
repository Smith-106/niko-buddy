import { describe, expect, it } from "vitest"
import { summarizeReviewRunDone } from "./review-center-helpers"

const dim = (n: number) => ({ issues: Array.from({ length: n }, () => ({})) }) as never

describe("summarizeReviewRunDone", () => {
  it("未跑 / 进行中 / 出错 → null", () => {
    expect(summarizeReviewRunDone(null, "")).toBeNull()
    expect(summarizeReviewRunDone({ running: true, results: [] }, "")).toBeNull()
    expect(summarizeReviewRunDone({ running: false, results: [] }, "boom")).toBeNull()
  })

  it("六维结果（results 为空）按逐维 issues 计数", () => {
    const run = { running: false, results: [], dimensionResults: { consistency: dim(2), pacing: dim(1) } }
    expect(summarizeReviewRunDone(run, "")).toEqual({ count: 3 })
  })

  it("六维全部无问题 → count 0（显示「没有发现需要处理的问题」）", () => {
    const run = { running: false, results: [], dimensionResults: { consistency: dim(0) } }
    expect(summarizeReviewRunDone(run, "")).toEqual({ count: 0 })
  })

  it("旧单遍审查仍按 results 计数", () => {
    expect(summarizeReviewRunDone({ running: false, results: [{}, {}] as never }, "")).toEqual({ count: 2 })
  })

  it("完成门 incomplete / suspect → 不宣称完成", () => {
    const base = { running: false, results: [], dimensionResults: { consistency: dim(0) } }
    expect(summarizeReviewRunDone({ ...base, gateStatus: "incomplete" }, "")).toBeNull()
    expect(summarizeReviewRunDone({ ...base, gateStatus: "suspect" }, "")).toBeNull()
  })
})

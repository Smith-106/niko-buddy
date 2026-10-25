import { describe, expect, it, vi } from "vitest"
import {
  failReviewRun,
  finishCurrentReviewRunIfOwned,
  isEmptyReviewInput,
  newReviewRunId,
  resolveReviewRunActions,
} from "@/lib/novel/review-runner"

/**
 * ISS-20260709-009：start-review-run / six-dimension-review 公共 runner 收敛。
 */
describe("ISS-20260709-009 review-runner convergence", () => {
  it("空输入守卫等价", () => {
    expect(isEmptyReviewInput("", "body")).toBe(true)
    expect(isEmptyReviewInput("f.md", "   ")).toBe(true)
    expect(isEmptyReviewInput("f.md", "body")).toBe(false)
  })

  it("runId 保持 Date.now-random 格式", () => {
    const id = newReviewRunId()
    expect(id).toMatch(/^\d+-\d(\.\d+)?$/)
  })

  it("DI 回退：未注入时走默认（函数可用），注入优先", () => {
    const actions = resolveReviewRunActions(undefined)
    expect(typeof actions.setReviewRun).toBe("function")
    const set = vi.fn()
    const finish = vi.fn()
    const get = vi.fn()
    const injected = resolveReviewRunActions({ setReviewRun: set as never, finishReviewRun: finish as never, getReviewRun: get as never })
    expect(injected.setReviewRun).toBe(set)
  })

  it("finally 收口仅本 run 才覆盖（防跨 run）", () => {
    const finish = vi.fn()
    const get = vi.fn(() => ({ runId: "other", results: [] }))
    finishCurrentReviewRunIfOwned(get as never, finish as never, "mine", { running: false } as never)
    expect(finish).not.toHaveBeenCalled()
    get.mockReturnValue({ runId: "mine", results: [1] } as never)
    finishCurrentReviewRunIfOwned(get as never, finish as never, "mine", { running: false, results: [1] } as never)
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it("catch 经公共失败路径（message-only + 统一失败态）", () => {
    const finish = vi.fn()
    failReviewRun("Scope", "msg", new Error("boom"), finish as never, "r1", "失败")
    expect(finish).toHaveBeenCalledWith("r1", { running: false, error: "失败" })
  })
});

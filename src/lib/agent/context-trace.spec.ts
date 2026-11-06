/** C4 冒烟覆盖：src/lib/agent/context-trace.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { createContextTrace, setContextInfo, finishTrace } from "./context-trace"
describe("context-trace.ts smoke", () => {
  it("exports createContextTrace", () => {
    expect(createContextTrace).toBeDefined()
  })
  it("exports setContextInfo", () => {
    expect(setContextInfo).toBeDefined()
  })
  it("exports finishTrace", () => {
    expect(finishTrace).toBeDefined()
  })

  // 以下为真实行为用例：上面的 toBeDefined 冒烟从未调用过这三个函数，
  // 三个 return 语句因此全未覆盖。
  it("createContextTrace 产出 running 初始迹，toolCalls 为空且无结束时间", () => {
    const before = Date.now()
    const trace = createContextTrace("trace-1")
    expect(trace.id).toBe("trace-1")
    expect(trace.status).toBe("running")
    expect(trace.toolCalls).toEqual([])
    expect(trace.finishedAt).toBeUndefined()
    expect(trace.startedAt).toBeGreaterThanOrEqual(before)
  })

  it("setContextInfo 返回新对象并挂上 contextInfo，不改动原迹", () => {
    const trace = createContextTrace("trace-2")
    const info = { tokens: 42, sources: ["a.md"] } as never
    const next = setContextInfo(trace, info)
    expect(next).not.toBe(trace)
    expect(next.contextInfo).toBe(info)
    expect(next.id).toBe("trace-2")
    expect(next.status).toBe("running")
    expect(trace.contextInfo).toBeUndefined()
  })

  it("finishTrace 写入终态、结束时间与可选错误信息", () => {
    const trace = createContextTrace("trace-3")
    const done = finishTrace(trace, "done")
    expect(done.status).toBe("done")
    expect(typeof done.finishedAt).toBe("number")
    expect(done.errorMessage).toBeUndefined()

    const failed = finishTrace(trace, "error", "boom")
    expect(failed.status).toBe("error")
    expect(failed.errorMessage).toBe("boom")
    expect(failed.finishedAt).toBeGreaterThanOrEqual(done.finishedAt!)
  })
})

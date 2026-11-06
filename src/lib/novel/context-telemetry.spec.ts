import { describe, expect, it, vi } from "vitest"

// reportRoutingROI 的非致命失败兜底：sink 是可注入的，两条失败路径（异步 reject /
// 同步 throw）都必须只 warn、不向上抛。computeIrrelevantRatio 与本用例无关，打桩
// 以免依赖 ContextPack 的具体形状。
const ratioStub = vi.hoisted(() => vi.fn(() => 0))
const warnStub = vi.hoisted(() => vi.fn())

vi.mock("./context-retrieval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./context-retrieval")>()
  return { ...actual, computeIrrelevantRatio: ratioStub }
})

vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>()
  return { ...actual, logger: { ...actual.logger, warn: warnStub } }
})

import { reportRoutingROI, type RoutingSampleInput } from "./context-telemetry"

const input: RoutingSampleInput = {
  pack: {} as never,
  activeEntities: [],
  chapterNumber: 3,
  conditionalRoutingEnabled: true,
}

describe("reportRoutingROI 的非致命失败兜底", () => {
  it("sink 返回 rejected Promise 时只 warn，不向外抛", async () => {
    warnStub.mockClear()
    const sink = vi.fn().mockRejectedValue(new Error("disk full"))
    expect(() => reportRoutingROI("proj-1", input, sink)).not.toThrow()
    // fire-and-forget：等 microtask 队列排空后 catch 回调才执行
    await vi.waitFor(() => expect(warnStub).toHaveBeenCalledTimes(1))
    expect(warnStub).toHaveBeenCalledWith(
      "ContextEngine",
      "routing ROI sample append failed (non-fatal)",
      expect.objectContaining({ error: "disk full" }),
    )
    expect(sink).toHaveBeenCalledWith("proj-1", expect.objectContaining({ chapterId: "3" }))
  })

  it("sink 同步抛错时被 try/catch 吞掉并 warn", () => {
    warnStub.mockClear()
    const sink = vi.fn(() => {
      throw new Error("sync boom")
    })
    expect(() => reportRoutingROI("proj-1", input, sink)).not.toThrow()
    expect(warnStub).toHaveBeenCalledWith(
      "ContextEngine",
      "routing ROI sample append failed (non-fatal)",
      expect.objectContaining({ error: "sync boom" }),
    )
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"

// 只替掉 dual-track 编排入口；其余数据源自带 .catch(() => [])，无需 mock。
const mocks = vi.hoisted(() => ({
  retrieveDualTrack: vi.fn(),
}))

vi.mock("./search-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./search-adapter")>()
  return { ...actual, retrieveDualTrack: mocks.retrieveDualTrack }
})

import { searchRelevantContentUnified } from "./context-retrieval"

const DUAL_ON = { dualKbRoutingEnabled: true } as never

describe("searchRelevantContentUnified 双轨分支（E-02 / C-3）", () => {
  beforeEach(() => {
    mocks.retrieveDualTrack.mockReset()
  })

  it("dualKbRoutingEnabled → 只消费 dual.ranked，片段进入上下文", async () => {
    mocks.retrieveDualTrack.mockResolvedValue({
      ranked: [
        { type: "wiki", path: "/p/book/wiki/entities/alice.md", title: "双轨结果", snippet: "双轨片段" },
      ],
    })

    const out = await searchRelevantContentUnified("/p/book", "任务目标", 3, 6, {
      novelConfig: DUAL_ON,
    })

    expect(mocks.retrieveDualTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/p/book",
        chapterNumber: 3,
        // topK = max(limit * 2, 6)
        topK: 12,
      }),
    )
    expect(out).toContain("双轨片段")
  })

  it("dual-track 抛错 → catch 成 null → 不返回其片段，且整体不失败", async () => {
    mocks.retrieveDualTrack.mockRejectedValue(new Error("dual boom"))

    const out = await searchRelevantContentUnified("/p/book", "任务目标", 3, 6, {
      novelConfig: DUAL_ON,
    })

    expect(mocks.retrieveDualTrack).toHaveBeenCalledTimes(1)
    expect(out).not.toContain("双轨片段")
    expect(typeof out).toBe("string")
  })
})

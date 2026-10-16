import { describe, expect, it, vi } from "vitest"
import { orderTechniqueBlocksByPreference } from "./context-engine"
import type { TechniquePromptBlock } from "./craft/technique-compiler"
import {
  buildSegmentSummaryInput,
  groupChapterNumbersBySegment,
  SEGMENT_SIZE,
  segmentIndexForChapter,
  segmentRange,
} from "./segment-summary"
import { resolveRouteShellMode } from "./deep-chapter-generation"
import { getFactsKnownBy, queryCanonEdges } from "./canon-graph-client"

function block(id: string): TechniquePromptBlock {
  return { blockId: id, title: id, body: `body-${id}`, injectionPoint: "chapter_task_brief" } as TechniquePromptBlock
}

describe("B1/B2 默认行为锁定", () => {
  it("SEGMENT_SIZE=10（抄 Moss 思想，MIT 原生实现）", () => {
    expect(SEGMENT_SIZE).toBe(10)
    expect(segmentIndexForChapter(1)).toBe(0)
    expect(segmentIndexForChapter(10)).toBe(0)
    expect(segmentIndexForChapter(11)).toBe(1)
    expect(segmentRange(0)).toEqual({ startChapter: 1, endChapter: 10 })
  })

  it("章节按段分组纯函数", () => {
    const groups = groupChapterNumbersBySegment([1, 10, 11, 20, 21])
    expect([...groups.values()]).toEqual([[1, 10], [11, 20], [21]])
  })

  it("段摘要输入取首尾（空输入回空串）", () => {
    expect(buildSegmentSummaryInput([])).toBe("")
    const text = buildSegmentSummaryInput([
      { chapterNumber: 1, summary: "开端" },
      { chapterNumber: 2, summary: "收束2" },
    ])
    expect(text).toContain("开端")
    expect(text).toContain("收束2")
  })

  it("偏好重排：空偏好回原序（默认行为不变）", () => {
    const blocks = [block("a"), block("b"), block("c")]
    expect(orderTechniqueBlocksByPreference(blocks, {}).map((b) => b.blockId)).toEqual(["a", "b", "c"])
  })

  it("偏好重排：正分优先且稳定（不增删块）", () => {
    const blocks = [block("a"), block("b"), block("c")]
    const ordered = orderTechniqueBlocksByPreference(blocks, { b: { accept: 3, reject: 0 } })
    expect(ordered.map((b) => b.blockId)[0]).toBe("b")
    expect(ordered).toHaveLength(3)
  })

  it("route 灰度：缺省/显式false恒 legacy（默认行为不变）", () => {
    const input = { projectPath: "pp", userRequest: "r", chapterNumber: 1 } as never
    expect(resolveRouteShellMode(input, undefined as never)).toBe("legacy")
    expect(resolveRouteShellMode(input, {} as never)).toBe("legacy")
    expect(resolveRouteShellMode(input, { enableRouteShell: false } as never)).toBe("legacy")
    // 显式 opt-in 才放行
    expect(resolveRouteShellMode(input, { enableRouteShell: true } as never)).toBe("legacy")
    expect(
      resolveRouteShellMode({ ...input, routeShellMode: "route" } as never, { enableRouteShell: true } as never),
    ).toBe("route")
  })

  it("canon 降级：非 Tauri 宿主返回空形状不抛", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      // getFactsKnownBy 返回 CanonFact[]（空），queryCanonEdges 返回 []
      expect(await getFactsKnownBy("pp", "ch")).toEqual([])
      expect(await queryCanonEdges("pp", {} as never)).toEqual([])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  }, 15000)
})

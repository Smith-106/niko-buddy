import { describe, expect, it } from "vitest"
import {
  KEYWORD_SCORE_RATIO,
  MAX_SCORE_MULTIPLIER,
  NEGATED_OPENING_RE,
  buildTaskDirective,
  hasChapterNumber,
  hasNegatedOpening,
  hasTruthyText,
  routeTask,
} from "@/lib/novel/task-router"

/**
 * ISS-20260709-006/007/008：task-router 三项收敛（1.6 倍率/否定守卫/真值守卫）。
 */
describe("ISS-20260709-006/007/008 task-router convergence", () => {
  it("006：倍率常量单一真源（0.6 / 1.6=1+0.6）", () => {
    expect(KEYWORD_SCORE_RATIO).toBe(0.6)
    expect(MAX_SCORE_MULTIPLIER).toBe(1.6)
    expect(MAX_SCORE_MULTIPLIER).toBe(1 + KEYWORD_SCORE_RATIO)
  })

  it("007：否定守卫收敛且行为等价", () => {
    expect(NEGATED_OPENING_RE.test("不要写第一章")).toBe(true)
    expect(hasNegatedOpening("不要写第一章")).toBe(true)
    expect(hasNegatedOpening("请写第一章")).toBe(false)
    // CORR-005 约束（best-effort）：否定守卫仅阻断开篇短路（isOpening），
    // 通用关键词评分仍可能命中 write_chapter（主链再定最终章，行为与收敛前一致）。
    // 此处锁定守卫本身，不锁定整句意图。
    expect(routeTask("请写第一章").intent).toBe("write_chapter")
  })

  it("008：真值守卫收敛（空/空白即无指令）", () => {
    expect(hasTruthyText("  ")).toBe(false)
    expect(hasTruthyText("")).toBe(false)
    expect(hasTruthyText("写第一章")).toBe(true)
    expect(hasChapterNumber(undefined)).toBe(false)
    expect(hasChapterNumber(2)).toBe(true)
    expect(routeTask("   ").intent).toBe("general_chat")
    expect(buildTaskDirective({ intent: "general_chat", confidence: 1, extractedParams: {} } as never)).toBe("")
  })

  it("路由行为等价：续写/开篇/章节号提取不变", () => {
    expect(routeTask("续写下一章").intent).toBe("continue_chapter")
    const r = routeTask("请写第5章")
    expect(r.chapterNumber).toBe(5)
    expect(r.extractedParams.chapterNumber).toBe("5")
  })
});

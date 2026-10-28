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

/**
 * ISS-20260709-007 升级：否定守卫从「仅阻断开篇短路」扩到「逐处过滤评分与章节号提取」。
 */
describe("ISS-20260709-007 否定守卫全量生效", () => {
  it("isNegatedBefore 以标点/换行为小句边界", async () => {
    const { isNegatedBefore } = await import("@/lib/novel/task-router")
    const text = "不要写第1章，写第5章"
    expect(isNegatedBefore(text, text.indexOf("第1章"))).toBe(true)
    expect(isNegatedBefore(text, text.indexOf("第5章"))).toBe(false)
  })

  it("hasUnnegatedPatternMatch / hasUnnegatedKeyword 逐处判定", async () => {
    const { hasUnnegatedPatternMatch, hasUnnegatedKeyword } = await import("@/lib/novel/task-router")
    expect(hasUnnegatedPatternMatch("不要写第1章，写第5章", /第\s*\d+\s*章/)).toBe(true)
    expect(hasUnnegatedPatternMatch("不要写第1章", /第\s*\d+\s*章/)).toBe(false)
    expect(hasUnnegatedKeyword("不要润色", "润色")).toBe(false)
    expect(hasUnnegatedKeyword("别润色，改重写", "重写")).toBe(true)
    expect(hasUnnegatedKeyword("任意", "")).toBe(false)
  })

  it("被否定的意图不再误路由（润色/写章）", () => {
    expect(routeTask("不要润色这段").intent).toBe("general_chat")
    expect(routeTask("避免生成第一章").intent).toBe("general_chat")
    // 未被否定的仍正常路由（不回归）。
    expect(routeTask("润色这段").intent).toBe("polish_chapter")
    expect(routeTask("写第5章").intent).toBe("write_chapter")
  })

  it("否定守卫不误伤引用型提及", () => {
    expect(routeTask("继续写，不要重复第一章的内容").intent).toBe("continue_chapter")
    expect(routeTask("继续生成下一章正文，不要重复第一章的内容。").intent).toBe("continue_chapter")
  })
})

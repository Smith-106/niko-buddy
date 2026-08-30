import { describe, it, expect } from "vitest"
import {
  buildSessionContextSummary,
  selectContextHistoryMessages,
  isSessionSummaryFresh,
  isLegacySessionContextSummary,
} from "./session-summary"

const msgs = (): Array<{ role: string; content: string }> => [
  { role: "user", content: "写一个古代仙侠大纲，主角是孤儿。" },
  { role: "assistant", content: "好的，我建议分四卷：入门卷/成长卷/宗门卷/决战卷。" },
  { role: "user", content: "第一卷请突出修炼体系。主角从凡人开始。" },
  { role: "assistant", content: "收到。修炼体系按炼气→筑基→金丹递进。" },
]

describe("session-summary（context-hub 子件，qmai 移植）", () => {
  it("buildSessionContextSummary 生成头尾摘要", () => {
    const s = buildSessionContextSummary({
      messages: msgs(),
      dependencyFingerprint: "fp-1",
      maxChars: 300,
    })
    expect(s.text).toContain("用户")
    expect(s.text).toContain("助手")
    expect(s.dependencyFingerprint).toBe("fp-1")
    expect(typeof s.updatedAt).toBe("number")
  })

  it("selectContextHistoryMessages：有摘要时只取近 2 条，无摘要全量", () => {
    const m = msgs()
    expect(selectContextHistoryMessages(m, "有摘要")).toHaveLength(2)
    expect(selectContextHistoryMessages(m, undefined)).toHaveLength(4)
  })

  it("isSessionSummaryFresh 按 fingerprint 判定新鲜度", () => {
    const s = buildSessionContextSummary({ messages: msgs(), dependencyFingerprint: "fp-1" })
    expect(isSessionSummaryFresh(s, "fp-1")).toBe(true)
    expect(isSessionSummaryFresh(s, "fp-2")).toBe(false)
    expect(isSessionSummaryFresh(undefined, "fp-1")).toBe(false)
  })

  it("isLegacySessionContextSummary 识别旧格式", () => {
    expect(isLegacySessionContextSummary("旧字符串摘要")).toBe(true)
    expect(isLegacySessionContextSummary({ text: "x", updatedAt: 1, dependencyFingerprint: "fp" })).toBe(false)
    expect(isLegacySessionContextSummary({ text: "x", updatedAt: 1 })).toBe(false)
    expect(isLegacySessionContextSummary(null)).toBe(false)
  })
})

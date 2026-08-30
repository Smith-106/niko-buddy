import { describe, expect, it } from "vitest"
import { evaluateUserMemoryCandidate } from "./prefilter"

describe("user memory local prefilter", () => {
  it.each(["继续", "确认", "重新生成", "可以，就这样"])("跳过短操作消息：%s", (message) => {
    expect(evaluateUserMemoryCandidate(message).shouldAnalyze).toBe(false)
  })

  it("跳过只有本次章节范围的一次性任务", () => {
    expect(evaluateUserMemoryCandidate("根据第1、3、5章生成后面四章").shouldAnalyze).toBe(false)
  })

  it.each([
    "以后回答时请先给结论，再说明依据。",
    "我习惯大纲使用分层标题，请一直保持。",
    "写作时不要使用空泛总结，这是长期要求。",
  ])("识别明确的长期偏好：%s", (message) => {
    expect(evaluateUserMemoryCandidate(message)).toMatchObject({ shouldAnalyze: true, reason: "explicit_preference" })
  })

  it("普通一次性修改没有稳定偏好信号时跳过", () => {
    expect(evaluateUserMemoryCandidate("把当前第二段改得更长一些").shouldAnalyze).toBe(false)
  })
})

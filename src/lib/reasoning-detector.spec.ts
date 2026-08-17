import { describe, expect, it } from "vitest"
import { countReasoningCharsInLine, extractReasoningTextFromLine } from "./reasoning-detector"

describe("reasoning detector", () => {
  it("extracts OpenAI Responses reasoning summary deltas", () => {
    const line = 'data: {"type":"response.reasoning_summary_text.delta","delta":"正在分析章节上下文"}'

    expect(extractReasoningTextFromLine(line)).toEqual(["正在分析章节上下文"])
    expect(countReasoningCharsInLine(line)).toBe("正在分析章节上下文".length)
  })

  it("extracts OpenAI Responses reasoning text deltas", () => {
    const line = 'data: {"type":"response.reasoning_text.delta","delta":"先确认用户意图"}'

    expect(extractReasoningTextFromLine(line)).toEqual(["先确认用户意图"])
    expect(countReasoningCharsInLine(line)).toBe("先确认用户意图".length)
  })

  it("extracts DeepSeek/Kimi reasoning_content and reasoning fields from choices", () => {
    const line = 'data: {"choices":[{"delta":{"reasoning_content":"思考中","reasoning":"再想想"}}]}'
    expect(extractReasoningTextFromLine(line)).toEqual(["思考中", "再想想"])
  })

  it("extracts OpenAI-style thinking_delta objects", () => {
    const line = 'data: {"delta":{"type":"thinking_delta","thinking":"推理内容","text":"补充文本"}}'
    expect(extractReasoningTextFromLine(line)).toEqual(["推理内容", "补充文本"])
  })

  it("skips non-string thinking_delta fields", () => {
    // thinking is a number and text is null — both typeof guards fail, so
    // neither string branch pushes anything.
    const line = 'data: {"delta":{"type":"thinking_delta","thinking":42,"text":null}}'
    expect(extractReasoningTextFromLine(line)).toEqual([])
  })

  it("tolerates candidates without content or parts", () => {
    // candidate.content?.parts is undefined → the `?? []` fallback runs and
    // the loop body is never entered.
    const line = 'data: {"candidates":[{"text":"not a part"},{"content":null}]}'
    expect(extractReasoningTextFromLine(line)).toEqual([])
  })

  it("extracts Google-style candidate parts flagged as thoughts", () => {
    const line = 'data: {"candidates":[{"content":{"parts":[{"text":"thought text","thought":true},{"text":"answer text"},{"thought":true}]}}]}'
    expect(extractReasoningTextFromLine(line)).toEqual(["thought text"])
  })

  it("returns [] for non-data lines, empty payloads, and DONE markers", () => {
    expect(extractReasoningTextFromLine("event: message")).toEqual([])
    expect(extractReasoningTextFromLine("data: ")).toEqual([])
    expect(extractReasoningTextFromLine("data: [DONE]")).toEqual([])
    expect(extractReasoningTextFromLine("   data:   ")).toEqual([])
  })

  it("returns [] for invalid JSON payloads", () => {
    expect(extractReasoningTextFromLine("data: {not json")).toEqual([])
  })

  it("ignores non-string reasoning fields", () => {
    const line = 'data: {"choices":[{"delta":{"reasoning_content":42,"reasoning":null}}]}'
    expect(extractReasoningTextFromLine(line)).toEqual([])
  })

  it("counts reasoning characters via the raw regex when extraction finds nothing", () => {
    // No data: prefix, so extraction returns [] and the regex path runs.
    const line = '{"reasoning":"abc","reasoning_content":"def","unrelated":"xyz"}'
    expect(countReasoningCharsInLine(line)).toBe(6)
  })

  it("counts escaped characters in the JSON-escaped form", () => {
    const line = '{"reasoning":"a\\nb","other":"ignored"}'
    // match[1] is "a\\nb" → 4 chars in escaped form
    expect(countReasoningCharsInLine(line)).toBe(4)
  })

  it("returns 0 when no reasoning fields exist", () => {
    expect(countReasoningCharsInLine("data: {\"choices\":[]}")).toBe(0)
  })
})

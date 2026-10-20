/** C4 冒烟覆盖：src/lib/antigravity-cli-transport.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { parseAntigravityCliLine, extractAntigravityCliError, buildPrompt, streamAntigravityCli } from "./antigravity-cli-transport"
describe("antigravity-cli-transport.ts smoke", () => {
  it("exports parseAntigravityCliLine", () => {
    expect(parseAntigravityCliLine).toBeDefined()
  })
  it("exports extractAntigravityCliError", () => {
    expect(extractAntigravityCliError).toBeDefined()
  })
  it("exports buildPrompt", () => {
    expect(buildPrompt).toBeDefined()
  })
  it("exports streamAntigravityCli", () => {
    expect(streamAntigravityCli).toBeDefined()
  })
})

describe("parseAntigravityCliLine — 事件形态（四-14 zod 窄化行为锁）", () => {
  it("codex 风 item.completed/agent_message", () => {
    expect(parseAntigravityCliLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "你好" } }))).toBe("你好")
  })
  it("直出 text/content/delta", () => {
    expect(parseAntigravityCliLine(JSON.stringify({ type: "message", content: "正文" }))).toBe("正文")
    expect(parseAntigravityCliLine(JSON.stringify({ delta: "增量" }))).toBe("增量")
  })
  it("parts 数组拼接", () => {
    expect(parseAntigravityCliLine(JSON.stringify({ parts: [{ text: "a" }, { text: "b" }] }))).toBe("ab")
  })
  it("Gemini candidates", () => {
    expect(parseAntigravityCliLine(JSON.stringify({ candidates: [{ content: { parts: [{ text: "c" }] } }] }))).toBe("c")
  })
  it("垃圾行/非对象 → null（上游加层不崩）", () => {
    expect(parseAntigravityCliLine("")).toBeNull()
    expect(parseAntigravityCliLine("not json")).toBeNull()
    expect(parseAntigravityCliLine("[1,2]")).toBeNull()
    expect(parseAntigravityCliLine(JSON.stringify({ type: "unknown.event", foo: 1 }))).toBeNull()
  })
})

describe("extractAntigravityCliError — 回退语义锁", () => {
  it("turn.failed 优先返回，error 累积 lastError", () => {
    const out = [
      JSON.stringify({ type: "error", message: "first" }),
      JSON.stringify({ type: "turn.failed", error: { message: "fatal" } }),
    ].join("\n")
    expect(extractAntigravityCliError(out)).toBe("fatal")
  })
  it("无结构化错误 → 回退原文", () => {
    expect(extractAntigravityCliError("plain boom")).toBe("plain boom")
  })
})

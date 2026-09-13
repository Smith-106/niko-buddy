import { describe, expect, it } from "vitest"
import { appendTaskExtraSection } from "./deep-chapter-prompts"

describe("appendTaskExtraSection（任务自定义追加段等价性）", () => {
  it("undefined/empty/whitespace extra → prompt returned byte-identical (等价直通)", () => {
    const base = "PROMPT-BODY"
    expect(appendTaskExtraSection(base)).toBe(base)
    expect(appendTaskExtraSection(base, undefined)).toBe(base)
    expect(appendTaskExtraSection(base, "")).toBe(base)
    expect(appendTaskExtraSection(base, "   \n\t")).toBe(base)
  })

  it("non-empty extra appends 【任务自定义要求】 section at the tail", () => {
    const out = appendTaskExtraSection("PROMPT-BODY", "多使用短句节奏")
    expect(out.startsWith("PROMPT-BODY")).toBe(true)
    expect(out).toContain("【任务自定义要求】")
    expect(out).toContain("多使用短句节奏")
    expect(out.indexOf("PROMPT-BODY")).toBeLessThan(out.indexOf("多使用短句节奏"))
  })

  it("trims the extra content", () => {
    const out = appendTaskExtraSection("BASE", "  内容  ")
    expect(out).toContain("内容")
    expect(out).not.toContain("  内容  ")
  })
})

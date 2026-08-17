import { describe, expect, it } from "vitest"
import { OUTPUT_LANGUAGE_OPTIONS } from "./output-language-options"

describe("OUTPUT_LANGUAGE_OPTIONS", () => {
  it("exports the auto-detect option first", () => {
    expect(OUTPUT_LANGUAGE_OPTIONS[0]).toEqual({
      value: "auto",
      label: "Auto (detect from input/source)",
    })
  })

  it("exports a non-empty, ordered list of concrete languages", () => {
    expect(OUTPUT_LANGUAGE_OPTIONS.length).toBeGreaterThan(10)
    const values = OUTPUT_LANGUAGE_OPTIONS.map((o) => o.value)
    expect(values).toContain("English")
    expect(values).toContain("Chinese")
    expect(values).toContain("Japanese")
    expect(values).toContain("Korean")
    expect(values).toContain("Arabic")
  })

  it("keeps every entry with a non-empty label", () => {
    for (const option of OUTPUT_LANGUAGE_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0)
    }
  })

  it("does not duplicate option values", () => {
    const values = OUTPUT_LANGUAGE_OPTIONS.map((o) => o.value)
    expect(new Set(values).size).toBe(values.length)
  })
})

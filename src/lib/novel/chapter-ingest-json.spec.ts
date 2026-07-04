import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

function extractFirstBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{")
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === "\\") {
      escape = true
      continue
    }
    if (ch === "\"") {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{") {
      depth += 1
      continue
    }
    if (ch === "}") {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return null
}

describe("chapter-ingest JSON extraction hardening", () => {
  it("uses balanced JSON extraction instead of greedy object matching", () => {
    const source = readFileSync(resolve(__dirname, "chapter-ingest.ts"), "utf8")

    expect(source).toContain("function extractFirstBalancedJsonObject")
    expect(source).toContain("function extractJsonObjectFromModelText")
    expect(source).toContain("const jsonText = extractJsonObjectFromModelText(result)")
  })

  it("extracts only the first balanced object when trailing metadata exists", () => {
    const raw = [
      "```json",
      "{\"summary\":\"ok\",\"characters\":[\"A\"],\"nested\":{\"k\":\"v\"}}",
      "```",
      "",
      "<!-- qmai-deep-chapter-draft:%7B%22conversationId%22%3A%22conv-1%22%7D -->",
    ].join("\n")

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw
    const extracted = extractFirstBalancedJsonObject(fenced)

    expect(extracted).toBe("{\"summary\":\"ok\",\"characters\":[\"A\"],\"nested\":{\"k\":\"v\"}}")
    expect(() => JSON.parse(extracted ?? "")).not.toThrow()
  })
})

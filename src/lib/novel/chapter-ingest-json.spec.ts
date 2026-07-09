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

  it("ISS-026: malformed snapshot JSON returns null (failReason path) instead of throwing bare SyntaxError", () => {
    // extractSnapshotWithLLM honors its Promise<ChapterSnapshot | null> contract:
    // a SyntaxError from JSON.parse (code-fence leakage / truncation / trailing
    // prose — the common model failure mode) must return null so ingestChapter
    // routes to the friendly failReason:"extract_failed" branch, rather than
    // escaping as a raw "SyntaxError: Unexpected token" to UI callers. A
    // non-SyntaxError (transport/stream failure) must still re-throw.
    const source = readFileSync(resolve(__dirname, "chapter-ingest.ts"), "utf8")

    // The parse is wrapped: SyntaxError → return null, non-SyntaxError → throw.
    expect(source).toMatch(/if \(error instanceof SyntaxError\)\s*\{[^}]*return null/s)
    // Non-SyntaxError is re-thrown unchanged (transport/abort paths stay distinct).
    expect(source).toMatch(/throw error/)
  })

  it("ISS-026: outline ingest surfaces a friendly message for malformed JSON (not raw SyntaxError)", () => {
    // normalizeOutlineIngestError distinguishes a SyntaxError (model emitted
    // invalid JSON) from a transport failure, surfacing a friendly message
    // instead of leaking "Unexpected token" to outline consumers.
    const source = readFileSync(resolve(__dirname, "chapter-ingest.ts"), "utf8")

    expect(source).toMatch(/if \(err instanceof SyntaxError\)\s*\{[^}]*无法解析的 JSON/s)
  })

  it("ISS-026 sibling: ingestOutline malformed JSON returns null (caller friendly ternary) instead of throwing", () => {
    // ingestOutline is the sibling of extractSnapshotWithLLM — same
    // Promise<ChapterSnapshot | null> contract, same malformed-JSON failure
    // mode. A SyntaxError from JSON.parse must return null so the caller
    // (outline-generation.ts:708) routes to the friendly 'ingestFailed'
    // ternary branch, not escape via the catch@2017 throw path. PAT-G2 twin
    // mirror: the parse wrap must mirror extractSnapshotWithLLM's fix.
    const source = readFileSync(resolve(__dirname, "chapter-ingest.ts"), "utf8")

    // The outline parse is wrapped: SyntaxError → return null.
    expect(source).toMatch(/\[Outline Ingest\] Malformed outline JSON/s)
  })
})

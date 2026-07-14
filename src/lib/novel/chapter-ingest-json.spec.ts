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
    // ISS-20260709-019: the block now contains a logger.error call whose
    // context object has its own `}`, so [^}]* no longer spans to return null.
    // Match the block boundary by structure (SyntaxError → ... → return null).
    expect(source).toMatch(/if \(error instanceof SyntaxError\)\s*\{[\s\S]*?return null/s)
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
    // ISS-20260709-019: logger.error splits scope + message into separate
    // args, so assert both substrings are present (no longer a single
    // "[Outline Ingest] Malformed outline JSON" string).
    expect(source).toMatch(/"Outline Ingest", "Malformed outline JSON"/s)
  })

  it("ISS-20260712-001: extractSnapshotWithLLM no-JSON-text path returns null (not throw), honoring Promise<ChapterSnapshot | null> contract", () => {
    // PAT-G2 twin recurrence #10 (sibling of ISS-026 @841): when the LLM
    // returns NO parseable JSON object at all (empty / prose-only / truncated
    // before any `{...}`), extractJsonObjectFromModelText returns null. The
    // prior `throw new Error("章节快照提取失败：模型没有返回可解析的 JSON")`
    // violated the Promise<ChapterSnapshot | null> contract and bypassed
    // ingestChapter @400 → :403 friendly `failReason: "extract_failed"`
    // degrade. Return null here mirrors the JSON.parse SyntaxError path @845
    // and lets the caller route to the friendly UX. Spec S-20260711-6ed4.
    const source = readFileSync(resolve(__dirname, "chapter-ingest.ts"), "utf8")

    // The old throw on the no-JSON-text path must be gone for extractSnapshotWithLLM.
    expect(source).not.toContain("章节快照提取失败：模型没有返回可解析的 JSON")
    // Replaced by a logger.error + return null degrade (ISS-20260709-019:
    // scope + message are separate logger args).
    expect(source).toMatch(/"Chapter Ingest", "extractSnapshotWithLLM: model returned no parseable JSON object"/s)
  })

  it("ISS-20260712-002: ingestOutline no-JSON-text path returns null (not throw), aligning with ISS-026 comment @2002-2009", () => {
    // PAT-G2 twin recurrence #10 (sibling of ISS-026 PAT-ID1 @2012): same
    // form in ingestOutline. The prior throw contradicted the ISS-026 comment
    // @2002-2009 which explicitly claims "Return null here honors the
    // Promise<ChapterSnapshot | null> contract and lets the caller route to
    // the friendly ingestFailedNotification" — the throw blocked exactly that
    // route, sending outline-generation.ts:703 → :707-719 into the catch
    // branch with raw error.message instead of the i18n ingestFailedNotification.
    // Spec S-20260711-6ed4.
    const source = readFileSync(resolve(__dirname, "chapter-ingest.ts"), "utf8")

    // The old throw on the no-JSON-text path must be gone for ingestOutline.
    expect(source).not.toContain("大纲摄取失败：模型没有返回可解析的 JSON")
    // Replaced by a logger.error + return null degrade (ISS-20260709-019).
    expect(source).toMatch(/"Outline Ingest", "ingestOutline: model returned no parseable JSON object"/s)
  })

  it("ISS-20260712-003: ingestOutline normalizeChapterSnapshot-null path returns null (not throw), third adjacent sibling", () => {
    // PAT-G2 twin recurrence #10 (third adjacent sibling of ISS-026 PAT-ID1
    // @2012 + ISS-20260712-002 @2008): normalizeChapterSnapshot returns null
    // when the LLM emitted valid JSON but the top-level value is not an object
    // (array / string / number — see normalizeChapterSnapshot @241). The prior
    // `throw new Error("Outline snapshot payload is invalid.")` contradicted
    // the ISS-026 comment @2030-2031 claiming "lets the caller route to the
    // friendly ingestFailedNotification" — same contradiction as ISS-20260712-002.
    // Return null here aligns the third null path (normalize null) with the two
    // already-fixed ones (no-JSON + SyntaxError) and mirrors
    // extractSnapshotWithLLM @859 which correctly propagates normalize null.
    // Spec S-20260711-6ed4.
    const source = readFileSync(resolve(__dirname, "chapter-ingest.ts"), "utf8")

    // The old throw on the normalize-null path must be gone — assert the
    // throw statement form is absent (not just the string, since the test
    // comment itself references the old message).
    expect(source).not.toMatch(/throw new Error\("Outline snapshot payload is invalid\."\)/)
    // Replaced by a logger.error + return null degrade (ISS-20260709-019).
    expect(source).toMatch(/"Outline Ingest", "normalizeChapterSnapshot returned null: parsed payload is not a valid snapshot object"/s)
  })
})

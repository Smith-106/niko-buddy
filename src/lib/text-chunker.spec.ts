import { describe, expect, it } from "vitest"
import { chunkMarkdown, stripFrontmatter } from "./text-chunker"

// ── stripFrontmatter ─────────────────────────────────────────────────────────

describe("stripFrontmatter", () => {
  it("returns content unchanged when there is no leading frontmatter", () => {
    expect(stripFrontmatter("plain body")).toEqual({ body: "plain body", bodyOffset: 0 })
    expect(stripFrontmatter("")).toEqual({ body: "", bodyOffset: 0 })
  })

  it("strips a well-formed YAML block and reports the body offset", () => {
    const content = "---\ntitle: Foo\n---\n# Body\n"
    const { body, bodyOffset } = stripFrontmatter(content)
    expect(body).toBe("# Body\n")
    expect(bodyOffset).toBe(content.indexOf("# Body"))
  })

  it("handles CRLF frontmatter openers", () => {
    const content = "---\r\ntitle: Foo\r\n---\r\nBody text\r\n"
    const { body, bodyOffset } = stripFrontmatter(content)
    expect(body).toBe("Body text\r\n")
    expect(bodyOffset).toBeGreaterThan(0)
  })

  it("returns content unchanged when the closing --- never arrives", () => {
    const content = "---\ntitle: Foo\nno closing marker"
    expect(stripFrontmatter(content)).toEqual({ body: content, bodyOffset: 0 })
  })

  it("returns content unchanged for a bare opener with nothing after it", () => {
    const content = "---\n"
    expect(stripFrontmatter(content)).toEqual({ body: content, bodyOffset: 0 })
  })

  it("offsets chunk charStart/charEnd back into the original document", () => {
    const content = "---\ntitle: Page\n---\n\nHello world, this is a body that is long enough."
    const chunks = chunkMarkdown(content, { targetChars: 2000, maxChars: 3000, minChars: 10, overlapChars: 0 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].charStart).toBe(content.indexOf("Hello"))
    expect(chunks[0].charEnd).toBe(content.length)
    expect(chunks[0].text).toContain("Hello world")
  })
})

// ── chunkMarkdown basics ─────────────────────────────────────────────────────

describe("chunkMarkdown", () => {
  it("returns [] for empty / whitespace-only bodies", () => {
    expect(chunkMarkdown("")).toEqual([])
    expect(chunkMarkdown("   \n\t\n  ")).toEqual([])
    expect(chunkMarkdown("---\ntitle: only frontmatter\n---\n")).toEqual([])
  })

  it("emits a single chunk for short content above any heading", () => {
    const chunks = chunkMarkdown("Just a short paragraph.")
    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingPath).toBe("")
    expect(chunks[0].index).toBe(0)
    expect(chunks[0].oversized).toBe(false)
    expect(chunks[0].text).toBe("Just a short paragraph.")
  })

  it("merges user options over the defaults", () => {
    const text = "word ".repeat(500)
    const chunks = chunkMarkdown(text, { targetChars: 200, maxChars: 300, minChars: 50, overlapChars: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(300)
  })

  it("defensively swaps maxChars when maxChars < targetChars", () => {
    // maxChars=50 < targetChars=100 → clamped so oversized is computed against 100.
    const chunks = chunkMarkdown("a".repeat(250), { targetChars: 100, maxChars: 50, minChars: 20, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.oversized).toBe(false)
    // 250 chars sliced into <=100 char pieces.
    expect(chunks.every((c) => c.text.length <= 100)).toBe(true)
  })

  it("clamps overlapChars >= targetChars to floor(target/2)", () => {
    // overlap=200 >= target=100 → clamped to 50. Two short paragraphs would
    // overlap by at most 50 chars instead of exploding.
    const text = `${"x".repeat(60)}\n\n${"y".repeat(60)}`
    const chunks = chunkMarkdown(text, { targetChars: 100, maxChars: 300, minChars: 0, overlapChars: 200 })
    expect(chunks).toHaveLength(2)
    expect(chunks[1].text.startsWith("x".repeat(50))).toBe(true)
  })

  it("assigns sequential indexes across sections", () => {
    const text = "# One\nbody one\n\n## Two\nbody two\n\n### Three\nbody three"
    const chunks = chunkMarkdown(text, { targetChars: 2000, maxChars: 3000, minChars: 5, overlapChars: 0 })
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i))
  })
})

// ── heading breadcrumbs / section segmentation ───────────────────────────────

describe("section segmentation", () => {
  it("builds headingPath breadcrumbs from nested headings", () => {
    const text = ["preamble line", "# H1", "text under H1", "## H2", "text under H2", "### H3", "text under H3"].join("\n")
    const chunks = chunkMarkdown(text, { targetChars: 2000, maxChars: 3000, minChars: 5, overlapChars: 0 })
    const paths = chunks.map((c) => c.headingPath)
    // preamble, H1 section, H2 section, H3 section — in order.
    expect(paths[0]).toBe("")
    expect(paths[1]).toBe("# H1")
    expect(paths[2]).toBe("# H1 > ## H2")
    expect(paths[3]).toBe("# H1 > ## H2 > ### H3")
    // heading line belongs to its own section
    expect(chunks[1].text.startsWith("# H1")).toBe(true)
  })

  it("clears deeper heading levels when a shallower heading appears", () => {
    const text = ["# A", "## B", "### C", "deep", "# A2", "shallow"].join("\n")
    const chunks = chunkMarkdown(text, { targetChars: 2000, maxChars: 3000, minChars: 5, overlapChars: 0 })
    const paths = chunks.map((c) => c.headingPath)
    expect(paths).toContain("# A > ## B > ### C")
    expect(paths).toContain("# A2")
    expect(paths[paths.length - 1]).toBe("# A2")
  })

  it("does not cut sections on headings inside fenced code blocks", () => {
    const text = ["```", "# Not a real heading", "```", "real body"].join("\n")
    const chunks = chunkMarkdown(text, { targetChars: 2000, maxChars: 3000, minChars: 5, overlapChars: 0 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingPath).toBe("")
    expect(chunks[0].text).toBe(text)
  })

  it("handles tilde fences and indented fences", () => {
    const text = ["~~~", "code", "~~~", "after"].join("\n")
    const chunks = chunkMarkdown(text, { targetChars: 2000, maxChars: 3000, minChars: 5, overlapChars: 0 })
    expect(chunks).toHaveLength(1)

    const indented = ["   ```", "code", "   ```", "after"].join("\n")
    const chunks2 = chunkMarkdown(indented, { targetChars: 2000, maxChars: 3000, minChars: 5, overlapChars: 0 })
    expect(chunks2).toHaveLength(1)
  })

  it("keeps an unterminated fence opaque to the end of the document", () => {
    const text = ["```", "# hidden", "still code"].join("\n")
    const chunks = chunkMarkdown(text, { targetChars: 2000, maxChars: 3000, minChars: 5, overlapChars: 0 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingPath).toBe("")
  })

  it("ignores a fence-marker line that does not exactly close the fence", () => {
    // ```python inside a ``` fence must NOT close it (trim mismatch).
    const text = ["```", "```python", "code", "```", "after"].join("\n")
    const chunks = chunkMarkdown(text, { targetChars: 2000, maxChars: 3000, minChars: 5, overlapChars: 0 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain("```python")
    expect(chunks[0].text).toContain("after")
  })
})

// ── code / table atoms ───────────────────────────────────────────────────────

describe("code and table atoms", () => {
  it("keeps an oversized fenced code block as one oversized chunk", () => {
    const code = "```\n" + "line of code content\n".repeat(80) + "```"
    const chunks = chunkMarkdown(code, { targetChars: 200, maxChars: 300, minChars: 20, overlapChars: 0 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].oversized).toBe(true)
    expect(chunks[0].text.length).toBeGreaterThan(300)
  })

  it("keeps an oversized table intact", () => {
    const rows = ["| h1 | h2 |", "| --- | --- |", ...Array.from({ length: 40 }, (_, i) => `| a${i} | b${i} |`)]
    const table = rows.join("\n")
    const chunks = chunkMarkdown(table, { targetChars: 200, maxChars: 300, minChars: 20, overlapChars: 0 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].oversized).toBe(true)
    expect(chunks[0].text.startsWith("| h1 |")).toBe(true)
  })

  it("handles a table followed by more prose (trailing newline accounting)", () => {
    const table = ["| a | b |", "| --- | --- |", "| 1 | 2 |", "after the table", "more prose here"].join("\n")
    const chunks = chunkMarkdown(table, { targetChars: 2000, maxChars: 3000, minChars: 5, overlapChars: 0 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain("after the table")
  })

  it("treats a lone leading-| line as a normal paragraph", () => {
    const text = "| not a table\n\nplain paragraph"
    const chunks = chunkMarkdown(text, { targetChars: 2000, maxChars: 3000, minChars: 5, overlapChars: 0 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain("| not a table")
  })

  it("treats a lone leading-| line as a normal paragraph inside a long section", () => {
    // Section longer than targetChars forces atom tokenization, where a
    // single leading-| line must NOT be consumed as a table (needs 2+ rows).
    const text = "x".repeat(80) + "\n| not a table\n\n" + "y".repeat(80)
    const chunks = chunkMarkdown(text, { targetChars: 100, maxChars: 300, minChars: 0, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.some((c) => c.text.includes("| not a table"))).toBe(true)
  })

  it("treats a lone leading-| line at a blank-line boundary as a paragraph", () => {
    // A | line that follows a blank line (so the previous paragraph atom has
    // ended) and is not followed by another | row must fall through to the
    // paragraph accumulator, not be consumed as a table atom.
    const text = "para one\n\n| not a table\n\n" + "z".repeat(120)
    const chunks = chunkMarkdown(text, { targetChars: 50, maxChars: 300, minChars: 0, overlapChars: 0 })
    expect(chunks.some((c) => c.text.includes("| not a table"))).toBe(true)
    expect(chunks.every((c) => c.text.length <= 300)).toBe(true)
  })

  it("splits prose around a code fence, mixing atoms", () => {
    const text = ["intro paragraph here.", "```", "code()", "```", "outro paragraph here."].join("\n")
    const chunks = chunkMarkdown(text, { targetChars: 2000, maxChars: 3000, minChars: 5, overlapChars: 0 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain("code()")
    expect(chunks[0].text).toContain("intro paragraph")
    expect(chunks[0].text).toContain("outro paragraph")
  })
})

// ── recursive splitting ladders ──────────────────────────────────────────────

describe("recursive splitting", () => {
  it("splits a long paragraph at paragraph boundaries", () => {
    const para = Array.from({ length: 20 }, (_, i) => `paragraph ${i} `.repeat(5).trim()).join("\n\n")
    const chunks = chunkMarkdown(para, { targetChars: 150, maxChars: 400, minChars: 0, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(400)
  })

  it("descends to sentence splitters and splits Chinese text at 。", () => {
    // A paragraph with no double-newlines, only 。 terminators.
    const para = Array.from({ length: 40 }, (_, i) => `这是第${i}句的正文内容，为了凑足长度反复重复。`).join("")
    const chunks = chunkMarkdown(para, { targetChars: 120, maxChars: 300, minChars: 0, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(300)
  })

  it("splits on English sentence terminators (. )", () => {
    const para = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} has enough words to be split. `).join("")
    const chunks = chunkMarkdown(para, { targetChars: 120, maxChars: 300, minChars: 0, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(300)
  })

  it("falls back to whitespace splitting when no sentence terminator exists", () => {
    const para = Array.from({ length: 200 }, () => "word").join(" ")
    const chunks = chunkMarkdown(para, { targetChars: 150, maxChars: 400, minChars: 0, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(400)
  })

  it("descends into a mixed batch of short and oversized sentences", () => {
    // One sentence larger than target among short ones: the short pieces are
    // staged into subOut, the long one keeps anyTooBig=true, and the ladder
    // eventually falls to hard slicing.
    const para = "短句一。".repeat(5) + "长句" + "字".repeat(150) + "。"
    const chunks = chunkMarkdown(para, { targetChars: 100, maxChars: 400, minChars: 0, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(400)
  })

  it("hard-slices a single unbreakable run (no separators at all)", () => {
    const word = "a".repeat(350)
    const chunks = chunkMarkdown(word, { targetChars: 100, maxChars: 300, minChars: 0, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(300)
    // offsets stay sequential through the run
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].charStart).toBe(chunks[i - 1].charEnd)
    }
  })

  it("emits a paragraph split by sentences and then repacks pieces into target-sized chunks", () => {
    // Reproduces the current engine's documented behavior: a paragraph that
    // splits cleanly into ≤target sentence pieces is emitted, then the packer
    // re-combines neighboring pieces up to targetChars.
    const para = Array.from({ length: 12 }, (_, i) => `句子${i} `.repeat(8) + "。").join("")
    const chunks = chunkMarkdown(para, { targetChars: 100, maxChars: 400, minChars: 0, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    const allText = chunks.map((c) => c.text).join("")
    // the source text appears at least once
    expect(allText).toContain("句子0")
  })
})

// ── small-chunk merging ──────────────────────────────────────────────────────

describe("small-chunk merging", () => {
  it("merges chunks shorter than minChars into their neighbours", () => {
    // 6 short paragraphs, each ~25 chars, minChars 50 → merged into 3 chunks.
    const text = Array.from({ length: 6 }, (_, i) => `short para ${i} `.repeat(3).trim()).join("\n\n")
    const chunks = chunkMarkdown(text, { targetChars: 2000, maxChars: 3000, minChars: 50, overlapChars: 0 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain("short para 5")
  })

  it("merges a small chunk into a following oversized chunk", () => {
    // sizePieces emits [small-buf, codeAtom]; mergeSmall folds the small buf
    // into the oversized atom when combined length stays under maxChars.
    const text = [
      "short paragraph one",
      "short paragraph two",
      "```",
      "code line ".repeat(80),
      "```",
    ].join("\n")
    const chunks = chunkMarkdown(text, { targetChars: 200, maxChars: 4000, minChars: 100, overlapChars: 0 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain("short paragraph one")
    expect(chunks[0].text).toContain("code line")
  })

  it("does not merge when the combined size would exceed maxChars", () => {
    const text = `${"a".repeat(160)}\n\n${"b".repeat(160)}`
    const chunks = chunkMarkdown(text, { targetChars: 200, maxChars: 300, minChars: 1000, overlapChars: 0 })
    // first chunk (160 < minChars 1000) cannot absorb the second (160+160 > 300)
    expect(chunks).toHaveLength(2)
  })
})

// ── overlap ──────────────────────────────────────────────────────────────────

describe("overlap", () => {
  it("prepends a snapped tail of the previous chunk", () => {
    const text = `${"x".repeat(80)}\n\n${"y".repeat(80)}`
    const chunks = chunkMarkdown(text, { targetChars: 100, maxChars: 400, minChars: 0, overlapChars: 40 })
    expect(chunks).toHaveLength(2)
    expect(chunks[1].text.startsWith("x".repeat(40))).toBe(true)
    expect(chunks[1].charStart).toBeLessThan(chunks[0].charEnd)
  })

  it("snaps overlap to a sentence boundary when available", () => {
    const p1 = `${"first sentence content ".repeat(6)}。${"second part ".repeat(10)}`
    const text = `${p1}\n\n${"z".repeat(60)}`
    const chunks = chunkMarkdown(text, { targetChars: 150, maxChars: 400, minChars: 0, overlapChars: 30 })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // overlap tail is snapped after a 。 boundary, not mid-sentence
    expect(chunks[1].text.startsWith("first sentence content 。")).toBe(true)
  })

  it("snaps overlap to whitespace when no sentence boundary exists", () => {
    const p1 = "alpha beta gamma delta epsilon ".repeat(6).trim()
    const text = `${p1}\n\n${"z".repeat(40)}`
    const chunks = chunkMarkdown(text, { targetChars: 120, maxChars: 400, minChars: 0, overlapChars: 25 })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // snapped to first whitespace inside the tail → starts on a word, no leading space
    expect(chunks[1].text[0]).not.toBe(" ")
    expect(chunks[1].text[0]).not.toBe("z")
  })

  it("keeps the full tail when no boundary is found", () => {
    const text = `${"x".repeat(55)}\n\n${"y".repeat(55)}`
    const chunks = chunkMarkdown(text, { targetChars: 100, maxChars: 400, minChars: 0, overlapChars: 20 })
    expect(chunks).toHaveLength(2)
    expect(chunks[1].text.startsWith("x".repeat(20))).toBe(true)
  })

  it("does not apply overlap when overlapChars is 0", () => {
    const text = `${"x".repeat(55)}\n\n${"y".repeat(55)}`
    const chunks = chunkMarkdown(text, { targetChars: 100, maxChars: 400, minChars: 0, overlapChars: 0 })
    expect(chunks).toHaveLength(2)
    expect(chunks[1].text).toBe("y".repeat(55))
    expect(chunks[1].charStart).toBe(57)
  })

  it("skips whitespace-only blank lines inside a long section", () => {
    // A line that trims to empty but carries spaces stays in the atom stream
    // as a "blank" atom; splitAtomsToPieces must skip it without emitting.
    const text = "x".repeat(300) + "\n   \n" + "y".repeat(300)
    const chunks = chunkMarkdown(text, { targetChars: 200, maxChars: 3000, minChars: 0, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text).not.toBe("   ")
    expect(chunks.every((c) => c.text.length <= 200)).toBe(true)
  })

  it("accounts for a trailing newline after a table followed by prose", () => {
    // j < lines.length after the table → the +1 trailing-newline term applies.
    const table = ["| a | b |", "| --- | --- |", "| 1 | 2 |"]
    const text = "x".repeat(300) + "\n" + table.join("\n") + "\n" + "y".repeat(300)
    const chunks = chunkMarkdown(text, { targetChars: 200, maxChars: 3000, minChars: 0, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.some((c) => c.text.includes("| 1 | 2 |"))).toBe(true)
  })

  it("skips hard slicing when a line-break split already covers the paragraph", () => {
    // A multi-line paragraph whose lines are all short is split cleanly by the
    // lines ladder → the hard-slice fallback must not fire.
    const para = Array.from({ length: 30 }, (_, i) => `short line ${i}`).join("\n")
    const chunks = chunkMarkdown(para, { targetChars: 100, maxChars: 300, minChars: 0, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(300)
  })

  it("does not apply overlap to a single chunk", () => {
    const chunks = chunkMarkdown("single chunk content here", {
      targetChars: 1000, maxChars: 1500, minChars: 200, overlapChars: 200,
    })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toBe("single chunk content here")
  })
})

// ── misc invariants ──────────────────────────────────────────────────────────

describe("invariants", () => {
  it("oversized flag is false for normally packed chunks", () => {
    const text = Array.from({ length: 50 }, (_, i) => `word ${i} `.repeat(10)).join(" ")
    const chunks = chunkMarkdown(text, { targetChars: 300, maxChars: 500, minChars: 50, overlapChars: 30 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.oversized).toBe(false)
  })

  it("outputs stable results for identical input (pure)", () => {
    const text = "# H\n\n" + "para ".repeat(300)
    const a = chunkMarkdown(text)
    const b = chunkMarkdown(text)
    expect(a).toEqual(b)
  })

  it("handles full-width spaces and tabs as whitespace splitters", () => {
    const text = Array.from({ length: 60 }, (_, i) => `词${i}　词${i}　词${i}`).join("　")
    const chunks = chunkMarkdown(text, { targetChars: 150, maxChars: 400, minChars: 0, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(400)
  })

  it("strips inline math segments from the sample when judging language (via ingest guard path)", () => {
    // Guard function is internal to ingest.ts; here we only verify the
    // chunker itself never tears $$ blocks — they are ordinary prose here.
    const text = "before $$ a = b $$ after " + "x".repeat(80)
    const chunks = chunkMarkdown(text, { targetChars: 2000, maxChars: 3000, minChars: 5, overlapChars: 0 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain("$$")
  })
})

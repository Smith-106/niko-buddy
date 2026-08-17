import { describe, expect, it } from "vitest"
import { chunkMarkdown, stripFrontmatter } from "./text-chunker"

// TEMP PROBE — target paths claimed unreachable. Do not keep.
describe("probe text-chunker paths", () => {
  it("probe 141: after null in stripFrontmatter", () => {
    // closing --- with trailing junk then EOF
    expect(stripFrontmatter("---\ntitle\n---extra").body).toBe("---\ntitle\n---extra")
    expect(stripFrontmatter("---\ntitle\n---extra").body).toBe("---\ntitle\n---extra")
    expect(stripFrontmatter("---\r\ntitle\r\n---\r\nbody").body).toBe("body")
  })

  it("probe 423-425: para atom with double newline inside", () => {
    // multi-paragraph text > targetChars forces tokenize; paragraphs with \n\n
    const text = "p1 ".repeat(40) + "\n\n" + "p2 ".repeat(40) + "\n\n" + "p3 ".repeat(40)
    const chunks = chunkMarkdown(text, { targetChars: 60, maxChars: 400, minChars: 0, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
  })

  it("probe 454-456: subOut emit when first branch failed", () => {
    const para = Array.from({ length: 40 }, (_, i) => `sentence ${i} `.repeat(6) + "。").join("")
    const chunks = chunkMarkdown(para, { targetChars: 90, maxChars: 400, minChars: 0, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
  })

  it("probe 433/445: empty sub strings from splitKeepingSep", () => {
    const para = "aaa\n\n\nbbb " + "x".repeat(200)
    const chunks = chunkMarkdown(para, { targetChars: 100, maxChars: 400, minChars: 0, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
  })

  it("probe 486: zero-width regex in splitKeepingSep", () => {
    const para = "word ".repeat(150) + "。" + "x".repeat(90)
    const chunks = chunkMarkdown(para, { targetChars: 70, maxChars: 400, minChars: 0, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
  })

  it("probe 505: empty piece in sizePieces", () => {
    const text = "a".repeat(300) + "\n\n" + "b".repeat(300)
    const chunks = chunkMarkdown(text, { targetChars: 150, maxChars: 500, minChars: 0, overlapChars: 0 })
    expect(chunks.length).toBeGreaterThan(1)
  })
})

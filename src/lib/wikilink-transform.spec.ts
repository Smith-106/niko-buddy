import { describe, expect, it } from "vitest"
import { transformWikilinks } from "./wikilink-transform"

describe("transformWikilinks", () => {
  it("returns the input unchanged when there are no wikilinks", () => {
    const body = "just plain text with [brackets] and (parens)"
    expect(transformWikilinks(body)).toBe(body)
  })

  it("converts [[target]] to a fragment markdown link", () => {
    expect(transformWikilinks("see [[alpha]] here")).toBe("see [alpha](#alpha) here")
  })

  it("uses the alias as the label when present", () => {
    expect(transformWikilinks("[[alpha|Alpha Page]]")).toBe("[Alpha Page](#alpha)")
    expect(transformWikilinks("[[alpha|  spaced alias  ]]")).toBe("[spaced alias](#alpha)")
  })

  it("trims the target before encoding it into the href", () => {
    expect(transformWikilinks("[[  spaced target  ]]")).toBe("[spaced target](#spaced%20target)")
  })

  it("falls back to the target as label when the alias is empty", () => {
    expect(transformWikilinks("[[alpha|]]")).toBe("[alpha](#alpha)")
    expect(transformWikilinks("[[alpha|   ]]")).toBe("[alpha](#alpha)")
  })

  it("encodes characters that would break the markdown link parser", () => {
    expect(transformWikilinks("[[my page (v2)]]")).toBe("[my page (v2)](#my%20page%20(v2))")
    expect(transformWikilinks("[[a#b]]")).toBe("[a#b](#a%23b)")
  })

  it("escapes opening brackets inside the label so the link text terminates correctly", () => {
    // A closing bracket in the alias would end the wikilink match early, so
    // only the opening-bracket escape is reachable.
    expect(transformWikilinks("[[t|label [with]]")).toBe("[label \\[with](#t)")
    expect(transformWikilinks("[[a[b]]")).toBe("[a\\[b](#a%5Bb)")
  })

  it("transforms multiple wikilinks in one pass", () => {
    expect(transformWikilinks("[[a]] and [[b|B]] and [[a]]")).toBe(
      "[a](#a) and [B](#b) and [a](#a)",
    )
  })

  it("leaves fenced code blocks untouched", () => {
    const body = [
      "Before [[kept]]",
      "```",
      "[[raw wikilink]] inside fence",
      "```",
      "After [[kept]]",
    ].join("\n")
    expect(transformWikilinks(body)).toBe(
      [
        "Before [kept](#kept)",
        "```",
        "[[raw wikilink]] inside fence",
        "```",
        "After [kept](#kept)",
      ].join("\n"),
    )
  })

  it("passes outside-of-fence text through untouched when it has no wikilinks", () => {
    // The second outside-code part ("\nend") contains no "[[", so
    // transformOutsideCode returns it early.
    const body = ["start [[a]]", "```", "fence", "```", "end"].join("\n")
    expect(transformWikilinks(body)).toBe(
      ["start [a](#a)", "```", "fence", "```", "end"].join("\n"),
    )
  })

  it("leaves inline code spans untouched", () => {
    const body = "text `[[inline code]]` and [[real]]"
    expect(transformWikilinks(body)).toBe("text `[[inline code]]` and [real](#real)")
  })

  it("handles inline code spans next to fenced blocks", () => {
    const body = [
      "line `[[a]]`",
      "```ts",
      "const x = [[b]]",
      "```",
      "end [[c]]",
    ].join("\n")
    expect(transformWikilinks(body)).toBe(
      [
        "line `[[a]]`",
        "```ts",
        "const x = [[b]]",
        "```",
        "end [c](#c)",
      ].join("\n"),
    )
  })

  it("does not treat a single backtick line as a fence", () => {
    const body = "a ` single backtick with [[link]]"
    expect(transformWikilinks(body)).toBe("a ` single backtick with [link](#link)")
  })

  it("preserves newlines across the body", () => {
    const body = "line1 [[a]]\nline2 [[b]]\nline3"
    expect(transformWikilinks(body)).toBe(
      "line1 [a](#a)\nline2 [b](#b)\nline3",
    )
  })

  it("leaves a wikilink that spans multiple lines untouched", () => {
    // WIKILINK_RE excludes `\n` inside the target, so a multi-line
    // bracketed expression is not treated as a wikilink.
    const body = "[[alpha\nbeta]]"
    expect(transformWikilinks(body)).toBe(body)
  })
})

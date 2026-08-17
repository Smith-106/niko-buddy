import { describe, expect, it } from "vitest"
import { convertLatexToUnicode } from "./latex-to-unicode"

describe("convertLatexToUnicode", () => {
  it("converts a standalone $\\command$ token", () => {
    expect(convertLatexToUnicode("$\\rightarrow$")).toBe("→")
    expect(convertLatexToUnicode("$\\alpha$")).toBe("α")
  })

  it("keeps unknown commands in $\\cmd$ verbatim", () => {
    expect(convertLatexToUnicode("$\\notarealcmd$")).toBe("\\notarealcmd")
  })

  it("wraps $$...$$ display math in newlines without converting", () => {
    expect(convertLatexToUnicode("before $$\\sum_{i=1}^n i$$ after")).toBe("before \n\\sum_{i=1}^n i\n after")
  })

  it("converts commands inside $...$ inline math", () => {
    expect(convertLatexToUnicode("$x \\times y \\leq z$")).toBe("x × y ≤ z")
  })

  it("keeps unknown commands inside $...$ inline math", () => {
    expect(convertLatexToUnicode("$\\bogus$")).toBe("\\bogus")
  })

  it("keeps unknown commands with a literal backslash inside $...$ inline math", () => {
    // Uses a genuinely unknown command (not in LATEX_TO_UNICODE) so the
    // fallback branch `?? \`\\${cmd}\`` in the inline-math pass runs.
    expect(convertLatexToUnicode("$x \\unknowncmd y$")).toBe("x \\unknowncmd y")
  })

  it("leaves plain text untouched", () => {
    expect(convertLatexToUnicode("just some text with arrows -> and no latex")).toBe(
      "just some text with arrows -> and no latex",
    )
  })

  it("handles multiple conversions in one string", () => {
    expect(convertLatexToUnicode("$\\pi$ ≈ $3.14$ and $\\infty$")).toBe("π ≈ 3.14 and ∞")
  })
})

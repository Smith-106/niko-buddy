import { describe, expect, it } from "vitest"
import { decidePageFate } from "./source-delete-decision"

describe("decidePageFate", () => {
  it("skips pages that never referenced the deleted source", () => {
    const result = decidePageFate(["source-a.pdf", "source-b.pdf"], "source-c.pdf")
    expect(result.action).toBe("skip")
    if (result.action === "skip") {
      expect(result.reason).toContain('page sources do not include "source-c.pdf"')
    }
  })

  it("keeps the page and filters the deleted source when others remain", () => {
    const result = decidePageFate(["source-a.pdf", "source-b.pdf"], "source-a.pdf")
    expect(result).toEqual({ action: "keep", updatedSources: ["source-b.pdf"] })
  })

  it("matches case-insensitively when filtering survivors", () => {
    const result = decidePageFate(["SOURCE-A.PDF", "source-b.pdf"], "source-a.pdf")
    expect(result).toEqual({ action: "keep", updatedSources: ["source-b.pdf"] })
  })

  it("deletes the page when the deleted source was the only reference", () => {
    const result = decidePageFate(["source-a.pdf"], "source-a.pdf")
    expect(result).toEqual({ action: "delete" })
  })

  it("handles an empty source list as a skip", () => {
    const result = decidePageFate([], "source-a.pdf")
    expect(result.action).toBe("skip")
  })
})

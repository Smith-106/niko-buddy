import { describe, expect, it, vi } from "vitest"
import { mergePageContent, type MergeFn, type MergePageOptions } from "./page-merge"

function baseOptions(overrides: Partial<MergePageOptions> = {}): MergePageOptions {
  return {
    sourceFileName: "source.pdf",
    pagePath: "wiki/entities/foo.md",
    today: () => "2026-01-02",
    ...overrides,
  }
}

const EXISTING = `---
type: entity
title: "林云"
created: 2025-01-01
sources:
  - src-a
related:
  - 陈渊
---

# 林云
旧正文内容。
`

const INCOMING = `---
type: entity
title: "林云"
created: 2025-01-01
sources:
  - src-b
---

# 林云
新正文内容，更长一些以便满足长度阈值。
`

const merger: MergeFn = vi.fn(async (existing, incoming) => {
  // Default: union everything sensibly
  const mergedBody = `# 林云\n${existing.slice(existing.indexOf("\n\n"))}${incoming.slice(incoming.indexOf("\n\n"))}`
  return `---\ntype: entity\ntitle: "林云"\ncreated: 2025-01-01\n---\n${mergedBody}`
})

describe("mergePageContent", () => {
  it("returns new content for a brand-new page", async () => {
    const result = await mergePageContent(INCOMING, null, merger, baseOptions())
    expect(result).toBe(INCOMING)
    expect(merger).not.toHaveBeenCalled()
  })

  it("returns existing content when byte-identical", async () => {
    const result = await mergePageContent(EXISTING, EXISTING, merger, baseOptions())
    expect(result).toBe(EXISTING)
    expect(merger).not.toHaveBeenCalled()
  })

  it("unions array fields and skips the LLM when bodies are identical", async () => {
    const sameBody = `---
type: entity
title: "林云"
sources:
  - src-new
---

# 林云
旧正文内容。
`
    const result = await mergePageContent(sameBody, EXISTING, merger, baseOptions())
    expect(merger).not.toHaveBeenCalled()
    expect(result).toContain('sources: ["src-a", "src-new"]')
    expect(result).toContain('related: ["陈渊"]')
  })

  it("falls back to array-merged content when the merger throws", async () => {
    const failing = vi.fn(async () => {
      throw new Error("LLM exploded")
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const backup = vi.fn(async () => {})
    const result = await mergePageContent(INCOMING, EXISTING, failing, baseOptions({ backup }))
    expect(result).toContain('sources: ["src-a", "src-b"]')
    expect(backup).toHaveBeenCalledWith(EXISTING)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("handles non-Error merger failures", async () => {
    const failing = vi.fn(async () => {
      throw "plain string failure"
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await mergePageContent(INCOMING, EXISTING, failing, baseOptions())
    expect(result).toContain('sources: ["src-a", "src-b"]')
    expect(warn.mock.calls.some((c) => String(c[0]).includes("plain string failure"))).toBe(true)
    warn.mockRestore()
  })

  it("falls back when backup itself throws", async () => {
    const failing = vi.fn(async () => {
      throw new Error("LLM exploded")
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const backup = vi.fn(async () => {
      throw new Error("backup failed")
    })
    await mergePageContent(INCOMING, EXISTING, failing, baseOptions({ backup }))
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.some((c) => String(c[0]).includes("backup failed"))).toBe(true)
    warn.mockRestore()
  })

  it("handles non-Error backup failures", async () => {
    const failing = vi.fn(async () => {
      throw new Error("LLM exploded")
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const backup = vi.fn(async () => {
      throw "string backup failure"
    })
    await mergePageContent(INCOMING, EXISTING, failing, baseOptions({ backup }))
    expect(warn.mock.calls.some((c) => String(c[0]).includes("string backup failure"))).toBe(true)
    warn.mockRestore()
  })

  it("rejects LLM output without frontmatter", async () => {
    const noFm = vi.fn(async () => "# 林云\n只有正文没有 frontmatter。")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await mergePageContent(INCOMING, EXISTING, noFm, baseOptions())
    expect(result).toContain('sources: ["src-a", "src-b"]')
    expect(warn.mock.calls.some((c) => String(c[0]).includes("no frontmatter"))).toBe(true)
    warn.mockRestore()
  })

  it("rejects LLM output whose body is too short", async () => {
    const tooShort = vi.fn(async () => `---\ntype: entity\ntitle: "林云"\n---\n\n# 林云\n短。`)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await mergePageContent(INCOMING, EXISTING, tooShort, baseOptions())
    expect(result).toContain('sources: ["src-a", "src-b"]')
    expect(warn.mock.calls.some((c) => String(c[0]).includes("below threshold"))).toBe(true)
    warn.mockRestore()
  })

  it("applies locked fields, re-unions arrays, and stamps updated on success", async () => {
    const llm = vi.fn(async () => `---
type: "wrong-type"
title: "错误标题"
created: 1999-01-01
sources:
  - only-llm
---

# 林云
${"足够长的正文内容用于通过长度检查。".repeat(10)}
`)
    const result = await mergePageContent(INCOMING, EXISTING, llm, baseOptions())
    // locked scalar fields restored from existing
    expect(result).toContain("type: entity")
    expect(result).toContain("title: 林云")
    expect(result).toContain("created: 2025-01-01")
    // union arrays re-applied
    expect(result).toContain('sources: ["src-a", "src-b", "only-llm"]')
    // updated stamped with injected today
    expect(result).toContain("updated: 2026-01-02")
  })

  it("uses the real date provider by default", async () => {
    const llm = vi.fn(async () => `---
type: entity
title: "林云"
---

# 林云
${"足够长的正文内容用于通过长度检查。".repeat(10)}
`)
    const result = await mergePageContent(INCOMING, EXISTING, llm, baseOptions({ today: undefined }))
    const expected = new Date().toISOString().slice(0, 10)
    expect(result).toContain(`updated: ${expected}`)
  })

  it("does not force-lock missing fields", async () => {
    const noCreated = `---
type: entity
title: "林云"
sources:
  - src-a
---

# 林云
旧正文内容。
`
    const llm = vi.fn(async () => `---
type: entity
title: "林云"
---

# 林云
${"足够长的正文内容用于通过长度检查。".repeat(10)}
`)
    const result = await mergePageContent(INCOMING, noCreated, llm, baseOptions())
    expect(result).not.toContain("created: 2025-01-01")
    expect(result).toContain("updated: 2026-01-02")
  })

  it("passes the source file name and abort signal to the merger", async () => {
    const signal = new AbortController().signal
    const spy = vi.fn(async () => `---
type: entity
title: "林云"
---

# 林云
${"足够长的正文内容用于通过长度检查。".repeat(10)}
`)
    await mergePageContent(INCOMING, EXISTING, spy, baseOptions({ signal, sourceFileName: "special.pdf" }))
    expect(spy).toHaveBeenCalledWith(EXISTING, expect.stringContaining("sources:"), "special.pdf", signal)
  })

  it("leaves content unchanged when strict frontmatter is absent during field writes", async () => {
    // parseFrontmatter has an "anywhere" fallback (<=6 prefix lines) so the
    // sanity check passes, but setFrontmatterScalar requires strict leading ---.
    const prefixed = `\n\n---\ntype: entity\ntitle: "林云"\ncreated: 2025-01-01\n---\n\n# 林云\n${ "足够长的正文内容用于通过长度检查。".repeat(10) }\n`
    const llm = vi.fn(async () => prefixed)
    const result = await mergePageContent(INCOMING, EXISTING, llm, baseOptions())
    // locked fields and updated are not written, content is still returned
    expect(result).toContain("# 林云")
  })
})

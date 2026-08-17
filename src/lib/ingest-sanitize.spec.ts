import { describe, expect, it } from "vitest"
import { sanitizeIngestedFileContent } from "./ingest-sanitize"

// ── passthrough ─────────────────────────────────────────────────────────────

describe("sanitizeIngestedFileContent — passthrough", () => {
  it("leaves plain markdown unchanged", () => {
    const content = "# Title\n\nSome body with `code` and [[wikilinks]].\n"
    expect(sanitizeIngestedFileContent(content)).toBe(content)
  })

  it("leaves an empty string unchanged", () => {
    expect(sanitizeIngestedFileContent("")).toBe("")
  })

  it("leaves a body-level code fence (not wrapping the doc) untouched", () => {
    const content = "prose before\n\n```ts\nconst a = 1\n```\n\nprose after"
    expect(sanitizeIngestedFileContent(content)).toBe(content)
  })

  it("leaves an unclosed trailing fence untouched (mid-stream truncation)", () => {
    const content = "```yaml\n---\ntype: entity\n---\n# body\n``` not closed"
    expect(sanitizeIngestedFileContent(content)).toBe(content)
  })

  it("leaves a prose mention of frontmatter: untouched", () => {
    const content = "Some prose about the frontmatter: key.\n\n---\ntype: entity\n---\n"
    expect(sanitizeIngestedFileContent(content)).toBe(content)
  })

  it("leaves body wikilink lists (outside frontmatter) untouched", () => {
    const content = "---\ntype: entity\n---\n\nrelated: [[a]], [[b]]\n"
    expect(sanitizeIngestedFileContent(content)).toBe(content)
  })
})

// ── (1) outer code fence ────────────────────────────────────────────────────

describe("stripOuterCodeFence", () => {
  it("strips a ```yaml fence wrapping the whole document", () => {
    const content = "```yaml\n---\ntype: entity\n---\n# Body\n```\n"
    expect(sanitizeIngestedFileContent(content)).toBe("---\ntype: entity\n---\n# Body")
  })

  it("strips a ```md fence wrapper", () => {
    const content = "```md\n# Heading\n\nBody text\n```\n"
    expect(sanitizeIngestedFileContent(content)).toBe("# Heading\n\nBody text")
  })

  it("strips a ```markdown fence wrapper", () => {
    const content = "```markdown\n---\ntitle: X\n---\n```\n"
    expect(sanitizeIngestedFileContent(content)).toBe("---\ntitle: X\n---")
  })

  it("strips a bare ``` fence wrapper", () => {
    const content = "```\nplain body\n```\n"
    expect(sanitizeIngestedFileContent(content)).toBe("plain body")
  })

  it("handles an indented fence opener and a closing fence with trailing whitespace", () => {
    const content = "   ```yaml  \n---\na: 1\n---\n```   \n\n"
    expect(sanitizeIngestedFileContent(content)).toBe("---\na: 1\n---")
  })

  it("leaves content untouched when the opener is not at the very start", () => {
    const content = "note:\n```yaml\n---\na: 1\n---\n```\n"
    expect(sanitizeIngestedFileContent(content)).toBe(content)
  })

  it("leaves content untouched when there is no closing fence", () => {
    const content = "```yaml\n---\na: 1\n---\n"
    expect(sanitizeIngestedFileContent(content)).toBe(content)
  })
})

// ── (2) frontmatter: key prefix ─────────────────────────────────────────────

describe("stripFrontmatterKeyPrefix", () => {
  it("strips a leading frontmatter: line before a real block", () => {
    const content = "frontmatter:\n---\ntype: entity\n---\n# Body\n"
    expect(sanitizeIngestedFileContent(content)).toBe("---\ntype: entity\n---\n# Body\n")
  })

  it("strips an indented / spaced frontmatter : variant", () => {
    const content = "  frontmatter :  \n---\ntype: entity\n---\n"
    expect(sanitizeIngestedFileContent(content)).toBe("---\ntype: entity\n---\n")
  })

  it("strips a frontmatter: line even when it is followed by a fence (combined shape)", () => {
    // Both (1) and (2) shapes at once: fence wrapper + frontmatter: key.
    const content = "```yaml\nfrontmatter:\n---\ntype: entity\n---\n```\n"
    expect(sanitizeIngestedFileContent(content)).toBe("---\ntype: entity\n---")
  })

  it("leaves content untouched when frontmatter: is not followed by ---", () => {
    const content = "frontmatter:\nnot a yaml block\n"
    expect(sanitizeIngestedFileContent(content)).toBe(content)
  })
})

// ── (3) wikilink list repair ────────────────────────────────────────────────

describe("repairWikilinkListsInFrontmatter", () => {
  it("rewrites a comma-separated wikilink list into a bracketed YAML list", () => {
    const content = "---\nrelated: [[a]], [[b]], [[c]]\ntype: entity\n---\nbody\n"
    const out = sanitizeIngestedFileContent(content)
    expect(out).toContain("related: [\"[[a]]\", \"[[b]]\", \"[[c]]\"]")
    expect(out).toContain("type: entity")
    expect(out).toContain("body")
    expect(out.startsWith("---\n")).toBe(true)
    expect(out.endsWith("---\nbody\n")).toBe(true)
  })

  it("handles a single-pair list and trims spaces between entries", () => {
    const content = "---\nlinks: [[x]] ,  [[y]]\n---\n"
    expect(sanitizeIngestedFileContent(content)).toBe("---\nlinks: [\"[[x]]\", \"[[y]]\"]\n---\n")
  })

  it("handles indented keys and CRLF line endings", () => {
    const content = "---\r\n  aliases: [[one]], [[two]]\r\ntype: entity\r\n---\r\n"
    const out = sanitizeIngestedFileContent(content)
    expect(out).toContain("aliases: [\"[[one]]\", \"[[two]]\"]")
  })

  it("preserves the exact fence lines and trailing shape when repairing", () => {
    const content = "---\nrelated: [[a]], [[b]]\n---\n\n# Body\n"
    const out = sanitizeIngestedFileContent(content)
    expect(out).toBe("---\nrelated: [\"[[a]]\", \"[[b]]\"]\n---\n\n# Body\n")
  })

  it("leaves a single wikilink value (no comma list) untouched", () => {
    const content = "---\nrelated: [[a]]\n---\n"
    expect(sanitizeIngestedFileContent(content)).toBe(content)
  })

  it("leaves a malformed non-wikilink value untouched", () => {
    const content = "---\nrelated: some text here\n---\n"
    expect(sanitizeIngestedFileContent(content)).toBe(content)
  })

  it("leaves a document without frontmatter untouched", () => {
    const content = "related: [[a]], [[b]]\n\nplain body"
    expect(sanitizeIngestedFileContent(content)).toBe(content)
  })

  it("does not repair wikilink lists inside a body-only fence", () => {
    const content = "```md\nrelated: [[a]], [[b]]\n```\n"
    // fence wrapper removed, but the payload has no frontmatter block → untouched
    expect(sanitizeIngestedFileContent(content)).toBe("related: [[a]], [[b]]")
  })
})

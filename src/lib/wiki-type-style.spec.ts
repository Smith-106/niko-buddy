import { describe, expect, it } from "vitest"
import {
  FALLBACK_TYPE_STYLE,
  WIKI_TYPE_STYLES,
  getWikiTypeStyle,
} from "./wiki-type-style"

describe("WIKI_TYPE_STYLES", () => {
  it("defines a style for every supported wiki type", () => {
    expect(Object.keys(WIKI_TYPE_STYLES)).toEqual([
      "entity",
      "concept",
      "query",
      "source",
      "thesis",
      "finding",
      "event",
      "overview",
      "chapter",
      "outline",
    ])
  })

  it("each style carries a capitalized label, icon, chip class and dot class", () => {
    for (const style of Object.values(WIKI_TYPE_STYLES)) {
      expect(typeof style.label).toBe("string")
      expect(style.label).toMatch(/^[A-Z]/)
      // lucide-react icons are forwardRef components (objects with render)
      expect(style.icon).toBeTruthy()
      expect(typeof (style.icon as { render?: unknown }).render).toBe("function")
      expect(typeof style.chipClass).toBe("string")
      expect(style.chipClass.length).toBeGreaterThan(0)
      expect(typeof style.dotClass).toBe("string")
      expect(style.dotClass.length).toBeGreaterThan(0)
    }
  })
})

describe("FALLBACK_TYPE_STYLE", () => {
  it("is a Page-style chip with a muted palette", () => {
    expect(FALLBACK_TYPE_STYLE.label).toBe("Page")
    expect(FALLBACK_TYPE_STYLE.chipClass).toBe("bg-muted text-muted-foreground")
    expect(FALLBACK_TYPE_STYLE.dotClass).toBe("bg-muted-foreground/60")
  })
})

describe("getWikiTypeStyle", () => {
  it("returns the fallback for null / undefined / empty type", () => {
    expect(getWikiTypeStyle(null)).toBe(FALLBACK_TYPE_STYLE)
    expect(getWikiTypeStyle(undefined)).toBe(FALLBACK_TYPE_STYLE)
    expect(getWikiTypeStyle("")).toBe(FALLBACK_TYPE_STYLE)
  })

  it("returns the exact style for a known type", () => {
    expect(getWikiTypeStyle("entity")).toBe(WIKI_TYPE_STYLES.entity)
    expect(getWikiTypeStyle("chapter")).toBe(WIKI_TYPE_STYLES.chapter)
    expect(getWikiTypeStyle("outline")).toBe(WIKI_TYPE_STYLES.outline)
  })

  it("matches case-insensitively", () => {
    expect(getWikiTypeStyle("Entity")).toBe(WIKI_TYPE_STYLES.entity)
    expect(getWikiTypeStyle("CONCEPT")).toBe(WIKI_TYPE_STYLES.concept)
  })

  it("trims surrounding whitespace before matching", () => {
    expect(getWikiTypeStyle("  source ")).toBe(WIKI_TYPE_STYLES.source)
  })

  it("returns the fallback for an unknown type", () => {
    expect(getWikiTypeStyle("bogus-type")).toBe(FALLBACK_TYPE_STYLE)
    expect(getWikiTypeStyle("entity-ish")).toBe(FALLBACK_TYPE_STYLE)
  })
})

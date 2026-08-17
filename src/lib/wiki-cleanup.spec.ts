import { describe, expect, it } from "vitest"
import {
  buildDeletedKeys,
  cleanIndexListing,
  extractFrontmatterTitle,
  normalizeWikiRefKey,
  stripDeletedWikilinks,
  type DeletedPageInfo,
} from "./wiki-cleanup"

describe("normalizeWikiRefKey", () => {
  it("collapses case and the space/hyphen/underscore boundary", () => {
    expect(normalizeWikiRefKey("KV Cache")).toBe("kvcache")
    expect(normalizeWikiRefKey("kv-cache")).toBe("kvcache")
    expect(normalizeWikiRefKey("kv_cache")).toBe("kvcache")
  })

  it("strips path prefixes and a trailing .md", () => {
    expect(normalizeWikiRefKey("wiki/concepts/kv-cache.md")).toBe("kvcache")
    expect(normalizeWikiRefKey("C:\\proj\\wiki\\concepts\\kv-cache.md")).toBe("kvcache")
  })

  it("treats backslashes as separators", () => {
    expect(normalizeWikiRefKey("wiki\\concepts\\kv-cache")).toBe("kvcache")
  })

  it("keeps other punctuation distinct on purpose", () => {
    expect(normalizeWikiRefKey("Hello, World")).toBe("hello,world")
    expect(normalizeWikiRefKey("Hello World")).toBe("helloworld")
    expect(normalizeWikiRefKey("hello.world")).toBe("hello.world")
  })

  it("handles empty and whitespace-only input", () => {
    expect(normalizeWikiRefKey("")).toBe("")
    expect(normalizeWikiRefKey("   ")).toBe("")
  })

  it("does not lowercase the .md check away from the leaf slice", () => {
    // leaf is lowercased before the .md suffix test
    expect(normalizeWikiRefKey("WIKI/CONCEPTS/KV-CACHE.MD")).toBe("kvcache")
  })
})

describe("buildDeletedKeys", () => {
  it("adds both slug-form and title-form keys for each page", () => {
    const infos: DeletedPageInfo[] = [{ slug: "kv-cache", title: "KV Cache" }]
    const keys = buildDeletedKeys(infos)
    expect(keys.size).toBe(1) // both collapse to the same normalized key
    expect(keys.has("kvcache")).toBe(true)
  })

  it("adds distinct keys when slug and title differ", () => {
    const infos: DeletedPageInfo[] = [{ slug: "ai-safety", title: "AI Safety Review" }]
    const keys = buildDeletedKeys(infos)
    expect(keys.has("aisafety")).toBe(true)
    expect(keys.has("aisafetyreview")).toBe(true)
  })

  it("skips empty slugs and titles", () => {
    const keys = buildDeletedKeys([{ slug: "", title: "" }])
    expect(keys.size).toBe(0)
  })

  it("handles an empty batch", () => {
    expect(buildDeletedKeys([]).size).toBe(0)
  })
})

describe("extractFrontmatterTitle", () => {
  it("extracts plain, double-quoted and single-quoted titles", () => {
    expect(extractFrontmatterTitle("---\ntitle: KV Cache\n---\nbody")).toBe("KV Cache")
    expect(extractFrontmatterTitle('---\ntitle: "KV Cache"\n---\nbody')).toBe("KV Cache")
    expect(extractFrontmatterTitle("---\ntitle: 'KV Cache'\n---\nbody")).toBe("KV Cache")
    expect(extractFrontmatterTitle("---\ntitle:   Spaced   \n---\nbody")).toBe("Spaced")
  })

  it("returns empty string when no title line exists", () => {
    expect(extractFrontmatterTitle("---\ntype: entity\n---\nbody")).toBe("")
    expect(extractFrontmatterTitle("no frontmatter at all")).toBe("")
  })
})

describe("cleanIndexListing", () => {
  it("returns text unchanged when the deleted-key set is empty", () => {
    const text = "- [[alpha]]\n- [[beta]]\n"
    expect(cleanIndexListing(text, new Set())).toBe(text)
  })

  it("drops dash and asterisk list items whose primary wikilink was deleted", () => {
    const text = [
      "# Index",
      "",
      "- [[KV Cache]] description",
      "* [[Beta|Beta Page]] extra",
      "- [[Kept]] stays",
      "plain prose line",
      "",
    ].join("\n")
    expect(cleanIndexListing(text, new Set(["kvcache", "beta"]))).toBe(
      [
        "# Index",
        "",
        "- [[Kept]] stays",
        "plain prose line",
        "",
      ].join("\n"),
    )
  })

  it("does not drop entries whose wikilink merely contains the deleted slug", () => {
    // Bug B regression: deleting "ai" must not take [[OpenAI]] down.
    const text = "- [[OpenAI]]\n- [[Constitutional AI]]\n- [[AI Safety]]\n"
    expect(cleanIndexListing(text, new Set(["ai"]))).toBe(text)
  })

  it("matches title-form wikilinks against the deleted slug", () => {
    // Bug A regression: deleting file kv-cache.md (slug key kvcache) also
    // removes an index line written with the human title [[KV Cache]].
    const text = "- [[KV Cache]]\n- [[Other]]\n"
    expect(cleanIndexListing(text, new Set(["kvcache"]))).toBe("- [[Other]]\n")
  })

  it("preserves blank lines and non-list lines", () => {
    const text = "---\ntitle: Index\n---\n\n# Heading\n\n- [[gone]]\n"
    expect(cleanIndexListing(text, new Set(["gone"]))).toBe(
      "---\ntitle: Index\n---\n\n# Heading\n\n",
    )
  })

  it("treats indented list items as list items", () => {
    const text = "  - [[gone]]\n  - [[kept]]\n"
    expect(cleanIndexListing(text, new Set(["gone"]))).toBe("  - [[kept]]\n")
  })
})

describe("stripDeletedWikilinks", () => {
  it("returns text unchanged when the deleted-key set is empty", () => {
    const text = "[[alpha]] remains"
    expect(stripDeletedWikilinks(text, new Set())).toBe(text)
  })

  it("replaces a deleted wikilink with its target as plain text", () => {
    expect(stripDeletedWikilinks("see [[kv-cache]] here", new Set(["kvcache"]))).toBe(
      "see kv-cache here",
    )
  })

  it("replaces a deleted wikilink with its display alias", () => {
    expect(stripDeletedWikilinks("see [[kv-cache|KV Cache]] here", new Set(["kvcache"]))).toBe(
      "see KV Cache here",
    )
  })

  it("leaves surviving wikilinks alone", () => {
    const text = "[[kv-cache]] and [[kept]]"
    expect(stripDeletedWikilinks(text, new Set(["kvcache"]))).toBe("kv-cache and [[kept]]")
  })

  it("matches title-form targets too", () => {
    expect(stripDeletedWikilinks("[[KV Cache]]", new Set(["kvcache"]))).toBe("KV Cache")
  })

  it("leaves deleted-adjacent fragments alone", () => {
    const text = "[[OpenAI]] [[ai]]"
    expect(stripDeletedWikilinks(text, new Set(["ai"]))).toBe("[[OpenAI]] ai")
  })
})

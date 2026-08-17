import { describe, expect, it, vi } from "vitest"
import {
  buildEntityLinkIndex,
  detectDuplicateGroups,
  extractEntitySummary,
  mergeDuplicateGroup,
  normalizeEntityLinkKey,
  parseDetectorResponse,
  resolveEntityLink,
  rewriteCrossReferences,
  rewriteIndexMd,
  type DedupLlmCall,
  type EntitySummary,
} from "./dedup"

describe("deterministic entity linking", () => {
  const hero = extractEntitySummary("wiki/entities/lin-yun.md", `---
type: entity
title: "林云"
tags: [character]
aliases: ["阿云", "林・云"]
---
# 林云
`)!

  it("normalizes width, case, whitespace, and punctuation deterministically", () => {
    expect(normalizeEntityLinkKey(" 林・云 ")).toBe(normalizeEntityLinkKey("林云"))
    expect(normalizeEntityLinkKey("VFA")).toBe("vfa")
  })

  it("links a unique title or alias to the existing canonical entity", () => {
    const index = buildEntityLinkIndex([hero])
    expect(resolveEntityLink(index, "阿云", "character")).toMatchObject({ canonicalName: "林云", source: "alias" })
    expect(resolveEntityLink(index, "林・云", "character")).toMatchObject({ canonicalName: "林云" })
  })

  it("does not cross-link entities of different kinds", () => {
    const place = extractEntitySummary("wiki/entities/lin-yun-tower.md", `---
type: entity
title: "林云"
tags: [location]
---
# 林云
`)!
    const index = buildEntityLinkIndex([hero, place])
    expect(resolveEntityLink(index, "林云", "character")).toMatchObject({ canonicalName: "林云", type: "character" })
    expect(resolveEntityLink(index, "林云", "location")).toMatchObject({ canonicalName: "林云", type: "location" })
  })

  it("leaves a new entity and ambiguous aliases unresolved", () => {
    const rival = extractEntitySummary("wiki/entities/chen-yun.md", `---
type: entity
title: "陈云"
tags: [character]
aliases: ["阿云"]
---
# 陈云
`)!
    const index = buildEntityLinkIndex([hero, rival])
    expect(resolveEntityLink(index, "新人物", "character")).toBeNull()
    expect(resolveEntityLink(index, "阿云", "character")).toBeNull()
  })
})

describe("extractEntitySummary — field fallbacks and edge cases", () => {
  it("returns null without frontmatter", () => {
    expect(extractEntitySummary("wiki/entities/foo.md", "# 无元数据")).toBeNull()
  })

  it("fills missing type/title and derives description from the body", () => {
    const s = extractEntitySummary(
      "wiki/entities/dpao",
      `---
tags: [character]
---
## 标题区
| 表格 | 行 |

第一段正文。`,
    )!
    expect(s.type).toBe("unknown")
    expect(s.title).toBe("dpao") // slug fallback
    expect(s.description).toBe("第一段正文。")
    expect(s.tags).toEqual(["character"])
    expect(s.aliases).toEqual([])
  })

  it("returns no description when the body is only headings and tables", () => {
    const s = extractEntitySummary("wiki/entities/x.md", "---\ntype: entity\n---\n## 标题\n| a | b |\n")!
    expect(s.description).toBeUndefined()
  })

  it("truncates long descriptions to 200 chars with an ellipsis", () => {
    const long = "字".repeat(250)
    const s = extractEntitySummary("wiki/entities/x.md", `---\ntype: entity\ndescription: ${long}\n---\n正文`)!
    expect(s.description).toHaveLength(200)
    expect(s.description!.endsWith("…")).toBe(true)
  })

  it("filters non-string and empty array entries", () => {
    const s = extractEntitySummary(
      "wiki/entities/x.md",
      "---\ntype: entity\ntitle: X\ntags: [ok, [1], \" \", also]\naliases: [\"别名\", 7]\n---\n正文",
    )!
    expect(s.tags).toEqual(["ok", "[1]", "also"])
    expect(s.aliases).toEqual(["别名", "7"])
  })

  it("treats scalar tags as an empty list", () => {
    const s = extractEntitySummary("wiki/entities/x.md", "---\ntype: entity\ntags: 42\n---\n正文")!
    expect(s.tags).toEqual([])
  })
})

describe("detectDuplicateGroups — LLM detection pipeline", () => {
  const summaries: EntitySummary[] = [
    { slug: "vfa", path: "wiki/entities/vfa.md", type: "entity", title: "VFA", tags: [], description: "挥发性脂肪酸" },
    { slug: "volatile-fatty-acids", path: "wiki/concepts/volatile-fatty-acids.md", type: "concept", title: "Volatile Fatty Acids", tags: [], description: undefined },
    { slug: "dpao", path: "wiki/entities/dpao.md", type: "entity", title: "DPAO", tags: ["bio"], description: undefined },
  ]

  it("returns [] when fewer than two summaries exist", async () => {
    const llm = vi.fn<DedupLlmCall>()
    await expect(detectDuplicateGroups(summaries.slice(0, 1), llm)).resolves.toEqual([])
    expect(llm).not.toHaveBeenCalled()
  })

  it("parses groups, drops invalid slugs and single-element groups, respects notDuplicates", async () => {
    const llm = vi.fn<DedupLlmCall>().mockResolvedValue(
      JSON.stringify({
        groups: [
          { slugs: ["vfa", "volatile-fatty-acids"], reason: "同义", confidence: "high" },
          { slugs: ["dpao", "ghost"], reason: "幻觉 slug", confidence: "medium" },
          { slugs: ["vfa"], reason: "单元素", confidence: "low" },
        ],
      }),
    )
    const groups = await detectDuplicateGroups(summaries, llm, {
      notDuplicates: [["vfa", "volatile-fatty-acids"]],
    })
    expect(llm).toHaveBeenCalledTimes(1)
    const [system, user] = llm.mock.calls[0]
    expect(system).toContain("wiki maintenance")
    expect(user).toContain("## Wiki pages to scan (3 entries)")
    expect(user).toContain("type=entity, slug=vfa, title=\"VFA\" — 挥发性脂肪酸")
    expect(user).toContain("type=entity, slug=dpao, title=\"DPAO\" [bio]")
    expect(groups).toEqual([])
  })

  it("passes the abort signal through and keeps valid groups", async () => {
    const signal = new AbortController().signal
    const llm = vi.fn<DedupLlmCall>().mockResolvedValue(
      JSON.stringify({ groups: [{ slugs: ["dpao", "vfa"], reason: "x", confidence: "high" }] }),
    )
    const groups = await detectDuplicateGroups(summaries, llm, { signal })
    expect(llm.mock.calls[0][2]).toBe(signal)
    expect(groups).toEqual([{ slugs: ["dpao", "vfa"], reason: "x", confidence: "high" }])
  })
})

describe("parseDetectorResponse — tolerant JSON extraction", () => {
  it("returns [] for text without JSON or with unbalanced braces", () => {
    expect(parseDetectorResponse("no json here")).toEqual([])
    expect(parseDetectorResponse('{"groups": [{"slugs": ["a","b"]}')).toEqual([])
    expect(parseDetectorResponse('{"groups": oops')).toEqual([])
    expect(parseDetectorResponse('{"groups": [oops]}')).toEqual([])
  })

  it("extracts JSON wrapped in fences and prose", () => {
    const raw = 'Sure! ```json\n{"groups":[{"slugs":["a","b"],"reason":"x","confidence":"medium"}]}\n``` hope this helps'
    expect(parseDetectorResponse(raw)).toEqual([{ slugs: ["a", "b"], reason: "x", confidence: "medium" }])
  })

  it("ignores braces inside strings and handles nested objects", () => {
    const raw = '{"note": "} not a brace", "groups": [{"slugs": ["a","b"], "reason": "x", "confidence": "high"}], "nested": {"inner": 1}} trailing'
    expect(parseDetectorResponse(raw)).toEqual([{ slugs: ["a", "b"], reason: "x", confidence: "high" }])
  })

  it("handles escaped quotes inside strings and unknown confidence levels", () => {
    const raw = '{"a": "escaped \\" quote", "groups": [{"slugs": ["a","b"], "reason": "r", "confidence": "weird"}]}'
    expect(parseDetectorResponse(raw)).toEqual([{ slugs: ["a", "b"], reason: "r", confidence: "low" }])
  })

  it("rejects malformed group shapes", () => {
    expect(parseDetectorResponse('{"groups": 42}')).toEqual([])
    expect(parseDetectorResponse('{"groups": [42]}')).toEqual([])
    expect(parseDetectorResponse('{"groups": [{"slugs": "not-array"}]}')).toEqual([])
    expect(parseDetectorResponse('{"groups": [{"slugs": ["a", 42]}]}')).toEqual([])
    expect(parseDetectorResponse('{"groups": [{"slugs": ["a", "b"], "reason": 5, "confidence": "high"}]}')).toEqual([
      { slugs: ["a", "b"], reason: "", confidence: "high" },
    ])
    expect(parseDetectorResponse('{"groups": []}')).toEqual([])
  })

  it("returns [] when the payload is valid JSON but not an object", () => {
    expect(parseDetectorResponse("42")).toEqual([])
    expect(parseDetectorResponse('"just a string"')).toEqual([])
    expect(parseDetectorResponse("null")).toEqual([])
    expect(parseDetectorResponse("[1, 2, 3]")).toEqual([])
  })
})

describe("mergeDuplicateGroup — full merge computation", () => {
  const group = [
    {
      slug: "dpao",
      path: "wiki/entities/dpao.md",
      content: "---\ntype: entity\ntitle: \"DPAO\"\ntags: [character]\nrelated: [vfa]\nsources: [src-a]\n---\n# DPAO 正文",
    },
    {
      slug: "dpaos",
      path: "wiki/entities/dpaos.md",
      content: "---\ntype: entity\ntitle: \"DPAOs\"\ntags: [character]\nrelated:\n  - vfa\n  - other\nsources: [src-b]\n---\n# DPAOs 正文",
    },
  ]

  const llmOutput = `---
type: entity
title: "DPAO"
tags: [character]
related: [vfa]
sources: [src-a]
---
# 合并后的正文

包含 [[wikilink]] 与事实。`

  it("throws when the canonical slug is missing from the group", async () => {
    const llm = vi.fn<DedupLlmCall>()
    await expect(
      mergeDuplicateGroup({ group, canonicalSlug: "nope", otherWikiPages: [] }, llm),
    ).rejects.toThrow(/canonicalSlug "nope" is not in the group: dpao, dpaos/)
  })

  it("throws when the group has fewer than two pages", async () => {
    const llm = vi.fn<DedupLlmCall>()
    await expect(
      mergeDuplicateGroup(
        { group: [group[0]], canonicalSlug: "dpao", otherWikiPages: [] },
        llm,
      ),
    ).rejects.toThrow(/at least 2 pages/)
  })

  it("merges bodies, unions frontmatter, rewrites references and packages backups", async () => {
    const llm = vi.fn<DedupLlmCall>().mockResolvedValue(llmOutput)
    const otherWikiPages = [
      { path: "wiki/concepts/acid.md", content: "---\nrelated: [dpaos, keep]\n---\n提及 [[dpaos|别名]] 和 [[dpaos]]。" },
      { path: "wiki/entities/unrelated.md", content: "无关内容" },
      { path: "wiki/entities/block.md", content: "---\nrelated:\n  - dpaos\n  - block-keep\n---\n正文" },
    ]
    const signal = new AbortController().signal
    const result = await mergeDuplicateGroup(
      { group, canonicalSlug: "dpao", otherWikiPages },
      llm,
      { signal, today: () => "2026-01-02" },
    )

    expect(llm).toHaveBeenCalledTimes(1)
    expect(llm.mock.calls[0][2]).toBe(signal)
    expect(llm.mock.calls[0][0]).toContain("wiki maintenance assistant")
    expect(llm.mock.calls[0][1]).toContain("These 2 wiki pages")

    // deterministic union of related + sources across both pages
    expect(result.canonicalContent).toContain('related: ["vfa", "other"]')
    expect(result.canonicalContent).toContain('sources: ["src-b", "src-a"]')
    expect(result.canonicalContent).toContain("updated: 2026-01-02")
    expect(result.canonicalContent).toContain("# 合并后的正文")
    expect(result.canonicalPath).toBe("wiki/entities/dpao.md")

    const rewrites = new Map(result.rewrites.map((r) => [r.path, r.newContent]))
    expect(rewrites.has("wiki/concepts/acid.md")).toBe(true)
    expect(rewrites.get("wiki/concepts/acid.md")).toContain("[[dpao|别名]]")
    expect(rewrites.get("wiki/concepts/acid.md")).toContain('related: ["dpao", "keep"]')
    expect(rewrites.get("wiki/entities/block.md")).toContain("dpao")
    expect(result.rewrites.some((r) => r.path === "wiki/entities/unrelated.md")).toBe(false)

    expect(result.pagesToDelete).toEqual(["wiki/entities/dpaos.md"])
    expect(result.backup.map((b) => b.path)).toEqual([
      "wiki/entities/dpao.md",
      "wiki/entities/dpaos.md",
      "wiki/concepts/acid.md",
      "wiki/entities/block.md",
    ])
  })

  it("passes LLM output without frontmatter through unchanged", async () => {
    const llm = vi.fn<DedupLlmCall>().mockResolvedValue("纯文本没有 frontmatter")
    const result = await mergeDuplicateGroup(
      { group, canonicalSlug: "dpao", otherWikiPages: [] },
      llm,
    )
    expect(result.canonicalContent).toBe("纯文本没有 frontmatter")
    expect(result.rewrites).toEqual([])
    expect(result.backup).toHaveLength(2)
  })

  it("replaces an existing updated field in the LLM output", async () => {
    const llm = vi.fn<DedupLlmCall>().mockResolvedValue(
      "---\nupdated: 2020-01-01\n---\n正文",
    )
    const result = await mergeDuplicateGroup(
      { group, canonicalSlug: "dpao", otherWikiPages: [] },
      llm,
      { today: () => "2026-03-04" },
    )
    expect(result.canonicalContent).toContain("updated: 2026-03-04")
    expect(result.canonicalContent).not.toContain("2020-01-01")
  })
})

describe("rewriteCrossReferences", () => {
  it("rewrites wikilinks and dedups related entries case-insensitively", () => {
    const content = "---\nrelated: [dPAOs, keep, DPAOS]\n---\n正文 [[dpaos|别名]] 与 [[dpaos]]。"
    const out = rewriteCrossReferences(content, new Map([["dpaos", "dpao"]]))
    expect(out).toContain('related: ["dPAOs", "keep"]')
    expect(out).toContain("[[dpao|别名]]")
    expect(out).toContain("[[dpao]]")
    expect(out).not.toContain("DPAOS")
  })

  it("returns content unchanged when nothing matches", () => {
    const content = "---\nrelated: [keep]\n---\n正文 [[other]]。"
    expect(rewriteCrossReferences(content, new Map([["dpaos", "dpao"]]))).toBe(content)
  })

  it("escapes regex-special characters in slugs", () => {
    const content = "[[a.b+c]] 与 [[plain]]"
    const out = rewriteCrossReferences(content, new Map([["a.b+c", "replaced"]]))
    expect(out).toContain("[[replaced]]")
    expect(out).toContain("[[plain]]")
  })
})

describe("rewriteIndexMd", () => {
  const index = "- 概述\n- [[dpaos]]\n- [[dpaos|别名]]\n- [dpaos](dpaos.md)\n- [链接](entities/dpaos.md)\n- 裸引用 dpaos.md 结束\n- 保留行\n"

  it("returns content unchanged for an empty removal set", () => {
    expect(rewriteIndexMd(index, new Set())).toBe(index)
  })

  it("removes wikilink, markdown-link and bare-slug lines", () => {
    const out = rewriteIndexMd(index, new Set(["dpaos"]))
    expect(out).not.toContain("dpaos")
    expect(out).toContain("- 概述")
    expect(out).toContain("- 保留行")
    expect(out).toBe("- 概述\n- 保留行\n")
  })
})

describe("entity linking — index edge cases", () => {
  it("skips non-linkable types and infers types from tags", () => {
    const summaries = [
      { slug: "concept-a", path: "wiki/concepts/a.md", type: "concept", title: "概念A", tags: [] },
      { slug: "loc", path: "wiki/entities/loc.md", type: "entity", title: "地点甲", tags: ["location"] },
      { slug: "org", path: "wiki/entities/org.md", type: "entity", title: "组织甲", tags: ["organization"] },
      { slug: "item", path: "wiki/entities/item.md", type: "entity", title: "物品甲", tags: ["item"] },
      { slug: "char", path: "wiki/entities/char.md", type: "entity", title: "人物甲", tags: [] },
      { slug: "loc2", path: "wiki/entities/loc2.md", type: "location", title: "地点乙", tags: [] },
    ] as EntitySummary[]
    const index = buildEntityLinkIndex(summaries)
    expect(resolveEntityLink(index, "概念A", "character")).toBeNull()
    expect(resolveEntityLink(index, "地点甲", "location")).toMatchObject({ type: "location", source: "title" })
    expect(resolveEntityLink(index, "组织甲", "organization")).toMatchObject({ type: "organization" })
    expect(resolveEntityLink(index, "物品甲", "item")).toMatchObject({ type: "item" })
    expect(resolveEntityLink(index, "人物甲", "character")).toMatchObject({ type: "character" })
    expect(resolveEntityLink(index, "char", "character")).toMatchObject({ source: "slug" })
    expect(resolveEntityLink(index, "地点乙", "location")).toMatchObject({ type: "location" })
  })

  it("omits ambiguous same-type keys and skips empty normalized keys", () => {
    const summaries = [
      { slug: "a", path: "wiki/entities/a.md", type: "character", title: "阿云", tags: [] },
      { slug: "b", path: "wiki/entities/b.md", type: "character", title: "阿・云", tags: [] },
      { slug: "punct", path: "wiki/entities/punct.md", type: "character", title: "！！！", tags: [] },
    ] as EntitySummary[]
    const index = buildEntityLinkIndex(summaries)
    // "阿云" and "阿・云" normalize to the same key but are different characters → ambiguous → omitted
    expect(resolveEntityLink(index, "阿云", "character")).toBeNull()
    // key with only punctuation normalizes to "" → never indexed
    expect(resolveEntityLink(index, "！！！", "character")).toBeNull()
  })

  it("resolves a name to null when the type does not match", () => {
    const summaries = [{ slug: "x", path: "wiki/entities/x.md", type: "character", title: "某甲", tags: [] }] as EntitySummary[]
    const index = buildEntityLinkIndex(summaries)
    expect(resolveEntityLink(index, "某甲", "location")).toBeNull()
  })

  it("normalizes width, case and punctuation deterministically", () => {
    expect(normalizeEntityLinkKey(" ＶＦＡ・一号 ")).toBe("vfa一号")
    expect(normalizeEntityLinkKey("A—B")).toBe("a—b") // em-dash is not in the strip set
  })

  it("deduplicates title/slug candidates with the same canonical name", () => {
    // title and slug normalize identically → both collapse to one candidate per type
    const summaries = [
      { slug: "alpha", path: "wiki/entities/alpha.md", type: "character", title: "alpha", tags: [] },
      { slug: "beta", path: "wiki/entities/beta.md", type: "character", title: "beta", tags: [] },
    ] as EntitySummary[]
    const index = buildEntityLinkIndex(summaries)
    expect(resolveEntityLink(index, "alpha", "character")).toMatchObject({ canonicalName: "alpha" })
    expect(resolveEntityLink(index, "beta", "character")).toMatchObject({ canonicalName: "beta" })
  })
})

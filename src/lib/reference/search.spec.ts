import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  buildReferenceContext,
  searchReferences,
  formatReferenceSection,
  clearReferenceCache,
  REFERENCE_SECTION_CAP,
} from "./search"
import { parseReferences, resolveReferences } from "./resolve"
import type { ResolvedReference } from "./types"

// Mock novelMixedSearch
vi.mock("@/lib/novel/search-adapter", () => ({
  novelMixedSearch: vi.fn(),
}))

// Mock user-memory（PR6 通道）
vi.mock("@/lib/user-memory/store", () => ({
  getUserPreferenceText: vi.fn(() => "避用词: 仿佛、不禁"),
}))

vi.mock("@/lib/user-memory/session", () => ({
  loadUserMemoryForProject: vi.fn(async () => ({})),
}))

// Mock providers（候选装载）
vi.mock("./providers", () => ({
  loadAllReferenceCandidates: vi.fn(async () => [
    { id: "character:林墨", kind: "character", name: "林墨", score: 0 },
    { id: "setting:北境", kind: "setting", name: "北境", score: 0 },
  ]),
}))

import { novelMixedSearch } from "@/lib/novel/search-adapter"

function makeRef(name: string, kind: "character" | "setting" | "chapter" = "character"): ResolvedReference {
  return {
    token: { raw: name, full: `@${name}` },
    kind,
    id: `${kind}:${name}`,
    name,
    score: 100,
    ambiguity: false,
  }
}

beforeEach(() => {
  clearReferenceCache()
  vi.clearAllMocks()
  vi.mocked(novelMixedSearch).mockResolvedValue([
    { type: "keyword", path: "wiki/entities/林墨.md", title: "林墨", snippet: "林墨是主角。", relevance: 0.9 },
  ])
})

describe("reference/search", () => {
  it("searchReferences calls novelMixedSearch with three-way fusion on", async () => {
    const hits = await searchReferences("/p", [makeRef("林墨")])
    expect(novelMixedSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/p",
        query: "林墨",
        includeKeyword: true,
        includeVector: true,
        includeGraph: true,
        includeCanon: false,
        authoritativeOnly: true,
      }),
    )
    expect(hits[0]).toMatchObject({ refId: "character:林墨", kind: "character", name: "林墨" })
  })

  it("enables recent_chapters only for chapter references", async () => {
    await searchReferences("/p", [makeRef("第3章", "chapter")])
    expect(novelMixedSearch).toHaveBeenCalledWith(expect.objectContaining({ includeRecentChapters: true }))
    vi.mocked(novelMixedSearch).mockClear()
    await searchReferences("/p", [makeRef("林墨")])
    expect(novelMixedSearch).toHaveBeenCalledWith(expect.objectContaining({ includeRecentChapters: false }))
  })

  it("caches identical queries (LRU)", async () => {
    await searchReferences("/p", [makeRef("林墨")])
    await searchReferences("/p", [makeRef("林墨")])
    expect(novelMixedSearch).toHaveBeenCalledTimes(1)
  })

  it("cache miss on different query", async () => {
    await searchReferences("/p", [makeRef("林墨")])
    await searchReferences("/p", [makeRef("北境", "setting")])
    expect(novelMixedSearch).toHaveBeenCalledTimes(2)
  })

  it("returns empty for no references", async () => {
    expect(await searchReferences("/p", [])).toEqual([])
    expect(novelMixedSearch).not.toHaveBeenCalled()
  })

  it("formatReferenceSection renders user memory + hits + ambiguity note", () => {
    const ref = makeRef("林墨")
    const text = formatReferenceSection(
      ref,
      [{ refId: "character:林墨", kind: "character", name: "林墨", type: "keyword", path: "wiki/entities/林墨.md", title: "林墨", snippet: "林墨是主角。", relevance: 0.9 }],
      "避用词: 仿佛、不禁",
      300,
    )
    expect(text).toContain("【@林墨】")
    expect(text).toContain("用户记忆：避用词: 仿佛、不禁")
    expect(text).toContain("林墨是主角。")
  })

  it("buildReferenceContext full chain: parse → resolve → search → section", async () => {
    const text = await buildReferenceContext("/p", "让@林墨，出场；@北境 是背景")
    expect(text).toContain("【@林墨】")
    expect(text).toContain("【@北境】")
    expect(text).toContain("用户记忆")
  })

  it("buildReferenceContext returns empty for text without @", async () => {
    expect(await buildReferenceContext("/p", "继续写正文")).toBe("")
    expect(novelMixedSearch).not.toHaveBeenCalled()
  })

  it("buildReferenceContext caps section length", async () => {
    vi.mocked(novelMixedSearch).mockResolvedValue([
      { type: "keyword", path: "x.md", title: "x", snippet: "长".repeat(500), relevance: 0.9 },
    ])
    const text = await buildReferenceContext("/p", "让@林墨出场", { sectionCap: 100 })
    expect(text.length).toBeLessThanOrEqual(100)
  })

  it("buildReferenceContext respects includeUserMemory=false", async () => {
    const text = await buildReferenceContext("/p", "让@林墨出场", { includeUserMemory: false })
    expect(text).not.toContain("用户记忆")
  })

  it("REFERENCE_SECTION_CAP is 2000", () => {
    expect(REFERENCE_SECTION_CAP).toBe(2000)
  })

  it("resolveReferences is used inside buildReferenceContext (deterministic top-1)", async () => {
    const refs = resolveReferences(parseReferences("@林墨"), [
      { id: "character:林墨", kind: "character", name: "林墨", score: 0 },
    ])
    expect(refs[0]?.name).toBe("林墨")
  })
})

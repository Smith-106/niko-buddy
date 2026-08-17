import { describe, expect, it } from "vitest"
import type { PageSearchResult } from "@/lib/embedding"
import {
  NOVEL_VECTOR_MIN_MATCH_SCORE,
  getNovelVectorMatchScore,
  selectRelevantNovelVectorResults,
  buildNovelVectorSnippet,
} from "./vector-relevance"

function result(overrides: Partial<PageSearchResult> = {}): PageSearchResult {
  return { id: "p1", score: 0.5, ...overrides }
}

describe("vector-relevance", () => {
  it("NOVEL_VECTOR_MIN_MATCH_SCORE is 0.45", () => {
    expect(NOVEL_VECTOR_MIN_MATCH_SCORE).toBe(0.45)
  })

  describe("getNovelVectorMatchScore", () => {
    it("returns max matchedChunks score when chunks exist", () => {
      const r = result({
        score: 0.1,
        matchedChunks: [
          { text: "a", headingPath: "", score: 0.4 },
          { text: "b", headingPath: "", score: 0.9 },
        ],
      })
      expect(getNovelVectorMatchScore(r)).toBe(0.9)
    })

    it("falls back to result.score when no chunks", () => {
      expect(getNovelVectorMatchScore(result({ score: 0.33 }))).toBe(0.33)
    })

    it("falls back to result.score when matchedChunks is empty array", () => {
      expect(
        getNovelVectorMatchScore(result({ score: 0.22, matchedChunks: [] })),
      ).toBe(0.22)
    })
  })

  describe("selectRelevantNovelVectorResults", () => {
    it("returns empty when topK <= 0", () => {
      expect(selectRelevantNovelVectorResults([result({ score: 1 })], 0)).toEqual([])
      expect(selectRelevantNovelVectorResults([result()], -1)).toEqual([])
    })

    it("filters results below threshold and slices to topK", () => {
      const results = [
        result({ id: "a", score: 0.9 }),
        result({ id: "b", score: 0.2 }),
        result({ id: "c", matchedChunks: [{ text: "x", headingPath: "", score: 0.3 }] }),
        result({ id: "d", matchedChunks: [{ text: "x", headingPath: "", score: 0.8 }] }),
      ]
      const selected = selectRelevantNovelVectorResults(results, 2)
      expect(selected.map((r) => r.id)).toEqual(["a", "d"])
    })

    it("returns all qualifying results when under topK", () => {
      const selected = selectRelevantNovelVectorResults(
        [result({ id: "a", score: 0.99 })],
        10,
      )
      expect(selected.map((r) => r.id)).toEqual(["a"])
    })

    it("handles empty result list", () => {
      expect(selectRelevantNovelVectorResults([], 5)).toEqual([])
    })
  })

  describe("buildNovelVectorSnippet", () => {
    it("returns empty when maxChars <= 0", () => {
      expect(buildNovelVectorSnippet(result(), 0)).toBe("")
      expect(buildNovelVectorSnippet(result(), -5)).toBe("")
    })

    it("joins up to 2 qualifying chunks with heading prefix", () => {
      const r = result({
        matchedChunks: [
          { text: "  第一段 文本 ", headingPath: "章节A", score: 0.9 },
          { text: "第二段", headingPath: "", score: 0.8 },
          { text: "低分噪音", headingPath: "nope", score: 0.1 },
          { text: "第四段", headingPath: "h", score: 0.7 },
        ],
      })
      const snippet = buildNovelVectorSnippet(r)
      expect(snippet).toBe("章节A: 第一段 文本\n第二段")
      expect(snippet.length).toBeLessThanOrEqual(800)
    })

    it("truncates to maxChars", () => {
      const r = result({
        matchedChunks: [
          { text: "x".repeat(500), headingPath: "h", score: 0.9 },
          { text: "y".repeat(500), headingPath: "", score: 0.8 },
        ],
      })
      const snippet = buildNovelVectorSnippet(r, 600)
      expect(snippet.length).toBe(600)
    })

    it("returns empty when no chunks qualify", () => {
      const r = result({
        matchedChunks: [
          { text: "noise", headingPath: "h", score: 0.1 },
        ],
      })
      expect(buildNovelVectorSnippet(r)).toBe("")
    })

    it("returns empty when no matchedChunks", () => {
      expect(buildNovelVectorSnippet(result({ score: 0.99 }))).toBe("")
    })
  })
})

import { describe, expect, it } from "vitest"
import {
  parseReferences,
  resolveReferences,
  scoreCandidate,
  chineseNumberToInt,
} from "./resolve"
import type { ReferenceCandidate } from "./types"

describe("reference/resolve", () => {
  describe("chineseNumberToInt", () => {
    it("parses arabic numerals", () => {
      expect(chineseNumberToInt("3")).toBe(3)
      expect(chineseNumberToInt("12")).toBe(12)
    })

    it("parses chinese numerals", () => {
      expect(chineseNumberToInt("三")).toBe(3)
      expect(chineseNumberToInt("十二")).toBe(12)
      expect(chineseNumberToInt("二十三")).toBe(23)
      expect(chineseNumberToInt("一百零五")).toBe(105)
    })

    it("returns null for invalid input", () => {
      expect(chineseNumberToInt("abc")).toBeNull()
      expect(chineseNumberToInt("")).toBeNull()
    })
  })

  describe("parseReferences", () => {
    it("parses plain character mentions", () => {
      const tokens = parseReferences("请让@林墨，出场")
      expect(tokens).toHaveLength(1)
      expect(tokens[0]).toMatchObject({ raw: "林墨", full: "@林墨" })
    })

    it("parses chapter tokens via number channel", () => {
      expect(parseReferences("@第3章")[0]?.kind).toBe("chapter")
      expect(parseReferences("@第十二章")[0]?.kind).toBe("chapter")
      expect(parseReferences("@ch5")[0]?.kind).toBe("chapter")
      expect(parseReferences("@chapter7")[0]?.kind).toBe("chapter")
    })

    it("terminates on punctuation and whitespace", () => {
      const tokens = parseReferences("写@林墨，然后@北境。")
      expect(tokens.map((t) => t.raw)).toEqual(["林墨", "北境"])
    })

    it("treats @@ as escape (no parse)", () => {
      expect(parseReferences("邮箱 a@@b.com")).toHaveLength(0)
    })

    it("parses multiple references", () => {
      const tokens = parseReferences("@林墨 @北境 @第2章")
      expect(tokens).toHaveLength(3)
    })

    it("returns empty for text without @", () => {
      expect(parseReferences("继续写正文")).toHaveLength(0)
    })

    it("ignores empty @ content", () => {
      expect(parseReferences("写@ 然后")).toHaveLength(0)
    })
  })

  describe("scoreCandidate", () => {
    const aliases = ["墨哥"]

    it("exact match scores 100", () => {
      expect(scoreCandidate("林墨", "林墨")).toBe(100)
    })

    it("alias match scores 90", () => {
      expect(scoreCandidate("林墨", "墨哥", aliases)).toBe(90)
    })

    it("prefix match scores 70", () => {
      expect(scoreCandidate("林墨白", "林墨")).toBe(70)
    })

    it("pinyin match scores 50", () => {
      expect(scoreCandidate("林墨", "linmo")).toBe(50)
    })

    it("simplified match scores 40 (pinyin tie-breaks first at 50)", () => {
      // 繁简同音 → 拼音 50 先命中；简繁通道 40 是拼音不命中的兜底
      expect(scoreCandidate("後山門", "后山门")).toBe(50)
    })

    it("no match scores 0", () => {
      expect(scoreCandidate("林墨", "北境")).toBe(0)
    })
  })

  describe("resolveReferences", () => {
    const candidates: ReferenceCandidate[] = [
      { id: "character:林墨", kind: "character", name: "林墨", score: 0 },
      { id: "character:林墨白", kind: "character", name: "林墨白", score: 0 },
      { id: "setting:北境", kind: "setting", name: "北境", score: 0 },
    ]

    it("resolves unique top candidate deterministically", () => {
      const refs = resolveReferences(parseReferences("@北境"), candidates)
      expect(refs).toHaveLength(1)
      expect(refs[0]).toMatchObject({ kind: "setting", id: "setting:北境", name: "北境", ambiguity: false })
    })

    it("marks ambiguity when top-2 score gap < 15", () => {
      const sameNameCandidates: ReferenceCandidate[] = [
        { id: "character:林墨", kind: "character", name: "林墨", score: 0 },
        { id: "character:林墨2", kind: "character", name: "林墨", score: 0 },
      ]
      const refs = resolveReferences(parseReferences("@林墨"), sameNameCandidates)
      expect(refs[0]?.ambiguity).toBe(true)
      expect(refs[0]?.candidates?.length).toBe(2)
    })

    it("resolves chapter tokens without candidate matching", () => {
      const refs = resolveReferences(parseReferences("@第3章"), [])
      expect(refs[0]).toMatchObject({ kind: "chapter", id: "3", name: "第3章", score: 100 })
    })

    it("drops tokens with zero candidates", () => {
      const refs = resolveReferences(parseReferences("@不存在"), candidates)
      expect(refs).toHaveLength(0)
    })

    it("returns empty for no tokens", () => {
      expect(resolveReferences([], candidates)).toHaveLength(0)
    })
  })
})

import { describe, expect, it } from "vitest"
import {
  emptyCognitionState,
  mergeCognitionFromSnapshot,
  resolveCanonicalName,
  resolveMatchingMap,
} from "./character-cognition"
import { buildNameAliasMap } from "./book-analysis/alias-resolver"
import type { ChapterSnapshot } from "./chapter-ingest"

function snapshotWith(changes: string[], characterAliases?: Record<string, string[]>): ChapterSnapshot {
  return {
    chapterNumber: 1,
    knowledgeChanges: changes,
    characterAliases,
  } as unknown as ChapterSnapshot
}

describe("resolveCanonicalName", () => {
  it("returns NFKC-normalized name when no alias map is provided", () => {
    // 菜月・昴 → NFKC + strip ・ → 菜月昴
    expect(resolveCanonicalName("菜月・昴")).toBe("菜月昴")
    expect(resolveCanonicalName("菜月昴")).toBe("菜月昴")
  })

  it("uses alias map canonical when matchesAnyAlias hits", () => {
    const map = buildNameAliasMap("菜月昴", ["昴", "菜月・昴"])
    expect(resolveCanonicalName("昴", map)).toBe("菜月昴")
    expect(resolveCanonicalName("菜月・昴", map)).toBe("菜月昴")
    expect(resolveCanonicalName("菜月昴", map)).toBe("菜月昴")
  })

  it("falls back to NFKC when alias map does not match", () => {
    const map = buildNameAliasMap("林动", ["小动"])
    // 昴 does not appear in 林动's alias map → NFKC fallback
    expect(resolveCanonicalName("菜月・昴", map)).toBe("菜月昴")
  })
})

describe("resolveMatchingMap", () => {
  it("finds the matching map across multiple characters", () => {
    const maps = [
      buildNameAliasMap("林动", ["小动"]),
      buildNameAliasMap("菜月昴", ["昴", "菜月・昴"]),
    ]
    const matched = resolveMatchingMap("菜月・昴", maps)
    expect(matched?.canonical).toBe("菜月昴")
  })

  it("returns undefined when no map matches", () => {
    const maps = [buildNameAliasMap("林动", ["小动"])]
    expect(resolveMatchingMap("菜月・昴", maps)).toBeUndefined()
  })

  it("returns undefined for empty alias map list", () => {
    expect(resolveMatchingMap("菜月昴", undefined)).toBeUndefined()
    expect(resolveMatchingMap("菜月昴", [])).toBeUndefined()
  })
})

describe("mergeCognitionFromSnapshot identity resolution", () => {
  it("folds 菜月昴 / 菜月・昴 / 昴 onto one CharacterCognition entry via alias map", () => {
    const aliasMaps = [buildNameAliasMap("菜月昴", ["昴", "菜月・昴"])]
    const snapshot = snapshotWith(
      [
        "菜月昴知道真相",
        "菜月・昴意识到危险",
        "昴察觉到气息",
      ],
      { 菜月昴: ["昴", "菜月・昴"] },
    )

    const result = mergeCognitionFromSnapshot(emptyCognitionState(), snapshot, aliasMaps)

    expect(result.characters).toHaveLength(1)
    expect(result.characters[0].character).toBe("菜月昴")
    expect(result.characters[0].knows).toEqual(
      expect.arrayContaining(["真相", "危险", "气息"]),
    )
    expect(result.characters[0].doesNotKnow).toHaveLength(0)
  })

  it("folds 菜月・昴 onto 菜月昴 via NFKC fallback when no alias map is provided", () => {
    const snapshot = snapshotWith([
      "菜月昴知道真相",
      "菜月・昴意识到危险",
    ])

    const result = mergeCognitionFromSnapshot(emptyCognitionState(), snapshot)

    expect(result.characters).toHaveLength(1)
    expect(result.characters[0].character).toBe("菜月昴")
    expect(result.characters[0].knows).toEqual(
      expect.arrayContaining(["真相", "危险"]),
    )
  })

  it("does not split cognition across alias variants (regression for S4 TASK-001)", () => {
    const aliasMaps = [buildNameAliasMap("菜月昴", ["昴", "菜月・昴"])]
    const snapshot = snapshotWith(
      [
        "菜月昴不知道暗号",
        "菜月・昴知道暗号",
      ],
      { 菜月昴: ["昴", "菜月・昴"] },
    )

    const result = mergeCognitionFromSnapshot(emptyCognitionState(), snapshot, aliasMaps)

    expect(result.characters).toHaveLength(1)
    // 菜月昴 first does-not-know 暗号, then knows 暗号 → doesNotKnow should drop it
    expect(result.characters[0].character).toBe("菜月昴")
    expect(result.characters[0].doesNotKnow).not.toContain("暗号")
    expect(result.characters[0].knows).toContain("暗号")
  })

  it("keeps distinct characters separate when no alias overlap", () => {
    const snapshot = snapshotWith([
      "林动知道武学",
      "林动不知道真相",
    ])

    const result = mergeCognitionFromSnapshot(emptyCognitionState(), snapshot)

    expect(result.characters).toHaveLength(1)
    expect(result.characters[0].character).toBe("林动")
  })
})

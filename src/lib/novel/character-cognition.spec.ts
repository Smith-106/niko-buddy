import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  appendExemplarABSample,
  appendRewriteRateASample,
  appendRoutingROISample,
  cognitionToContextText,
  emptyCognitionState,
  exemplarABStats,
  loadCognitionState,
  mergeCognitionFromSnapshot,
  resolveCanonicalName,
  resolveMatchingMap,
  rewriteRateABStats,
  saveCognitionState,
  type CognitionState,
} from "./character-cognition"
import { buildNameAliasMap } from "./book-analysis/alias-resolver"
import type { ChapterSnapshot } from "./chapter-ingest"

// vi.hoisted: 内存文件系统 mock, 控制 save/loadCognitionState 与 A/B 埋点读写
// (走 @/commands/fs readFile/writeFileAtomic/createDirectory/fileExists,
// 同 aura-evolution.spec / emotion-ledger.spec 的 mock 模式)。
const fsMocks = vi.hoisted(() => {
  const files = new Map<string, string>()
  return {
    files,
    readFile: vi.fn(async (p: string) => {
      const k = String(p).replace(/\\/g, "/")
      if (!files.has(k)) throw new Error(`ENOENT: ${p}`)
      return files.get(k)!
    }),
    writeFileAtomic: vi.fn(async (p: string, c: string) => {
      files.set(String(p).replace(/\\/g, "/"), c)
    }),
    createDirectory: vi.fn(async () => {}),
    fileExists: vi.fn(async (p: string) => {
      return files.has(String(p).replace(/\\/g, "/"))
    }),
  }
})

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
  createDirectory: fsMocks.createDirectory,
  fileExists: fsMocks.fileExists,
}))

beforeEach(() => {
  fsMocks.files.clear()
  vi.clearAllMocks()
})

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

  it("returns empty string for blank names (trimmed empty guard)", () => {
    expect(resolveCanonicalName("")).toBe("")
    expect(resolveCanonicalName("   ")).toBe("")
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

  it("returns undefined for a blank name even when maps exist", () => {
    const maps = [buildNameAliasMap("林动", ["小动"])]
    expect(resolveMatchingMap("  ", maps)).toBeUndefined()
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

  it("records reader-knows and skips blank/whitespace changes", () => {
    const snapshot = snapshotWith(["", "   ", "读者知道了关键线索"])
    const result = mergeCognitionFromSnapshot(emptyCognitionState(), snapshot)
    expect(result.readerKnows).toEqual(["关键线索"])
    expect(result.lastUpdatedChapter).toBe(1)
  })

  it("does not duplicate reader-knows entries", () => {
    const snapshot = snapshotWith(["读者知道真相", "读者知道真相"])
    const result = mergeCognitionFromSnapshot(emptyCognitionState(), snapshot)
    expect(result.readerKnows).toEqual(["真相"])
  })

  it("ignores changes matching no knowledge pattern (knowMatch/extra fallthrough)", () => {
    const snapshot = snapshotWith(["一阵风吹过门缝", "读者知道背景设定"])
    const result = mergeCognitionFromSnapshot(emptyCognitionState(), snapshot)
    expect(result.characters).toHaveLength(0)
    expect(result.readerKnows).toEqual(["背景设定"])
  })

  it("does not re-push a know entry the character already knows (knowRegex dedupe)", () => {
    const snapshot = snapshotWith(["林动知道武学", "林动知道武学"])
    const result = mergeCognitionFromSnapshot(emptyCognitionState(), snapshot)
    expect(result.characters[0].knows).toEqual(["武学"])
  })

  it("does not re-push a know entry already known via extra-know pattern", () => {
    const snapshot = snapshotWith(["林动知道密语", "林动得知密语"])
    const result = mergeCognitionFromSnapshot(emptyCognitionState(), snapshot)
    expect(result.characters[0].knows).toEqual(["密语"])
    expect(result.characters[0].doesNotKnow).toHaveLength(0)
  })

  it("dedupes doesNotKnow entries", () => {
    const snapshot = snapshotWith(["林动不知道真相", "林动不知道真相"])
    const result = mergeCognitionFromSnapshot(emptyCognitionState(), snapshot)
    expect(result.characters[0].doesNotKnow).toEqual(["真相"])
  })

  it("extra-know pattern promotes info from doesNotKnow to knows", () => {
    const snapshot = snapshotWith(["林动不知道密语", "林动得知密语"])
    const result = mergeCognitionFromSnapshot(emptyCognitionState(), snapshot)
    expect(result.characters[0].knows).toContain("密语")
    expect(result.characters[0].doesNotKnow).not.toContain("密语")
  })

  it("merges onto existing state without mutating it, keeps max chapter", () => {
    const current: CognitionState = {
      characters: [{ character: "林动", knows: ["武学"], doesNotKnow: [] }],
      readerKnows: ["旧线索"],
      lastUpdatedChapter: 2,
    }
    const result = mergeCognitionFromSnapshot(
      current,
      snapshotWith(["林动知道新事"]),
    )
    expect(result.lastUpdatedChapter).toBe(2)
    expect(current.characters[0].knows).toEqual(["武学"])
    expect(result.characters[0].knows).toEqual(["武学", "新事"])
    expect(result.readerKnows).toEqual(["旧线索"])
  })
})

describe("saveCognitionState / loadCognitionState (fs mock)", () => {
  it("roundtrips state through the mock filesystem", async () => {
    const state: CognitionState = {
      characters: [{ character: "林动", knows: ["武学"], doesNotKnow: ["真相"] }],
      readerKnows: ["背景"],
      lastUpdatedChapter: 3,
    }
    await saveCognitionState("/proj", state)
    expect(await loadCognitionState("/proj")).toEqual(state)
  })

  it("returns null when the cognition file does not exist", async () => {
    expect(await loadCognitionState("/missing-proj")).toBeNull()
  })

  it("returns null when the cognition file is empty/whitespace", async () => {
    fsMocks.files.set("/empty-proj/.novel/cognition-state.json", "   ")
    expect(await loadCognitionState("/empty-proj")).toBeNull()
  })

  it("throws a descriptive error for corrupt JSON", async () => {
    fsMocks.files.set("/bad-proj/.novel/cognition-state.json", "{not json")
    await expect(loadCognitionState("/bad-proj")).rejects.toThrow(
      /Failed to parse cognition-state.json/,
    )
  })

  it("stringifies non-Error parse failures (defensive String(err) path)", async () => {
    fsMocks.files.set("/bad-proj/.novel/cognition-state.json", "{}")
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw "boom"
    })
    try {
      await expect(loadCognitionState("/bad-proj")).rejects.toThrow(
        /Failed to parse cognition-state.json: boom/,
      )
    } finally {
      parseSpy.mockRestore()
    }
  })
})

describe("appendRoutingROISample", () => {
  it("appends a sample, creating minimal state when the file is absent", async () => {
    await appendRoutingROISample("/roi-proj", {
      variant: "enabled",
      irrelevantRatio: 0.1,
      chapterId: "3",
      timestamp: "t1",
    })
    const saved = await loadCognitionState("/roi-proj")
    expect(saved?.characters).toEqual([])
    expect(saved?.routingROIBuckets).toHaveLength(1)
    expect(saved?.routingROIBuckets?.[0]).toMatchObject({
      variant: "enabled",
      irrelevantRatio: 0.1,
      chapterId: "3",
    })
  })

  it("appends to existing buckets and caps at 1024 (drops oldest)", async () => {
    const state: CognitionState = {
      characters: [],
      readerKnows: [],
      lastUpdatedChapter: 0,
      routingROIBuckets: [],
    }
    for (let i = 0; i < 1024; i++) {
      state.routingROIBuckets!.push({
        variant: "disabled",
        irrelevantRatio: i / 100,
        chapterId: "c",
        timestamp: `t${i}`,
      })
    }
    await saveCognitionState("/roi-cap", state)
    await appendRoutingROISample("/roi-cap", {
      variant: "enabled",
      irrelevantRatio: 0.5,
      chapterId: "c",
      timestamp: "t1024",
    })
    const saved = await loadCognitionState("/roi-cap")
    expect(saved?.routingROIBuckets).toHaveLength(1024)
    expect(saved?.routingROIBuckets?.[0].timestamp).toBe("t1")
    expect(saved?.routingROIBuckets?.[1023].timestamp).toBe("t1024")
  })

  it("swallows non-fatal write failures", async () => {
    fsMocks.writeFileAtomic.mockRejectedValueOnce(new Error("disk full"))
    await expect(
      appendRoutingROISample("/roi-fail", {
        variant: "enabled",
        irrelevantRatio: 0.1,
        chapterId: "3",
        timestamp: "t1",
      }),
    ).resolves.toBeUndefined()
  })
})

describe("appendExemplarABSample / exemplarABStats", () => {
  it("appends exemplar samples and computes per-variant averages", async () => {
    await appendExemplarABSample("/ex-proj", {
      variant: "enabled",
      score: 5,
      chapterId: "1",
      timestamp: "t1",
    })
    await appendExemplarABSample("/ex-proj", {
      variant: "disabled",
      score: 3,
      chapterId: "1",
      timestamp: "t2",
    })
    await appendExemplarABSample("/ex-proj", {
      variant: "enabled",
      score: 4,
      chapterId: "1",
      timestamp: "t3",
    })
    const saved = await loadCognitionState("/ex-proj")
    expect(saved?.exemplarABuckets).toHaveLength(3)
    const stats = exemplarABStats(saved)
    expect(stats.enabledAvg).toBe(4.5)
    expect(stats.disabledAvg).toBe(3)
  })

  it("caps exemplar buckets at 1024 (drops oldest)", async () => {
    const state: CognitionState = {
      characters: [],
      readerKnows: [],
      lastUpdatedChapter: 0,
      exemplarABuckets: [],
    }
    for (let i = 0; i < 1024; i++) {
      state.exemplarABuckets!.push({
        variant: "disabled",
        score: i % 5,
        chapterId: "c",
        timestamp: `t${i}`,
      })
    }
    await saveCognitionState("/ex-cap", state)
    await appendExemplarABSample("/ex-cap", {
      variant: "enabled",
      score: 5,
      chapterId: "c",
      timestamp: "t1024",
    })
    const saved = await loadCognitionState("/ex-cap")
    expect(saved?.exemplarABuckets).toHaveLength(1024)
    expect(saved?.exemplarABuckets?.[0].timestamp).toBe("t1")
    expect(saved?.exemplarABuckets?.[1023].timestamp).toBe("t1024")
  })

  it("returns null averages for null / missing / empty data", () => {
    expect(exemplarABStats(null)).toEqual({ enabledAvg: null, disabledAvg: null })
    expect(exemplarABStats(emptyCognitionState())).toEqual({
      enabledAvg: null,
      disabledAvg: null,
    })
    expect(
      exemplarABStats({ ...emptyCognitionState(), exemplarABuckets: [] }),
    ).toEqual({ enabledAvg: null, disabledAvg: null })
  })

  it("returns null average for the group without samples", () => {
    const stats = exemplarABStats({
      ...emptyCognitionState(),
      exemplarABuckets: [
        { variant: "disabled", score: 2, chapterId: "1", timestamp: "t1" },
      ],
    })
    expect(stats.enabledAvg).toBeNull()
    expect(stats.disabledAvg).toBe(2)
  })
})

describe("appendRewriteRateASample / rewriteRateABStats", () => {
  it("appends rewrite-rate samples and computes per-variant averages", async () => {
    await appendRewriteRateASample("/rr-proj", {
      variant: "disabled",
      rewriteRate: 0.4,
      chapterId: "1",
      timestamp: "t1",
    })
    await appendRewriteRateASample("/rr-proj", {
      variant: "enabled",
      rewriteRate: 0.2,
      chapterId: "1",
      timestamp: "t2",
    })
    const saved = await loadCognitionState("/rr-proj")
    expect(saved?.rewriteRateABuckets).toHaveLength(2)
    const stats = rewriteRateABStats(saved)
    expect(stats.enabledAvg).toBe(0.2)
    expect(stats.disabledAvg).toBe(0.4)
  })

  it("caps rewrite-rate buckets at 1024 (drops oldest)", async () => {
    const state: CognitionState = {
      characters: [],
      readerKnows: [],
      lastUpdatedChapter: 0,
      rewriteRateABuckets: [],
    }
    for (let i = 0; i < 1024; i++) {
      state.rewriteRateABuckets!.push({
        variant: "disabled",
        rewriteRate: i / 1000,
        chapterId: "c",
        timestamp: `t${i}`,
      })
    }
    await saveCognitionState("/rr-cap", state)
    await appendRewriteRateASample("/rr-cap", {
      variant: "enabled",
      rewriteRate: 0.5,
      chapterId: "c",
      timestamp: "t1024",
    })
    const saved = await loadCognitionState("/rr-cap")
    expect(saved?.rewriteRateABuckets).toHaveLength(1024)
    expect(saved?.rewriteRateABuckets?.[0].timestamp).toBe("t1")
    expect(saved?.rewriteRateABuckets?.[1023].timestamp).toBe("t1024")
  })

  it("returns null averages for null / missing / empty data", () => {
    expect(rewriteRateABStats(null)).toEqual({
      enabledAvg: null,
      disabledAvg: null,
    })
    expect(rewriteRateABStats(emptyCognitionState())).toEqual({
      enabledAvg: null,
      disabledAvg: null,
    })
    expect(
      rewriteRateABStats({ ...emptyCognitionState(), rewriteRateABuckets: [] }),
    ).toEqual({ enabledAvg: null, disabledAvg: null })
  })

  it("returns null average for the group without samples", () => {
    const stats = rewriteRateABStats({
      ...emptyCognitionState(),
      rewriteRateABuckets: [
        { variant: "enabled", rewriteRate: 0.1, chapterId: "1", timestamp: "t1" },
      ],
    })
    expect(stats.enabledAvg).toBe(0.1)
    expect(stats.disabledAvg).toBeNull()
  })
})

describe("cognitionToContextText", () => {
  it("returns empty string for an empty state", () => {
    expect(cognitionToContextText(emptyCognitionState())).toBe("")
  })

  it("returns empty string when only reader-knows is present is false (chars only)", () => {
    // readerKnows empty → 读者知道 line skipped
    const state: CognitionState = {
      characters: [{ character: "林动", knows: ["武学"], doesNotKnow: [] }],
      readerKnows: [],
      lastUpdatedChapter: 1,
    }
    expect(cognitionToContextText(state)).toBe("林动知道：武学")
  })

  it("formats characters and reader-knows lines", () => {
    const state: CognitionState = {
      characters: [
        { character: "林动", knows: ["武学"], doesNotKnow: [] },
        { character: "菜月昴", knows: [], doesNotKnow: ["真相"] },
      ],
      readerKnows: ["背景"],
      lastUpdatedChapter: 1,
    }
    expect(cognitionToContextText(state)).toBe(
      "林动知道：武学\n菜月昴不知道：真相\n读者知道：背景",
    )
  })
})

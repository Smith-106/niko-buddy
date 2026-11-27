// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest"
import {
  EMOTION_CB_THRESHOLD,
  computeCheckpointDigest,
  type ChapterDraft,
  type EmotionLedgerStore,
  type EmotionalArcStore,
  type ForeshadowingStore,
  type NovelReviewResult,
  type NovelSessionStatus,
  type OutlineModel,
  type SubplotBoardStore,
} from "@/lib/novel"
import {
  LONGFORM_HEALTH_SECTIONS,
  runAuditLongformHealth,
  runDraftDiff,
  type AuditLongformHealthDeps,
  type DraftDiffDeps,
} from "./phase3-read-tools"

function makeDraft(overrides: Partial<ChapterDraft> & { id: string; content: string }): ChapterDraft {
  return {
    chapterName: "第3章",
    status: "draft",
    createdAt: 1700000000000,
    revisionRound: 0,
    ...overrides,
  }
}

describe("phase3-read-tools: draft.diff", () => {
  const baseDeps = (
    drafts: ChapterDraft[],
    chapters: Array<{ name: string; path: string }> = [],
    files: Record<string, string> = {},
  ): Partial<DraftDiffDeps> => ({
    listDrafts: async () => drafts,
    listChapters: async () => chapters,
    readFileText: async (path: string) => {
      if (path in files) return files[path]!
      throw new Error(`ENOENT: ${path}`)
    },
  })

  it("validates projectPath, object params, unknown keys, bounds, and Mode 1 vs Mode 2 mutual exclusion 1:1 with Rust", async () => {
    await expect(runDraftDiff("", { draftId: "d1" })).rejects.toThrow("需要已打开的项目")
    await expect(runDraftDiff("/proj", [] as never)).rejects.toThrow("params 必须是对象")
    await expect(runDraftDiff("/proj", { draftId: "d1", unknownKey: 1 })).rejects.toThrow("参数未知")
    await expect(runDraftDiff("/proj", {})).rejects.toThrow("必须提供")

    // Invalid draftId format / traversal
    await expect(runDraftDiff("/proj", { draftId: "../evil" })).rejects.toThrow("draftId 非法")
    await expect(runDraftDiff("/proj", { baseDraftId: "ok", targetDraftId: "bad id" })).rejects.toThrow(
      "targetDraftId 非法",
    )

    // Mode 1 requires both baseDraftId and targetDraftId
    await expect(runDraftDiff("/proj", { baseDraftId: "d1" })).rejects.toThrow("必须同时提供")
    await expect(runDraftDiff("/proj", { targetDraftId: "d2" })).rejects.toThrow("必须同时提供")

    // Mode 1 forbids draftId, chapterNumber, compareToFormal=true
    await expect(
      runDraftDiff("/proj", { baseDraftId: "d1", targetDraftId: "d2", draftId: "d3" }),
    ).rejects.toThrow("互斥")
    await expect(
      runDraftDiff("/proj", { baseDraftId: "d1", targetDraftId: "d2", chapterNumber: 3 }),
    ).rejects.toThrow("不得传入 chapterNumber")
    await expect(
      runDraftDiff("/proj", { baseDraftId: "d1", targetDraftId: "d2", compareToFormal: true }),
    ).rejects.toThrow("不得设置 compareToFormal: true")

    // Mode 2 forbids compareToFormal=false
    await expect(runDraftDiff("/proj", { draftId: "d1", compareToFormal: false })).rejects.toThrow(
      "不得设置 compareToFormal: false",
    )

    // Numeric range checks
    await expect(runDraftDiff("/proj", { draftId: "d1", chapterNumber: 0 })).rejects.toThrow("1..100000")
    await expect(runDraftDiff("/proj", { draftId: "d1", contextLines: 11 })).rejects.toThrow("0..10")
    await expect(runDraftDiff("/proj", { draftId: "d1", maxHunks: 0 })).rejects.toThrow("1..200")
    await expect(runDraftDiff("/proj", { draftId: "d1", maxChars: 499 })).rejects.toThrow("500..50000")
    await expect(runDraftDiff("/proj", { draftId: "d1", maxChars: 50001 })).rejects.toThrow("500..50000")
    await expect(runDraftDiff("/proj", { draftId: "d1", compareToFormal: "true" as never })).rejects.toThrow(
      "必须是 boolean",
    )
  })

  it("computes Myers draft-vs-draft unified diff with byte-identical computeCheckpointDigest SHA-256 parity", async () => {
    const d1 = makeDraft({
      id: "draft_v1",
      content: "第一段：雨夜祠堂。\n第二段：门缝冷光。\n第三段：主角推门而入。\n第四段：结尾。",
      revisionRound: 0,
    })
    const d2 = makeDraft({
      id: "draft_v2",
      content: "第一段：雨夜祠堂。\n第二段：门缝里渗出一线冷光。\n第三段：主角握紧旧钥匙推门而入。\n第四段：结尾。",
      revisionRound: 1,
    })

    const res = await runDraftDiff(
      "/proj",
      { baseDraftId: "draft_v1", targetDraftId: "draft_v2", compareToFormal: false, contextLines: 1 },
      baseDeps([d1, d2]),
    )

    expect(res.mode).toBe("draft_vs_draft")
    expect(res.algorithm).toBe("myers")
    expect(res.identical).toBe(false)
    expect(res.baseSha256).toBe(await computeCheckpointDigest(d1.content))
    expect(res.targetSha256).toBe(await computeCheckpointDigest(d2.content))
    expect(res.base.sha256).toBe(res.baseSha256)
    expect(res.target.sha256).toBe(res.targetSha256)
    expect(res.stats.addedLines).toBe(2)
    expect(res.stats.removedLines).toBe(2)
    expect(res.stats.unchangedLines).toBe(2)
    expect(res.hunks).toHaveLength(1)
    expect(res.hunks[0]!.header).toBe("@@ -1,4 +1,4 @@")
    expect(res.unifiedDiff).toContain("-第二段：门缝冷光。")
    expect(res.unifiedDiff).toContain("+第二段：门缝里渗出一线冷光。")
    expect(res.truncated).toBe(false)
    expect(res.truncatedReason).toBeNull()
    expect(res.meta).toEqual({ readOnly: true, llmCalls: 0, diskWrites: 0 })
  })

  it("compares draft vs formal chapter with YAML frontmatter stripped, and handles missing formal chapter cleanly without throwing", async () => {
    const draft = makeDraft({
      id: "draft_ch3",
      chapterName: "第3章",
      content: "第一行\n修订后的第二行\n第三行",
    })
    const formalRaw = "---\ntitle: 第3章\nchapter_number: 3\nstatus: final\n---\n\n第一行\n原始第二行\n第三行"
    const formalPath = "/proj/wiki/chapters/chapter-003.md"

    const withFormal = await runDraftDiff(
      "/proj",
      { draftId: "draft_ch3", compareToFormal: true },
      baseDeps([draft], [{ name: "chapter-003.md", path: formalPath }], { [formalPath]: formalRaw }),
    )

    expect(withFormal.mode).toBe("draft_vs_formal")
    expect(withFormal.base.kind).toBe("formal")
    expect(withFormal.base.exists).toBe(true)
    expect(withFormal.base.sha256).toBe(await computeCheckpointDigest("第一行\n原始第二行\n第三行"))
    expect(withFormal.unifiedDiff).not.toContain("chapter_number: 3")
    expect(withFormal.unifiedDiff).toContain("-原始第二行")
    expect(withFormal.unifiedDiff).toContain("+修订后的第二行")

    // Missing formal chapter -> base.exists = false against "" (no throw)
    const withoutFormal = await runDraftDiff(
      "/proj",
      { draftId: "draft_ch3", chapterNumber: 9 },
      baseDeps([draft], [], {}),
    )
    expect(withoutFormal.base.kind).toBe("formal")
    expect(withoutFormal.base.exists).toBe(false)
    expect(withoutFormal.base.chapterNumber).toBe(9)
    expect(withoutFormal.baseSha256).toBe(await computeCheckpointDigest(""))
    expect(withoutFormal.stats.addedLines).toBe(3)
    expect(withoutFormal.stats.removedLines).toBe(0)
    expect(withoutFormal.identical).toBe(false)
  })

  it("falls back to line_index_fallback when remOld * remNew exceeds myersCellLimit, and truncates honestly by maxHunks / maxChars", async () => {
    const oldLines = Array.from({ length: 40 }, (_, i) => `old-line-${i + 1}`)
    const newLines = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? `new-line-${i + 1}` : `old-line-${i + 1}`))
    const d1 = makeDraft({ id: "d1", content: oldLines.join("\n") })
    const d2 = makeDraft({ id: "d2", content: newLines.join("\n") })

    // Force fallback via injected small cell limit
    const fallbackRes = await runDraftDiff(
      "/proj",
      { baseDraftId: "d1", targetDraftId: "d2", contextLines: 0 },
      { ...baseDeps([d1, d2]), myersCellLimit: 10 },
    )
    expect(fallbackRes.algorithm).toBe("line_index_fallback")
    expect(fallbackRes.stats.addedLines).toBe(10)
    expect(fallbackRes.stats.removedLines).toBe(10)

    // Bound by maxHunks
    const hunkLimited = await runDraftDiff(
      "/proj",
      { baseDraftId: "d1", targetDraftId: "d2", contextLines: 0, maxHunks: 3 },
      baseDeps([d1, d2]),
    )
    expect(hunkLimited.stats.totalHunks).toBe(10)
    expect(hunkLimited.stats.returnedHunks).toBe(3)
    expect(hunkLimited.truncated).toBe(true)
    expect(hunkLimited.truncatedReason).toBe("max_hunks_exceeded")

    // Bound by maxChars (even on single huge hunk)
    const big1 = makeDraft({ id: "big1", content: Array.from({ length: 30 }, (_, i) => `A${i}-${"甲".repeat(30)}`).join("\n") })
    const big2 = makeDraft({ id: "big2", content: Array.from({ length: 30 }, (_, i) => `B${i}-${"乙".repeat(30)}`).join("\n") })
    const charLimited = await runDraftDiff(
      "/proj",
      { baseDraftId: "big1", targetDraftId: "big2", maxChars: 500 },
      baseDeps([big1, big2]),
    )
    expect(charLimited.truncated).toBe(true)
    expect(charLimited.truncatedReason).toBe("max_chars_exceeded")
    expect(charLimited.unifiedDiff.length).toBeLessThanOrEqual(500)
  })
})

describe("phase3-read-tools: audit.longform_health", () => {
  function emptyDeps(overrides: Partial<AuditLongformHealthDeps> = {}): Partial<AuditLongformHealthDeps> {
    return {
      loadForeshadowing: async (): Promise<ForeshadowingStore> => ({ items: [], lastUpdated: "" }),
      loadStatus: async (): Promise<NovelSessionStatus | null> => null,
      loadSubplotBoard: async (): Promise<SubplotBoardStore> => ({ items: [], lastUpdated: "" }),
      loadEmotionLedger: async (): Promise<EmotionLedgerStore> => ({ entries: [], lastUpdated: "" }),
      loadEmotionalArcs: async (): Promise<EmotionalArcStore> => ({ beats: [], lastUpdated: "" }),
      listDrafts: async (): Promise<ChapterDraft[]> => [],
      listChapters: async () => [],
      loadOutlineModel: async () => ({ model: null }),
      runContinuityPreflight: vi.fn(async () => [] as NovelReviewResult[]),
      ...overrides,
    }
  }

  it("validates all parameters 1:1 with Rust tools.rs (ranges, mutual exclusion, sections enum, finite threshold)", async () => {
    await expect(runAuditLongformHealth("", {})).rejects.toThrow("需要已打开的项目")
    await expect(runAuditLongformHealth("/proj", { unknownField: 1 })).rejects.toThrow("参数未知")
    await expect(runAuditLongformHealth("/proj", { volume: 1, chapterStart: 1 })).rejects.toThrow("互斥")
    await expect(runAuditLongformHealth("/proj", { volume: 1, chapterEnd: 5 })).rejects.toThrow("互斥")
    await expect(runAuditLongformHealth("/proj", { chapterStart: 10, chapterEnd: 5 })).rejects.toThrow("不能大于")
    await expect(runAuditLongformHealth("/proj", { volume: 0 })).rejects.toThrow("1..1000")
    await expect(runAuditLongformHealth("/proj", { sections: [] })).rejects.toThrow("不能为空数组")
    await expect(runAuditLongformHealth("/proj", { sections: ["invalid"] })).rejects.toThrow("sections[0]")
    await expect(runAuditLongformHealth("/proj", { sections: ["emotion", "drafts", "a", "b", "c", "d"] })).rejects.toThrow(
      "最多包含 5 项",
    )
    await expect(runAuditLongformHealth("/proj", { topK: 51 })).rejects.toThrow("1..50")
    await expect(runAuditLongformHealth("/proj", { includeDetails: "yes" as never })).rejects.toThrow("必须是 boolean")
    await expect(runAuditLongformHealth("/proj", { emotionBreakerThreshold: 0.1 })).rejects.toThrow("-10..0")
    await expect(runAuditLongformHealth("/proj", { emotionBreakerThreshold: -10.5 })).rejects.toThrow("-10..0")
    await expect(runAuditLongformHealth("/proj", { emotionBreakerThreshold: Number.NaN })).rejects.toThrow("有限数字")
  })

  it("runs strictly readOnly continuity preflight, computes healthy baseline, and enforces P0 > P1 > P2 overallStatus", async () => {
    const preflightSpy = vi.fn(async () => [] as NovelReviewResult[])
    const healthy = await runAuditLongformHealth(
      "/proj",
      { currentChapter: 10 },
      emptyDeps({ runContinuityPreflight: preflightSpy }),
    )
    expect(healthy.overallStatus).toBe("healthy")
    expect(healthy.sectionsRequested).toEqual([...LONGFORM_HEALTH_SECTIONS])
    expect(healthy.emotionBreakerThreshold).toBe(EMOTION_CB_THRESHOLD)
    expect(healthy.degradedSignals).toEqual([])
    expect(healthy.meta).toEqual({ readOnly: true, llmCalls: 0, diskWrites: 0 })
    expect(preflightSpy).toHaveBeenCalledWith("/proj", 10, {
      readOnly: true,
      includeNonBlockingAudit: true,
    })

    // P0 canon risk error forces overallStatus = "at_risk"
    const p0Res = await runAuditLongformHealth(
      "/proj",
      { currentChapter: 12, sections: ["canonRisk"], includeDetails: true },
      emptyDeps({
        runContinuityPreflight: async () => [
          {
            severity: "error",
            type: "consistency_mechanical",
            message: "死亡角色在第12章再次活跃",
            evidence: "character:老周",
            relatedMemory: "character-states.json",
            suggestion: "修正出场人物",
            continuityMeta: { subtype: "dead_character_state", ref: "character:老周", chapter: 12 },
          },
        ],
      }),
    )
    expect(p0Res.overallStatus).toBe("at_risk")
    expect(p0Res.sections.canonRisk?.p0Blocked).toBe(true)
    expect(p0Res.sections.canonRisk?.errorCount).toBe(1)
    expect(p0Res.sections.canonRisk?.topFindings[0]?.evidence).toBe("character:老周")
    expect(p0Res.sections.foreshadowing).toBeUndefined()
  })

  it("aggregates all 5 sections with volume/chapter filtering, topK, includeDetails, and custom emotionBreakerThreshold", async () => {
    const outlineModel: OutlineModel = {
      schemaVersion: 2,
      updatedAt: "2026-11-27T00:00:00Z",
      volumes: [
        {
          number: 1,
          title: "第一卷",
          arc: "起",
          chapters: [
            { id: "v01c001", volume: 1, chapter: 1, title: "第一章", pov: "", arc: "", entities: [], foreshadow: { plant: [], payoff: [] }, constraints: [], prose: { goal: "", scenes: [], emotion: "" }, updatedAt: "" },
            { id: "v01c002", volume: 1, chapter: 2, title: "第二章", pov: "", arc: "", entities: [], foreshadow: { plant: [], payoff: [] }, constraints: [], prose: { goal: "", scenes: [], emotion: "" }, updatedAt: "" },
          ],
        },
        {
          number: 2,
          title: "第二卷",
          arc: "承",
          chapters: [
            { id: "v02c010", volume: 2, chapter: 10, title: "第十章", pov: "", arc: "", entities: [], foreshadow: { plant: [], payoff: [] }, constraints: [], prose: { goal: "", scenes: [], emotion: "" }, updatedAt: "" },
          ],
        },
      ],
    }

    const res = await runAuditLongformHealth(
      "/proj",
      {
        currentChapter: 15,
        volume: 1,
        topK: 1,
        includeDetails: true,
        emotionBreakerThreshold: -0.4,
      },
      emptyDeps({
        loadOutlineModel: async () => ({ model: outlineModel }),
        loadForeshadowing: async () => ({
          lastUpdated: "",
          items: [
            { id: "f1", name: "旧钥匙", description: "第1章埋设", status: "planted", plantedChapter: 1, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
            { id: "f2", name: "二卷线索", description: "第10章埋设", status: "planted", plantedChapter: 10, advancedChapters: [], relatedCharacters: [], relatedEvents: [], notes: "" },
          ],
        }),
        loadEmotionLedger: async () => ({
          lastUpdated: "",
          entries: [
            { characterName: "沈鸢", valence: -0.5, arousal: -0.4, dominance: -0.4, netValue: -0.5, lastUpdatedChapter: 2, history: [{ chapter: 2, delta: -0.5, reason: "受挫" }] },
            { characterName: "二卷反派", valence: -0.9, arousal: -0.9, dominance: -0.9, netValue: -0.9, lastUpdatedChapter: 10, history: [{ chapter: 10, delta: -0.9, reason: "重创" }] },
          ],
        }),
        loadEmotionalArcs: async () => ({
          lastUpdated: "",
          beats: [
            { character: "沈鸢", chapterNumber: 2, emotion: "哀", intensity: 0.8, trigger: "失利", notes: "" },
            { character: "二卷反派", chapterNumber: 10, emotion: "怒", intensity: 0.9, trigger: "反噬", notes: "" },
          ],
        }),
        loadSubplotBoard: async () => ({
          lastUpdated: "",
          items: [
            { id: "s1", title: "族谱暗线", status: "active", startChapter: 1, lastSeenChapter: 2, targetResolutionChapter: 8, relatedCharacters: ["沈鸢"], summary: "追查缺页", progress: [], notes: "" },
          ],
        }),
        listDrafts: async () => [
          makeDraft({ id: "d_v1", chapterName: "第2章", content: "草稿正文", partial: true }),
          makeDraft({ id: "d_v2", chapterName: "第10章", content: "二卷草稿" }),
        ],
      }),
    )

    expect(res.scope).toEqual({ volume: 1, chapterStart: null, chapterEnd: null, matchedChapters: 2 })
    // Volume 1 excludes chapter 10 items
    expect(res.sections.foreshadowing?.total).toBe(1)
    expect(res.sections.foreshadowing?.criticalCount).toBe(1)
    expect(res.sections.foreshadowing?.topItems).toHaveLength(1)
    expect(res.sections.foreshadowing?.topItems[0]?.description).toBe("第1章埋设")
    expect(res.sections.emotion?.trackedCharacters).toBe(1)
    expect(res.sections.emotion?.breakerTripped).toBe(true) // -0.5 < -0.4
    expect(res.sections.emotion?.recentArcBeats).toHaveLength(1)
    expect(res.sections.chaseDebt?.overdueSubplots).toBe(1)
    expect(res.sections.drafts?.activeDrafts).toBe(1)
    expect(res.sections.drafts?.partialCount).toBe(1)
    expect(res.overallStatus).toBe("at_risk")
  })

  it("captures per-source errors cleanly into degradedSignals without crashing and downgrades overallStatus to watch", async () => {
    const res = await runAuditLongformHealth(
      "/proj",
      { currentChapter: 5 },
      emptyDeps({
        loadForeshadowing: async () => {
          throw new Error("foreshadowing corrupt JSON")
        },
        loadEmotionLedger: async () => {
          throw new Error("emotion disk read failed")
        },
        runContinuityPreflight: async () => [
          {
            severity: "warning",
            type: "consistency_mechanical",
            message: "连续性引擎执行异常",
            evidence: "engine_error",
            relatedMemory: "",
            suggestion: "",
          },
        ],
      }),
    )

    expect(res.overallStatus).toBe("watch")
    expect(res.degradedSignals).toHaveLength(3)
    expect(res.degradedSignals.map((d) => d.source)).toEqual([
      "foreshadowingTracker",
      "emotionLedger",
      "engine_error",
    ])
  })

  it("tolerates explicit null on optional fields (1:1 parity with Rust tools.rs) while rejecting unknown null keys and all-null draft.diff", async () => {
    const draft = makeDraft({
      id: "draft_null_test",
      chapterName: "第3章 雨夜",
      content: "第一行\n第二行",
    })
    const diffRes = await runDraftDiff(
      "/proj",
      {
        draftId: "draft_null_test",
        baseDraftId: null,
        targetDraftId: null,
        chapterNumber: null,
        compareToFormal: null,
        contextLines: null,
        maxHunks: null,
        maxChars: null,
      },
      {
        listDrafts: async () => [draft],
        listChapters: async () => [],
        readFileText: async () => "",
      },
    )
    expect(diffRes.mode).toBe("draft_vs_formal")
    expect(diffRes.target.draftId).toBe("draft_null_test")

    await expect(
      runDraftDiff("/proj", { draftId: null, baseDraftId: null, targetDraftId: null }),
    ).rejects.toThrow("draft.diff")

    await expect(
      runDraftDiff("/proj", { draftId: "draft_null_test", unknownKey: null }),
    ).rejects.toThrow("未知")

    const healthRes = await runAuditLongformHealth(
      "/proj",
      {
        currentChapter: null,
        chapterStart: null,
        chapterEnd: null,
        volume: null,
        sections: null,
        topK: null,
        includeDetails: null,
        emotionBreakerThreshold: null,
      },
      emptyDeps(),
    )
    expect(healthRes.overallStatus).toBe("healthy")
    expect(Object.keys(healthRes.sections).sort()).toEqual([
      "canonRisk",
      "chaseDebt",
      "drafts",
      "emotion",
      "foreshadowing",
    ])

    await expect(
      runAuditLongformHealth("/proj", { unknownExtra: null }, emptyDeps()),
    ).rejects.toThrow("未知")
  })
})

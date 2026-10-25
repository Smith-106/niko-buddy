/**
 * ISS-20260709-034：buildContextPackFromRawData 单函数 156 行 7 职责拆小函数。
 *
 * 结构断言：七职责 helper 均导出可用；
 * 等价断言：各 helper 输出与原内联语义一致（快照优先/降级、拼装顺序、缺失收窄）。
 */
import { describe, expect, it } from "vitest"
import {
  applyTemporalFactsToCanonRules,
  loadProjectionTexts,
  normalizeRawSnapshots,
  resolveAuraMatchingText,
  resolveChapterGoalSection,
  resolveCharacterStates,
  resolveDerivedStoreSections,
  resolveForeshadowingSection,
  resolveSummaryBasics,
  resolveTimelineSection,
  type RawSnapshotView,
} from "./context-engine"
import type { ContextRawData } from "./context-data-source"

const RAW: ContextRawData = {
  snapshots: {
    recentSummaries: ["snap-sum"],
    previousChapterEnding: "snap-ending",
    characterStates: "snap-chars",
    foreshadowingSignals: [],
    timeline: "snap-timeline",
  },
  fallbackRecentSummaries: ["fb-sum"],
  fallbackPreviousEnding: "fb-ending",
  fallbackCharacterStates: "fb-chars",
  fallbackTimeline: "fb-timeline",
  fallbackForeshadowingStates: "fb-foreshadow",
  outline: "outline-text",
  volumeContext: "vol",
  storySimulationBinding: "binding",
  chapterOutline: "ch-outline",
  cognitionText: "cog",
  searchResults: "",
  revisionFeedback: { mustFix: [], shouldImprove: [], carryToNextChapter: [] },
}

describe("ISS-20260709-034 buildContextPackFromRawData 职责拆分", () => {
  it("七职责 helper 均导出（拆分结构存在）", () => {
    for (const fn of [
      normalizeRawSnapshots,
      resolveSummaryBasics,
      loadProjectionTexts,
      resolveCharacterStates,
      resolveTimelineSection,
      resolveForeshadowingSection,
      resolveChapterGoalSection,
      resolveAuraMatchingText,
      applyTemporalFactsToCanonRules,
      resolveDerivedStoreSections,
    ]) {
      expect(typeof fn).toBe("function")
    }
  })

  it("normalizeRawSnapshots：非对象快照收窄为空对象（等价原内联收窄）", () => {
    expect(normalizeRawSnapshots({} as ContextRawData)).toEqual({})
    expect(normalizeRawSnapshots({ snapshots: null } as unknown as ContextRawData)).toEqual({})
    const snapshots = normalizeRawSnapshots(RAW)
    expect(snapshots.recentSummaries).toEqual(["snap-sum"])
  })

  it("resolveSummaryBasics：快照优先、缺失回退降级、delta 缺失为 undefined", () => {
    const basics = resolveSummaryBasics(RAW, normalizeRawSnapshots(RAW))
    expect(basics.recentSummaries).toEqual(["snap-sum"])
    expect(basics.previousChapterEnding).toBe("snap-ending")
    expect(basics.recentStateDeltas).toBeUndefined()

    const fallbackOnly = resolveSummaryBasics(
      { fallbackRecentSummaries: ["fb"], fallbackPreviousEnding: "fb-end" },
      {} as RawSnapshotView,
    )
    expect(fallbackOnly.recentSummaries).toEqual(["fb"])
    expect(fallbackOnly.previousChapterEnding).toBe("fb-end")

    const withDelta = resolveSummaryBasics(
      {},
      { recentStateDeltas: "delta-text" } as RawSnapshotView,
    )
    expect(withDelta.recentStateDeltas).toBe("delta-text")
  })

  it("resolveCharacterStates：快照/降级/投影按序拼装、空段跳过", () => {
    const text = resolveCharacterStates(RAW, normalizeRawSnapshots(RAW), {
      emotionalText: "emo",
      subplotText: "",
      resourceText: "",
      emotionLedgerText: "",
      auraEvolutionText: "",
    })
    expect(text).toBe("snap-chars\n\nfb-chars\n\nemo")
  })

  it("resolveTimelineSection / resolveForeshadowingSection 等价原内联", () => {
    expect(resolveTimelineSection(RAW, normalizeRawSnapshots(RAW))).toBe("snap-timeline\n\nfb-timeline")
    const fore = resolveForeshadowingSection(RAW, normalizeRawSnapshots(RAW))
    expect(fore).toContain("fb-foreshadow")
  })

  it("resolveChapterGoalSection：大纲合并跳空、修订指令为字符串", () => {
    const section = resolveChapterGoalSection(RAW, 3)
    expect(section.mergedOutline).toBe("outline-text\n\nvol\n\nbinding\n\nch-outline")
    expect(typeof section.chapterGoal).toBe("string")
    expect(typeof section.revisionDirectives).toBe("string")
  })

  it("resolveAuraMatchingText 按原五段顺序拼装", () => {
    const text = resolveAuraMatchingText(RAW, normalizeRawSnapshots(RAW), "GOAL")
    expect(text).toBe("GOAL\n\nch-outline\n\nfb-chars\n\nsnap-chars\n\ncog")
  })

  it("applyTemporalFactsToCanonRules：null 回退 raw（向后兼容）", () => {
    expect(applyTemporalFactsToCanonRules("raw-rules", null, 3)).toBe("raw-rules")
  })
})

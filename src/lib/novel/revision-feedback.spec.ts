import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LintResult } from "@/lib/lint"
import type { NovelReviewResult } from "./review-adapter"

const mocks = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  uniqueNonEmpty: vi.fn(),
  t: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  createDirectory: (...args: unknown[]) => mocks.createDirectory(...args),
  fileExists: (...args: unknown[]) => mocks.fileExists(...args),
  readFile: (...args: unknown[]) => mocks.readFile(...args),
  writeFile: (...args: unknown[]) => mocks.writeFile(...args),
}))

vi.mock("@/i18n", () => ({
  default: { t: (...args: unknown[]) => mocks.t(...args) },
}))

vi.mock("@/lib/utils", () => ({
  uniqueNonEmpty: (...args: unknown[]) => mocks.uniqueNonEmpty(...args),
}))

import {
  buildRevisionDirectives,
  clearRevisionFeedback,
  createEmptyRevisionFeedback,
  DEFAULT_REVISION_FEEDBACK_WINDOW_CONFIG,
  getRevisionDirectives,
  loadRevisionFeedbackForContext,
  loadRevisionFeedbackForProject,
  mergeRevisionFeedback,
  persistRevisionFeedbackForChapter,
  persistRevisionFeedbackForProject,
  pickRevisionFeedbackFromLintResults,
  pickRevisionFeedbackFromReviewResults,
  setRevisionFeedbackForTesting,
  storeRevisionFeedback,
  type NovelRevisionFeedback,
} from "./revision-feedback"

const projectPath = "E:/Novel"
const feedbackFilePath = `${projectPath}/.novel/revision-feedback.json`

function reviewResult(overrides: Partial<NovelReviewResult>): NovelReviewResult {
  return {
    severity: "warning",
    type: "consistency",
    message: "承接下章伏笔",
    evidence: "e",
    relatedMemory: "m",
    suggestion: "s",
    ...overrides,
  }
}

describe("revision-feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createDirectory.mockResolvedValue(undefined)
    mocks.fileExists.mockResolvedValue(false)
    mocks.writeFile.mockResolvedValue(undefined)
    mocks.uniqueNonEmpty.mockImplementation((items: readonly string[]) => [...new Set(items.filter((i) => i.trim().length > 0))])
    mocks.t.mockImplementation((key: string) => `[${key}]`)
    clearRevisionFeedback()
  })

  describe("pickRevisionFeedbackFromReviewResults", () => {
    it("routes error → mustFix and warning → shouldImprove, carry regex on message", () => {
      const feedback = pickRevisionFeedbackFromReviewResults([
        reviewResult({ severity: "error", message: "主角知道秘密", suggestion: "" }),
        reviewResult({ severity: "warning", message: "节奏偏慢", suggestion: "压缩中段" }),
      ])
      expect(feedback.mustFix).toEqual(["主角知道秘密"])
      expect(feedback.shouldImprove).toEqual(["节奏偏慢；压缩中段"])
    })

    it("drops empty normalized entries (both message and suggestion blank)", () => {
      const feedback = pickRevisionFeedbackFromReviewResults([
        reviewResult({ severity: "error", message: "  ", suggestion: "" }),
        reviewResult({ severity: "warning", message: "下一章继续承接黑玉令", suggestion: "" }),
      ])
      expect(feedback.mustFix).toEqual([])
      expect(feedback.shouldImprove).toEqual(["下一章继续承接黑玉令"])
      expect(feedback.carryToNextChapter).toEqual(["下一章继续承接黑玉令"])
    })

    it("dedupes identical entries across review results", () => {
      const feedback = pickRevisionFeedbackFromReviewResults([
        reviewResult({ severity: "error", message: "同一问题", suggestion: "修正" }),
        reviewResult({ severity: "error", message: "同一问题", suggestion: "修正" }),
      ])
      expect(feedback.mustFix).toEqual(["同一问题；修正"])
    })

    it("carry regex matches 回收/承接 in suggestion only", () => {
      const feedback = pickRevisionFeedbackFromReviewResults([
        reviewResult({ severity: "warning", message: "细节", suggestion: "下章回收伏笔" }),
        reviewResult({ severity: "warning", message: "其他", suggestion: "无关" }),
      ])
      expect(feedback.carryToNextChapter).toEqual(["细节；下章回收伏笔"])
    })
  })

  describe("pickRevisionFeedbackFromLintResults", () => {
    function lint(overrides: Partial<LintResult>): LintResult {
      return {
        type: "semantic",
        severity: "error",
        path: "p",
        line: 1,
        message: "m",
        detail: "d",
        ...overrides,
      } as LintResult
    }

    it("ignores non-semantic results and empty details", () => {
      const feedback = pickRevisionFeedbackFromLintResults([
        lint({ type: "orphan", detail: "[contradiction] x" }),
        lint({ type: "semantic", detail: "   " }),
      ])
      expect(feedback.mustFix).toEqual([])
      expect(feedback.shouldImprove).toEqual([])
    })

    it("maps [contradiction]/[stale] → mustFix and [suggestion] → shouldImprove", () => {
      const feedback = pickRevisionFeedbackFromLintResults([
        lint({ detail: "[contradiction] 时间线矛盾" }),
        lint({ detail: "[stale] 角色状态过期" }),
        lint({ detail: "[suggestion] 可压缩段落" }),
        lint({ detail: "普通 detail，无标记" }),
      ])
      expect(feedback.mustFix).toEqual(["[contradiction] 时间线矛盾", "[stale] 角色状态过期"])
      expect(feedback.shouldImprove).toEqual(["[suggestion] 可压缩段落"])
    })

    it("carry regex on detail (回收/铺设)", () => {
      const feedback = pickRevisionFeedbackFromLintResults([
        lint({ detail: "[suggestion] 下章铺设机关线索" }),
      ])
      expect(feedback.carryToNextChapter).toEqual(["[suggestion] 下章铺设机关线索"])
    })
  })

  describe("merge + directives + in-memory store", () => {
    it("mergeRevisionFeedback concatenates and dedupes arrays", () => {
      const merged = mergeRevisionFeedback(
        { mustFix: ["a"], shouldImprove: [], carryToNextChapter: ["c"] },
        { mustFix: ["a", "b"], shouldImprove: ["s"], carryToNextChapter: [] },
      )
      expect(merged).toEqual({ mustFix: ["a", "b"], shouldImprove: ["s"], carryToNextChapter: ["c"] })
    })

    it("buildRevisionDirectives renders only non-empty sections with i18n labels", () => {
      const text = buildRevisionDirectives({
        mustFix: ["m1", "m2"],
        shouldImprove: [],
        carryToNextChapter: ["c1"],
      })
      expect(text).toContain("[novel.revisionFeedback.mustFix]")
      expect(text).toContain("  - m1")
      expect(text).toContain("  - m2")
      expect(text).not.toContain("shouldImprove")
      expect(text).toContain("[novel.revisionFeedback.carryToNextChapter]")
      expect(text).toContain("  - c1")
    })

    it("buildRevisionDirectives renders shouldImprove section", () => {
      const text = buildRevisionDirectives({
        mustFix: [],
        shouldImprove: ["s1", "s2"],
        carryToNextChapter: [],
      })
      expect(text).toContain("[novel.revisionFeedback.shouldImprove]")
      expect(text).toContain("  - s1")
      expect(text).toContain("  - s2")
    })

    it("buildRevisionDirectives returns empty string when nothing present", () => {
      expect(buildRevisionDirectives(createEmptyRevisionFeedback())).toBe("")
    })

    it("storeRevisionFeedback merges into current; getRevisionDirectives reflects it", () => {
      storeRevisionFeedback({ mustFix: ["x"], shouldImprove: [], carryToNextChapter: [] })
      storeRevisionFeedback({ mustFix: ["y"], shouldImprove: [], carryToNextChapter: [] })
      expect(getRevisionDirectives()).toContain("x")
      expect(getRevisionDirectives()).toContain("y")
    })

    it("setRevisionFeedbackForTesting replaces current; clearRevisionFeedback empties it", () => {
      setRevisionFeedbackForTesting({ mustFix: ["z"], shouldImprove: [], carryToNextChapter: [] })
      expect(getRevisionDirectives()).toContain("z")
      clearRevisionFeedback()
      expect(getRevisionDirectives()).toBe("")
    })
  })

  describe("persist + load project", () => {
    it("persistRevisionFeedbackForProject dedupes, sets current, writes JSON", async () => {
      await persistRevisionFeedbackForProject(projectPath, {
        mustFix: ["a", "a"],
        shouldImprove: [" "],
        carryToNextChapter: [],
      })
      expect(mocks.createDirectory).toHaveBeenCalledWith(`${projectPath}/.novel`)
      const [path, payload] = mocks.writeFile.mock.calls[0] as [string, string]
      expect(path).toBe(feedbackFilePath)
      const parsed = JSON.parse(payload) as NovelRevisionFeedback
      expect(parsed.mustFix).toEqual(["a"])
      expect(parsed.shouldImprove).toEqual([])
      expect(getRevisionDirectives()).toContain("a")
    })

    it("loadRevisionFeedbackForProject returns empty when file missing", async () => {
      mocks.fileExists.mockResolvedValue(false)
      const loaded = await loadRevisionFeedbackForProject(projectPath)
      expect(loaded).toEqual(createEmptyRevisionFeedback())
    })

    it("loadRevisionFeedbackForProject parses legacy format with partial arrays", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify({ mustFix: ["只有必改"] }))
      const loaded = await loadRevisionFeedbackForProject(projectPath)
      expect(loaded.mustFix).toEqual(["只有必改"])
      expect(loaded.shouldImprove).toEqual([])
      expect(loaded.carryToNextChapter).toEqual([])
    })

    it("loadRevisionFeedbackForProject handles legacy with only shouldImprove key", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify({ shouldImprove: ["建议"] }))
      const loaded = await loadRevisionFeedbackForProject(projectPath)
      expect(loaded.mustFix).toEqual([])
      expect(loaded.shouldImprove).toEqual(["建议"])
      expect(loaded.carryToNextChapter).toEqual([])
    })

    it("loadRevisionFeedbackForProject treats payload without chapters as empty persisted", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify({ unrelated: true }))
      const loaded = await loadRevisionFeedbackForProject(projectPath)
      expect(loaded).toEqual(createEmptyRevisionFeedback())
    })

    it("loadRevisionFeedbackForProject parses legacy flat format", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify({ mustFix: ["旧问题"], shouldImprove: [], carryToNextChapter: ["旧承接"] }))
      const loaded = await loadRevisionFeedbackForProject(projectPath)
      expect(loaded.mustFix).toEqual(["旧问题"])
      expect(loaded.carryToNextChapter).toEqual(["旧承接"])
    })

    it("loadRevisionFeedbackForProject parses per-chapter format and flattens", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify({
        chapters: {
          "1": {
            fromReview: { mustFix: ["r1"], shouldImprove: ["r2"], carryToNextChapter: ["r3"] },
            fromLint: { mustFix: ["l1"], shouldImprove: [], carryToNextChapter: [] },
          },
          "2": {
            fromLint: { mustFix: ["l2"], shouldImprove: [], carryToNextChapter: [] },
          },
        },
      }))
      const loaded = await loadRevisionFeedbackForProject(projectPath)
      expect(loaded.mustFix).toEqual(["r1", "l1", "l2"])
      expect(loaded.shouldImprove).toEqual(["r2"])
    })

    it("loadRevisionFeedbackForProject tolerates corrupt JSON", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue("{not json")
      const loaded = await loadRevisionFeedbackForProject(projectPath)
      expect(loaded).toEqual(createEmptyRevisionFeedback())
    })

    it("loadRevisionFeedbackForProject treats non-object payload as empty", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify("nope"))
      const loaded = await loadRevisionFeedbackForProject(projectPath)
      expect(loaded).toEqual(createEmptyRevisionFeedback())
    })
  })

  describe("persistRevisionFeedbackForChapter", () => {
    it("writes review-source feedback into the chapter bucket and merges current", async () => {
      mocks.fileExists.mockResolvedValue(false)
      await persistRevisionFeedbackForChapter(projectPath, 3, "review", {
        mustFix: ["rev-fix"],
        shouldImprove: [],
        carryToNextChapter: [],
      })
      const [, payload] = mocks.writeFile.mock.calls[0] as [string, string]
      const parsed = JSON.parse(payload) as { chapters: Record<string, unknown> }
      expect(parsed.chapters["3"]).toEqual({
        fromReview: { mustFix: ["rev-fix"], shouldImprove: [], carryToNextChapter: [] },
        fromLint: { mustFix: [], shouldImprove: [], carryToNextChapter: [] },
      })
      expect(getRevisionDirectives()).toContain("rev-fix")
    })

    it("writes lint-source feedback preserving an existing review bucket", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify({
        chapters: { "3": { fromReview: { mustFix: ["old"], shouldImprove: [], carryToNextChapter: [] } } },
      }))
      await persistRevisionFeedbackForChapter(projectPath, 3, "lint", {
        mustFix: ["lint-fix"],
        shouldImprove: [],
        carryToNextChapter: [],
      })
      const [, payload] = mocks.writeFile.mock.calls[0] as [string, string]
      const parsed = JSON.parse(payload) as { chapters: Record<string, { fromReview: NovelRevisionFeedback; fromLint: NovelRevisionFeedback }> }
      expect(parsed.chapters["3"]!.fromReview.mustFix).toEqual(["old"])
      expect(parsed.chapters["3"]!.fromLint.mustFix).toEqual(["lint-fix"])
    })

    it("normalizes malformed buckets during chapter persist", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify({
        chapters: { "3": { fromReview: "garbage" } },
      }))
      await persistRevisionFeedbackForChapter(projectPath, 3, "review", {
        mustFix: ["x"],
        shouldImprove: [],
        carryToNextChapter: [],
      })
      const [, payload] = mocks.writeFile.mock.calls[0] as [string, string]
      const parsed = JSON.parse(payload) as { chapters: Record<string, unknown> }
      expect(parsed.chapters["3"]).toBeTruthy()
    })
  })

  describe("loadRevisionFeedbackForContext", () => {
    beforeEach(() => {
      clearRevisionFeedback()
    })

    it("returns project-wide feedback when chapter is missing or <= 0", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify({ mustFix: ["legacy"], shouldImprove: [], carryToNextChapter: [] }))
      const noChapter = await loadRevisionFeedbackForContext(projectPath)
      expect(noChapter.mustFix).toEqual(["legacy"])
      const zero = await loadRevisionFeedbackForContext(projectPath, 0)
      expect(zero.mustFix).toEqual(["legacy"])
    })

    it("loadRevisionFeedbackForContext returns empty buckets for unknown chapter", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify({
        chapters: { "1": { fromReview: { mustFix: ["m1"], shouldImprove: [], carryToNextChapter: [] }, fromLint: { mustFix: [], shouldImprove: [], carryToNextChapter: [] } } },
      }))
      const loaded = await loadRevisionFeedbackForContext(projectPath, 99)
      expect(loaded.mustFix).toEqual([])
      expect(loaded.shouldImprove).toEqual([])
    })

    it("loadRevisionFeedbackForContext tolerates corrupt persisted file", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue("{not json")
      const loaded = await loadRevisionFeedbackForContext(projectPath, 5)
      expect(loaded.mustFix).toEqual([])
      expect(loaded.shouldImprove).toEqual([])
    })

    it("loadRevisionFeedbackForContext handles legacy flat file via persisted loader", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify({ mustFix: ["旧问题"], shouldImprove: [], carryToNextChapter: ["旧承接"] }))
      const loaded = await loadRevisionFeedbackForContext(projectPath, 5)
      expect(loaded.mustFix).toEqual([])
    })

    it("combines current chapter buckets and previous chapter carry", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify({
        chapters: {
          "5": {
            fromReview: { mustFix: ["cur-fix"], shouldImprove: ["cur-sug"], carryToNextChapter: ["cur-carry"] },
            fromLint: { mustFix: [], shouldImprove: [], carryToNextChapter: [] },
          },
          "4": {
            fromReview: { mustFix: [], shouldImprove: [], carryToNextChapter: ["prev-carry"] },
            fromLint: { mustFix: [], shouldImprove: [], carryToNextChapter: [] },
          },
        },
      }))
      const loaded = await loadRevisionFeedbackForContext(projectPath, 5)
      expect(loaded.mustFix).toEqual(["cur-fix"])
      expect(loaded.shouldImprove).toEqual(["cur-sug"])
      expect(loaded.carryToNextChapter).toEqual(["cur-carry", "prev-carry"])
    })

    it("drops current shouldImprove when currentChapterIncludeShouldImprove=false", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify({
        chapters: { "2": { fromReview: { mustFix: [], shouldImprove: ["s"], carryToNextChapter: [] }, fromLint: { mustFix: [], shouldImprove: [], carryToNextChapter: [] } } },
      }))
      const loaded = await loadRevisionFeedbackForContext(projectPath, 2, {
        ...DEFAULT_REVISION_FEEDBACK_WINDOW_CONFIG,
        currentChapterIncludeShouldImprove: false,
      })
      expect(loaded.shouldImprove).toEqual([])
    })

    it("skips previous-chapter carry when previousChapterCarryEnabled=false", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify({
        chapters: {
          "3": { fromReview: { mustFix: [], shouldImprove: [], carryToNextChapter: [] }, fromLint: { mustFix: [], shouldImprove: [], carryToNextChapter: [] } },
          "2": { fromReview: { mustFix: [], shouldImprove: [], carryToNextChapter: ["pc"] }, fromLint: { mustFix: [], shouldImprove: [], carryToNextChapter: [] } },
        },
      }))
      const loaded = await loadRevisionFeedbackForContext(projectPath, 3, {
        ...DEFAULT_REVISION_FEEDBACK_WINDOW_CONFIG,
        previousChapterCarryEnabled: false,
      })
      expect(loaded.carryToNextChapter).toEqual([])
    })

    it("lookback window merges mustFix from older chapters (mustFix-only mode)", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify({
        chapters: {
          "9": { fromReview: { mustFix: ["m9"], shouldImprove: ["s9"], carryToNextChapter: [] }, fromLint: { mustFix: [], shouldImprove: [], carryToNextChapter: [] } },
          "8": { fromReview: { mustFix: ["m8"], shouldImprove: ["s8"], carryToNextChapter: [] }, fromLint: { mustFix: [], shouldImprove: [], carryToNextChapter: [] } },
        },
      }))
      const loaded = await loadRevisionFeedbackForContext(projectPath, 9, {
        ...DEFAULT_REVISION_FEEDBACK_WINDOW_CONFIG,
        lookbackChapterCount: 2,
        lookbackIncludeMustFixOnly: true,
      })
      expect(loaded.mustFix).toEqual(["m9", "m8"])
      expect(loaded.shouldImprove).toEqual(["s9"]) // current chapter's own suggestion kept
    })

    it("lookback includes shouldImprove when lookbackIncludeMustFixOnly=false", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify({
        chapters: {
          "9": { fromReview: { mustFix: [], shouldImprove: [], carryToNextChapter: [] }, fromLint: { mustFix: [], shouldImprove: [], carryToNextChapter: [] } },
          "8": { fromReview: { mustFix: [], shouldImprove: ["s8"], carryToNextChapter: [] }, fromLint: { mustFix: [], shouldImprove: [], carryToNextChapter: [] } },
        },
      }))
      const loaded = await loadRevisionFeedbackForContext(projectPath, 9, {
        ...DEFAULT_REVISION_FEEDBACK_WINDOW_CONFIG,
        lookbackChapterCount: 1,
        lookbackIncludeMustFixOnly: false,
      })
      expect(loaded.shouldImprove).toEqual(["s8"])
    })

    it("stops lookback at chapter 0 and tolerates missing lookback chapters", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify({
        chapters: {
          "1": { fromReview: { mustFix: ["m1"], shouldImprove: [], carryToNextChapter: [] }, fromLint: { mustFix: [], shouldImprove: [], carryToNextChapter: [] } },
        },
      }))
      const loaded = await loadRevisionFeedbackForContext(projectPath, 1, {
        ...DEFAULT_REVISION_FEEDBACK_WINDOW_CONFIG,
        lookbackChapterCount: 5,
      })
      expect(loaded.mustFix).toEqual(["m1"])
    })

    it("zero lookbackChapterCount skips the lookback loop entirely", async () => {
      mocks.fileExists.mockResolvedValue(true)
      mocks.readFile.mockResolvedValue(JSON.stringify({
        chapters: {
          "4": { fromReview: { mustFix: [], shouldImprove: [], carryToNextChapter: [] }, fromLint: { mustFix: [], shouldImprove: [], carryToNextChapter: [] } },
          "2": { fromReview: { mustFix: ["old"], shouldImprove: [], carryToNextChapter: [] }, fromLint: { mustFix: [], shouldImprove: [], carryToNextChapter: [] } },
        },
      }))
      const loaded = await loadRevisionFeedbackForContext(projectPath, 4, {
        ...DEFAULT_REVISION_FEEDBACK_WINDOW_CONFIG,
        lookbackChapterCount: 0,
      })
      expect(loaded.mustFix).toEqual([])
    })
  })
})

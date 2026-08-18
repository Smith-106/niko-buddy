import { describe, expect, it, vi, beforeEach } from "vitest"

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: vi.fn(() => ({
      novelConfig: { reviewModel: "fallback-model" },
    })),
  },
  DEFAULT_NOVEL_CONFIG: {
    contextTokenBudget: 0,
    recentSummaryWindow: 0,
    searchTopK: 0,
    chapterTargetChars: 0,
    autoIngestOnSave: false,
    autoExtractOnImport: false,
    reviewBeforeSave: false,
    deepPreviousChaptersAnalysis: false,
    reviewModel: "",
    summaryModel: "",
    extractModel: "",
    reviewReasoningEffort: "high",
  },
}))

import { resolveReviewModel } from "./review-model"
import { DEFAULT_NOVEL_CONFIG } from "@/stores/wiki-store"

describe("review-model resolveReviewModel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns trimmed reviewModel from explicit config", () => {
    expect(resolveReviewModel({ ...DEFAULT_NOVEL_CONFIG, reviewModel: "  deepseek-r1  " })).toBe("deepseek-r1")
  })

  it("returns empty string when explicit config has blank reviewModel", () => {
    expect(resolveReviewModel({ ...DEFAULT_NOVEL_CONFIG, reviewModel: "   " })).toBe("")
    expect(resolveReviewModel({ ...DEFAULT_NOVEL_CONFIG, reviewModel: "" })).toBe("")
  })

  it("falls back to wiki store novelConfig when config omitted", () => {
    expect(resolveReviewModel()).toBe("fallback-model")
  })

  it("falls back to store when config is undefined-valued", () => {
    expect(resolveReviewModel(undefined)).toBe("fallback-model")
  })
})

import { describe, expect, it, vi, beforeEach } from "vitest"

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: {
    getState: vi.fn(() => ({
      novelConfig: { reviewModel: "fallback-model" },
    })),
  },
}))

import { resolveReviewModel } from "./review-model"

describe("review-model resolveReviewModel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns trimmed reviewModel from explicit config", () => {
    expect(resolveReviewModel({ reviewModel: "  deepseek-r1  " })).toBe("deepseek-r1")
  })

  it("returns empty string when explicit config has blank reviewModel", () => {
    expect(resolveReviewModel({ reviewModel: "   " })).toBe("")
    expect(resolveReviewModel({ reviewModel: "" })).toBe("")
  })

  it("falls back to wiki store novelConfig when config omitted", () => {
    expect(resolveReviewModel()).toBe("fallback-model")
  })

  it("falls back to store when config is undefined-valued", () => {
    expect(resolveReviewModel(undefined)).toBe("fallback-model")
  })
})

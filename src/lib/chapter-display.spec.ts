import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string) => `label:${key}`),
}))
vi.mock("@/i18n", () => ({ default: { t: mocks.t } }))
const tMock = mocks.t

import {
  buildChapterTotalWordCountLabel,
  buildChapterWordCountLabel,
  getChapterStatusLabel,
} from "./chapter-display"

describe("getChapterStatusLabel", () => {
  it.each([
    ["final", "novel.chapter.status.canon"],
    ["revised", "novel.chapter.status.revised"],
    ["archived", "novel.chapter.status.archived"],
    ["draft", "novel.chapter.status.draft"],
  ])("maps %s to its i18n key", (status, expectedKey) => {
    expect(getChapterStatusLabel(status)).toBe(`label:${expectedKey}`)
    expect(tMock).toHaveBeenCalledWith(expectedKey)
    tMock.mockClear()
  })

  it("falls back to the draft label for unknown values", () => {
    expect(getChapterStatusLabel("bogus")).toBe("label:novel.chapter.status.draft")
    expect(getChapterStatusLabel(null)).toBe("label:novel.chapter.status.draft")
    expect(getChapterStatusLabel(undefined)).toBe("label:novel.chapter.status.draft")
    expect(getChapterStatusLabel(42)).toBe("label:novel.chapter.status.draft")
  })
})

describe("buildChapterWordCountLabel", () => {
  it("formats a word count with the 字 suffix", () => {
    expect(buildChapterWordCountLabel(1234)).toBe("1234字")
    expect(buildChapterWordCountLabel(0)).toBe("0字")
  })
})

describe("buildChapterTotalWordCountLabel", () => {
  it("formats a total word count with the 总字数 prefix", () => {
    expect(buildChapterTotalWordCountLabel(99999)).toBe("总字数：99999字")
  })
})

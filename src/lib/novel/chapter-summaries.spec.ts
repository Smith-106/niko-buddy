/** C4 冒烟覆盖：src/lib/novel/chapter-summaries.ts（自动生成，核心行为由专项 spec 加深） */
import { describe, expect, it } from "vitest"
import { createEmptyChapterSummariesStore, saveChapterSummaries, loadChapterSummaries, foldChapterSummary, upsertChapterSummary, recentChapterSummaries, chapterSummariesToContextText } from "./chapter-summaries"
describe("chapter-summaries.ts smoke", () => {
  it("createEmptyChapterSummariesStore() executes", async () => {
    await (createEmptyChapterSummariesStore() as unknown as Promise<unknown>)
  })
  it("exports saveChapterSummaries", () => {
    expect(saveChapterSummaries).toBeDefined()
  })
  it("exports loadChapterSummaries", () => {
    expect(loadChapterSummaries).toBeDefined()
  })
  it("exports foldChapterSummary", () => {
    expect(foldChapterSummary).toBeDefined()
  })
  it("exports upsertChapterSummary", () => {
    expect(upsertChapterSummary).toBeDefined()
  })
  it("exports recentChapterSummaries", () => {
    expect(recentChapterSummaries).toBeDefined()
  })
  it("exports chapterSummariesToContextText", () => {
    expect(chapterSummariesToContextText).toBeDefined()
  })
})
